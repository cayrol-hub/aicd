import {createHash} from "node:crypto";

/** Removes what changes from one run to the next (dates, ids, durations, temp paths, numbers). */
export function normalizeErrorLine(line: string): string {
    return line
        .toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, "<date>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
        .replace(/\b[0-9a-f]{7,64}\b/g, "<hex>")
        .replace(/(?:\/tmp|\/var\/folders|\/private\/var|[a-z]:\\users\\[^\\]+\\appdata)[^\s'"]*/g, "<tmp>")
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g, "<duration>")
        .replace(/:\d+(?::\d+)?\b/g, ":<n>")
        .replace(/\d+/g, "<n>")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Same failure → same fingerprint, across runs and branches. Built from the first error
 * lines and the failing test ids, so a known failure is recognised without calling the LLM.
 */
export function fingerprint(errorLines: string[], failingTests: string[]): string {
    const lines = errorLines.slice(0, 5).map(normalizeErrorLine);
    const tests = [...failingTests].sort();
    const material = JSON.stringify({lines, tests});
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
