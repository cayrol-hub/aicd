import type {ErrorGroup, MetricQuery, MetricSample, MetricsSource, TimeWindow} from "@aicd-ci/plugin-sdk";
import {getJson, trimBase, type HttpOptions} from "./http.js";

export interface SentryOptions extends HttpOptions {
    /** Default: `https://sentry.io`. Self-hosted: the base URL of the instance. */
    url?: string;
    organization: string;
    project: string;
    token: string;
    /** Pages of 100 issues read at most. Default: 5. */
    maxPages?: number;
}

interface SentryIssue {
    id: string;
    title?: string;
    culprit?: string;
    firstSeen?: string;
    count?: string | number;
    level?: string;
    permalink?: string;
}

/** Next page cursor from Sentry's `Link` header, only when it says there are results. */
function nextCursor(link: string | null): string | undefined {
    if (!link) return undefined;
    for (const part of link.split(",")) {
        if (/rel="next"/.test(part) && /results="true"/.test(part)) return /cursor="([^"]+)"/.exec(part)?.[1];
    }
    return undefined;
}

const quoteValue = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

/**
 * Sentry issues API. `newErrors` lists the issue groups first seen in the window (optionally for one environment
 * and release); the window is also checked on our side since Sentry's search may round dates.
 * Sentry has no time series of arbitrary queries: `queryRange` throws.
 */
export class SentrySource implements MetricsSource {
    readonly name = "sentry";
    readonly #options: SentryOptions;
    readonly #fetch: typeof fetch;

    constructor(options: SentryOptions) {
        if (!options.organization || !options.project) throw new Error("sentry: organization and project are required");
        if (!options.token) throw new Error("sentry: token is required");
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    async queryRange(query: MetricQuery, _window: TimeWindow, _stepSeconds: number): Promise<MetricSample[]> {
        throw new Error(
            `sentry: queryRange is not supported (metric "${query.name}"); use Sentry for new errors and Prometheus or Datadog for metrics`
        );
    }

    async newErrors(window: TimeWindow, filter: {environment?: string; release?: string} = {}): Promise<ErrorGroup[]> {
        const {organization, project} = this.#options;
        const base = trimBase(this.#options.url ?? "https://sentry.io");
        const terms = [`firstSeen:>=${window.start.toISOString()}`, `firstSeen:<=${window.end.toISOString()}`];
        if (filter.environment) terms.push(`environment:${quoteValue(filter.environment)}`);
        if (filter.release) terms.push(`release:${quoteValue(filter.release)}`);

        const groups: ErrorGroup[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < (this.#options.maxPages ?? 5); page++) {
            const url = new URL(
                `${base}/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/issues/`
            );
            url.searchParams.set("query", terms.join(" "));
            url.searchParams.set("limit", "100");
            if (cursor) url.searchParams.set("cursor", cursor);
            const {body, response} = await getJson<SentryIssue[]>(
                "sentry",
                this.#fetch,
                url,
                {Authorization: `Bearer ${this.#options.token}`},
                this.#options.timeoutMs ?? 10_000
            );
            if (!Array.isArray(body)) throw new Error("sentry: unexpected issues response");
            for (const issue of body) {
                const firstSeen = issue.firstSeen ? new Date(issue.firstSeen) : undefined;
                if (!firstSeen || Number.isNaN(firstSeen.getTime())) continue;
                if (firstSeen < window.start || firstSeen > window.end) continue;
                groups.push({
                    id: String(issue.id),
                    title: issue.title ?? issue.culprit ?? `issue ${issue.id}`,
                    firstSeen: firstSeen.toISOString(),
                    count: Number(issue.count ?? 0) || 0,
                    ...(issue.level ? {level: issue.level} : {}),
                    ...(issue.permalink ? {url: issue.permalink} : {})
                });
            }
            cursor = nextCursor(response.headers.get("link"));
            if (!cursor) break;
        }
        return groups;
    }
}
