import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    buildCoverageMap,
    COMMENT_MARKER,
    missedRegressions,
    recordSelection,
    runTestSelection,
    saveCoverageMap,
    testIdMatches
} from "@aicd-ci/agent-test-selection";
import {RunBudget} from "@aicd-ci/core";
import {COLLECTIONS, type AgentRuntime, type PipelineContext, type TestSelectionRecord} from "@aicd-ci/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const NOW = new Date("2026-10-21T12:00:00Z");

function write(root: string, path: string, content = "x\n") {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), content);
}

function gitIn(root: string, ...args: string[]): string {
    return execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();
}

function runtime(overrides: Partial<AgentRuntime> & {context?: Partial<PipelineContext>} = {}): AgentRuntime {
    const {context, ...rest} = overrides;
    return {
        runId: "run_sel",
        context: {
            provider: "test",
            repository: "acme/app",
            branch: "feature/x",
            defaultBranch: "main",
            isFork: false,
            ...context
        },
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text.replace(/s3cr3t/g, "[REDACTED]"),
        language: "en",
        sendCode: "diff_only",
        now: () => NOW,
        ...rest
    };
}

describe("runTestSelection", () => {
    let root: string;
    let base: string;
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "aicd-ts-agent-"));
        gitIn(root, "init", "-q");
        gitIn(root, "config", "user.email", "test@example.com");
        gitIn(root, "config", "user.name", "Test");
        gitIn(root, "config", "commit.gpgsign", "false");
        for (const path of ["src/calc.ts", "src/calc.test.ts", "src/format.ts", "src/format.test.ts", "README.md"]) {
            write(root, path);
        }
        gitIn(root, "add", ".");
        gitIn(root, "commit", "-q", "-m", "init");
        base = gitIn(root, "rev-parse", "HEAD");
        write(root, "src/calc.ts", "changed\n");
        gitIn(root, "commit", "-q", "-am", "change calc");
    });
    afterAll(() => rmSync(root, {recursive: true, force: true}));

    async function withMap(rt: AgentRuntime) {
        const map = await buildCoverageMap({
            tests: ["src/calc.test.ts", "src/format.test.ts"],
            cwd: root,
            coChanges: false,
            now: () => NOW
        });
        await saveCoverageMap(rt.state, map, "abc");
        return rt;
    }

    it("selects from the stored map, records the selection and proposes one comment", async () => {
        const rt = await withMap(runtime());
        const result = await runTestSelection(rt, {cwd: root, changedFiles: ["src/calc.ts", "README.md"]});
        expect(result.agent).toBe("test-selection");
        expect(result.report).toMatchObject({
            full: false,
            selected: ["src/calc.test.ts"],
            skipped: ["src/format.test.ts"]
        });
        expect(result.actions).toHaveLength(1);
        const action = result.actions[0];
        expect(action).toMatchObject({type: "comment", marker: COMMENT_MARKER});
        expect(action?.type === "comment" && action.body.startsWith(COMMENT_MARKER)).toBe(true);
        const stored = await rt.state.getRecord<TestSelectionRecord>(COLLECTIONS.testSelections, "run_sel");
        expect(stored?.value).toMatchObject({
            runId: "run_sel",
            full: false,
            selected: ["src/calc.test.ts"],
            skipped: ["src/format.test.ts"],
            at: NOW.toISOString()
        });
        expect(result.llmCalls).toBe(0);
    });

    it("computes the changed files from the merge request base when none are given", async () => {
        const rt = await withMap(runtime({context: {baseSha: base}}));
        const result = await runTestSelection(rt, {cwd: root});
        expect(result.report.selected).toEqual(["src/calc.test.ts"]);
    });

    it("never selects a changed test that no longer exists", async () => {
        const rt = await withMap(runtime());
        const result = await runTestSelection(rt, {cwd: root, changedFiles: ["src/removed.test.ts", "src/format.ts"]});
        expect(result.report.selected).toEqual(["src/format.test.ts"]);
        expect(result.report.decisions).toContainEqual({kind: "deleted_test", test: "src/removed.test.ts"});
    });

    it("runs the full suite without a map, on the default branch and when forced — and stays silent", async () => {
        const noMap = await runTestSelection(runtime(), {cwd: root, changedFiles: ["src/calc.ts"]});
        expect(noMap.report.full).toBe(true);
        expect(noMap.report.decisions).toEqual([{kind: "no_map"}]);
        expect(noMap.actions).toEqual([]);

        const onMain = await runTestSelection(await withMap(runtime({context: {branch: "main"}})), {
            cwd: root,
            changedFiles: ["src/calc.ts"]
        });
        expect(onMain.report.decisions).toEqual([{kind: "default_branch", branch: "main"}]);

        const forced = await runTestSelection(await withMap(runtime()), {
            cwd: root,
            changedFiles: ["src/calc.ts"],
            options: {forceFull: true}
        });
        expect(forced.report.full).toBe(true);
        expect(forced.report.reasons).toEqual(["Full suite: forced (high-risk change)"]);
    });

    it("runs the full suite when the stored map is too old", async () => {
        const rt = await withMap(runtime({now: () => new Date("2026-11-30T00:00:00Z")}));
        const result = await runTestSelection(rt, {cwd: root, changedFiles: ["src/calc.ts"]});
        expect(result.report.decisions[0]).toMatchObject({kind: "stale_map", max: 14});
    });

    it("discovers tests itself, comments in French, redacts, and skips the comment on forks or when disabled", async () => {
        const rt = await withMap(runtime({language: "fr"}));
        const result = await runTestSelection(rt, {
            cwd: root,
            changedFiles: ["src/calc.ts", "src/s3cr3t.ts"],
            options: {unmappedSource: "ignore"}
        });
        const action = result.actions[0];
        expect(action?.type === "comment" ? action.body : "").toContain("### aicd · Sélection des tests");
        expect(action?.type === "comment" ? action.body : "").toContain("[REDACTED]");
        expect(action?.type === "comment" ? action.body : "").not.toContain("s3cr3t");

        const fork = await runTestSelection(await withMap(runtime({context: {isFork: true}})), {
            cwd: root,
            changedFiles: ["src/calc.ts"]
        });
        expect(fork.report.full).toBe(false);
        expect(fork.actions).toEqual([]);

        const quiet = await runTestSelection(await withMap(runtime()), {
            cwd: root,
            changedFiles: ["src/calc.ts"],
            options: {comment: false}
        });
        expect(quiet.actions).toEqual([]);
    });

    it("falls back to the full suite when the state store fails", async () => {
        const rt = runtime();
        rt.state.listRecords = async () => {
            throw new Error("db down");
        };
        rt.state.putRecord = async () => {
            throw new Error("db down");
        };
        const result = await runTestSelection(rt, {cwd: root, changedFiles: ["src/calc.ts"]});
        expect(result.report.full).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("coverage map unreadable"));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not record"));
    });
});

describe("missedRegressions", () => {
    const record = (runId: string, at: string, full: boolean, skipped: string[]): TestSelectionRecord => ({
        runId,
        commitSha: `sha_${runId}`,
        full,
        selected: [],
        skipped,
        reasons: [],
        at
    });

    it("finds selections that skipped a test which later failed on the default branch", async () => {
        const state = new SqliteStateStore(":memory:");
        await recordSelection(
            state,
            record("r1", "2026-10-10T00:00:00Z", false, ["tests/test_api.py", "src/a.test.ts"])
        );
        await recordSelection(
            state,
            record("r2", "2026-10-15T00:00:00Z", false, ["src/test/java/com/acme/BillingTest.java"])
        );
        await recordSelection(state, record("r3", "2026-10-16T00:00:00Z", true, []));
        await recordSelection(state, record("r0", "2026-09-01T00:00:00Z", false, ["src/a.test.ts"]));
        const missed = await missedRegressions(state, {
            failedOnDefaultBranch: ["tests/test_api.py::test_list", "com.acme.BillingTest#totals", "other.test.ts"],
            since: "2026-10-01T00:00:00Z"
        });
        expect(missed).toEqual([
            {
                runId: "r2",
                commitSha: "sha_r2",
                at: "2026-10-15T00:00:00Z",
                tests: ["src/test/java/com/acme/BillingTest.java"]
            },
            {runId: "r1", commitSha: "sha_r1", at: "2026-10-10T00:00:00Z", tests: ["tests/test_api.py"]}
        ]);
        expect(await missedRegressions(state, {failedOnDefaultBranch: []})).toEqual([]);
        expect(
            (await missedRegressions(state, {failedOnDefaultBranch: ["src/a.test.ts > suite > case"]})).map(
                (m) => m.runId
            )
        ).toEqual(["r1", "r0"]);
    });

    it("matches test ids to test files", () => {
        expect(testIdMatches("src/a.test.ts", "src/a.test.ts")).toBe(true);
        expect(testIdMatches("src/a.test.ts", "./src/a.test.ts")).toBe(true);
        expect(testIdMatches("src/a.test.ts", "src/a.test.tsx")).toBe(false);
        expect(testIdMatches("src/test/kotlin/a/BTest.kt", "a.BTest.method")).toBe(true);
        expect(testIdMatches("src/test/kotlin/a/BTest.kt", "a.BTestOther")).toBe(false);
    });
});
