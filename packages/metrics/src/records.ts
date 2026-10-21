import {log} from "@aicd/git";
import {COLLECTIONS, type DeploymentRecord, type IncidentRecord, type StateStore} from "@aicd/plugin-sdk";

/** Upper bound of records read from a collection at once. */
export const MAX_RECORDS = 10_000;

/** Default cap of commits returned by `deploymentCommits` (first deployment of a long history). */
export const DEFAULT_MAX_COMMITS = 500;

export interface ShippedCommit {
    sha: string;
    authoredAt: string;
    subject: string;
}

/** Time in ms of an ISO date, or undefined when absent or unparsable (never NaN). */
export function timeOf(iso: string | undefined): number | undefined {
    if (!iso) return undefined;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? undefined : time;
}

function definedFields<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

/**
 * Stores a deployment, upserting by id: fields of `record` that are set replace the stored ones, the others are
 * kept (a deployment recorded `in_progress` then `success` keeps its commits). Returns the stored record.
 */
export async function recordDeployment(state: StateStore, record: DeploymentRecord): Promise<DeploymentRecord> {
    if (!record.id) throw new Error("deployment record without id");
    if (timeOf(record.startedAt) === undefined) throw new Error(`deployment ${record.id}: invalid startedAt`);
    const existing = await state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, record.id);
    const merged: DeploymentRecord = {...existing?.value, ...definedFields(record)} as DeploymentRecord;
    await state.putRecord(COLLECTIONS.deployments, record.id, merged);
    return merged;
}

/**
 * Stores an incident, upserting by id like `recordDeployment`. Timelines are merged: entries of both records,
 * without duplicates, sorted by date.
 */
export async function recordIncident(state: StateStore, record: IncidentRecord): Promise<IncidentRecord> {
    if (!record.id) throw new Error("incident record without id");
    if (timeOf(record.openedAt) === undefined) throw new Error(`incident ${record.id}: invalid openedAt`);
    const existing = (await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, record.id))?.value;
    const seen = new Set<string>();
    const timeline = [...(existing?.timeline ?? []), ...(record.timeline ?? [])]
        .filter((entry) => {
            const key = `${entry.at}\u001f${entry.kind}\u001f${entry.text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => (timeOf(a.at) ?? 0) - (timeOf(b.at) ?? 0));
    const merged = {...existing, ...definedFields(record), timeline} as IncidentRecord;
    await state.putRecord(COLLECTIONS.incidents, record.id, merged);
    return merged;
}

/** Every deployment of the state, oldest first; records without a valid `startedAt` are skipped. */
export async function listDeployments(state: StateStore, environment?: string): Promise<DeploymentRecord[]> {
    const records = await state.listRecords<DeploymentRecord>(COLLECTIONS.deployments, {limit: MAX_RECORDS});
    return records
        .map((record) => record.value)
        .filter((deployment) => timeOf(deployment?.startedAt) !== undefined)
        .filter((deployment) => environment === undefined || deployment.environment === environment)
        .sort((a, b) => (timeOf(a.startedAt) ?? 0) - (timeOf(b.startedAt) ?? 0));
}

/** Every incident of the state, oldest first; records without a valid `openedAt` are skipped. */
export async function listIncidents(state: StateStore): Promise<IncidentRecord[]> {
    const records = await state.listRecords<IncidentRecord>(COLLECTIONS.incidents, {limit: MAX_RECORDS});
    return records
        .map((record) => record.value)
        .filter((incident) => timeOf(incident?.openedAt) !== undefined)
        .sort((a, b) => (timeOf(a.openedAt) ?? 0) - (timeOf(b.openedAt) ?? 0));
}

/**
 * The last successful deployment of `environment` started before `beforeIso`: what was running in production,
 * hence the base of the commits shipped by the next deployment.
 */
export async function previousDeployment(
    state: StateStore,
    environment: string,
    beforeIso: string
): Promise<DeploymentRecord | undefined> {
    const before = timeOf(beforeIso);
    if (before === undefined) return undefined;
    const candidates = (await listDeployments(state, environment)).filter(
        (deployment) => deployment.status === "success" && (timeOf(deployment.startedAt) ?? 0) < before
    );
    return candidates.at(-1);
}

/**
 * Commits shipped by a deployment: `fromSha..toSha`, or every commit reachable from `toSha` when there is no
 * previous deployment, capped at `maxCount` (most recent kept). Oldest first. Empty when git fails.
 */
export async function deploymentCommits(options: {
    fromSha?: string;
    toSha: string;
    cwd?: string;
    maxCount?: number;
}): Promise<ShippedCommit[]> {
    const range = options.fromSha ? `${options.fromSha}..${options.toSha}` : options.toSha;
    const commits = await log(range, {
        ...(options.cwd ? {cwd: options.cwd} : {}),
        maxCount: options.maxCount ?? DEFAULT_MAX_COMMITS
    });
    return commits
        .reverse()
        .map((commit) => ({sha: commit.sha, authoredAt: commit.authoredAt, subject: commit.subject}));
}
