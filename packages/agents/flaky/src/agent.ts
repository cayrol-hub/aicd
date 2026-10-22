import {
    COLLECTIONS,
    type AgentResult,
    type AgentRuntime,
    type IssueDraft,
    type ProposedAction,
    type QuarantineRecord,
    type StateStore,
    type TestStatus
} from "@aicd-ci/plugin-sdk";
import {COMMENT_MARKER, describeScore, renderFlakyComment, renderIssue} from "./render.js";
import {scoreTests, type TestScore} from "./score.js";

export const AGENT_NAME = "flaky";

/** Own bookkeeping: the last score of every test that is or was flaky. */
export const FLAKY_COLLECTION = "flaky_tests";

export interface FlakyOptions {
    /** Last outcomes looked at per test. Default 30. */
    window: number;
    /** Status changes that make a test flaky without same-commit evidence. Default 2. */
    minFlips: number;
    /** Non-skipped runs needed before a test can be called flaky. Default 3. */
    minRuns: number;
    /** Intermittent failures in the window before a flaky test is quarantined. Default 3. */
    quarantineAfter: number;
    /** Consecutive passes that release a test from quarantine. Default 10. */
    releaseAfter: number;
    /** Propose one issue per newly quarantined test. Default false. */
    createIssues: boolean;
}

export const DEFAULT_FLAKY_OPTIONS: FlakyOptions = {
    window: 30,
    minFlips: 2,
    minRuns: 3,
    quarantineAfter: 3,
    releaseAfter: 10,
    createIssues: false
};

export interface FlakyInput {
    /** Outcomes of this run, already recorded in the state store by the caller. */
    currentRun: {testId: string; status: TestStatus}[];
    options?: Partial<FlakyOptions>;
}

export interface FlakyBookkeeping {
    testId: string;
    score: number;
    flips: number;
    runs: number;
    flaky: boolean;
    confidence: TestScore["confidence"];
    runId: string;
    updatedAt: string;
}

export interface QuarantinedTest extends QuarantineRecord {
    /** Passes since the last failure, when the test was scored in this run. */
    consecutivePasses?: number;
}

export interface FlakyReport {
    /** Tests scored in this run (the current run's tests plus the quarantined ones). */
    scored: number;
    /** Every scored test that is flaky now. */
    flaky: TestScore[];
    /** Flaky now, not flaky (or unknown) at the previous run. */
    newlyFlaky: TestScore[];
    /** Proposed for quarantine in this run. */
    toQuarantine: {testId: string; reason: string; score: TestScore}[];
    /** Already in quarantine before this run. */
    quarantined: QuarantinedTest[];
    /** Quarantined tests that passed `releaseAfter` times in a row. */
    toRelease: {testId: string; consecutivePasses: number}[];
    /** Failing tests of this run, split by quarantine. */
    failing: {quarantined: string[]; notQuarantined: string[]};
}

/** Reads the quarantine collection, oldest quarantine first, then by test id. */
export async function listQuarantine(state: StateStore): Promise<QuarantineRecord[]> {
    const records = await state.listRecords<QuarantineRecord>(COLLECTIONS.quarantine);
    return records
        .map((record) => ({...record.value, testId: record.value.testId ?? record.id}))
        .sort((a, b) => a.since.localeCompare(b.since) || a.testId.localeCompare(b.testId));
}

/**
 * CI gate: a pipeline whose failures are all quarantined tests may pass.
 * `allQuarantined` is false when nothing failed, so that a job failing for another reason is not waved through.
 */
export async function checkQuarantine(
    state: StateStore,
    failingTestIds: string[]
): Promise<{allQuarantined: boolean; quarantined: string[]; notQuarantined: string[]}> {
    const ids = [...new Set(failingTestIds)];
    const records = await Promise.all(ids.map((id) => state.getRecord(COLLECTIONS.quarantine, id)));
    const quarantined = ids.filter((_, index) => records[index] !== undefined);
    const notQuarantined = ids.filter((_, index) => records[index] === undefined);
    return {allQuarantined: ids.length > 0 && notQuarantined.length === 0, quarantined, notQuarantined};
}

/**
 * Runs at the end of every pipeline, after the outcomes were recorded. Scores the tests of the run and the
 * quarantined ones, proposes quarantines (flaky and failing intermittently `quarantineAfter` times) and
 * releases (`releaseAfter` passes in a row), and one comment when something changed or quarantined tests failed.
 * Rules only: no LLM call.
 */
export async function runFlakyAgent(runtime: AgentRuntime, input: FlakyInput): Promise<AgentResult<FlakyReport>> {
    const options = {...DEFAULT_FLAKY_OPTIONS, ...input.options};
    const {state, language, runId} = runtime;

    const quarantine = await listQuarantine(state);
    const quarantinedIds = new Set(quarantine.map((record) => record.testId));
    const runIds = input.currentRun.map((outcome) => outcome.testId);
    const scores = await scoreTests(state, [...runIds, ...quarantinedIds], {
        window: options.window,
        minRuns: options.minRuns,
        minFlips: options.minFlips,
        streakWindow: options.releaseAfter
    });
    const scoreOf = new Map(scores.map((score) => [score.testId, score]));

    const previous = await Promise.all(
        scores.map((score) => state.getRecord<FlakyBookkeeping>(FLAKY_COLLECTION, score.testId))
    );
    const newlyFlaky = scores.filter((score, index) => score.flaky && !previous[index]?.value.flaky);

    const toQuarantine = scores
        .filter(
            (score) =>
                !quarantinedIds.has(score.testId) &&
                score.flaky &&
                score.intermittentFailures >= options.quarantineAfter
        )
        .map((score) => ({
            testId: score.testId,
            score,
            reason: `${describeScore(score)}; ${score.intermittentFailures} intermittent failures in the last ${options.window} runs`
        }));

    const quarantined: QuarantinedTest[] = quarantine.map((record) => {
        const score = scoreOf.get(record.testId);
        return {
            ...record,
            ...(score ? {flakyScore: record.flakyScore || score.score, consecutivePasses: score.consecutivePasses} : {})
        };
    });
    const toRelease = quarantined
        .filter((record) => (record.consecutivePasses ?? 0) >= options.releaseAfter)
        .map((record) => ({testId: record.testId, consecutivePasses: record.consecutivePasses ?? 0}));

    const failingIds = [...new Set(input.currentRun.filter((o) => o.status === "failed").map((o) => o.testId))];
    const failing = {
        quarantined: failingIds.filter((id) => quarantinedIds.has(id)),
        notQuarantined: failingIds.filter((id) => !quarantinedIds.has(id))
    };

    const report: FlakyReport = {
        scored: scores.length,
        flaky: scores.filter((score) => score.flaky),
        newlyFlaky,
        toQuarantine,
        quarantined,
        toRelease,
        failing
    };

    // Bookkeeping: only tests that are or were flaky; a missing record means "never flaky".
    const now = runtime.now().toISOString();
    await Promise.all(
        scores.map(async (score, index) => {
            if (!score.flaky && !previous[index]) return;
            const record: FlakyBookkeeping = {
                testId: score.testId,
                score: score.score,
                flips: score.flips,
                runs: score.runs,
                flaky: score.flaky,
                confidence: score.confidence,
                runId,
                updatedAt: now
            };
            await state.putRecord(FLAKY_COLLECTION, score.testId, record);
        })
    );

    const actions: ProposedAction[] = [];
    for (const entry of toQuarantine) {
        actions.push({
            type: "quarantine_test",
            testIds: [entry.testId],
            reason: entry.reason,
            flakyScore: entry.score.score
        });
    }
    for (const entry of toRelease) {
        actions.push({
            type: "release_quarantine",
            testIds: [entry.testId],
            reason: `${entry.consecutivePasses} consecutive passes (threshold ${options.releaseAfter})`
        });
    }
    if (options.createIssues) {
        for (const entry of toQuarantine) {
            const draft = renderIssue(entry.score, {runId, language, releaseAfter: options.releaseAfter});
            const issue: IssueDraft = {
                title: runtime.redact(draft.title),
                body: runtime.redact(draft.body),
                labels: ["flaky-test"]
            };
            actions.push({type: "create_issue", issue, reason: `flaky test quarantined: ${entry.reason}`});
        }
    }

    const changed = newlyFlaky.length > 0 || toQuarantine.length > 0 || toRelease.length > 0;
    if (changed || failing.quarantined.length > 0) {
        actions.push({
            type: "comment",
            marker: COMMENT_MARKER,
            body: runtime.redact(renderFlakyComment(report, {runId, language, releaseAfter: options.releaseAfter})),
            reason: changed ? "flaky tests changed" : "quarantined tests failed in this run"
        });
    }

    runtime.logger.debug(
        `${AGENT_NAME}: ${scores.length} tests scored, ${report.flaky.length} flaky, ${toQuarantine.length} to quarantine, ${toRelease.length} to release`
    );
    return {agent: AGENT_NAME, actions, report, llmCalls: 0, costUsd: 0};
}
