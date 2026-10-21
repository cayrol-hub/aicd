const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** GitHub Actions prefixes each line with an ISO timestamp. */
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/;
/** GitLab section markers. */
const GITLAB_SECTION = /section_(?:start|end):\d+:[\w.-]+\r?/g;

const ERROR_LINE =
    /\b(error|errors|failed|failure|failing|exception|panic|fatal|traceback|assert(?:ion)?(?:error)?|segmentation fault|killed|timed? ?out|exit (?:code|status) [1-9]\d*)\b|^\s*(FAIL|✗|✕|×)\s/i;

export interface LogExcerpt {
    /** Excerpt lines prefixed with their 1-based line number: `L123: text`. */
    text: string;
    /** Error lines found (without prefix), in order. Used for fingerprints. */
    errorLines: string[];
    totalLines: number;
    truncated: boolean;
}

export interface ExcerptOptions {
    before?: number;
    after?: number;
    maxLines?: number;
    /** Lines kept from the end of the log when no error line is found. */
    tailLines?: number;
}

export function cleanLog(raw: string): string[] {
    return raw
        .replace(GITLAB_SECTION, "")
        .split(/\r?\n/)
        .map((line) => line.replace(ANSI, "").replace(LEADING_TIMESTAMP, "").replace(/\r/g, ""));
}

/** Keeps the useful windows of a CI log: around error lines, or its tail when none is found. */
export function extractExcerpt(raw: string, options: ExcerptOptions = {}): LogExcerpt {
    const {before = 8, after = 20, maxLines = 300, tailLines = 80} = options;
    const lines = cleanLog(raw);
    const hits = lines.flatMap((line, index) => (ERROR_LINE.test(line) ? [index] : []));

    const ranges: [number, number][] = [];
    if (hits.length === 0) {
        ranges.push([Math.max(0, lines.length - tailLines), lines.length - 1]);
    } else {
        for (const hit of hits) {
            const start = Math.max(0, hit - before);
            const end = Math.min(lines.length - 1, hit + after);
            const last = ranges.at(-1);
            if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
            else ranges.push([start, end]);
        }
    }

    const kept: string[] = [];
    let truncated = false;
    for (const [start, end] of ranges) {
        if (kept.length > 0) kept.push("…");
        for (let index = start; index <= end; index++) {
            if (kept.length >= maxLines) {
                truncated = true;
                break;
            }
            kept.push(`L${index + 1}: ${lines[index]}`);
        }
        if (truncated) break;
    }

    return {
        text: kept.join("\n"),
        errorLines: hits.map((index) => lines[index] ?? "").filter((line) => line.trim().length > 0),
        totalLines: lines.length,
        truncated
    };
}
