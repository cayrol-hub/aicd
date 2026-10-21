import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {
    checkQuarantine,
    COMMENT_MARKER,
    FLAKY_COLLECTION,
    renderFlakyComment,
    runFlakyAgent,
    scoreHistory,
    scoreTests,
    type FlakyReport
} from "@aicd/agent-flaky";
import {RunBudget} from "@aicd/core";
import {COLLECTIONS, type AgentRuntime, type QuarantineRecord, type TestOutcome} from "@aicd/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function runtime(state: SqliteStateStore, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_42",
        context: {provider: "test", repository: "acme/app", commitSha: "c-current", isFork: false},
        state,
        budget: new RunBudget(1),
        logger,
        redact: (text) => text,
        language: "en",
        sendCode: "none",
        now: () => new Date("2026-10-21T10:00:00Z"),
        ...overrides
    };
}

let counter = 0;

/** Records a sequence like "PPFPF" (oldest first), one commit per run unless `sameCommit` is set. */
async function record(state: SqliteStateStore, testId: string, sequence: string, sameCommit?: string): Promise<void> {
    const outcomes: TestOutcome[] = [...sequence].map((char) => {
        counter++;
        return {
            testId,
            status: char === "P" ? "passed" : char === "F" ? "failed" : "skipped",
            runId: `run_${counter}`,
            commitSha: sameCommit ?? `sha${counter.toString().padStart(8, "0")}`,
            at: new Date(Date.UTC(2026, 9, 1, 0, counter)).toISOString()
        };
    });
    for (const outcome of outcomes) await state.recordTestOutcomes([outcome]);
}

const history = (sequence: string, sha?: (index: number) => string): TestOutcome[] =>
    [...sequence]
        .map((char, index): TestOutcome => ({
            testId: "t",
            status: char === "P" ? "passed" : char === "F" ? "failed" : "skipped",
            runId: `r${index}`,
            commitSha: sha ? sha(index) : `c${index}`,
            at: "2026-10-01T00:00:00Z"
        }))
        .reverse();

describe("scoreHistory", () => {
    it("counts flips, failures and the score over non-skipped runs", () => {
        const score = scoreHistory("t", history("PPFSPFP"), {window: 30});
        expect(score).toMatchObject({
            runs: 6,
            failures: 2,
            flips: 4,
            sameCommitFlips: 0,
            intermittentFailures: 2,
            consecutivePasses: 1,
            flaky: true,
            confidence: "medium",
            history: "PPFPFP"
        });
        expect(score.score).toBeCloseTo(4 / 5);
    });

    it("is high confidence when the test passed and failed on the same commit", () => {
        const score = scoreHistory(
            "t",
            history("PF", () => "same"),
            {window: 30, minRuns: 2}
        );
        expect(score).toMatchObject({sameCommitFlips: 1, sameCommitShas: ["same"], flaky: true, confidence: "high"});
    });

    it("does not count a trailing failure streak as intermittent, nor a stable test as flaky", () => {
        expect(scoreHistory("t", history("PPPPFFF"), {window: 30})).toMatchObject({
            flips: 1,
            intermittentFailures: 0,
            flaky: false,
            confidence: "low"
        });
        expect(scoreHistory("t", history("PPPP"), {window: 30})).toMatchObject({score: 0, flaky: false});
    });

    it("handles an empty history and respects minRuns and the window", () => {
        expect(scoreHistory("t", [], {window: 30})).toMatchObject({runs: 0, score: 0, flaky: false, history: ""});
        expect(scoreHistory("t", history("FP"), {window: 30, minRuns: 3}).flaky).toBe(false);
        // Only the last 3 outcomes are scored; the streak still looks at everything fetched.
        expect(scoreHistory("t", history("FPFPPP"), {window: 3})).toMatchObject({runs: 3, flips: 0});
    });

    it("is deterministic", () => {
        const outcomes = history("PFPFFPPF");
        expect(scoreHistory("t", outcomes, {window: 30})).toEqual(scoreHistory("t", outcomes, {window: 30}));
    });
});

describe("scoreTests", () => {
    it("reads each test's history once, in order, from the state store", async () => {
        const state = new SqliteStateStore(":memory:");
        await record(state, "a", "PFPF");
        await record(state, "b", "PPPP");
        const scores = await scoreTests(state, ["b", "a", "b", "unknown"], {window: 30, minRuns: 3});
        expect(scores.map((s) => [s.testId, s.flaky])).toEqual([
            ["b", false],
            ["a", true],
            ["unknown", false]
        ]);
    });
});

describe("runFlakyAgent", () => {
    it("proposes nothing and no comment when every test is stable", async () => {
        const state = new SqliteStateStore(":memory:");
        await record(state, "a", "PPPPP");
        const result = await runFlakyAgent(runtime(state), {currentRun: [{testId: "a", status: "passed"}]});
        expect(result.actions).toEqual([]);
        expect(result.report).toMatchObject({scored: 1, flaky: [], newlyFlaky: [], toQuarantine: []});
        expect(result).toMatchObject({agent: "flaky", llmCalls: 0, costUsd: 0});
    });

    it("handles an empty run", async () => {
        const result = await runFlakyAgent(runtime(new SqliteStateStore(":memory:")), {currentRun: []});
        expect(result.actions).toEqual([]);
        expect(result.report.scored).toBe(0);
    });

    it("quarantines a test failing intermittently, with evidence, an issue and a comment", async () => {
        const state = new SqliteStateStore(":memory:");
        await record(state, "pricing > caps", "PFPFPPFPF");
        const result = await runFlakyAgent(runtime(state), {
            currentRun: [{testId: "pricing > caps", status: "failed"}],
            options: {createIssues: true}
        });
        const types = result.actions.map((action) => action.type);
        expect(types).toEqual(["quarantine_test", "create_issue", "comment"]);
        const quarantine = result.actions[0];
        expect(quarantine).toMatchObject({type: "quarantine_test", testIds: ["pricing > caps"]});
        expect(quarantine?.reason).toContain("flaky score 0.88 (7 status changes in 9 runs)");
        expect(quarantine?.reason).toContain("3 intermittent failures");
        const issue = result.actions[1];
        expect(issue?.type === "create_issue" && issue.issue.title).toBe("Flaky test: pricing > caps");
        expect(issue?.type === "create_issue" && issue.issue.body).toContain("`PFPFPPFPF`");
        const comment = result.actions[2];
        expect(comment).toMatchObject({type: "comment", marker: COMMENT_MARKER});
        expect(result.report.newlyFlaky.map((s) => s.testId)).toEqual(["pricing > caps"]);
        expect(result.report.failing).toEqual({quarantined: [], notQuarantined: ["pricing > caps"]});

        // Bookkeeping: the next run does not report it as newly flaky again.
        expect((await state.getRecord(FLAKY_COLLECTION, "pricing > caps"))?.value).toMatchObject({flaky: true});
        await record(state, "pricing > caps", "P");
        const next = await runFlakyAgent(runtime(state), {currentRun: [{testId: "pricing > caps", status: "passed"}]});
        expect(next.report.newlyFlaky).toEqual([]);
    });

    it("reports a newly flaky test without quarantining it below quarantineAfter, and no issue by default", async () => {
        const state = new SqliteStateStore(":memory:");
        await record(state, "a", "PPFPP");
        await record(state, "a", "F", "same");
        await record(state, "a", "P", "same");
        const result = await runFlakyAgent(runtime(state), {currentRun: [{testId: "a", status: "passed"}]});
        expect(result.report.newlyFlaky[0]).toMatchObject({testId: "a", confidence: "high"});
        expect(result.actions.map((action) => action.type)).toEqual(["comment"]);
    });

    it("splits failing tests by quarantine and comments when quarantined tests fail", async () => {
        const state = new SqliteStateStore(":memory:");
        const record_: QuarantineRecord = {
            testId: "q",
            since: "2026-10-01T00:00:00Z",
            reason: "flaky",
            flakyScore: 0.5
        };
        await state.putRecord(COLLECTIONS.quarantine, "q", record_);
        await record(state, "q", "PPPPF");
        await record(state, "r", "PPPPF");
        const result = await runFlakyAgent(runtime(state, {language: "fr"}), {
            currentRun: [
                {testId: "q", status: "failed"},
                {testId: "r", status: "failed"}
            ]
        });
        expect(result.report.failing).toEqual({quarantined: ["q"], notQuarantined: ["r"]});
        expect(result.report.quarantined[0]).toMatchObject({testId: "q", flakyScore: 0.5, consecutivePasses: 0});
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]?.type === "comment" && result.actions[0].body).toContain(
            "Tests en quarantaine en échec"
        );
    });

    it("releases a quarantined test after releaseAfter consecutive passes, even beyond the window", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.quarantine, "q", {
            testId: "q",
            since: "2026-10-01T00:00:00Z",
            reason: "flaky",
            flakyScore: 0
        } satisfies QuarantineRecord);
        await record(state, "q", "FPFP" + "P".repeat(11));
        const result = await runFlakyAgent(runtime(state), {
            currentRun: [{testId: "q", status: "passed"}],
            options: {window: 5, releaseAfter: 12}
        });
        expect(result.report.toRelease).toEqual([{testId: "q", consecutivePasses: 12}]);
        expect(result.actions[0]).toMatchObject({type: "release_quarantine", testIds: ["q"]});
        expect(result.actions.at(-1)?.type).toBe("comment");
    });

    it("does not propose a quarantine twice", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.quarantine, "a", {
            testId: "a",
            since: "2026-10-01T00:00:00Z",
            reason: "flaky",
            flakyScore: 0.9
        } satisfies QuarantineRecord);
        await record(state, "a", "PFPFPFPF");
        const result = await runFlakyAgent(runtime(state), {currentRun: [{testId: "a", status: "failed"}]});
        expect(result.report.toQuarantine).toEqual([]);
        expect(result.actions.filter((action) => action.type === "quarantine_test")).toEqual([]);
    });

    it("passes rendered texts through redact", async () => {
        const state = new SqliteStateStore(":memory:");
        await record(state, "secret-token-test", "PFPFPFPF");
        const result = await runFlakyAgent(
            runtime(state, {redact: (text) => text.replaceAll("secret-token", "[REDACTED]")}),
            {currentRun: [{testId: "secret-token-test", status: "failed"}], options: {createIssues: true}}
        );
        for (const action of result.actions) {
            if (action.type === "comment") expect(action.body).not.toContain("secret-token");
            if (action.type === "create_issue") expect(action.issue.title).toBe("Flaky test: [REDACTED]-test");
        }
    });
});

describe("checkQuarantine", () => {
    it("lets the gate pass only when every failing test is quarantined", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.quarantine, "q1", {testId: "q1", since: "x", reason: "r", flakyScore: 1});
        await state.putRecord(COLLECTIONS.quarantine, "q2", {testId: "q2", since: "x", reason: "r", flakyScore: 1});
        expect(await checkQuarantine(state, ["q1", "q2", "q1"])).toEqual({
            allQuarantined: true,
            quarantined: ["q1", "q2"],
            notQuarantined: []
        });
        expect(await checkQuarantine(state, ["q1", "x"])).toEqual({
            allQuarantined: false,
            quarantined: ["q1"],
            notQuarantined: ["x"]
        });
        // Nothing failed: the job failed for another reason, the gate must not wave it through.
        expect((await checkQuarantine(state, [])).allQuarantined).toBe(false);
    });
});

describe("renderFlakyComment", () => {
    const score = scoreHistory(
        "a`b",
        history("PFPF", () => "deadbeefcafe"),
        {window: 30}
    );
    const report: FlakyReport = {
        scored: 2,
        flaky: [score],
        newlyFlaky: [score],
        toQuarantine: [{testId: score.testId, reason: "r", score}],
        quarantined: [{testId: "q", since: "x", reason: "r", flakyScore: 0.4}],
        toRelease: [{testId: "q", consecutivePasses: 10}],
        failing: {quarantined: ["q"], notQuarantined: ["z"]}
    };

    it("renders in English", () => {
        const body = renderFlakyComment(report, {runId: "run_1", language: "en"});
        expect(body.startsWith(COMMENT_MARKER)).toBe(true);
        expect(body).toContain("### aicd · Flaky tests");
        expect(body).toContain("**Newly detected flaky tests**:");
        expect(body).toContain("| `a'b` | 1.00 | 3 | 4 | high |");
        expect(body).toContain("passed and failed on the same commit deadbeef");
        expect(body).toContain("`q` — 10 consecutive passes");
        expect(body).toContain("**Other failing tests (not quarantined)**:\n- `z`");
        expect(body).toContain("Run `run_1`");
    });

    it("renders in French with a space before the colon", () => {
        const body = renderFlakyComment(report, {runId: "run_1", language: "fr"});
        expect(body).toContain("### aicd · Tests instables");
        expect(body).toContain("**Nouveaux tests instables détectés** :");
        expect(body).toContain("**Sortie de quarantaine proposée** :");
        expect(body).toContain("| haute |");
        expect(body).toContain("réussi et échoué sur le même commit deadbeef");
        expect(body).toContain("Exécution `run_1`");
    });
});
