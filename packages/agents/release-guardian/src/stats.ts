import type {MetricQuery, MetricSample} from "@aicd/plugin-sdk";

export interface WindowStats {
    count: number;
    mean: number;
    p95: number;
}

export interface Comparison {
    statistic: "mean" | "p95";
    baseline: number;
    observed: number;
    /** Change in the bad direction (positive = worse). */
    absolute: number;
    /** `absolute / |baseline|`; null when the baseline is 0 and things got worse (an infinite increase). */
    relative: number | null;
}

export type MetricStatus = "ok" | "degraded" | "severe";

export interface Thresholds {
    relative_increase: number;
    absolute_min: number;
    severe_factor: number;
}

/** Mean and p95 (nearest rank) of the finite values; undefined without any. */
export function windowStats(samples: MetricSample[]): WindowStats | undefined {
    const values = samples.map((sample) => sample.value).filter((value) => Number.isFinite(value));
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] as number;
    return {count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length, p95};
}

function compareOne(
    statistic: "mean" | "p95",
    baseline: number,
    observed: number,
    bad: MetricQuery["bad"]
): Comparison {
    const absolute = bad === "up" ? observed - baseline : baseline - observed;
    const relative = baseline === 0 ? (absolute > 0 ? null : 0) : absolute / Math.abs(baseline);
    return {statistic, baseline, observed, absolute, relative};
}

/** Mean and p95 compared in the direction that counts as a degradation. */
export function compareWindows(baseline: WindowStats, observed: WindowStats, bad: MetricQuery["bad"]): Comparison[] {
    return [compareOne("mean", baseline.mean, observed.mean, bad), compareOne("p95", baseline.p95, observed.p95, bad)];
}

const relativeRank = (comparison: Comparison) => comparison.relative ?? Number.POSITIVE_INFINITY;

/**
 * Degraded when one statistic crosses both thresholds (relative ≥ `relative_increase` and absolute change
 * > `absolute_min`); severe when that relative change also reaches `severe_factor × relative_increase`.
 * Returns the comparison that decided (the worst crossing one, else the mean).
 */
export function classify(
    comparisons: Comparison[],
    thresholds: Thresholds
): {status: MetricStatus; decisive: Comparison} {
    const crossing = comparisons.filter(
        (comparison) =>
            comparison.absolute > thresholds.absolute_min && relativeRank(comparison) >= thresholds.relative_increase
    );
    // The mean wins ties (floating-point noise included): it is the statistic people expect to read.
    const worst = crossing.reduce<Comparison | undefined>(
        (best, comparison) => (!best || relativeRank(comparison) > relativeRank(best) + 1e-9 ? comparison : best),
        undefined
    );
    if (!worst) return {status: "ok", decisive: comparisons[0] as Comparison};
    const severe = relativeRank(worst) >= thresholds.severe_factor * thresholds.relative_increase;
    return {status: severe ? "severe" : "degraded", decisive: worst};
}
