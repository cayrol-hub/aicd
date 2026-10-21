import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    dedupeAlerts,
    globToRegExp,
    matchIgnorePath,
    parseSarif,
    recordBaseline,
    renderSecurityComment,
    runSecurityTriage,
    SarifError,
    splitNewAlerts,
    type LlmSecurityVerdict,
    type SecurityAlert
} from "@aicd-ci/agent-security-triage";
import {RunBudget} from "@aicd-ci/core";
import {
    COLLECTIONS,
    type AgentRuntime,
    type LLMProvider,
    type ReadonlyCI,
    type StructuredRequest
} from "@aicd-ci/plugin-sdk";
import {CODEQL, LOGIN_JS, semgrep, TRIVY} from "./fixtures.js";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const REDIRECT_RULE = "javascript.express.security.audit.express-open-redirect.express-open-redirect";

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_sec",
        context: {
            provider: "gitlab",
            repository: "acme/app",
            branch: "feature/login",
            defaultBranch: "main",
            commitSha: "abc1234",
            mergeRequest: {id: "42"},
            pipelineUrl: "https://gitlab.example.com/acme/app/-/pipelines/9",
            isFork: false
        },
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text.replace(/sk_live_\w+/g, "[REDACTED]"),
        language: "en",
        sendCode: "full",
        now: () => new Date("2026-10-21T10:00:00Z"),
        ...overrides
    };
}

const onDefaultBranch = (state: SqliteStateStore) =>
    runtime({
        state,
        context: {provider: "gitlab", repository: "acme/app", branch: "main", defaultBranch: "main", isFork: false}
    });

function fakeCi(files: Record<string, string> = {"src/routes/login.js": LOGIN_JS}): ReadonlyCI {
    return {
        name: "fake",
        getContext: async () => ({provider: "fake", repository: "acme/app", isFork: false}),
        listFailedJobs: async () => [],
        listJobs: async () => [],
        listRecentPipelines: async () => [],
        getJobLog: async () => "",
        getDiff: async () => undefined,
        readFile: async (path) => files[path]
    };
}

function fakeLlm(output: LlmSecurityVerdict | Error): LLMProvider & {prompts: string[]} {
    const provider = {
        name: "fake",
        model: "fake-model",
        prompts: [] as string[],
        async generateStructured<T>(request: StructuredRequest<T>) {
            provider.prompts.push(request.prompt);
            if (output instanceof Error) throw output;
            return {
                output: output as T,
                usage: {model: "fake-model", inputTokens: 300, outputTokens: 80, costUsd: 0.002}
            };
        }
    };
    return provider;
}

const verdict = (overrides: Partial<LlmSecurityVerdict> = {}): LlmSecurityVerdict => ({
    verdict: "exploitable",
    explanation: "`next` comes from the query string and is passed to res.redirect without validation.",
    evidence: [
        {line: 10, quote: "const next = req.query.next;"},
        {line: 12, quote: "res.redirect(next);"}
    ],
    fix_description: "",
    fix_edits: [],
    ...overrides
});

describe("parseSarif", () => {
    it("normalizes Semgrep, CodeQL and Trivy outputs", () => {
        const alerts = [...parseSarif(semgrep()), ...parseSarif(CODEQL), ...parseSarif(TRIVY)];
        expect(alerts).toHaveLength(6);
        expect(alerts[0]).toMatchObject({
            tool: "Semgrep OSS",
            ruleId: REDIRECT_RULE,
            severity: "medium",
            file: "src/routes/login.js",
            startLine: 12,
            endLine: 12,
            helpUri: "https://semgrep.dev/r/javascript.express.security.audit.express-open-redirect"
        });
        expect(alerts[1]).toMatchObject({severity: "high", file: "test/fixtures/keys.js"});
        expect(alerts[2]).toMatchObject({
            tool: "CodeQL",
            ruleId: "js/sql-injection",
            severity: "high",
            file: "src/db/users.js"
        });
        // rule found by index, message from messageStrings, absolute URI made relative to the scan root.
        expect(alerts[3]).toMatchObject({
            ruleId: "js/code-injection",
            severity: "critical",
            message: "This code execution depends on a user-provided value.",
            file: "src/eval.js"
        });
        expect(alerts[4]).toMatchObject({
            tool: "Trivy",
            ruleId: "CVE-2021-23337",
            severity: "high",
            file: "package-lock.json"
        });
        expect(alerts[5]).toMatchObject({ruleId: "CVE-2020-28500", severity: "medium"});
        expect(new Set(alerts.map((alert) => alert.id)).size).toBe(6);
    });

    it("keeps the same id when the code moves", () => {
        const before = parseSarif(semgrep(12))[0];
        const after = parseSarif(semgrep(30))[0];
        expect(after?.startLine).toBe(30);
        expect(after?.id).toBe(before?.id);
    });

    it("uses fingerprints when the scanner gives them", () => {
        const moved = CODEQL.replace('"startLine":4', '"startLine":40').replace("[user-provided value](1)", "value");
        expect(parseSarif(moved)[0]?.id).toBe(parseSarif(CODEQL)[0]?.id);
    });

    it("maps levels when there is no security-severity", () => {
        const doc = (level: string) =>
            JSON.stringify({
                version: "2.1.0",
                runs: [{tool: {driver: {name: "x"}}, results: [{ruleId: "r", level, message: {text: "m"}}]}]
            });
        expect(parseSarif(doc("error"))[0]?.severity).toBe("high");
        expect(parseSarif(doc("warning"))[0]?.severity).toBe("medium");
        expect(parseSarif(doc("note"))[0]?.severity).toBe("low");
        expect(parseSarif(doc("none"))[0]?.severity).toBe("note");
    });

    it("redacts messages and rejects documents that are not SARIF", () => {
        const doc = JSON.stringify({
            version: "2.1.0",
            runs: [
                {
                    tool: {driver: {name: "gitleaks"}},
                    results: [{ruleId: "key", message: {text: "found sk_live_abc123"}}]
                }
            ]
        });
        expect(parseSarif(doc, {redact: (t) => t.replace(/sk_live_\w+/, "[REDACTED]")})[0]?.message).toBe(
            "found [REDACTED]"
        );
        expect(() => parseSarif("{not json")).toThrow(SarifError);
        expect(() => parseSarif('{"version":"2.1.0"}')).toThrow(SarifError);
        expect(parseSarif('{"runs":[]}')).toEqual([]);
    });
});

describe("heuristics", () => {
    it("matches ignore globs", () => {
        expect(globToRegExp("**/test/**").test("test/a.js")).toBe(true);
        expect(globToRegExp("**/test/**").test("src/test/a.js")).toBe(true);
        expect(globToRegExp("**/test/**").test("src/latest/a.js")).toBe(false);
        expect(matchIgnorePath("src/app.spec.ts", ["*.spec.*"])).toBe("*.spec.*");
        expect(matchIgnorePath("src/app.ts", ["**/vendor/**"])).toBeUndefined();
    });

    it("dedupes the same alert reported twice, keeping the most severe", () => {
        const alert: SecurityAlert = {
            id: "a",
            tool: "t",
            ruleId: "r",
            severity: "low",
            message: "m",
            file: "f",
            startLine: 1
        };
        const result = dedupeAlerts([
            alert,
            {...alert, severity: "high"},
            {...alert, id: "b"},
            {...alert, id: "c", file: "g"}
        ]);
        expect(result.map((a) => [a.id, a.severity])).toEqual([
            ["a", "high"],
            ["c", "low"]
        ]);
    });
});

describe("baseline", () => {
    it("splits new and existing alerts and forgets fixed ones", async () => {
        const state = new SqliteStateStore(":memory:");
        const [a, b, c] = parseSarif(TRIVY).concat(parseSarif(CODEQL)) as SecurityAlert[];
        await recordBaseline(state, [a as SecurityAlert, b as SecurityAlert, c as SecurityAlert]);
        // Trivy ran again and CVE-2020-28500 is fixed; CodeQL did not run: its records stay.
        const result = await recordBaseline(state, [a as SecurityAlert], {tools: ["Trivy"]});
        expect(result).toEqual({recorded: 1, removed: 1});
        const split = await splitNewAlerts(state, [a as SecurityAlert, b as SecurityAlert, c as SecurityAlert]);
        expect(split.existing.map((x) => x.id)).toEqual([a?.id, c?.id]);
        expect(split.newAlerts.map((x) => x.id)).toEqual([b?.id]);
    });
});

describe("runSecurityTriage", () => {
    it("records the baseline on the default branch and proposes nothing", async () => {
        const state = new SqliteStateStore(":memory:");
        const result = await runSecurityTriage(onDefaultBranch(state), {ci: fakeCi(), sarifDocuments: [TRIVY]});
        expect(result.actions).toEqual([]);
        expect(result.report).toMatchObject({defaultBranch: true, newCount: 0, existingCount: 2});
        expect(await state.listRecords(COLLECTIONS.securityBaseline)).toHaveLength(2);
    });

    it("reports only new alerts on a merge request, rules only", async () => {
        const state = new SqliteStateStore(":memory:");
        await runSecurityTriage(onDefaultBranch(state), {ci: fakeCi(), sarifDocuments: [TRIVY]});
        const result = await runSecurityTriage(runtime({state}), {
            ci: fakeCi(),
            sarifDocuments: [TRIVY, semgrep(), "not json"]
        });
        const {report} = result;
        expect(report.errors).toEqual([expect.stringContaining("SARIF document 3")]);
        expect(report.newCount).toBe(2);
        expect(report.existingCount).toBe(2);
        const fixture = report.alerts.find((item) => item.alert.file === "test/fixtures/keys.js");
        expect(fixture).toMatchObject({verdict: "likely_false_positive", confidence: "low", ignoredBy: "**/test/**"});
        const redirect = report.alerts.find((item) => item.alert.ruleId === REDIRECT_RULE);
        expect(redirect).toMatchObject({verdict: "needs_review", source: "heuristic", isNew: true});
        // medium needs_review is under fail_on "high": success.
        expect(report.status).toBe("success");
        expect(result.actions.map((action) => action.type)).toEqual(["comment", "set_status"]);
        const comment = result.actions[0];
        expect(comment?.type === "comment" && comment.marker).toBe("<!-- aicd:security -->");
        expect(comment?.type === "comment" && comment.body).not.toContain("CVE-2021-23337");
    });

    it("fails the status on a new high alert that needs review, and never dismisses critical ones by path", async () => {
        const result = await runSecurityTriage(runtime(), {
            ci: fakeCi(),
            sarifDocuments: [CODEQL.replace("src/eval.js", "test/eval.js")],
            options: {fail_on: "high"}
        });
        expect(result.report.baselineMissing).toBe(true);
        const critical = result.report.alerts.find((item) => item.alert.severity === "critical");
        expect(critical).toMatchObject({verdict: "needs_review", ignoredBy: "**/test/**"});
        expect(result.report.blocking).toHaveLength(2);
        const status = result.actions.find((action) => action.type === "set_status");
        expect(status?.type === "set_status" && status.status).toMatchObject({
            state: "failure",
            context: "aicd/security",
            url: "https://gitlab.example.com/acme/app/-/pipelines/9"
        });
    });

    it("proposes no comment when nothing is new", async () => {
        const state = new SqliteStateStore(":memory:");
        await runSecurityTriage(onDefaultBranch(state), {ci: fakeCi(), sarifDocuments: [CODEQL]});
        const result = await runSecurityTriage(runtime({state}), {ci: fakeCi(), sarifDocuments: [CODEQL]});
        expect(result.actions.map((action) => action.type)).toEqual(["set_status"]);
        expect(result.report.status).toBe("success");
    });

    it("accepts an LLM verdict with verified quotes, on a redacted snippet", async () => {
        const llm = fakeLlm(verdict());
        const result = await runSecurityTriage(runtime({llm}), {
            ci: fakeCi(),
            sarifDocuments: [semgrep()],
            options: {fail_on: "medium"}
        });
        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain("L12:     res.redirect(next);");
        expect(llm.prompts[0]).not.toContain("sk_live");
        const redirect = result.report.alerts.find((item) => item.alert.ruleId === REDIRECT_RULE);
        expect(redirect).toMatchObject({verdict: "exploitable", source: "llm", confidence: "medium"});
        expect(redirect?.evidence).toHaveLength(2);
        expect(result.llmCalls).toBe(1);
        expect(result.costUsd).toBeCloseTo(0.002);
        expect(result.report.status).toBe("failure");
    });

    it("downgrades a verdict whose quote is not in the snippet", async () => {
        const llm = fakeLlm(
            verdict({
                verdict: "not_exploitable",
                evidence: [{line: 11, quote: "if (isSafeUrl(next)) res.redirect(next);"}]
            })
        );
        const result = await runSecurityTriage(runtime({llm}), {ci: fakeCi(), sarifDocuments: [semgrep()]});
        const redirect = result.report.alerts.find((item) => item.alert.ruleId === REDIRECT_RULE);
        expect(redirect).toMatchObject({verdict: "needs_review", downgraded: "unverified_evidence", evidence: []});
    });

    it("never lets the LLM alone dismiss a critical alert", async () => {
        const llm = fakeLlm(verdict({verdict: "not_exploitable", evidence: [{line: 2, quote: "eval(expression)"}]}));
        const ci = fakeCi({"src/eval.js": "function run(expression) {\n    return eval(expression);\n}\n"});
        const result = await runSecurityTriage(runtime({llm}), {ci, sarifDocuments: [CODEQL]});
        const critical = result.report.alerts.find((item) => item.alert.ruleId === "js/code-injection");
        expect(critical).toMatchObject({verdict: "needs_review", downgraded: "never_dismiss", source: "llm"});
        // The high SQL alert has no readable file: rules only, still blocking.
        expect(result.report.blocking).toHaveLength(2);
    });

    it("lets the LLM clear a high alert with proof", async () => {
        const llm = fakeLlm(verdict({verdict: "not_exploitable", evidence: [{line: 2, quote: "eval(expression)"}]}));
        const ci = fakeCi({"src/eval.js": "function run(expression) {\n    return eval(expression);\n}\n"});
        const result = await runSecurityTriage(runtime({llm}), {
            ci,
            sarifDocuments: [CODEQL],
            options: {never_dismiss: []}
        });
        expect(result.report.alerts.find((i) => i.alert.ruleId === "js/code-injection")?.verdict).toBe(
            "not_exploitable"
        );
    });

    it("with sendCode diff_only, shows the LLM only alerts in files the merge request changes", async () => {
        const llm = fakeLlm(new Error("must not be called"));
        const result = await runSecurityTriage(runtime({llm, sendCode: "diff_only"}), {
            ci: fakeCi(),
            sarifDocuments: [semgrep()],
            changedFiles: ["some/other/file.ts"]
        });
        expect(result.llmCalls).toBe(0);
        expect(llm.prompts).toEqual([]);
    });

    it("sends no code and calls no LLM with sendCode none, and respects max_alerts", async () => {
        const llm = fakeLlm(verdict());
        await runSecurityTriage(runtime({llm, sendCode: "none"}), {ci: fakeCi(), sarifDocuments: [semgrep()]});
        expect(llm.prompts).toHaveLength(0);
        await runSecurityTriage(runtime({llm}), {ci: fakeCi(), sarifDocuments: [semgrep()], options: {max_alerts: 0}});
        expect(llm.prompts).toHaveLength(0);
    });

    it("falls back to rules when the LLM fails", async () => {
        const llm = fakeLlm(new Error("overloaded"));
        const result = await runSecurityTriage(runtime({llm}), {ci: fakeCi(), sarifDocuments: [semgrep()]});
        expect(result.llmCalls).toBe(0);
        expect(result.report.alerts.find((i) => i.alert.ruleId === REDIRECT_RULE)?.source).toBe("heuristic");
    });

    it("proposes a fix merge request only when the edits apply", async () => {
        const good = fakeLlm(
            verdict({
                fix_description: "Only redirect to relative paths.",
                fix_edits: [
                    {
                        path: "src/routes/login.js",
                        search: "    res.redirect(next);",
                        replace:
                            '    res.redirect(typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");'
                    }
                ]
            })
        );
        const result = await runSecurityTriage(runtime({llm: good}), {
            ci: fakeCi(),
            sarifDocuments: [semgrep()],
            options: {fix_proposal: true}
        });
        const fix = result.actions.find((action) => action.type === "open_fix_mr");
        expect(fix?.type === "open_fix_mr" && fix.fix.branch).toMatch(/^aicd\/fix-security-javascript/);
        expect(fix?.type === "open_fix_mr" && fix.fix.changes[0]?.content).toContain('next.startsWith("/")');
        // The fix is applied to the real file, not the redacted one.
        expect(fix?.type === "open_fix_mr" && fix.fix.changes[0]?.content).toContain(
            "sk_" + "live_51HxAbCdEfGhIjKlMnOpQrStUv"
        );
        expect(fix?.type === "open_fix_mr" && fix.fix.body).toContain(REDIRECT_RULE);
        const french = await runSecurityTriage(runtime({llm: good, language: "fr"}), {
            ci: fakeCi(),
            sarifDocuments: [semgrep()],
            options: {fix_proposal: true}
        });
        const frFix = french.actions.find((action) => action.type === "open_fix_mr");
        expect(frFix?.type === "open_fix_mr" && frFix.fix.body).toContain(
            "Correctif proposé par aicd pour une alerte moyenne"
        );
        expect(frFix?.type === "open_fix_mr" && frFix.fix.body).toContain("- Règle : `");

        const bad = fakeLlm(
            verdict({fix_edits: [{path: "src/routes/login.js", search: "res.redirect(url);", replace: "x"}]})
        );
        const rejected = await runSecurityTriage(runtime({llm: bad}), {
            ci: fakeCi(),
            sarifDocuments: [semgrep()],
            options: {fix_proposal: true}
        });
        expect(rejected.actions.some((action) => action.type === "open_fix_mr")).toBe(false);
    });

    it("proposes no action outside a merge request", async () => {
        const context = {
            provider: "gitlab",
            repository: "acme/app",
            branch: "feature/x",
            defaultBranch: "main",
            isFork: false
        };
        const result = await runSecurityTriage(runtime({context}), {ci: fakeCi(), sarifDocuments: [semgrep()]});
        expect(result.actions).toEqual([]);
        expect(result.report.newCount).toBe(2);
    });
});

describe("renderSecurityComment", () => {
    it("renders in English and French", async () => {
        const llm = fakeLlm(verdict());
        const {report} = await runSecurityTriage(runtime({llm}), {ci: fakeCi(), sarifDocuments: [semgrep()]});
        const en = renderSecurityComment(report, {language: "en", runId: "run_sec"});
        expect(en).toContain("<!-- aicd:security -->");
        expect(en).toContain("| Severity | Rule | Location | Verdict |");
        expect(en).toContain("exploitable (analysis)");
        expect(en).toContain("1 alert(s) in test, example, vendored or generated code");
        expect(en).toContain("`res.redirect(next);`");
        const fr = renderSecurityComment(report, {language: "fr", runId: "run_sec"});
        expect(fr).toContain("aicd · Sécurité");
        expect(fr).toContain("| Sévérité | Règle | Emplacement | Verdict |");
        expect(fr).toContain("faux positif probable");
        expect(fr).toContain("La branche par défaut n'a jamais été analysée :");
    });
});
