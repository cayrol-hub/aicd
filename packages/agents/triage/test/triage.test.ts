import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    fingerprint,
    normalizeErrorLine,
    renderTriageComment,
    runTriage,
    verifyEvidence,
    type LlmDiagnosis,
    type TriageInput
} from "@aicd-ci/agent-triage";
import {RunBudget} from "@aicd-ci/core";
import {LLMError, type LLMProvider} from "@aicd-ci/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function input(overrides: Partial<TriageInput> = {}): TriageInput {
    return {
        runId: "run_test",
        context: {provider: "test", repository: "acme/app", commitSha: "abc1234", isFork: false},
        jobs: [],
        tests: [],
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text,
        options: {
            useLlm: false,
            sendCode: "diff_only",
            language: "en",
            retryFlaky: true,
            flakyWindow: 20,
            flakyMinFlips: 2
        },
        ...overrides
    };
}

function fakeLlm(output: LlmDiagnosis | Error): LLMProvider & {calls: number} {
    const provider = {
        name: "fake",
        model: "fake-model",
        calls: 0,
        async generateStructured() {
            provider.calls++;
            if (output instanceof Error) throw output;
            return {
                output: output as never,
                usage: {model: "fake-model", inputTokens: 100, outputTokens: 20, costUsd: 0.001}
            };
        }
    };
    return provider;
}

const failedTestLog =
    "> vitest\n ✗ pricing > caps\n AssertionError: expected 70 to be 50\nERROR: Job failed: exit code 1";

describe("fingerprint", () => {
    it("ignores what changes between runs", () => {
        expect(
            normalizeErrorLine("2026-10-20T08:12:44Z Error at /tmp/abc123/x.js:12:4 after 350ms (id 9f86d081)")
        ).toBe("<date> error at <tmp> after <duration> (id <hex>)");
        expect(fingerprint(["Error in 120ms"], ["b", "a"])).toBe(fingerprint(["Error in 99ms"], ["a", "b"]));
    });
});

describe("runTriage", () => {
    it("classifies with rules first and proposes a retry for infrastructure", async () => {
        const report = await runTriage(
            input({jobs: [{id: "7", name: "install", log: "npm ci\nnpm error code ECONNRESET\n"}]})
        );
        expect(report.findings[0]).toMatchObject({
            category: "infrastructure",
            source: "heuristic",
            confidence: "medium"
        });
        expect(report.findings[0]?.actions).toEqual([{type: "retry_job", jobId: "7", reason: expect.any(String)}]);
    });

    it("reuses a known diagnosis without calling the LLM", async () => {
        const state = new SqliteStateStore(":memory:");
        const llm = fakeLlm(new Error("should not be called"));
        const job = {id: "1", name: "install", log: "npm error code ECONNRESET"};
        await runTriage(input({state, jobs: [job]}));
        const second = await runTriage(input({state, jobs: [job], llm, options: {...input().options, useLlm: true}}));
        expect(second.findings[0]?.source).toBe("cache");
        expect(llm.calls).toBe(0);
        expect((await state.getDiagnosis(second.findings[0]?.fingerprint ?? ""))?.hits).toBe(2);
    });

    it("detects a flaky test from its history", async () => {
        const state = new SqliteStateStore(":memory:");
        const testId = "suite::sync";
        await state.recordTestOutcomes([
            {testId, status: "failed", runId: "r1", commitSha: "c1", at: "2026-10-01T00:00:00Z"},
            {testId, status: "passed", runId: "r2", commitSha: "c1", at: "2026-10-01T01:00:00Z"}
        ]);
        const report = await runTriage(
            input({
                state,
                jobs: [{id: "3", name: "test", log: "FAIL sync\nTimeoutError"}],
                tests: [{id: testId, name: "sync", status: "failed"}]
            })
        );
        expect(report.findings[0]).toMatchObject({category: "flaky_test", confidence: "high"});
    });

    it("accepts an LLM diagnosis only with verifiable evidence", async () => {
        const llm = fakeLlm({
            category: "regression",
            summary: "The discount cap was removed.",
            cause: "src/pricing.ts no longer caps the percentage.",
            confidence: "high",
            evidence: [
                {kind: "log", ref: "log L3", quote: "AssertionError: expected 70 to be 50"},
                {kind: "diff", ref: "src/pricing.ts", quote: "this line is not in the diff"}
            ],
            suggested_fix: "Restore Math.min(percent, 50)."
        });
        const report = await runTriage(
            input({
                llm,
                diff: "+    const capped = percent;",
                jobs: [{id: "9", name: "unit", log: failedTestLog}],
                options: {...input().options, useLlm: true}
            })
        );
        expect(report.findings[0]).toMatchObject({category: "regression", source: "llm", confidence: "high"});
        expect(report.findings[0]?.evidence).toHaveLength(1);
        expect(report.costUsd).toBe(0.001);
    });

    it("rejects an LLM diagnosis without evidence and falls back to rules", async () => {
        const llm = fakeLlm({
            category: "infrastructure",
            summary: "Invented.",
            cause: "Invented.",
            confidence: "high",
            evidence: [{kind: "log", ref: "log L1", quote: "this text does not exist"}],
            suggested_fix: ""
        });
        const report = await runTriage(
            input({
                llm,
                jobs: [{id: "9", name: "unit", log: failedTestLog}],
                options: {...input().options, useLlm: true}
            })
        );
        expect(report.findings[0]).toMatchObject({category: "regression", source: "heuristic", confidence: "low"});
    });

    it("counts the cost of a failed LLM call and stops at the budget", async () => {
        const failing = fakeLlm(new LLMError("declined", {model: "m", inputTokens: 1, outputTokens: 1, costUsd: 2}));
        const budget = new RunBudget(1);
        const report = await runTriage(
            input({
                llm: failing,
                budget,
                jobs: [
                    {id: "1", name: "a", log: failedTestLog},
                    {id: "2", name: "b", log: `${failedTestLog}\nother`}
                ],
                options: {...input().options, useLlm: true}
            })
        );
        expect(failing.calls).toBe(1);
        expect(budget.spentUsd).toBe(2);
        expect(report.findings).toHaveLength(2);
    });

    it("never calls the LLM for code from a fork", async () => {
        const llm = fakeLlm(new Error("should not be called"));
        await runTriage(
            input({
                llm,
                context: {provider: "test", repository: "acme/app", isFork: true},
                jobs: [{id: "1", name: "unit", log: failedTestLog}],
                options: {...input().options, useLlm: true}
            })
        );
        expect(llm.calls).toBe(0);
    });
});

describe("verifyEvidence", () => {
    it("matches quotes regardless of whitespace and line prefixes", () => {
        const result = verifyEvidence(
            {
                category: "unknown",
                summary: "",
                cause: "",
                confidence: "low",
                suggested_fix: "",
                evidence: [{kind: "log", ref: "L2", quote: "alpha   beta"}]
            },
            {excerpt: "L1: x\nL2: alpha beta"}
        );
        expect(result.evidence).toHaveLength(1);
    });
});

describe("renderTriageComment", () => {
    it("renders a localized comment with the marker and suggestions", () => {
        const body = renderTriageComment(
            [
                {
                    agent: "triage",
                    jobName: "unit",
                    category: "flaky_test",
                    summary: "1 flaky test failed.",
                    confidence: "high",
                    evidence: [{kind: "history", ref: "suite::sync", quote: "passed and failed on the same commit"}],
                    source: "heuristic",
                    failingTests: ["suite::sync"],
                    actions: []
                }
            ],
            {runId: "run_1", language: "fr", suggestions: ["`retry_job` (job 3)"]}
        );
        expect(body.startsWith("<!-- aicd:triage -->")).toBe(true);
        expect(body).toContain("#### `unit` — Test instable");
        expect(body).toContain("**Confiance** : haute (preuves solides) · **Diagnostic** : règles");
        expect(body).toContain("**Que faire**");
        expect(body).toContain("Actions suggérées");
    });

    it("gives the full picture of a regression: assertion, location, meaning, next steps and reasoning", async () => {
        const report = await runTriage(
            input({
                jobs: [{id: "9", name: "test", url: "https://ci.example/jobs/9", log: "✖ failing tests:\nexit 1"}],
                tests: [
                    {
                        id: "pricing::caps the discount at 50%",
                        name: "caps the discount at 50%",
                        file: "test/pricing.test.ts",
                        status: "failed",
                        message: "Expected values to be strictly equal:30 !== 50",
                        details: "AssertionError\n    at TestContext (file:///repo/test/pricing.test.ts:7:51)"
                    }
                ]
            })
        );
        const finding = report.findings[0];
        expect(finding).toMatchObject({category: "regression", jobUrl: "https://ci.example/jobs/9"});
        expect(finding?.evidence).toEqual([
            {
                kind: "test",
                ref: "pricing::caps the discount at 50%",
                quote: "Expected values to be strictly equal:30 !== 50"
            }
        ]);
        expect(finding?.trail).toMatchObject({knownHits: 0, rule: null, llm: "not_configured"});

        const body = renderTriageComment(report.findings, {
            runId: "run_1",
            language: "en",
            context: {
                provider: "github",
                repository: "acme/shop",
                commitSha: "ee12958aaaa",
                branch: "fix/discount",
                pipelineUrl: "https://ci.example/runs/1",
                isFork: false
            }
        });
        expect(body).toContain(
            "**The pipeline failed: 1 job diagnosed** · commit `ee12958` on `fix/discount` · [pipeline](https://ci.example/runs/1)"
        );
        expect(body).toContain("**Job**: [test](https://ci.example/jobs/9)");
        expect(body).toContain("- `pricing::caps the discount at 50%` — `test/pricing.test.ts:7`");
        expect(body).toContain("  > `Expected values to be strictly equal:30 !== 50`");
        expect(body).toContain("**What it means**: The failing tests have no history of instability");
        expect(body).toContain("1. Read the assertion messages above");
        expect(body).toContain(
            "Rules (network, runner resources, external services, dependencies, configuration): no match."
        );
        expect(body).toContain(
            "Test history of `pricing::caps the discount at 50%`: no earlier run recorded, too early to tell whether it is flaky."
        );
        expect(body).toContain("LLM analysis: none, no LLM is configured");
    });

    it("puts a rule's own advice first", async () => {
        const report = await runTriage(
            input({jobs: [{id: "4", name: "build", log: "FATAL ERROR: JavaScript heap out of memory"}]})
        );
        const body = renderTriageComment(report.findings, {runId: "run_1", language: "en"});
        expect(body).toContain("1. A retry may fail the same way: give the job more memory or disk");
        expect(body).not.toContain("Re-run the job: this kind of failure is usually transient.");
        expect(body).toContain("Rules: the `resources` rule matches the log.");
    });
});
