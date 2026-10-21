/** Readers for untrusted JSON: each returns `undefined` instead of throwing on a missing or mistyped field. */

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

export function at(value: unknown, ...path: string[]): unknown {
    let current: unknown = value;
    for (const key of path) current = obj(current)?.[key];
    return current;
}

/** A non-empty string, or a finite number turned into a string (ids are numbers in most payloads). */
export function text(value: unknown): string | undefined {
    if (typeof value === "string") return value.length > 0 ? value : undefined;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
}

export function str(value: unknown, ...path: string[]): string | undefined {
    return text(at(value, ...path));
}

/**
 * ISO 8601 from the date formats webhooks use: ISO already, or GitLab's `2026-10-21 10:00:00 +0200` /
 * `2026-10-21 08:00:00 UTC`. Unparsable dates give `undefined`.
 */
export function isoDate(value: unknown): string | undefined {
    const raw = text(value);
    if (!raw) return undefined;
    const gitlab = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?(UTC|[+-]\d{2}:?\d{2})$/.exec(raw);
    const candidate = gitlab
        ? `${gitlab[1]}T${gitlab[2]}${gitlab[3] === "UTC" ? "Z" : gitlab[3]!.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2")}`
        : raw;
    const time = Date.parse(candidate);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Copies only the defined optional fields, so events never carry `undefined` values. */
export function defined<T extends Json>(fields: T): {[K in keyof T]?: Exclude<T[K], undefined>} {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
        [K in keyof T]?: Exclude<T[K], undefined>;
    };
}
