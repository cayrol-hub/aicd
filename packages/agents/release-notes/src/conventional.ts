import type {Commit} from "@aicd/git";

export type Section = "breaking" | "features" | "fixes" | "performance" | "security" | "documentation" | "other";

/** Order of the sections in the notes. */
export const SECTIONS: readonly Section[] = [
    "breaking",
    "features",
    "fixes",
    "performance",
    "security",
    "documentation",
    "other"
];

/** Conventional types users do not care about: left out of the `users` notes. */
export const INTERNAL_TYPES: readonly string[] = ["chore", "ci", "test", "tests", "refactor", "build", "style"];

export interface Reference {
    kind: "issue" | "merge_request" | "ticket";
    /** As written: "#12", "!45", "PROJ-7". */
    id: string;
}

export interface ReleaseEntry {
    sha: string;
    shortSha: string;
    /** Conventional type in lower case; undefined for a non-conventional commit. */
    type?: string;
    scope?: string;
    description: string;
    breaking: boolean;
    /** Text of the `BREAKING CHANGE:` footer. */
    breakingNote?: string;
    section: Section;
    references: Reference[];
    subject: string;
}

export interface ParsedSubject {
    type: string;
    scope?: string;
    breaking: boolean;
    description: string;
}

const CONVENTIONAL = /^([a-zA-Z]+)(?:\(([^()]*)\))?(!)?:\s*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:[ \t]*(.*)$/m;

/** `type(scope)!: description`, or undefined when the subject is not a conventional commit. */
export function parseConventionalSubject(subject: string): ParsedSubject | undefined {
    const match = subject.trim().match(CONVENTIONAL);
    if (!match) return undefined;
    const scope = match[2]?.trim();
    return {
        type: (match[1] as string).toLowerCase(),
        ...(scope ? {scope} : {}),
        breaking: match[3] === "!",
        description: (match[4] as string).trim()
    };
}

/** First line of the `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer; "" when empty, undefined when absent. */
export function breakingNote(body: string): string | undefined {
    const match = body.match(BREAKING_FOOTER);
    return match ? (match[1] ?? "").trim() : undefined;
}

export function sectionOf(type: string | undefined, breaking: boolean): Section {
    if (breaking) return "breaking";
    switch (type) {
        case "feat":
        case "feature":
            return "features";
        case "fix":
        case "bugfix":
        case "hotfix":
            return "fixes";
        case "perf":
            return "performance";
        case "security":
        case "sec":
            return "security";
        case "docs":
        case "doc":
            return "documentation";
        default:
            return "other";
    }
}

/** Version strings, hashes and standards look like ticket keys: never treat them as tickets. */
const NOT_TICKETS = new Set([
    "UTF",
    "SHA",
    "MD",
    "ISO",
    "RFC",
    "CVE",
    "CWE",
    "GHSA",
    "HTTP",
    "TLS",
    "SSL",
    "AES",
    "RSA",
    "ES",
    "ECMA",
    "PEP",
    "GPL",
    "LGPL",
    "AGPL",
    "BSD",
    "X",
    "WCAG",
    "IPV"
]);

export interface ReferenceOptions {
    /** Only these ticket prefixes count (e.g. ["PROJ"]); default: any `ABC-123` key except standards. */
    ticketPrefixes?: string[];
}

/** `#12` issues/pull requests, `!45` GitLab merge requests and `ABC-123` ticket keys, in order of appearance. */
export function findReferences(text: string, options: ReferenceOptions = {}): Reference[] {
    const found: {index: number; ref: Reference}[] = [];
    for (const match of text.matchAll(/(?<![&\w/#])#(\d+)\b/g)) {
        found.push({index: match.index, ref: {kind: "issue", id: `#${match[1]}`}});
    }
    for (const match of text.matchAll(/(?<![!\d])!(\d+)\b/g)) {
        found.push({index: match.index, ref: {kind: "merge_request", id: `!${match[1]}`}});
    }
    const prefixes = options.ticketPrefixes?.map((prefix) => prefix.toUpperCase());
    for (const match of text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]{0,15})-(\d+)\b/g)) {
        const prefix = match[1] as string;
        if (prefixes ? !prefixes.includes(prefix) : NOT_TICKETS.has(prefix)) continue;
        found.push({index: match.index, ref: {kind: "ticket", id: `${prefix}-${match[2]}`}});
    }
    const seen = new Set<string>();
    return found
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.ref)
        .filter((ref) => (seen.has(ref.id) ? false : (seen.add(ref.id), true)));
}

const MERGE =
    /^Merge (?:branch|pull request|remote-tracking branch|tag|commit|changes|remote branch)\b|^Merged? .+ into .+/i;

/** Why a commit is left out of the notes: merge commits and `chore(release)` commits. */
export function skipReason(commit: Pick<Commit, "subject">): "merge" | "release" | undefined {
    if (MERGE.test(commit.subject)) return "merge";
    if (/^chore\(release\)!?:/i.test(commit.subject.trim())) return "release";
    return undefined;
}

/**
 * Turns a commit into a release entry. A non-conventional commit goes to "other", unless it
 * references exactly one merge request whose (conventional) title is in `titles`.
 */
export function toEntry(
    commit: Pick<Commit, "sha" | "subject" | "body">,
    options: ReferenceOptions & {titles?: Record<string, string>} = {}
): ReleaseEntry {
    const references = findReferences(`${commit.subject}\n${commit.body}`, options);
    let parsed = parseConventionalSubject(commit.subject);
    if (!parsed && options.titles) {
        const linked = references.filter((ref) => ref.kind !== "ticket" && options.titles?.[ref.id] !== undefined);
        if (linked.length === 1)
            parsed = parseConventionalSubject(options.titles[(linked[0] as Reference).id] as string);
    }
    const note = breakingNote(commit.body);
    const breaking = (parsed?.breaking ?? false) || note !== undefined;
    return {
        sha: commit.sha,
        shortSha: commit.sha.slice(0, 7),
        ...(parsed ? {type: parsed.type} : {}),
        ...(parsed?.scope ? {scope: parsed.scope} : {}),
        description: parsed?.description ?? commit.subject.trim(),
        breaking,
        ...(note ? {breakingNote: note} : {}),
        section: sectionOf(parsed?.type, breaking),
        references,
        subject: commit.subject
    };
}
