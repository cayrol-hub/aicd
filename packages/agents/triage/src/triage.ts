import {extractExcerpt, type TestCaseResult} from "@aicd-ci/parsers";
import {
    CONFIDENCE_LEVELS,
    LLMError,
    type Budget,
    type Confidence,
    type FailedJob,
    type Finding,
    type LLMProvider,
    type Logger,
    type PipelineContext,
    type ProposedAction,
    type StateStore
} from "@aicd-ci/plugin-sdk";
import {fingerprint} from "./fingerprint.js";
import {flakiness, looksLikeTestFailure, matchRules, RULES, type Flakiness, type Rule} from "./heuristics.js";
import {buildPrompt, LlmDiagnosisSchema, SYSTEM_PROMPT, verifyEvidence} from "./llm.js";

export const AGENT_NAME = "triage";

export interface TriageOptions {
    useLlm: boolean;
    /** none: no code is sent; diff_only / full: the merge request diff is sent. */
    sendCode: "none" | "diff_only" | "full";
    language: "en" | "fr";
    retryFlaky: boolean;
    flakyWindow: number;
    flakyMinFlips: number;
    /** Characters of diff sent at most. */
    maxDiffChars?: number;
    /**
     * Skip known fingerprints, rules and history so every job goes to the LLM. Only for evaluating
     * models (`aicd replay --llm-only`); production runs keep the rules first.
     */
    llmOnly?: boolean;
}

export interface TriageInput {
    runId: string;
    context: PipelineContext;
    jobs: FailedJob[];
    tests: TestCaseResult[];
    diff?: string;
    state: StateStore;
    llm?: LLMProvider;
    budget: Budget;
    logger: Logger;
    /** Applied to every piece of CI data before it is analysed or sent anywhere. */
    redact: (text: string) => string;
    options: TriageOptions;
    /** Called for each LLM call, for the audit log. */
    onLlmCall?: (event: {
        jobId: string;
        model: string;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        accepted: boolean;
        rejectedEvidence: number;
    }) => void;
    now?: () => Date;
}

/**
 * Whether the LLM analysed the job, and why not: the failure was already explained (not_needed), no provider is
 * configured, the code comes from a fork, the budget is spent, its diagnosis had no verifiable quote (rejected), or
 * the call failed.
 */
export type LlmStatus = "used" | "not_needed" | "not_configured" | "fork" | "budget" | "rejected" | "failed";

/** A failing test as the comment shows it: where it is and what its assertion said. */
export interface FailingTest {
    id: string;
    name: string;
    /** File relative to the repository, with the line of the failure when the report gives it. */
    location?: string;
    /** First line of the failure message, verbatim from the report. */
    message?: string;
}

/** The steps the diagnosis went through, in order. Steps after the deciding one are absent. */
export interface TriageTrail {
    /** Times this failure (same fingerprint) was diagnosed before; 0 when it is new. */
    knownHits: number;
    /** Rule that matched; null when the rules were checked without a match. */
    rule?: Rule["id"] | null;
    /** Test history of each failing test, when it was checked. */
    history?: ({testId: string} & Flakiness)[];
    llm: LlmStatus;
}

/** A finding with what the comment needs to give the full picture. */
export interface TriageFinding extends Finding {
    jobUrl?: string;
    tests: FailingTest[];
    trail: TriageTrail;
    /** Rule-specific advice, in the report language. */
    hint?: string;
}

export interface TriageReport {
    findings: TriageFinding[];
    llmCalls: number;
    costUsd: number;
}

const TEXT = {
    en: {
        flaky: (n: number) => `${n} test(s) known to be flaky failed.`,
        regression: (n: number) => `${n > 0 ? `${n} test(s)` : "Tests"} failed and none is known to be flaky.`,
        unknown: "No known pattern matches this failure."
    },
    fr: {
        flaky: (n: number) => `${n} test(s) connu(s) comme instable(s) en échec.`,
        regression: (n: number) =>
            `${n > 0 ? `${n} test(s) en échec` : "Des tests échouent"}, aucun n'est connu comme instable.`,
        unknown: "Aucun motif connu ne correspond à cet échec."
    }
};

const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

const atLeast = (a: Confidence, b: Confidence) => CONFIDENCE_LEVELS.indexOf(a) >= CONFIDENCE_LEVELS.indexOf(b);

/** Failing tests that belong to a job: matched by job name in the test file or classname, else all of them. */
function testsForJob(job: FailedJob, failing: TestCaseResult[], jobCount: number): TestCaseResult[] {
    if (jobCount <= 1) return failing;
    return failing.filter((test) => job.log.includes(test.name));
}

function actionsFor(
    finding: Omit<Finding, "actions">,
    jobId: string | undefined,
    retryFlaky: boolean
): ProposedAction[] {
    const retryable = finding.category === "flaky_test" || finding.category === "infrastructure";
    if (!retryFlaky || !retryable || !jobId || !atLeast(finding.confidence, "medium")) return [];
    const why = finding.category === "flaky_test" ? "flaky tests" : "an infrastructure problem";
    return [
        {
            type: "retry_job",
            jobId,
            reason: `${finding.jobName ? `\`${finding.jobName}\`` : "the job"} failed because of ${why}: a retry is likely to pass`
        }
    ];
}

const firstLine = (text: string | undefined) =>
    text
        ?.split("\n")
        .map((line) => line.trim())
        .find(Boolean);

/** Where a test failed: its file, with the line from the stack trace when the report has one. */
function locate(test: TestCaseResult): string | undefined {
    if (!test.file) return undefined;
    const escaped = test.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(`${escaped}:(\\d+)`).exec(test.details ?? "")?.[1];
    return line ? `${test.file}:${line}` : test.file;
}

function describeTest(test: TestCaseResult, redact: (text: string) => string): FailingTest {
    const location = locate(test);
    const message = firstLine(test.message) ?? firstLine(test.details);
    return {
        id: test.id,
        name: test.name,
        ...(location ? {location: redact(location)} : {}),
        ...(message ? {message: redact(message)} : {})
    };
}

/**
 * Diagnoses each failed job. Order: known fingerprint (no LLM) → rules (infrastructure,
 * dependency, configuration) → test history (flaky) → LLM, only if still unexplained and the
 * budget allows → deterministic fallback.
 */
export async function runTriage(input: TriageInput): Promise<TriageReport> {
    const {state, logger, options, budget, context} = input;
    const text = TEXT[options.language];
    const now = input.now ?? (() => new Date());
    const failing = input.tests.filter((test) => test.status === "failed");

    // History first, so this run's outcomes count for the next one.
    await state.recordTestOutcomes(
        input.tests.map((test) => ({
            testId: test.id,
            status: test.status,
            runId: input.runId,
            ...(context.branch ? {branch: context.branch} : {}),
            ...(context.commitSha ? {commitSha: context.commitSha} : {}),
            at: now().toISOString()
        }))
    );

    const jobs: FailedJob[] =
        input.jobs.length > 0
            ? input.jobs
            : failing.length > 0
              ? [
                    {
                        id: "tests",
                        name: "tests",
                        log: failing
                            .map((test) => `FAIL ${test.id}\n${test.message ?? ""}\n${test.details ?? ""}`)
                            .join("\n")
                    }
                ]
              : [];

    const diff =
        options.sendCode === "none" || !input.diff
            ? undefined
            : input
                  .redact(input.diff)
                  .slice(0, options.maxDiffChars ?? (options.sendCode === "full" ? 200_000 : 60_000));

    const findings: TriageFinding[] = [];
    let llmCalls = 0;
    let costUsd = 0;

    for (const job of jobs) {
        const excerpt = extractExcerpt(input.redact(job.log));
        const jobTests = testsForJob(job, failing, jobs.length);
        const testIds = jobTests.map((test) => test.id);
        const fp = fingerprint(excerpt.errorLines, testIds);
        const tests = jobTests.map((test) => describeTest(test, input.redact));
        const base = {
            agent: AGENT_NAME,
            jobId: job.id,
            jobName: job.name,
            ...(job.url ? {jobUrl: job.url} : {}),
            fingerprint: fp,
            failingTests: testIds,
            tests
        };
        const trail: TriageTrail = {knownHits: 0, llm: "not_needed"};

        const finish = async (finding: Omit<TriageFinding, "actions" | "trail">) => {
            const complete: TriageFinding = {
                ...finding,
                trail: {...trail},
                actions: actionsFor(finding, input.jobs.length > 0 ? job.id : undefined, options.retryFlaky)
            };
            findings.push(complete);
            // Only confident diagnoses are reused; a reuse bumps the hit counter.
            if (complete.category !== "unknown" && atLeast(complete.confidence, "medium")) {
                await state.saveDiagnosis({
                    fingerprint: fp,
                    category: complete.category,
                    summary: complete.summary,
                    ...(complete.cause ? {cause: complete.cause} : {}),
                    confidence: complete.confidence
                });
            }
        };

        // 1. Known failure.
        const known = options.llmOnly ? undefined : await state.getDiagnosis(fp);
        if (known) {
            trail.knownHits = known.hits;
            logger.debug(`job ${job.name}: known fingerprint ${fp} (${known.hits} hits)`);
            await finish({
                ...base,
                category: known.category,
                summary: known.summary,
                ...(known.cause ? {cause: known.cause} : {}),
                confidence: known.confidence,
                evidence: [{kind: "history", ref: `fingerprint ${fp}`, quote: `seen ${known.hits + 1} times`}],
                source: "cache"
            });
            continue;
        }

        // 2. Rules that explain a failure on their own.
        const rule = options.llmOnly ? undefined : matchRules(excerpt.errorLines, excerpt.text, options.language);
        if (!options.llmOnly) trail.rule = rule?.rule ?? null;
        if (rule) {
            const {rule: id, ...diagnosis} = rule;
            const hint = RULES_BY_ID.get(id)?.hint?.[options.language];
            await finish({
                ...base,
                ...diagnosis,
                ...(hint ? {hint} : {}),
                evidence: diagnosis.evidence.map((e) => ({...e, ref: `log`})),
                source: "heuristic"
            });
            continue;
        }

        // 3. Flaky tests: every failing test of the job flips in its history.
        if (jobTests.length > 0 && !options.llmOnly) {
            const verdicts = await Promise.all(
                jobTests.map(async (test) => ({
                    test,
                    ...flakiness(await state.getTestHistory(test.id, options.flakyWindow), options.flakyMinFlips)
                }))
            );
            trail.history = verdicts.map(({test, ...verdict}) => ({testId: test.id, ...verdict}));
            if (verdicts.every((verdict) => verdict.flaky)) {
                const confidence = verdicts.every((verdict) => verdict.confidence === "high") ? "high" : "medium";
                await finish({
                    ...base,
                    category: "flaky_test",
                    summary: text.flaky(jobTests.length),
                    confidence,
                    evidence: verdicts.map((verdict) => ({
                        kind: "history",
                        ref: verdict.test.id,
                        quote: verdict.detail
                    })),
                    source: "heuristic"
                });
                continue;
            }
        }

        // 4. LLM analysis, verified.
        trail.llm = !options.useLlm || !input.llm ? "not_configured" : context.isFork ? "fork" : "budget";
        if (options.useLlm && input.llm && !context.isFork) {
            if (!budget.canSpend()) {
                logger.warn(
                    `LLM budget reached (${budget.spentUsd.toFixed(4)} / ${budget.limitUsd} USD): job ${job.name} analysed by rules only`
                );
            } else {
                try {
                    const history = await Promise.all(
                        jobTests.map(async (test) => {
                            const runs = await state.getTestHistory(test.id, options.flakyWindow);
                            return `${test.id}: ${runs.map((run) => (run.status === "passed" ? "P" : run.status === "failed" ? "F" : "S")).join("") || "no history"}`;
                        })
                    );
                    const response = await input.llm.generateStructured({
                        system: SYSTEM_PROMPT,
                        prompt: buildPrompt({
                            jobName: job.name,
                            excerpt: excerpt.text,
                            failingTests: jobTests.map(
                                (test) => `${test.id}${test.message ? ` — ${input.redact(test.message)}` : ""}`
                            ),
                            history,
                            ...(diff ? {diff} : {}),
                            language: options.language
                        }),
                        schema: LlmDiagnosisSchema
                    });
                    llmCalls++;
                    costUsd += response.usage.costUsd;
                    budget.record(response.usage);
                    const verified = verifyEvidence(response.output, {excerpt: excerpt.text, ...(diff ? {diff} : {})});
                    const accepted = verified.evidence.length > 0;
                    input.onLlmCall?.({
                        jobId: job.id,
                        model: response.usage.model,
                        costUsd: response.usage.costUsd,
                        inputTokens: response.usage.inputTokens,
                        outputTokens: response.usage.outputTokens,
                        accepted,
                        rejectedEvidence: verified.rejected
                    });
                    trail.llm = accepted ? "used" : "rejected";
                    if (accepted) {
                        const output = response.output;
                        await finish({
                            ...base,
                            category: output.category,
                            summary: output.summary,
                            cause: output.cause,
                            ...(output.suggested_fix ? {suggestedFix: output.suggested_fix} : {}),
                            confidence: output.confidence,
                            evidence: verified.evidence,
                            source: "llm"
                        });
                        continue;
                    }
                    logger.warn(`job ${job.name}: LLM diagnosis rejected (no verifiable evidence)`);
                } catch (error) {
                    trail.llm = "failed";
                    if (error instanceof LLMError && error.usage) {
                        llmCalls++;
                        costUsd += error.usage.costUsd;
                        budget.record(error.usage);
                    }
                    logger.warn(
                        `job ${job.name}: LLM analysis failed, falling back to rules: ${(error as Error).message}`
                    );
                }
            }
        }

        // 5. Deterministic fallback. The assertion messages of the failing tests say more than the log's first error.
        const firstError = excerpt.errorLines[0];
        const testEvidence = tests
            .filter((test) => test.message)
            .slice(0, 5)
            .map((test) => ({kind: "test" as const, ref: test.id, quote: test.message as string}));
        const evidence =
            testEvidence.length > 0
                ? testEvidence
                : firstError
                  ? [{kind: "log" as const, ref: "log", quote: firstError.trim()}]
                  : [];
        if (jobTests.length > 0 || looksLikeTestFailure(excerpt.text)) {
            await finish({
                ...base,
                category: "regression",
                summary: text.regression(jobTests.length),
                confidence: "low",
                evidence,
                source: "heuristic"
            });
        } else {
            await finish({
                ...base,
                category: "unknown",
                summary: text.unknown,
                confidence: "low",
                evidence,
                source: "heuristic"
            });
        }
    }

    return {findings, llmCalls, costUsd};
}
