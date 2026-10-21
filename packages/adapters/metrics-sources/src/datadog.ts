import type {MetricQuery, MetricSample, MetricsSource, TimeWindow} from "@aicd/plugin-sdk";
import {getJson, sumPointWise, unixSeconds, type HttpOptions} from "./http.js";

export interface DatadogOptions extends HttpOptions {
    /** Datadog site: `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`… Default: `datadoghq.com`. */
    site?: string;
    apiKey: string;
    appKey: string;
}

interface DatadogResponse {
    status?: string;
    error?: string;
    series?: {pointlist?: [number, number | null][]}[];
}

/**
 * Datadog metrics query API (`/api/v1/query`). Datadog picks the resolution itself: add `.rollup(avg, 60)` to the
 * query to fix it, `stepSeconds` is not sent. Several series are summed point-wise, like Prometheus.
 */
export class DatadogSource implements MetricsSource {
    readonly name = "datadog";
    readonly #options: DatadogOptions;
    readonly #fetch: typeof fetch;

    constructor(options: DatadogOptions) {
        if (!options.apiKey || !options.appKey) throw new Error("datadog: apiKey and appKey are required");
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    async queryRange(query: MetricQuery, window: TimeWindow, _stepSeconds: number): Promise<MetricSample[]> {
        const site = (this.#options.site ?? "datadoghq.com").replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const url = new URL(`https://api.${site.replace(/^api\./, "")}/api/v1/query`);
        url.searchParams.set("from", String(unixSeconds(window.start)));
        url.searchParams.set("to", String(unixSeconds(window.end)));
        url.searchParams.set("query", query.query);
        const {body} = await getJson<DatadogResponse>(
            "datadog",
            this.#fetch,
            url,
            {"DD-API-KEY": this.#options.apiKey, "DD-APPLICATION-KEY": this.#options.appKey},
            this.#options.timeoutMs ?? 10_000
        );
        if (body.status === "error" || body.error) {
            throw new Error(`datadog: query "${query.name}" failed: ${body.error ?? "status error"}`);
        }
        return sumPointWise(
            (body.series ?? []).map((series) =>
                (series.pointlist ?? [])
                    .filter((point): point is [number, number] => point[1] !== null)
                    .map(([ms, value]): [number, number] => [ms, Number(value)])
            )
        );
    }
}
