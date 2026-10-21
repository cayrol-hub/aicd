import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {runTriage, type TriageOptions} from "@aicd-ci/agent-triage";
import {RunBudget} from "@aicd-ci/core";
import {parseJUnit} from "@aicd-ci/parsers";
import type {Confidence, FailureCategory, LLMProvider, Logger, TestOutcome} from "@aicd-ci/plugin-sdk";

/**
 * A replay case is a directory:
 *   job.log        log of the failed job (required)
 *   junit.xml      JUnit report (optional)
 *   diff.patch     merge request diff (optional)
 *   history.json   past TestOutcome[] of the tests (optional)
 *   expected.json  {"category": "...", "note": "..."} — the human label (required)
 */
export interface ReplayCase {
    name: string;
    log: string;
    junit?: string;
    diff?: string;
    history: TestOutcome[];
    expected: {category: FailureCategory; note?: string};
}

export interface CaseResult {
    name: string;
    expected: FailureCategory;
    actual: FailureCategory;
    confidence: Confidence;
    source: string;
    correct: boolean;
    costUsd: number;
}

export interface ReplayReport {
    cases: CaseResult[];
    accuracy: number;
    correct: number;
    total: number;
    llmCalls: number;
    costUsd: number;
}

export function loadCases(directory: string): ReplayCase[] {
    if (!existsSync(directory)) throw new Error(`fixtures directory not found: ${directory}`);
    return readdirSync(directory)
        .filter((entry) => statSync(join(directory, entry)).isDirectory())
        .sort()
        .map((name) => {
            const dir = join(directory, name);
            const read = (file: string) =>
                existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : undefined;
            const log = read("job.log");
            const expected = read("expected.json");
            if (log === undefined || expected === undefined)
                throw new Error(`${dir}: job.log and expected.json are required`);
            const junit = read("junit.xml");
            const diff = read("diff.patch");
            return {
                name,
                log,
                ...(junit ? {junit} : {}),
                ...(diff ? {diff} : {}),
                history: JSON.parse(read("history.json") ?? "[]") as TestOutcome[],
                expected: JSON.parse(expected) as ReplayCase["expected"]
            };
        });
}

export interface ReplayOptions {
    llm?: LLMProvider;
    budgetUsd: number;
    triage: TriageOptions;
    logger: Logger;
    redact: (text: string) => string;
}

/**
 * Shadow mode: runs the triage agent on labelled past failures, publishes nothing, and
 * scores it. Each case gets a fresh in-memory state seeded with its own history.
 */
export async function replayCases(cases: ReplayCase[], options: ReplayOptions): Promise<ReplayReport> {
    const budget = new RunBudget(options.budgetUsd);
    const results: CaseResult[] = [];
    let llmCalls = 0;

    for (const testCase of cases) {
        const state = new SqliteStateStore(":memory:");
        try {
            await state.recordTestOutcomes([...testCase.history].reverse());
            const report = await runTriage({
                runId: `replay_${testCase.name}`,
                context: {provider: "replay", repository: "replay", commitSha: "replay", isFork: false},
                jobs: [{id: testCase.name, name: testCase.name, log: testCase.log}],
                tests: testCase.junit ? parseJUnit(testCase.junit) : [],
                ...(testCase.diff ? {diff: testCase.diff} : {}),
                state,
                ...(options.llm ? {llm: options.llm} : {}),
                budget,
                logger: options.logger,
                redact: options.redact,
                options: options.triage
            });
            llmCalls += report.llmCalls;
            const finding = report.findings[0];
            const actual = finding?.category ?? "unknown";
            results.push({
                name: testCase.name,
                expected: testCase.expected.category,
                actual,
                confidence: finding?.confidence ?? "low",
                source: finding?.source ?? "none",
                correct: actual === testCase.expected.category,
                costUsd: report.costUsd
            });
        } finally {
            await state.close();
        }
    }

    const correct = results.filter((result) => result.correct).length;
    return {
        cases: results,
        correct,
        total: results.length,
        accuracy: results.length === 0 ? 0 : correct / results.length,
        llmCalls,
        costUsd: budget.spentUsd
    };
}

export function formatReport(report: ReplayReport): string {
    const rows = report.cases.map(
        (result) =>
            `${result.correct ? "ok  " : "MISS"}  ${result.name.padEnd(32)} expected ${result.expected.padEnd(15)} got ${result.actual.padEnd(15)} ${result.confidence.padEnd(6)} ${result.source}`
    );
    const pct = (report.accuracy * 100).toFixed(1);
    return [
        ...rows,
        "",
        `accuracy ${pct}% (${report.correct}/${report.total}) · ${report.llmCalls} LLM call(s) · ${report.costUsd.toFixed(4)} USD`
    ].join("\n");
}
