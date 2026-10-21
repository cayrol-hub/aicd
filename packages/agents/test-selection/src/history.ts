import {COLLECTIONS, type StateStore, type TestSelectionRecord} from "@aicd/plugin-sdk";
import {normalizePath} from "./paths.js";

/** Stores a selection (`COLLECTIONS.testSelections`, id = run id). */
export async function recordSelection(state: StateStore, record: TestSelectionRecord): Promise<void> {
    await state.putRecord(COLLECTIONS.testSelections, record.runId, record);
}

export interface MissedRegression {
    runId: string;
    commitSha?: string;
    at: string;
    /** Tests this selection skipped that later failed on the default branch. */
    tests: string[];
}

/** JVM test file → class name (`src/test/java/a/b/FooTest.java` → `a.b.FooTest`). */
function jvmClassName(test: string): string | undefined {
    const match = /(?:^|\/)src\/[^/]+\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(test);
    return match?.[1]?.replace(/\//g, ".");
}

/**
 * True when a failed test id belongs to a skipped test file: same path, `file::name` / `file > name` style ids,
 * or a JVM class name (`a.b.FooTest`, `a.b.FooTest.method`, `a.b.FooTest#method`).
 */
export function testIdMatches(skippedTest: string, failedId: string): boolean {
    const file = normalizePath(skippedTest);
    const id = failedId.trim();
    if (id === file || normalizePath(id) === file) return true;
    if (id.startsWith(file) && [":", "#", " ", ">", "("].includes(id.charAt(file.length))) return true;
    const className = jvmClassName(file);
    if (className && (id === className || [".", "#", ":", "("].some((sep) => id.startsWith(`${className}${sep}`)))) {
        return true;
    }
    return false;
}

/**
 * Selections since `since` (ISO date) that skipped a test which then failed on the default branch: the
 * "regressions missed by selection" gate metric. Full-suite selections never miss anything.
 */
export async function missedRegressions(
    state: StateStore,
    options: {failedOnDefaultBranch: readonly string[]; since?: string}
): Promise<MissedRegression[]> {
    if (options.failedOnDefaultBranch.length === 0) return [];
    const records = await state.listRecords<TestSelectionRecord>(
        COLLECTIONS.testSelections,
        options.since ? {since: options.since} : {}
    );
    const missed: MissedRegression[] = [];
    for (const {value} of records) {
        if (value.full || (options.since && value.at < options.since)) continue;
        const tests = value.skipped.filter((test) =>
            options.failedOnDefaultBranch.some((failed) => testIdMatches(test, failed))
        );
        if (tests.length === 0) continue;
        missed.push({
            runId: value.runId,
            ...(value.commitSha ? {commitSha: value.commitSha} : {}),
            at: value.at,
            tests
        });
    }
    return missed.sort((a, b) => b.at.localeCompare(a.at));
}
