/** An HTTP error from a tracker API. `findTickets` ignores a 404 and logs the rest. */
export class TrackerHttpError extends Error {
    constructor(
        readonly tracker: string,
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "TrackerHttpError";
    }
}

/** JSON body of a tracker API call; undefined on 404 when `allowNotFound`, a `TrackerHttpError` otherwise. */
export async function requestJson(
    fetchFn: typeof fetch,
    tracker: string,
    url: string,
    init: RequestInit & {allowNotFound?: boolean} = {}
): Promise<unknown> {
    const {allowNotFound, ...requestInit} = init;
    const method = requestInit.method ?? "GET";
    const response = await fetchFn(url, {
        ...requestInit,
        headers: {
            Accept: "application/json",
            ...(requestInit.body ? {"Content-Type": "application/json"} : {}),
            ...(requestInit.headers as Record<string, string> | undefined)
        }
    });
    if (response.status === 404 && allowNotFound) return undefined;
    if (!response.ok) {
        throw new TrackerHttpError(
            tracker,
            response.status,
            `${tracker} API ${method} ${new URL(url).pathname}: HTTP ${response.status}`
        );
    }
    return response.json();
}

export function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

export function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** Unique values in order of first appearance. */
export function unique(values: string[]): string[] {
    return [...new Set(values)];
}
