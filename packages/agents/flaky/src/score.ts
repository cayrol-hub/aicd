import type {Confidence, StateStore, TestOutcome} from "@aicd/plugin-sdk";

export interface ScoreOptions {
    /** Last recorded outcomes looked at per test (skipped ones included in the count, ignored in the stats). */
    window: number;
    /** Non-skipped runs needed before a test can be called flaky. Default 3. */
    minRuns?: number;
    /** Status changes needed to call a test flaky without same-commit evidence. Default 2. */
    minFlips?: number;
    /** Outcomes fetched to count the current pass streak, when it must look further back than `window`. */
    streakWindow?: number;
}

export interface TestScore {
    testId: string;
    /** Non-skipped runs in the window. */
    runs: number;
    failures: number;
    /** Status changes between consecutive non-skipped runs. */
    flips: number;
    /** Commits on which the test both passed and failed. */
    sameCommitFlips: number;
    /** Those commits, sorted. */
    sameCommitShas: string[];
    /** Failures followed by a later pass, or on a commit where the test also passed. */
    intermittentFailures: number;
    /** Passes since the last failure, most recent first, skipped runs ignored. */
    consecutivePasses: number;
    /** flips / (runs − 1), 0 to 1. */
    score: number;
    flaky: boolean;
    confidence: Confidence;
    /** Non-skipped statuses, oldest first: P = passed, F = failed. */
    history: string;
}

/** Scores one test from its history (most recent first, as `StateStore.getTestHistory` returns it). */
export function scoreHistory(
    testId: string,
    history: TestOutcome[],
    options: Omit<ScoreOptions, "streakWindow">
): TestScore {
    const minRuns = options.minRuns ?? 3;
    const minFlips = options.minFlips ?? 2;
    const runs = history
        .slice(0, options.window)
        .filter((outcome) => outcome.status !== "skipped")
        .reverse();

    const byCommit = new Map<string, Set<string>>();
    for (const outcome of runs) {
        if (!outcome.commitSha) continue;
        const statuses = byCommit.get(outcome.commitSha) ?? new Set<string>();
        statuses.add(outcome.status);
        byCommit.set(outcome.commitSha, statuses);
    }
    const sameCommitShas = [...byCommit.entries()]
        .filter(([, statuses]) => statuses.size > 1)
        .map(([sha]) => sha)
        .sort();
    const mixedCommits = new Set(sameCommitShas);

    let flips = 0;
    let failures = 0;
    let intermittentFailures = 0;
    const lastPass = runs.map((outcome) => outcome.status).lastIndexOf("passed");
    runs.forEach((outcome, index) => {
        if (index > 0 && outcome.status !== runs[index - 1]?.status) flips++;
        if (outcome.status !== "failed") return;
        failures++;
        // A trailing streak of failures may be a real regression: it only counts with same-commit evidence.
        if (index < lastPass || (outcome.commitSha !== undefined && mixedCommits.has(outcome.commitSha))) {
            intermittentFailures++;
        }
    });

    const sameCommitFlips = sameCommitShas.length;
    const flaky = runs.length >= minRuns && (sameCommitFlips > 0 || flips >= minFlips);
    const confidence: Confidence = sameCommitFlips > 0 ? "high" : flips >= minFlips ? "medium" : "low";
    return {
        testId,
        runs: runs.length,
        failures,
        flips,
        sameCommitFlips,
        sameCommitShas,
        intermittentFailures,
        consecutivePasses: passStreak(history),
        score: runs.length > 1 ? flips / (runs.length - 1) : 0,
        flaky,
        confidence,
        history: runs.map((outcome) => (outcome.status === "passed" ? "P" : "F")).join("")
    };
}

function passStreak(history: TestOutcome[]): number {
    let streak = 0;
    for (const outcome of history) {
        if (outcome.status === "skipped") continue;
        if (outcome.status !== "passed") break;
        streak++;
    }
    return streak;
}

/**
 * Scores each test from its recorded history. Deterministic: same history, same score.
 * Duplicate ids are scored once; the result keeps the order of first appearance.
 */
export async function scoreTests(state: StateStore, testIds: string[], options: ScoreOptions): Promise<TestScore[]> {
    const ids = [...new Set(testIds)];
    const limit = Math.max(options.window, options.streakWindow ?? 0);
    const scores: TestScore[] = [];
    // Bounded concurrency: remote stores answer one query per test.
    for (let start = 0; start < ids.length; start += 20) {
        const batch = ids.slice(start, start + 20);
        const histories = await Promise.all(batch.map((id) => state.getTestHistory(id, limit)));
        batch.forEach((id, index) => scores.push(scoreHistory(id, histories[index] ?? [], options)));
    }
    return scores;
}
