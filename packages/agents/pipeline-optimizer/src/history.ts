import {COLLECTIONS, type JobInfo, type JobRunRecord, type PipelineSummary, type StateStore} from "@aicd/plugin-sdk";

const FINISHED = new Set(["success", "failed", "canceled"]);

/**
 * Stores the finished jobs of a pipeline in `COLLECTIONS.jobRuns` (id `${pipelineId}:${jobId}`).
 * Running, pending and skipped jobs are ignored; nothing is stored without a pipeline id.
 */
export async function recordJobRuns(
    state: StateStore,
    jobs: JobInfo[],
    context: {pipelineId?: string; branch?: string; createdAt?: string},
    now: Date = new Date()
): Promise<number> {
    if (!context.pipelineId) return 0;
    let recorded = 0;
    for (const job of jobs) {
        if (!FINISHED.has(job.status)) continue;
        const record: JobRunRecord = {
            pipelineId: context.pipelineId,
            jobId: job.id,
            name: job.name,
            ...(job.stage ? {stage: job.stage} : {}),
            status: job.status,
            ...(job.durationSeconds !== undefined ? {durationSeconds: job.durationSeconds} : {}),
            ...(job.queuedSeconds !== undefined ? {queuedSeconds: job.queuedSeconds} : {}),
            ...(context.branch ? {branch: context.branch} : {}),
            at: job.finishedAt ?? job.startedAt ?? context.createdAt ?? now.toISOString()
        };
        await state.putRecord(COLLECTIONS.jobRuns, `${context.pipelineId}:${job.id}`, record);
        recorded++;
    }
    return recorded;
}

/** Records the jobs of recent pipelines returned by the CI. */
export async function recordPipelines(
    state: StateStore,
    pipelines: PipelineSummary[],
    now: Date = new Date()
): Promise<number> {
    let recorded = 0;
    for (const pipeline of pipelines) {
        recorded += await recordJobRuns(
            state,
            pipeline.jobs,
            {
                pipelineId: pipeline.id,
                ...(pipeline.branch ? {branch: pipeline.branch} : {}),
                createdAt: pipeline.createdAt
            },
            now
        );
    }
    return recorded;
}

/** Job runs of the `limit` most recent pipelines in the state store. */
export async function loadHistory(state: StateStore, limit: number): Promise<JobRunRecord[]> {
    const records = (await state.listRecords<JobRunRecord>(COLLECTIONS.jobRuns, {limit: Math.max(limit, 1) * 200})).map(
        (record) => record.value
    );
    const latest = new Map<string, string>();
    for (const record of records) {
        const at = latest.get(record.pipelineId);
        if (!at || record.at > at) latest.set(record.pipelineId, record.at);
    }
    const kept = new Set(
        [...latest.entries()]
            .sort((a, b) => b[1].localeCompare(a[1]))
            .slice(0, limit)
            .map(([id]) => id)
    );
    return records.filter((record) => kept.has(record.pipelineId));
}

/** Nearest-rank percentile of `values` (0 < p ≤ 100). */
export function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface JobStats {
    name: string;
    /** Successful runs with a duration. */
    runs: number;
    p50Seconds?: number;
    p90Seconds?: number;
    p50QueuedSeconds?: number;
    /** p50 of this job divided by the sum of p50 of every job (compute share). */
    share?: number;
    pipelines: number;
}

/** Duration statistics per job name. */
export function jobStats(history: JobRunRecord[]): JobStats[] {
    const byName = new Map<string, JobRunRecord[]>();
    for (const record of history) byName.set(record.name, [...(byName.get(record.name) ?? []), record]);
    const stats: JobStats[] = [...byName.entries()].map(([name, runs]) => {
        const durations = runs
            .filter((run) => run.status === "success" && run.durationSeconds !== undefined)
            .map((run) => run.durationSeconds as number);
        const queued = runs.filter((run) => run.queuedSeconds !== undefined).map((run) => run.queuedSeconds as number);
        const p50 = percentile(durations, 50);
        const p90 = percentile(durations, 90);
        const p50Queued = percentile(queued, 50);
        return {
            name,
            runs: durations.length,
            ...(p50 !== undefined ? {p50Seconds: p50} : {}),
            ...(p90 !== undefined ? {p90Seconds: p90} : {}),
            ...(p50Queued !== undefined ? {p50QueuedSeconds: p50Queued} : {}),
            pipelines: new Set(runs.map((run) => run.pipelineId)).size
        };
    });
    const total = stats.reduce((sum, stat) => sum + (stat.p50Seconds ?? 0), 0);
    for (const stat of stats) if (total > 0 && stat.p50Seconds !== undefined) stat.share = stat.p50Seconds / total;
    return stats.sort((a, b) => (b.p50Seconds ?? 0) - (a.p50Seconds ?? 0));
}
