import {SEVERITIES, type SecurityAlert} from "./sarif.js";

/** Paths where an alert is most likely not reachable in production. */
export const DEFAULT_IGNORE_PATHS: readonly string[] = [
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/spec/**",
    "**/fixture/**",
    "**/fixtures/**",
    "**/testdata/**",
    "**/example/**",
    "**/examples/**",
    "**/vendor/**",
    "**/third_party/**",
    "**/node_modules/**",
    "**/generated/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.go",
    "**/*.generated.*",
    "**/*.pb.go",
    "**/*.min.js"
];

/**
 * Glob → RegExp: `**` matches any number of directories, `*` anything but `/`, `?` one character.
 * A pattern without `/` matches the file name in any directory.
 */
export function globToRegExp(pattern: string): RegExp {
    const glob = pattern.includes("/") ? pattern.replace(/^\.?\//, "") : `**/${pattern}`;
    let source = "";
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index] as string;
        if (char === "*" && glob[index + 1] === "*") {
            const slash = glob[index + 2] === "/";
            source += slash ? "(?:.*/)?" : ".*";
            index += slash ? 2 : 1;
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, "i");
}

/** First pattern matching the path, if any. */
export function matchIgnorePath(path: string | undefined, patterns: readonly string[]): string | undefined {
    if (!path) return undefined;
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    return patterns.find((pattern) => globToRegExp(pattern).test(normalized));
}

/**
 * Removes duplicates: same id (the same alert reported twice, e.g. by two SARIF files) or same
 * tool, rule, file and lines. The most severe copy is kept, in first-seen order.
 */
export function dedupeAlerts(alerts: SecurityAlert[]): SecurityAlert[] {
    const byKey = new Map<string, SecurityAlert>();
    const keyOf = new Map<string, string>();
    for (const alert of alerts) {
        const location = `${alert.tool}|${alert.ruleId}|${alert.file ?? ""}|${alert.startLine ?? ""}|${alert.endLine ?? ""}`;
        const key = keyOf.get(alert.id) ?? keyOf.get(location) ?? alert.id;
        keyOf.set(alert.id, key);
        if (alert.file && alert.startLine !== undefined) keyOf.set(location, key);
        const kept = byKey.get(key);
        if (!kept || SEVERITIES.indexOf(alert.severity) > SEVERITIES.indexOf(kept.severity)) byKey.set(key, alert);
    }
    return [...byKey.values()];
}
