import type {DeploymentRecord, IncidentRecord, StateStore} from "@aicd/plugin-sdk";
import {listDeployments, listIncidents, timeOf} from "./records.js";

export type DoraLevel = "elite" | "high" | "medium" | "low";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Performance levels of the DORA 2023 "Accelerate State of DevOps" report. The report describes clusters
 * (elite: on demand / < 1 day / 5 % / < 1 hour; high: daily to weekly / 1 day to 1 week / 10 % / < 1 day;
 * medium: weekly to monthly / 1 week to 1 month / 15 % / 1 day to 1 week; low: weekly to monthly /
 * 1 week to 1 month / 64 % / 1 to 6 months). The 2023 low cluster overlaps the medium one for frequency and lead
 * time, so a value beyond the medium bound is "low". Frequency: at least the bound; durations: strictly below it
 * ("less than one day"); change failure rate: at most the bound.
 */
export const DORA_THRESHOLDS = {
    /** Minimum deployments per day: on demand (at least daily), weekly, monthly. */
    deploymentsPerDay: {elite: 1, high: 1 / 7, medium: 1 / 30},
    /** Lead time in hours, strictly below: one day, one week, one month. */
    leadTimeHours: {elite: 24, high: 24 * 7, medium: 24 * 30},
    /** Maximum change failure rate: 5 %, 10 %, 15 %. */
    changeFailureRate: {elite: 0.05, high: 0.1, medium: 0.15},
    /** Time to restore in hours, strictly below: one hour, one day, one week. */
    timeToRestoreHours: {elite: 1, high: 24, medium: 24 * 7}
} as const;

export interface DoraOptions {
    /** Default "production". */
    environment?: string;
    start: Date | string;
    end: Date | string;
}

export interface DoraReport {
    environment: string;
    start: string;
    end: string;
    days: number;
    /** Deployments started in the window and no longer in progress. */
    deploymentFrequency: {
        count: number;
        successful: number;
        perDay: number;
        perWeek: number;
        /** Null when there is no deployment in the window. */
        level: DoraLevel | null;
    };
    /** From each shipped commit's authoredAt to the end of its first successful deployment in the window. */
    leadTime: {commits: number; medianHours: number | null; p90Hours: number | null; level: DoraLevel | null};
    changeFailureRate: {
        deployments: number;
        failed: number;
        rate: number | null;
        level: DoraLevel | null;
        failedDeploymentIds: string[];
    };
    /** Incidents opened in the window, plus failed deployments of the window that no incident covers. */
    timeToRestore: {
        failures: number;
        restored: number;
        open: number;
        medianHours: number | null;
        level: DoraLevel | null;
    };
}

/** Percentile with linear interpolation between closest ranks; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    const lowValue = sorted[low] ?? 0;
    const highValue = sorted[high] ?? lowValue;
    return lowValue + (highValue - lowValue) * (rank - low);
}

function round(value: number | null, digits = 2): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function atLeast(value: number, bounds: {elite: number; high: number; medium: number}): DoraLevel {
    if (value >= bounds.elite) return "elite";
    if (value >= bounds.high) return "high";
    if (value >= bounds.medium) return "medium";
    return "low";
}

/** Durations: the report says "less than", so a bound is excluded. Rates: a bound is included. */
function atMost(value: number, bounds: {elite: number; high: number; medium: number}, strict: boolean): DoraLevel {
    const within = (bound: number) => (strict ? value < bound : value <= bound);
    if (within(bounds.elite)) return "elite";
    if (within(bounds.high)) return "high";
    if (within(bounds.medium)) return "medium";
    return "low";
}

function toDate(value: Date | string, name: string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new RangeError(`invalid ${name} date`);
    return date;
}

/** When a deployment went live: its end, or its start when the end is unknown. */
function liveAt(deployment: DeploymentRecord): number {
    return timeOf(deployment.finishedAt) ?? timeOf(deployment.startedAt) ?? 0;
}

/**
 * An incident counts for `environment` when it names it, or names none but points to a deployment of it, or
 * names neither (incidents of a single-environment setup).
 */
function incidentMatches(incident: IncidentRecord, environment: string, deployments: Map<string, DeploymentRecord>) {
    if (incident.environment !== undefined) return incident.environment === environment;
    if (incident.deploymentId !== undefined) {
        const deployment = deployments.get(incident.deploymentId);
        return deployment === undefined || deployment.environment === environment;
    }
    return true;
}

/**
 * DORA metrics of one environment over `[start, end)`. A deployment is failed when its status is failed or
 * rolled_back, when a later deployment rolls it back (`rollbackOf`), or when an incident points to it. Empty data
 * gives null values, never NaN.
 */
export async function computeDora(state: StateStore, options: DoraOptions): Promise<DoraReport> {
    const environment = options.environment ?? "production";
    const start = toDate(options.start, "start");
    const end = toDate(options.end, "end");
    if (end.getTime() <= start.getTime()) throw new RangeError("end must be after start");
    const from = start.getTime();
    const to = end.getTime();
    const inWindow = (time: number | undefined) => time !== undefined && time >= from && time < to;
    const days = (to - from) / DAY;

    const everywhere = await listDeployments(state);
    const byId = new Map(everywhere.map((deployment) => [deployment.id, deployment]));
    const all = everywhere.filter((deployment) => deployment.environment === environment);
    const incidents = (await listIncidents(state)).filter((incident) => incidentMatches(incident, environment, byId));

    const rolledBack = new Set(all.flatMap((deployment) => (deployment.rollbackOf ? [deployment.rollbackOf] : [])));
    const withIncident = new Set(
        incidents.flatMap((incident) => (incident.deploymentId ? [incident.deploymentId] : []))
    );
    const isFailed = (deployment: DeploymentRecord) =>
        deployment.status === "failed" ||
        deployment.status === "rolled_back" ||
        rolledBack.has(deployment.id) ||
        withIncident.has(deployment.id);

    const windowed = all.filter(
        (deployment) => deployment.status !== "in_progress" && inWindow(timeOf(deployment.startedAt))
    );
    const successful = windowed.filter((deployment) => deployment.status === "success");
    const failed = windowed.filter(isFailed);

    // Deployment frequency.
    const perDay = windowed.length / days;
    const deploymentFrequency = {
        count: windowed.length,
        successful: successful.length,
        perDay: round(perDay, 4) ?? 0,
        perWeek: round(perDay * 7, 4) ?? 0,
        level: windowed.length > 0 ? atLeast(perDay, DORA_THRESHOLDS.deploymentsPerDay) : null
    };

    // Lead time: each commit counts once, at its first successful deployment (earlier ones included, so that a
    // commit shipped before the window and redeployed in it is not counted again).
    const leadTimes: number[] = [];
    const shipped = new Set<string>();
    for (const deployment of all) {
        if (deployment.status !== "success" || (timeOf(deployment.startedAt) ?? 0) >= to) continue;
        const counted = inWindow(timeOf(deployment.startedAt));
        for (const commit of deployment.commits ?? []) {
            if (!commit?.sha || shipped.has(commit.sha)) continue;
            shipped.add(commit.sha);
            const authored = timeOf(commit.authoredAt);
            if (counted && authored !== undefined) leadTimes.push(Math.max(0, liveAt(deployment) - authored) / HOUR);
        }
    }
    const medianLead = percentile(leadTimes, 50);
    const leadTime = {
        commits: leadTimes.length,
        medianHours: round(medianLead),
        p90Hours: round(percentile(leadTimes, 90)),
        level: medianLead === null ? null : atMost(medianLead, DORA_THRESHOLDS.leadTimeHours, true)
    };

    // Change failure rate.
    const rate = windowed.length > 0 ? failed.length / windowed.length : null;
    const changeFailureRate = {
        deployments: windowed.length,
        failed: failed.length,
        rate: round(rate, 4),
        level: rate === null ? null : atMost(rate, DORA_THRESHOLDS.changeFailureRate, false),
        failedDeploymentIds: failed.map((deployment) => deployment.id)
    };

    // Time to restore: incidents of the window, then failed deployments that no incident covers, restored by the
    // next successful deployment that is not itself failed.
    const restoreHours: number[] = [];
    let open = 0;
    const windowIncidents = incidents.filter((incident) => inWindow(timeOf(incident.openedAt)));
    for (const incident of windowIncidents) {
        const opened = timeOf(incident.openedAt) ?? 0;
        const resolved = timeOf(incident.resolvedAt);
        if (resolved === undefined) open++;
        else if (resolved >= opened) restoreHours.push((resolved - opened) / HOUR);
    }
    const uncovered = failed.filter((deployment) => !withIncident.has(deployment.id));
    for (const deployment of uncovered) {
        const startedAt = timeOf(deployment.startedAt) ?? 0;
        const restore = all.find(
            (next) =>
                (timeOf(next.startedAt) ?? 0) > startedAt &&
                next.status === "success" &&
                !isFailed(next) &&
                next.id !== deployment.id
        );
        if (!restore) open++;
        else restoreHours.push(Math.max(0, liveAt(restore) - liveAt(deployment)) / HOUR);
    }
    const medianRestore = percentile(restoreHours, 50);
    const timeToRestore = {
        failures: windowIncidents.length + uncovered.length,
        restored: restoreHours.length,
        open,
        medianHours: round(medianRestore),
        level: medianRestore === null ? null : atMost(medianRestore, DORA_THRESHOLDS.timeToRestoreHours, true)
    };

    return {
        environment,
        start: start.toISOString(),
        end: end.toISOString(),
        days: round(days, 4) ?? 0,
        deploymentFrequency,
        leadTime,
        changeFailureRate,
        timeToRestore
    };
}
