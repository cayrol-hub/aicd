import {callLlm} from "@aicd/core";
import {
    COLLECTIONS,
    type AgentResult,
    type AgentRuntime,
    type DeploymentRecord,
    type DeploymentRef,
    type ErrorGroup,
    type MetricQuery,
    type MetricsSource,
    type ProposedAction
} from "@aicd/plugin-sdk";
import {buildPrompt, LlmGuardSchema, SYSTEM_PROMPT, verifyGuardOutput} from "./llm.js";
import {COMMENT_MARKER, metricsLines, renderGuardReport, renderMetricsTable, verdictLabel} from "./render.js";
import {classify, compareWindows, windowStats, type Comparison, type WindowStats} from "./stats.js";

export const AGENT_NAME = "release-guardian";

/** Guard results, keyed by deployment id. The deployment itself goes to `COLLECTIONS.deployments`. */
export const GUARD_RESULTS_COLLECTION = "guard_results";

export interface GuardOptions {
    /** Minutes before `startedAt` used as the baseline. */
    baseline_minutes: number;
    /** Minutes after `startedAt` observed. The guard waits until they have elapsed. */
    observe_minutes: number;
    step_seconds: number;
    /** Relative change (0.5 = +50 %) in the bad direction that counts as a degradation. */
    relative_increase: number;
    /** Minimum absolute change, one number for every metric or per metric name (default 0). */
    absolute_min: number | Record<string, number>;
    /** New error groups first seen after the deployment that count as a degradation. */
    new_errors_threshold: number;
    /** A degradation is severe when its relative change reaches `severe_factor × relative_increase`. */
    severe_factor: number;
}

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
    baseline_minutes: 60,
    observe_minutes: 15,
    step_seconds: 60,
    relative_increase: 0.5,
    absolute_min: 0,
    new_errors_threshold: 3,
    severe_factor: 2
};

export interface GuardedMetric {
    /** Key of the source in `sources`. */
    source: string;
    query: MetricQuery;
    /** Overrides `options.absolute_min` for this metric. */
    absolute_min?: number;
}

export interface GuardInput {
    deployment: DeploymentRef;
    metrics: GuardedMetric[];
    sources: Record<string, MetricsSource>;
    /** Source of new error groups: a key of `sources` or a source; it must implement `newErrors`. */
    errorSource?: string | MetricsSource;
    options?: Partial<GuardOptions>;
    /** Commits shipped by the deployment; default: those of its record in the state, if any. */
    commits?: {sha: string; authoredAt: string; subject?: string}[];
    /** Sleeps until the observation window has elapsed. Default: a real timer. Tests inject one. */
    wait?: (ms: number) => Promise<void>;
}

export type Verdict = "continue" | "pause" | "rollback";
export type Health = "healthy" | "degraded" | "no_data" | "partial";

export interface MetricResult {
    name: string;
    source: string;
    bad: MetricQuery["bad"];
    status: "ok" | "degraded" | "severe" | "no_data" | "error";
    absoluteMin: number;
    baseline?: WindowStats;
    observed?: WindowStats;
    /** The comparison that decided (the worst crossing statistic, else the mean). */
    change?: Comparison;
    comparisons?: Comparison[];
    error?: string;
}

export interface NewErrorsResult {
    status: "ok" | "degraded" | "severe" | "error" | "not_configured";
    threshold: number;
    groups: ErrorGroup[];
    error?: string;
}

export interface GuardReport {
    deployment: DeploymentRef;
    verdict: Verdict;
    /** "no_data" and "partial" are never "healthy": the guard says when it could not see. */
    health: Health;
    degradations: number;
    severe: boolean;
    windows: {baseline: {start: string; end: string}; observe: {start: string; end: string}};
    metrics: MetricResult[];
    newErrors: NewErrorsResult;
    /** Deterministic reasons, in English, for the audit log. */
    reasons: string[];
    explanation?: string;
    suspectCommit?: {sha: string; subject?: string; reason: string};
    source: "rules" | "llm";
    evaluatedAt: string;
}

const MINUTE = 60_000;
const realWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function absoluteMinFor(metric: GuardedMetric, options: GuardOptions): number {
    if (metric.absolute_min !== undefined) return metric.absolute_min;
    if (typeof options.absolute_min === "number") return options.absolute_min;
    return options.absolute_min[metric.query.name] ?? 0;
}

async function evaluateMetric(
    metric: GuardedMetric,
    input: GuardInput,
    options: GuardOptions,
    windows: {baseline: {start: Date; end: Date}; observe: {start: Date; end: Date}}
): Promise<MetricResult> {
    const base = {
        name: metric.query.name,
        source: metric.source,
        bad: metric.query.bad,
        absoluteMin: absoluteMinFor(metric, options)
    };
    const source = input.sources[metric.source];
    if (!source) return {...base, status: "error", error: `unknown metrics source "${metric.source}"`};
    try {
        const [before, after] = await Promise.all([
            source.queryRange(metric.query, windows.baseline, options.step_seconds),
            source.queryRange(metric.query, windows.observe, options.step_seconds)
        ]);
        const baseline = windowStats(before);
        const observed = windowStats(after);
        if (!baseline || !observed) {
            return {...base, status: "no_data", ...(baseline ? {baseline} : {}), ...(observed ? {observed} : {})};
        }
        const comparisons = compareWindows(baseline, observed, metric.query.bad);
        const {status, decisive} = classify(comparisons, {
            relative_increase: options.relative_increase,
            absolute_min: base.absoluteMin,
            severe_factor: options.severe_factor
        });
        return {...base, status, baseline, observed, change: decisive, comparisons};
    } catch (error) {
        return {...base, status: "error", error: (error as Error).message.slice(0, 300)};
    }
}

async function evaluateErrors(
    input: GuardInput,
    options: GuardOptions,
    observe: {start: Date; end: Date},
    redact: (text: string) => string
): Promise<NewErrorsResult> {
    const threshold = Math.max(1, options.new_errors_threshold);
    const source = typeof input.errorSource === "string" ? input.sources[input.errorSource] : input.errorSource;
    if (!input.errorSource) return {status: "not_configured", threshold, groups: []};
    if (!source?.newErrors) {
        return {status: "error", threshold, groups: [], error: "the error source does not list new errors"};
    }
    try {
        const groups = (
            await source.newErrors(observe, {
                environment: input.deployment.environment,
                ...(input.deployment.version ? {release: input.deployment.version} : {})
            })
        )
            .filter((group) => {
                const firstSeen = new Date(group.firstSeen);
                return firstSeen >= observe.start && firstSeen <= observe.end;
            })
            .map((group) => ({...group, title: redact(group.title)}));
        const status =
            groups.length >= options.severe_factor * threshold
                ? "severe"
                : groups.length >= threshold
                  ? "degraded"
                  : "ok";
        return {status, threshold, groups};
    } catch (error) {
        return {status: "error", threshold, groups: [], error: (error as Error).message.slice(0, 300)};
    }
}

function healthOf(metrics: MetricResult[], errors: NewErrorsResult, degradations: number): Health {
    if (degradations > 0) return "degraded";
    const seen = metrics.filter((m) => m.status === "ok").length + (errors.status === "ok" ? 1 : 0);
    const blind = metrics.filter((m) => m.status === "no_data" || m.status === "error").length;
    if (seen === 0) return "no_data";
    return blind > 0 || errors.status === "error" ? "partial" : "healthy";
}

const pct = (comparison: Comparison | undefined) =>
    !comparison ? "" : comparison.relative === null ? "from 0" : `${Math.round(comparison.relative * 100)}%`;

/**
 * Watches a deployment: waits for the observation window, compares every metric with the baseline before the
 * deployment, counts new error groups, and decides deterministically: `rollback` (two degradations or one
 * severe), `pause` (one degradation) or `continue`. The LLM, when available, only explains and points at the
 * most suspect commit. Records the deployment and the result; proposes the pause/rollback, a notification and,
 * on a merge request, a comment.
 */
export async function guardDeployment(runtime: AgentRuntime, input: GuardInput): Promise<AgentResult<GuardReport>> {
    const options: GuardOptions = {...DEFAULT_GUARD_OPTIONS, ...input.options};
    const {deployment} = input;
    const started = new Date(deployment.startedAt);
    if (Number.isNaN(started.getTime())) {
        throw new Error(
            `release-guardian: deployment ${deployment.id} has an invalid startedAt "${deployment.startedAt}"`
        );
    }
    const windows = {
        baseline: {start: new Date(started.getTime() - options.baseline_minutes * MINUTE), end: started},
        observe: {start: started, end: new Date(started.getTime() + options.observe_minutes * MINUTE)}
    };

    const remaining = windows.observe.end.getTime() - runtime.now().getTime();
    if (remaining > 0) {
        runtime.logger.info(`${AGENT_NAME}: waiting ${Math.ceil(remaining / 1000)} s for the observation window`);
        await (input.wait ?? realWait)(remaining);
    }

    const metrics = await Promise.all(input.metrics.map((metric) => evaluateMetric(metric, input, options, windows)));
    const newErrors = await evaluateErrors(input, options, windows.observe, runtime.redact);

    const reasons: string[] = [];
    for (const metric of metrics) {
        if (metric.status === "degraded" || metric.status === "severe") {
            reasons.push(`${metric.name} ${metric.status} (${metric.change?.statistic} ${pct(metric.change)})`);
        } else if (metric.status === "no_data") reasons.push(`${metric.name}: no data`);
        else if (metric.status === "error") reasons.push(`${metric.name}: ${metric.error}`);
    }
    if (newErrors.status === "degraded" || newErrors.status === "severe") {
        reasons.push(`${newErrors.groups.length} new error group(s) (threshold ${newErrors.threshold})`);
    } else if (newErrors.status === "error") reasons.push(`new errors: ${newErrors.error}`);

    const flagged = [...metrics.map((m) => m.status), newErrors.status];
    const degradations = flagged.filter((status) => status === "degraded" || status === "severe").length;
    const severe = flagged.includes("severe");
    const verdict: Verdict = severe || degradations >= 2 ? "rollback" : degradations === 1 ? "pause" : "continue";
    const health = healthOf(metrics, newErrors, degradations);
    if (health === "no_data") reasons.push("no data: the deployment could not be judged");

    const record = await runtime.state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, deployment.id);
    const commits = (input.commits ?? record?.value.commits ?? []).map((commit) => ({
        ...commit,
        ...(commit.subject ? {subject: runtime.redact(commit.subject)} : {})
    }));

    const report: GuardReport = {
        deployment,
        verdict,
        health,
        degradations,
        severe,
        windows: {
            baseline: {start: windows.baseline.start.toISOString(), end: windows.baseline.end.toISOString()},
            observe: {start: windows.observe.start.toISOString(), end: windows.observe.end.toISOString()}
        },
        metrics,
        newErrors,
        reasons,
        source: "rules",
        evaluatedAt: runtime.now().toISOString()
    };

    let llmCalls = 0;
    let costUsd = 0;
    if (verdict !== "continue") {
        const metricsText = metricsLines(report).join("\n");
        const errorsText = newErrors.groups
            .slice(0, 20)
            .map((group) => `${group.title} (${group.count} events, first seen ${group.firstSeen})`)
            .join("\n");
        const response = await callLlm(runtime, AGENT_NAME, {
            system: SYSTEM_PROMPT,
            prompt: buildPrompt({
                deployment: [
                    `id: ${deployment.id}`,
                    `environment: ${deployment.environment}`,
                    ...(deployment.service ? [`service: ${deployment.service}`] : []),
                    ...(deployment.version ? [`version: ${deployment.version}`] : []),
                    `verdict: ${verdict}`
                ].join("\n"),
                metrics: metricsText,
                errors: errorsText,
                commits: commits
                    .slice(-50)
                    .map((commit) => `${commit.sha} ${commit.subject ?? ""}`.trim())
                    .join("\n"),
                language: runtime.language
            }),
            schema: LlmGuardSchema
        });
        if (response) {
            llmCalls++;
            costUsd += response.usage.costUsd;
            const verified = verifyGuardOutput(response.output, {metrics: metricsText, errors: errorsText, commits});
            if (verified.explanation) report.explanation = verified.explanation;
            if (verified.suspect) report.suspectCommit = verified.suspect;
            if (verified.explanation || verified.suspect) report.source = "llm";
            if (verified.rejected > 0) {
                runtime.logger.warn(`${AGENT_NAME}: ${verified.rejected} unverifiable LLM claim(s) dropped`);
            }
        }
    }

    await runtime.state.putRecord<DeploymentRecord>(COLLECTIONS.deployments, deployment.id, {
        ...(record?.value ?? {status: "in_progress", source: AGENT_NAME}),
        ...deployment
    });
    await runtime.state.putRecord<GuardReport & {runId: string}>(GUARD_RESULTS_COLLECTION, deployment.id, {
        ...report,
        runId: runtime.runId
    });

    return {agent: AGENT_NAME, actions: proposeActions(runtime, report), report, llmCalls, costUsd};
}

function proposeActions(runtime: AgentRuntime, report: GuardReport): ProposedAction[] {
    const {deployment, verdict} = report;
    const language = runtime.language;
    const why = report.reasons.filter((reason) => / (degraded|severe) \(|new error group/.test(reason)).join("; ");
    const actions: ProposedAction[] = [];
    if (verdict === "rollback") {
        actions.push({type: "rollback_deployment", deployment, reason: `release guardian: ${why}`});
    } else if (verdict === "pause") {
        actions.push({type: "pause_deployment", deployment, reason: `release guardian: ${why}`});
    }
    if (verdict !== "continue") {
        actions.push({
            type: "notify",
            reason: `deployment ${deployment.id} degraded`,
            notification: {
                title: `${deployment.service ?? deployment.id} (${deployment.environment}): ${verdictLabel(verdict, language)}`,
                text: renderMetricsTable(report, language),
                severity: verdict === "rollback" ? "critical" : "warning",
                ...(deployment.url ? {url: deployment.url} : {}),
                fields: {
                    environment: deployment.environment,
                    ...(deployment.version ? {version: deployment.version} : {}),
                    ...(report.suspectCommit ? {suspect: report.suspectCommit.sha.slice(0, 12)} : {})
                }
            }
        });
    }
    // On a merge request, comment when there is something to say: a degradation or a blind spot.
    if (runtime.context.mergeRequest && (verdict !== "continue" || report.health !== "healthy")) {
        actions.push({
            type: "comment",
            marker: COMMENT_MARKER,
            body: renderGuardReport(report, {language, runId: runtime.runId}),
            reason: `release guardian verdict for deployment ${deployment.id}`
        });
    }
    return actions;
}
