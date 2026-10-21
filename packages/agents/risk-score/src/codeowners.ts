import {globToRegExp} from "./glob.js";

export interface CodeownersRule {
    pattern: string;
    owners: string[];
    /** GitLab section name; "" for GitHub files and entries before the first section. */
    section: string;
    line: number;
}

const SECTION = /^\^?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/;

/** Owners are `@user`, `@group/team` or e-mail addresses; anything else on the line is ignored. */
function ownersIn(text: string): string[] {
    return text.split(/\s+/).filter((token) => token.startsWith("@") || /^[^@\s]+@[^@\s]+$/.test(token));
}

/**
 * Parses a GitHub or GitLab CODEOWNERS file. GitLab sections (`[Name]`, `^[Name][2] @default`)
 * are kept; their default owners apply to entries that list none.
 */
export function parseCodeowners(content: string): CodeownersRule[] {
    const rules: CodeownersRule[] = [];
    let section = "";
    let defaults: string[] = [];
    content.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.replace(/(^|\s)#.*$/, "").trim();
        if (!line) return;
        const header = line.match(SECTION);
        if (header) {
            section = (header[1] as string).trim();
            defaults = ownersIn(header[2] ?? "");
            return;
        }
        const [pattern = "", ...rest] = line.split(/\s+/);
        const owners = ownersIn(rest.join(" "));
        rules.push({
            pattern: pattern.replace(/\\#/g, "#"),
            owners: owners.length > 0 ? owners : defaults,
            section,
            line: index + 1
        });
    });
    return rules;
}

/** Owners of `path`: the last matching rule of each section wins; owners of all sections are merged. */
export function ownersOf(path: string, rules: readonly CodeownersRule[]): string[] {
    const bySection = new Map<string, string[]>();
    for (const rule of rules) if (globToRegExp(rule.pattern).test(path)) bySection.set(rule.section, rule.owners);
    return [...new Set([...bySection.values()].flat())].sort();
}
