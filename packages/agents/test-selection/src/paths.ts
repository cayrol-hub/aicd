import {posix} from "node:path";

function clean(path: string): string {
    const value = path
        .trim()
        .replace(/^file:\/\//, "")
        .replace(/\\/g, "/");
    if (value === "") return "";
    const normalized = posix.normalize(value);
    return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

/**
 * Repository-relative POSIX path: backslashes become slashes, `./`, `..` and duplicate slashes are resolved, and
 * an absolute path under `root` is made relative to it (without case on Windows drives). A path outside `root`
 * is kept as it is.
 */
export function normalizePath(path: string, root?: string): string {
    let value = clean(path);
    if (root) {
        const base = clean(root).replace(/\/+$/, "");
        const insensitive = /^[A-Za-z]:\//.test(base);
        const compareValue = insensitive ? value.toLowerCase() : value;
        const compareBase = insensitive ? base.toLowerCase() : base;
        if (compareBase !== "" && compareValue === compareBase) value = "";
        else if (compareBase !== "" && compareValue.startsWith(`${compareBase}/`)) value = value.slice(base.length + 1);
    }
    if (value === ".") return "";
    return value.replace(/^(\.\/)+/, "");
}

const regexCache = new Map<string, RegExp>();

/**
 * Compiles a glob to a regular expression: `**` (any depth), `*` and `?` (inside one segment) and `{a,b}`.
 * A pattern without a slash matches the file name at any depth, like `.gitignore`.
 */
export function globToRegExp(pattern: string): RegExp {
    const cached = regexCache.get(pattern);
    if (cached) return cached;
    let glob = pattern.trim().replace(/^\.\//, "");
    if (!glob.includes("/")) glob = `**/${glob}`;
    let source = "";
    let braces = 0;
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i] as string;
        if (char === "*") {
            if (glob[i + 1] === "*") {
                const wholeSegment = (i === 0 || glob[i - 1] === "/") && glob[i + 2] === "/";
                source += wholeSegment ? "(?:.*/)?" : ".*";
                i += wholeSegment ? 2 : 1;
            } else {
                source += "[^/]*";
            }
        } else if (char === "?") {
            source += "[^/]";
        } else if (char === "{") {
            braces++;
            source += "(?:";
        } else if (char === "}" && braces > 0) {
            braces--;
            source += ")";
        } else if (char === "," && braces > 0) {
            source += "|";
        } else {
            source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
        }
    }
    const regex = new RegExp(`^${source}$`);
    regexCache.set(pattern, regex);
    return regex;
}

export function matchesGlob(path: string, pattern: string): boolean {
    return globToRegExp(pattern).test(path);
}

/** The first pattern that matches `path`, if any. */
export function firstMatch(path: string, patterns: readonly string[]): string | undefined {
    return patterns.find((pattern) => matchesGlob(path, pattern));
}

/** Matches a branch name against a pattern where `*` may span slashes (`release/*`, `hotfix-*`). */
export function branchMatches(branch: string, pattern: string): boolean {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`).test(branch);
}

/** Quotes a word for POSIX shells only when needed. */
export function shellQuote(word: string): string {
    if (word !== "" && /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(word)) return word;
    return `'${word.replace(/'/g, `'\\''`)}'`;
}
