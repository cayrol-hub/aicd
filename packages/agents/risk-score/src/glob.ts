const cache = new Map<string, RegExp>();

/**
 * Converts a gitignore / CODEOWNERS style glob to a regular expression on repository paths.
 * A pattern without a slash matches a file or directory name at any depth; a leading slash anchors
 * it to the root; a pattern that matches a directory also matches every file below it.
 * Supports `*`, `**`, `?` and `{a,b}`.
 */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
    const key = `${ignoreCase ? "i" : "s"}:${glob}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let pattern = glob.trim();
    const anchored = pattern.startsWith("/") || pattern.replace(/\/+$/, "").includes("/");
    pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i] as string;
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                const slashAfter = pattern[i + 2] === "/";
                source += slashAfter ? "(?:.*/)?" : ".*";
                i += slashAfter ? 2 : 1;
            } else source += "[^/]*";
        } else if (char === "?") source += "[^/]";
        else if (char === "{") {
            const end = pattern.indexOf("}", i);
            if (end === -1) source += "\\{";
            else {
                const options = pattern
                    .slice(i + 1, end)
                    .split(",")
                    .map(escape);
                source += `(?:${options.join("|")})`;
                i = end;
            }
        } else source += escape(char);
    }
    const regex = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}(?:/.*)?$`, ignoreCase ? "i" : "");
    cache.set(key, regex);
    return regex;
}

function escape(text: string): string {
    return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** The first glob of `globs` that matches `path`, if any. */
export function firstMatch(path: string, globs: readonly string[], ignoreCase = true): string | undefined {
    return globs.find((glob) => globToRegExp(glob, ignoreCase).test(path));
}
