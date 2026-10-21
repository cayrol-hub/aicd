import type {Evidence, JobRunRecord, Language} from "@aicd/plugin-sdk";
import {lineOf, parseCiConfig, type CiJob, type ConfigFile} from "./ci-config.js";
import {jobStats, percentile, type JobStats} from "./history.js";

export type FindingKind =
    | "slow_job"
    | "long_queue"
    | "missing_cache"
    | "serialized_stages"
    | "no_path_filter"
    | "duplicate_job"
    | "no_auto_cancel"
    | "flaky_retry";

export const FINDING_KINDS: readonly FindingKind[] = [
    "missing_cache",
    "flaky_retry",
    "duplicate_job",
    "long_queue",
    "serialized_stages",
    "slow_job",
    "no_auto_cancel",
    "no_path_filter"
];

export interface OptimizerFinding {
    kind: FindingKind;
    job?: string;
    /** CI configuration file concerned, when there is one. */
    file?: string;
    title: string;
    detail: string;
    evidence: Evidence[];
    /** Estimated from history only; absent when history is too short. */
    estimatedSavingMinutesPerRun?: number;
}

export interface AnalyzeOptions {
    /** Runs a job needs in history before statistics are used. Default 5. */
    min_runs?: number;
    /** Share of the total job time above which a job is "slow". Default 0.25. */
    slow_job_share?: number;
    /** Minimum p50 duration of a slow job, in minutes. Default 5. */
    slow_job_min_minutes?: number;
    /** Median runner wait above which queues are reported, in seconds. Default 120. */
    queue_threshold_seconds?: number;
    /** Share of pipelines where a job failed then passed on retry, above which it is reported. Default 0.1. */
    retry_rate?: number;
    language?: Language;
}

export interface PipelineAnalysis {
    findings: OptimizerFinding[];
    stats: JobStats[];
    /** Pipelines in the history. */
    pipelines: number;
    errors: string[];
}

/** Share of an uncached job's time a dependency cache typically saves. A rough, documented estimate. */
export const CACHE_SAVING_SHARE = 0.25;

const INSTALLERS: [string, RegExp][] = [
    ["npm", /\bnpm\s+(ci|install|i)\b/],
    ["yarn", /\byarn(\s+install\b|\s*$|\s+--)/],
    ["pnpm", /\bpnpm\s+(install|i)\b/],
    ["pip", /\b(pip3?|python3?\s+-m\s+pip)\s+install\b/],
    ["poetry", /\bpoetry\s+install\b/],
    ["bundle", /\bbundle(\s+install\b|\s*$|\s+--)/],
    ["maven", /(^|[\s/])mvnw?(\s|$)/],
    ["gradle", /(^|[\s/])gradlew?(\s|$)/],
    ["go", /\bgo\s+(mod\s+download|build|test|get|install)\b/]
];

const minutes = (seconds: number) => Math.round((seconds / 60) * 10) / 10;

const TEXT = {
    en: {
        slow: (job: string) => `Slow job \`${job}\``,
        slowDetail: (p50: number, p90: number, share: number, runs: number) =>
            `p50 ${p50} min, p90 ${p90} min over ${runs} runs: ${Math.round(share * 100)}% of the total job time. Consider splitting it (parallel, sharding) or caching its inputs.`,
        queue: "Jobs wait for a runner",
        queueDetail: (median: number, jobs: string) =>
            `Median wait for a runner: ${median} min per pipeline (longest wait in each pipeline). Most affected: ${jobs}. Add runners or use autoscaling.`,
        cache: (tools: string) => `Dependencies installed without cache (${tools})`,
        cacheDetail: (job: string, flavor: string) =>
            flavor === "gitlab"
                ? `\`${job}\` installs dependencies on every run and has no \`cache:\`. Add a cache keyed on the lockfile.`
                : `\`${job}\` installs dependencies on every run without \`actions/cache\` or a \`cache:\` input of its setup action.`,
        serialized: "Stages run one after the other",
        serializedDetail: (stages: string[]) =>
            `${stages.length} stages (${stages.join(" → ")}) and no job uses \`needs\`: each stage waits for the whole previous one. Declare \`needs\` to run jobs as a DAG.`,
        pathFilter: "Every change runs the whole pipeline",
        pathFilterDetail: (flavor: string) =>
            flavor === "gitlab"
                ? "No `rules: changes` in the pipeline: a documentation-only change runs every job."
                : "The workflow runs on push / pull_request without `paths` or `paths-ignore`: a documentation-only change runs it.",
        duplicate: (jobs: string) => `Duplicated jobs: ${jobs}`,
        duplicateDetail: "These jobs run the same commands with the same image and variables. Keep one.",
        cancel: "Superseded runs are not cancelled",
        cancelDetail: (flavor: string) =>
            flavor === "gitlab"
                ? "No job is `interruptible`: a new push does not cancel the pipeline of the previous commit."
                : "No `concurrency` with `cancel-in-progress`: a new push does not cancel the run of the previous commit.",
        retry: (job: string) => `\`${job}\` often fails then passes on retry`,
        retryDetail: (count: number, pipelines: number) =>
            `Failed then passed in the same pipeline in ${count} of ${pipelines} pipelines. Fix the flaky step or the infrastructure it depends on.`
    },
    fr: {
        slow: (job: string) => `Job lent \`${job}\``,
        slowDetail: (p50: number, p90: number, share: number, runs: number) =>
            `p50 ${p50} min, p90 ${p90} min sur ${runs} exécutions : ${Math.round(share * 100)} % du temps total des jobs. Envisagez de le découper (parallel, sharding) ou de mettre ses entrées en cache.`,
        queue: "Les jobs attendent un runner",
        queueDetail: (median: number, jobs: string) =>
            `Attente médiane d'un runner : ${median} min par pipeline (plus longue attente de chaque pipeline). Jobs les plus touchés : ${jobs}. Ajoutez des runners ou activez l'autoscaling.`,
        cache: (tools: string) => `Dépendances installées sans cache (${tools})`,
        cacheDetail: (job: string, flavor: string) =>
            flavor === "gitlab"
                ? `\`${job}\` installe les dépendances à chaque exécution et n'a pas de \`cache:\`. Ajoutez un cache indexé sur le lockfile.`
                : `\`${job}\` installe les dépendances à chaque exécution sans \`actions/cache\` ni entrée \`cache:\` dans son action de setup.`,
        serialized: "Les stages s'exécutent l'un après l'autre",
        serializedDetail: (stages: string[]) =>
            `${stages.length} stages (${stages.join(" → ")}) et aucun job n'utilise \`needs\` : chaque stage attend la fin complète du précédent. Déclarez \`needs\` pour exécuter les jobs en DAG.`,
        pathFilter: "Chaque modification lance tout le pipeline",
        pathFilterDetail: (flavor: string) =>
            flavor === "gitlab"
                ? "Aucune règle `rules: changes` dans le pipeline : une modification de documentation seule lance tous les jobs."
                : "Le workflow se lance sur push / pull_request sans `paths` ni `paths-ignore` : une modification de documentation seule le lance.",
        duplicate: (jobs: string) => `Jobs dupliqués : ${jobs}`,
        duplicateDetail:
            "Ces jobs lancent les mêmes commandes avec la même image et les mêmes variables. Gardez-en un seul.",
        cancel: "Les exécutions obsolètes ne sont pas annulées",
        cancelDetail: (flavor: string) =>
            flavor === "gitlab"
                ? "Aucun job n'est `interruptible` : un nouveau push n'annule pas le pipeline du commit précédent."
                : "Pas de `concurrency` avec `cancel-in-progress` : un nouveau push n'annule pas l'exécution du commit précédent.",
        retry: (job: string) => `\`${job}\` échoue souvent puis passe au relancement`,
        retryDetail: (count: number, pipelines: number) =>
            `En échec puis réussi dans le même pipeline dans ${count} pipelines sur ${pipelines}. Corrigez l'étape instable ou l'infrastructure dont elle dépend.`
    }
};

function savingOrder(a: OptimizerFinding, b: OptimizerFinding): number {
    const sa = a.estimatedSavingMinutesPerRun;
    const sb = b.estimatedSavingMinutesPerRun;
    if (sa !== undefined || sb !== undefined) {
        if (sa === undefined) return 1;
        if (sb === undefined) return -1;
        if (sb !== sa) return sb - sa;
    }
    return FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind);
}

/** fail → pass of the same job inside one pipeline (a retry that succeeded). */
function retriedJobs(
    history: JobRunRecord[]
): Map<string, {count: number; pipelines: number; failedSeconds: number[]}> {
    const byPipelineJob = new Map<string, JobRunRecord[]>();
    for (const record of history) {
        const key = `${record.pipelineId}\u0000${record.name}`;
        byPipelineJob.set(key, [...(byPipelineJob.get(key) ?? []), record]);
    }
    const result = new Map<string, {count: number; pipelines: number; failedSeconds: number[]}>();
    for (const [key, runs] of byPipelineJob) {
        const name = key.split("\u0000")[1] as string;
        const entry = result.get(name) ?? {count: 0, pipelines: 0, failedSeconds: []};
        entry.pipelines++;
        const ordered = [...runs].sort(
            (a, b) => a.at.localeCompare(b.at) || Number(a.jobId) - Number(b.jobId) || a.jobId.localeCompare(b.jobId)
        );
        const firstFailure = ordered.findIndex((run) => run.status === "failed");
        if (firstFailure !== -1 && ordered.slice(firstFailure + 1).some((run) => run.status === "success")) {
            entry.count++;
            for (const run of ordered.slice(0, firstFailure + 1)) {
                if (run.status === "failed" && run.durationSeconds !== undefined)
                    entry.failedSeconds.push(run.durationSeconds);
            }
        }
        result.set(name, entry);
    }
    return result;
}

/**
 * Deterministic analysis of CI configuration files and job history. Every finding carries its
 * evidence (configuration lines or history statistics). Savings are estimated only for jobs with at
 * least `min_runs` runs in the history; there is no number otherwise.
 */
export function analyzePipeline(input: {
    provider: string;
    configFiles: ConfigFile[];
    history: JobRunRecord[];
    options?: AnalyzeOptions;
}): PipelineAnalysis {
    const options = input.options ?? {};
    const minRuns = options.min_runs ?? 5;
    const t = TEXT[options.language ?? "en"];
    const config = parseCiConfig(input.provider, input.configFiles);
    const contents = new Map(input.configFiles.map((file) => [file.path, file.content]));
    const stats = jobStats(input.history);
    const statsByName = new Map(stats.map((stat) => [stat.name, stat]));
    const pipelineIds = new Set(input.history.map((record) => record.pipelineId));
    const known = (job: string) => {
        const stat = statsByName.get(job);
        return stat && stat.runs >= minRuns && stat.p50Seconds !== undefined ? stat : undefined;
    };
    const codeEvidence = (file: string, needle: string | undefined, job?: string): Evidence[] => {
        if (!needle) return [{kind: "code", ref: file}];
        const line = lineOf(contents.get(file) ?? "", needle, job);
        return [{kind: "code", ref: line ? `${file}:${line}` : file, quote: needle}];
    };
    const findings: OptimizerFinding[] = [];

    // Slow jobs.
    for (const stat of stats) {
        if (
            stat.runs < minRuns ||
            stat.p50Seconds === undefined ||
            stat.share === undefined ||
            stat.p50Seconds < (options.slow_job_min_minutes ?? 5) * 60 ||
            stat.share < (options.slow_job_share ?? 0.25)
        )
            continue;
        const p50 = minutes(stat.p50Seconds);
        const p90 = minutes(stat.p90Seconds ?? stat.p50Seconds);
        findings.push({
            kind: "slow_job",
            job: stat.name,
            title: t.slow(stat.name),
            detail: t.slowDetail(p50, p90, stat.share, stat.runs),
            evidence: [
                {kind: "history", ref: `job ${stat.name}`, quote: `p50 ${p50} min, p90 ${p90} min, ${stat.runs} runs`}
            ]
        });
    }

    // Long queues: longest runner wait of each pipeline.
    const queueByPipeline = new Map<string, number>();
    for (const record of input.history) {
        if (record.queuedSeconds === undefined) continue;
        queueByPipeline.set(
            record.pipelineId,
            Math.max(queueByPipeline.get(record.pipelineId) ?? 0, record.queuedSeconds)
        );
    }
    const medianQueue = queueByPipeline.size >= minRuns ? percentile([...queueByPipeline.values()], 50) : undefined;
    if (medianQueue !== undefined && medianQueue >= (options.queue_threshold_seconds ?? 120)) {
        const worst = stats
            .filter((stat) => stat.p50QueuedSeconds !== undefined)
            .sort((a, b) => (b.p50QueuedSeconds ?? 0) - (a.p50QueuedSeconds ?? 0))
            .slice(0, 3);
        findings.push({
            kind: "long_queue",
            title: t.queue,
            detail: t.queueDetail(minutes(medianQueue), worst.map((stat) => `\`${stat.name}\``).join(", ")),
            evidence: worst.map((stat) => ({
                kind: "history" as const,
                ref: `job ${stat.name}`,
                quote: `p50 queued ${minutes(stat.p50QueuedSeconds ?? 0)} min`
            })),
            estimatedSavingMinutesPerRun: minutes(medianQueue)
        });
    }

    // Dependencies installed without cache.
    for (const job of config.jobs) {
        if (job.hasCache) continue;
        const matches = INSTALLERS.flatMap(([tool, pattern]) => {
            const line = job.scripts.find((script) => pattern.test(script));
            return line ? [{tool, line}] : [];
        });
        if (matches.length === 0) continue;
        const stat = known(job.name);
        findings.push({
            kind: "missing_cache",
            job: job.name,
            file: job.file,
            title: t.cache(matches.map((match) => match.tool).join(", ")),
            detail: t.cacheDetail(job.name, job.flavor),
            evidence: matches.flatMap((match) => codeEvidence(job.file, match.line, job.name)),
            ...(stat ? {estimatedSavingMinutesPerRun: minutes((stat.p50Seconds ?? 0) * CACHE_SAVING_SHARE)} : {})
        });
    }

    // GitLab: stages serialized without needs.
    const gitlabJobs = config.jobs.filter((job) => job.flavor === "gitlab");
    const declared = config.stages.length > 0 ? config.stages : [".pre", "build", "test", "deploy", ".post"];
    const usedStages = declared.filter((stage) => gitlabJobs.some((job) => job.stage === stage));
    if (usedStages.length >= 3 && !gitlabJobs.some((job) => job.usesNeeds)) {
        const file = config.gitlabFiles[0] as string;
        findings.push({
            kind: "serialized_stages",
            file,
            title: t.serialized,
            detail: t.serializedDetail(usedStages),
            evidence: codeEvidence(file, config.stages.length > 0 ? "stages:" : undefined)
        });
    }

    // No path filters for documentation-only changes.
    if (gitlabJobs.length > 0 && !config.gitlabWorkflowChanges && !gitlabJobs.some((job) => job.hasChangesRule)) {
        const file = config.gitlabFiles[0] as string;
        findings.push({
            kind: "no_path_filter",
            file,
            title: t.pathFilter,
            detail: t.pathFilterDetail("gitlab"),
            evidence: codeEvidence(file, undefined)
        });
    }
    for (const workflow of config.workflows) {
        if (!workflow.onCodeChanges || workflow.hasPathFilter) continue;
        findings.push({
            kind: "no_path_filter",
            file: workflow.file,
            title: t.pathFilter,
            detail: t.pathFilterDetail("github"),
            evidence: codeEvidence(
                workflow.file,
                (contents.get(workflow.file) ?? "").split("\n").find((l) => /^on\s*:/.test(l))
            )
        });
    }

    // Duplicated jobs.
    const groups = new Map<string, CiJob[]>();
    for (const job of config.jobs) {
        if (job.mainScript.length === 0) continue;
        const key = JSON.stringify([job.flavor, job.variant, job.mainScript]);
        groups.set(key, [...(groups.get(key) ?? []), job]);
    }
    for (const jobs of groups.values()) {
        if (jobs.length < 2) continue;
        const extra = jobs.slice(1).map((job) => known(job.name));
        const saving = extra.every(Boolean) ? extra.reduce((sum, stat) => sum + (stat?.p50Seconds ?? 0), 0) : undefined;
        findings.push({
            kind: "duplicate_job",
            job: jobs[1]?.name as string,
            file: jobs[0]?.file as string,
            title: t.duplicate(jobs.map((job) => `\`${job.name}\``).join(", ")),
            detail: t.duplicateDetail,
            evidence: jobs.flatMap((job) => codeEvidence(job.file, `${job.name}:`)),
            ...(saving !== undefined ? {estimatedSavingMinutesPerRun: minutes(saving)} : {})
        });
    }

    // Superseded runs not cancelled.
    if (gitlabJobs.length > 0 && !gitlabJobs.some((job) => job.interruptible)) {
        const file = config.gitlabFiles[0] as string;
        findings.push({
            kind: "no_auto_cancel",
            file,
            title: t.cancel,
            detail: t.cancelDetail("gitlab"),
            evidence: codeEvidence(file, undefined)
        });
    }
    for (const workflow of config.workflows) {
        if (!workflow.onCodeChanges || workflow.cancelsSuperseded) continue;
        findings.push({
            kind: "no_auto_cancel",
            file: workflow.file,
            title: t.cancel,
            detail: t.cancelDetail("github"),
            evidence: codeEvidence(workflow.file, undefined)
        });
    }

    // Jobs that fail then pass on retry.
    for (const [name, entry] of retriedJobs(input.history)) {
        if (entry.pipelines < minRuns || entry.count < 2 || entry.count / entry.pipelines < (options.retry_rate ?? 0.1))
            continue;
        const failed = percentile(entry.failedSeconds, 50);
        findings.push({
            kind: "flaky_retry",
            job: name,
            title: t.retry(name),
            detail: t.retryDetail(entry.count, entry.pipelines),
            evidence: [
                {
                    kind: "history",
                    ref: `job ${name}`,
                    quote: `failed then passed in ${entry.count}/${entry.pipelines} pipelines`
                }
            ],
            ...(failed !== undefined
                ? {estimatedSavingMinutesPerRun: minutes((failed * entry.count) / entry.pipelines)}
                : {})
        });
    }

    return {findings: findings.sort(savingOrder), stats, pipelines: pipelineIds.size, errors: config.errors};
}
