export interface TimeWindow {
    start: Date;
    end: Date;
}

export interface MetricQuery {
    /** Name shown to humans, e.g. "http_5xx_rate". */
    name: string;
    /** Query in the source's language (PromQL, Datadog query…). */
    query: string;
    /** Which direction is a degradation. */
    bad: "up" | "down";
}

export interface MetricSample {
    at: string;
    value: number;
}

export interface ErrorGroup {
    id: string;
    title: string;
    firstSeen: string;
    count: number;
    level?: string;
    url?: string;
}

export interface MetricsSource {
    readonly name: string;
    queryRange(query: MetricQuery, window: TimeWindow, stepSeconds: number): Promise<MetricSample[]>;
    /** Error groups first seen in the window (Sentry-like sources). */
    newErrors?(window: TimeWindow, filter?: {environment?: string; release?: string}): Promise<ErrorGroup[]>;
}
