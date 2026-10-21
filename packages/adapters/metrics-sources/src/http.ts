/** Options every HTTP-backed source accepts. */
export interface HttpOptions {
    /** Injected in tests. Default: the global `fetch`. */
    fetch?: typeof fetch;
    /** Per-request timeout. Default: 10 s. */
    timeoutMs?: number;
}

/** GET a JSON document; a non-2xx answer becomes an error naming the source and the status, never the secrets. */
export async function getJson<T>(
    source: string,
    fetchFn: typeof fetch,
    url: URL,
    headers: Record<string, string>,
    timeoutMs: number
): Promise<{body: T; response: Response}> {
    const response = await fetchFn(url, {
        method: "GET",
        headers: {Accept: "application/json", ...headers},
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
        let detail = "";
        try {
            detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ").trim();
        } catch {
            // The status alone is enough.
        }
        throw new Error(`${source} ${url.pathname}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    try {
        return {body: (await response.json()) as T, response};
    } catch {
        throw new Error(`${source} ${url.pathname}: response is not valid JSON`);
    }
}

/** Removes trailing slashes so that `new URL(base + path)` works whatever the configuration says. */
export function trimBase(url: string): string {
    return url.replace(/\/+$/, "");
}

/** Adds the values of the series point-wise, keyed by timestamp (ms), skipping non-finite values. */
export function sumPointWise(series: [number, number][][]): {at: string; value: number}[] {
    const totals = new Map<number, number>();
    for (const points of series) {
        for (const [ms, value] of points) {
            if (!Number.isFinite(ms) || !Number.isFinite(value)) continue;
            totals.set(ms, (totals.get(ms) ?? 0) + value);
        }
    }
    return [...totals.entries()]
        .sort(([a], [b]) => a - b)
        .map(([ms, value]) => ({at: new Date(ms).toISOString(), value}));
}

export const unixSeconds = (date: Date) => Math.floor(date.getTime() / 1000);
