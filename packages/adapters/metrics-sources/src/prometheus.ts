import type {MetricQuery, MetricSample, MetricsSource, TimeWindow} from "@aicd-ci/plugin-sdk";
import {getJson, sumPointWise, trimBase, unixSeconds, type HttpOptions} from "./http.js";

export interface PrometheusOptions extends HttpOptions {
    /** Base URL of Prometheus (or a compatible API: Thanos, Mimir, VictoriaMetrics). */
    url: string;
    bearerToken?: string;
    /** Extra headers, e.g. `X-Scope-OrgID` for a multi-tenant Mimir. */
    headers?: Record<string, string>;
}

interface PrometheusResponse {
    status: "success" | "error";
    error?: string;
    data?: {resultType: string; result: {metric: Record<string, string>; values?: [number, string][]}[]};
}

/**
 * Prometheus `query_range`. When the query returns several series (no aggregation in the PromQL), their values
 * are summed point-wise: write `sum(...)`, `avg(...)` or a ratio yourself when a sum is not what you mean.
 */
export class PrometheusSource implements MetricsSource {
    readonly name = "prometheus";
    readonly #options: PrometheusOptions;
    readonly #fetch: typeof fetch;

    constructor(options: PrometheusOptions) {
        if (!options.url) throw new Error("prometheus: url is required");
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    async queryRange(query: MetricQuery, window: TimeWindow, stepSeconds: number): Promise<MetricSample[]> {
        const url = new URL(`${trimBase(this.#options.url)}/api/v1/query_range`);
        url.searchParams.set("query", query.query);
        url.searchParams.set("start", String(unixSeconds(window.start)));
        url.searchParams.set("end", String(unixSeconds(window.end)));
        url.searchParams.set("step", `${Math.max(1, Math.round(stepSeconds))}s`);
        const headers: Record<string, string> = {...this.#options.headers};
        if (this.#options.bearerToken) headers.Authorization = `Bearer ${this.#options.bearerToken}`;
        const {body} = await getJson<PrometheusResponse>(
            "prometheus",
            this.#fetch,
            url,
            headers,
            this.#options.timeoutMs ?? 10_000
        );
        if (body.status !== "success" || !body.data) {
            throw new Error(`prometheus: query "${query.name}" failed: ${body.error ?? "unexpected response"}`);
        }
        if (body.data.resultType !== "matrix") {
            throw new Error(`prometheus: query "${query.name}" returned a ${body.data.resultType}, expected a matrix`);
        }
        return sumPointWise(
            body.data.result.map((series) =>
                (series.values ?? []).map(([seconds, value]): [number, number] => [seconds * 1000, Number(value)])
            )
        );
    }
}
