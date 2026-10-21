import {z} from "zod";
import {callLlm, fixBranchName} from "@aicd/core";
import type {AgentResult, AgentRuntime, FileChange, ProposedAction, ReadonlyCI} from "@aicd/plugin-sdk";
import {analyzePipeline, type AnalyzeOptions, type OptimizerFinding} from "./analyze.js";
import {flavorOf, type ConfigFile} from "./ci-config.js";
import {loadHistory, recordJobRuns, recordPipelines, type JobStats} from "./history.js";
import {buildPrompt, LlmPipelineFixSchema, SYSTEM_PROMPT, verifyFix} from "./llm.js";
import {COMMENT_MARKER, fixBody, issueTitle, renderOptimizerReport} from "./render.js";

export const AGENT_NAME = "pipeline-optimizer";

/** Finding kinds a configuration edit can fix (the others need runners, code or test changes). */
const FIXABLE = new Set(["missing_cache", "serialized_stages", "no_path_filter", "no_auto_cancel", "duplicate_job"]);

/** `agents.pipeline_optimizer` section of `.aicd.yaml`. */
export const PipelineOptimizerOptionsSchema = z
    .object({
        history_limit: z.number().int().positive().default(50),
        min_runs: z.number().int().positive().default(5),
        slow_job_share: z.number().min(0).max(1).default(0.25),
        slow_job_min_minutes: z.number().nonnegative().default(5),
        queue_threshold_seconds: z.number().nonnegative().default(120),
        retry_rate: z.number().min(0).max(1).default(0.1),
        max_llm_findings: z.number().int().nonnegative().default(3),
        fix_proposal: z.boolean().default(true)
    })
    .strict();

export type PipelineOptimizerOptions = z.output<typeof PipelineOptimizerOptionsSchema>;

export interface OptimizerReport {
    findings: OptimizerFinding[];
    /** Pipelines and job runs used as history. */
    pipelines: number;
    jobRuns: number;
    /** Slowest jobs (top 10). */
    stats: JobStats[];
    /** Sum of the estimated savings, when at least one is known. */
    totalEstimatedSavingMinutesPerRun?: number;
    onMergeRequest: boolean;
    /** On a merge request: whether it changes CI configuration. */
    ciConfigTouched?: boolean;
    fix?: {title: string; branch: string; summary: string; files: string[]; addressed: OptimizerFinding[]};
    errors: string[];
}

export interface PipelineOptimizerInput {
    ci: ReadonlyCI;
    /** CI configuration files of the repository (`.gitlab-ci.yml`, `.github/workflows/*.yml`…). */
    configFiles: ConfigFile[];
    options?: Partial<PipelineOptimizerOptions>;
}

/** Paths of a unified diff (`diff --git a/x b/y`, `+++ b/y`). */
export function diffPaths(diff: string): string[] {
    const paths = new Set<string>();
    for (const line of diff.split("\n")) {
        const git = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
        if (git) {
            paths.add(git[1] as string);
            paths.add(git[2] as string);
        }
        const file = /^(?:\+\+\+|---) [ab]\/(\S+)/.exec(line);
        if (file) paths.add(file[1] as string);
    }
    return [...paths];
}

/**
 * Finds what slows the pipeline down. Records this pipeline's finished jobs and the recent
 * pipelines of the CI as history, analyses configuration and history deterministically, then
 * (optionally) asks the LLM for configuration edits that are kept only when they apply, still parse
 * and make a finding disappear. Scheduled run: proposes an issue with the report. Merge request:
 * comments only when it touches CI configuration. Both may propose a fix merge request.
 */
export async function runPipelineOptimizer(
    runtime: AgentRuntime,
    input: PipelineOptimizerInput
): Promise<AgentResult<OptimizerReport>> {
    const options = PipelineOptimizerOptionsSchema.parse(input.options ?? {});
    const {context, logger, state} = runtime;
    const now = runtime.now();
    const errors: string[] = [];

    try {
        await recordJobRuns(
            state,
            await input.ci.listJobs(),
            {
                ...(context.pipelineId ? {pipelineId: context.pipelineId} : {}),
                ...(context.branch ? {branch: context.branch} : {})
            },
            now
        );
    } catch (error) {
        logger.warn(`${AGENT_NAME}: could not list the jobs of this pipeline: ${(error as Error).message}`);
    }
    try {
        const pipelines = await input.ci.listRecentPipelines({
            ...(context.defaultBranch ? {branch: context.defaultBranch} : {}),
            limit: options.history_limit
        });
        await recordPipelines(state, pipelines, now);
    } catch (error) {
        const message = `could not list recent pipelines: ${(error as Error).message}`;
        errors.push(message);
        logger.warn(`${AGENT_NAME}: ${message}`);
    }
    const history = await loadHistory(state, options.history_limit);

    const onMergeRequest = !!context.mergeRequest;
    let ciConfigTouched: boolean | undefined;
    if (onMergeRequest) {
        try {
            const diff = await input.ci.getDiff();
            const known = new Set(input.configFiles.map((file) => file.path));
            ciConfigTouched = diffPaths(diff ?? "").some((path) => known.has(path) || flavorOf(path, "") !== undefined);
        } catch (error) {
            logger.warn(`${AGENT_NAME}: could not read the merge request diff: ${(error as Error).message}`);
            ciConfigTouched = false;
        }
    }

    const analyzeOptions: AnalyzeOptions = {
        min_runs: options.min_runs,
        slow_job_share: options.slow_job_share,
        slow_job_min_minutes: options.slow_job_min_minutes,
        queue_threshold_seconds: options.queue_threshold_seconds,
        retry_rate: options.retry_rate,
        language: runtime.language
    };
    const redactedFiles = input.configFiles.map((file) => ({path: file.path, content: runtime.redact(file.content)}));
    const analysis = analyzePipeline({
        provider: context.provider,
        configFiles: redactedFiles,
        history,
        options: analyzeOptions
    });
    errors.push(...analysis.errors);
    const savings = analysis.findings.flatMap((finding) =>
        finding.estimatedSavingMinutesPerRun !== undefined ? [finding.estimatedSavingMinutesPerRun] : []
    );
    const report: OptimizerReport = {
        findings: analysis.findings,
        pipelines: analysis.pipelines,
        jobRuns: history.length,
        stats: analysis.stats.slice(0, 10),
        ...(savings.length > 0
            ? {totalEstimatedSavingMinutesPerRun: Math.round(savings.reduce((a, b) => a + b, 0) * 10) / 10}
            : {}),
        onMergeRequest,
        ...(ciConfigTouched !== undefined ? {ciConfigTouched} : {}),
        errors
    };

    // Outside merge requests, only scheduled-like runs on the default branch report (not every branch push).
    const relevant = onMergeRequest
        ? ciConfigTouched === true
        : !context.tag && (!context.branch || !context.defaultBranch || context.branch === context.defaultBranch);
    let llmCalls = 0;
    let costUsd = 0;
    let fixChanges: FileChange[] = [];
    const candidates = analysis.findings
        .filter((finding) => FIXABLE.has(finding.kind) && finding.file)
        .slice(0, options.max_llm_findings);
    // CI files reach the LLM only when they are part of the diff (`diff_only`) or with `full`.
    const mayShowFiles = runtime.sendCode === "full" || (runtime.sendCode === "diff_only" && ciConfigTouched === true);
    if (relevant && options.fix_proposal && mayShowFiles && candidates.length > 0) {
        const files = redactedFiles.filter((file) => candidates.some((finding) => finding.file === file.path));
        const response = await callLlm(runtime, AGENT_NAME, {
            system: SYSTEM_PROMPT,
            prompt: buildPrompt({findings: candidates, files, language: runtime.language}),
            schema: LlmPipelineFixSchema
        });
        if (response) {
            llmCalls++;
            costUsd += response.usage.costUsd;
            const verified = await verifyFix(response.output, {
                sent: candidates,
                files: input.configFiles.filter((file) => files.some((sent) => sent.path === file.path)),
                provider: context.provider,
                history,
                options: analyzeOptions,
                redact: runtime.redact
            });
            if (verified.fix) {
                report.fix = {
                    title: "ci: speed up the pipeline",
                    branch: fixBranchName("ci pipeline optimization", runtime.runId),
                    summary: verified.fix.summary,
                    files: verified.fix.changes.map((change) => change.path),
                    addressed: verified.fix.addressed
                };
                fixChanges = verified.fix.changes;
            } else {
                logger.warn(`${AGENT_NAME}: proposed CI edits rejected (${verified.reason ?? "unknown reason"})`);
            }
        }
    }

    const actions: ProposedAction[] = [];
    if (relevant && report.findings.length > 0) {
        const body = renderOptimizerReport(report, {language: runtime.language});
        if (onMergeRequest) {
            actions.push({
                type: "comment",
                marker: COMMENT_MARKER,
                body: `${COMMENT_MARKER}\n${body}`,
                reason: `${report.findings.length} pipeline optimization finding(s) on a merge request that changes CI configuration`
            });
        } else {
            actions.push({
                type: "create_issue",
                issue: {
                    title: issueTitle(report, runtime.language),
                    body,
                    labels: ["aicd", "ci-optimization"]
                },
                reason: `${report.findings.length} pipeline optimization finding(s)`
            });
        }
    }
    if (report.fix && fixChanges.length > 0) {
        actions.push({
            type: "open_fix_mr",
            fix: {
                title: report.fix.title,
                body: fixBody(report.fix, runtime.language),
                branch: report.fix.branch,
                changes: fixChanges
            },
            reason: `CI configuration edits that fix ${report.fix.addressed.length} finding(s)`
        });
    }
    return {agent: AGENT_NAME, actions, report, llmCalls, costUsd};
}
