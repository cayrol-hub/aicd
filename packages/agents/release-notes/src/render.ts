import type {Language} from "@aicd/plugin-sdk";
import {SECTIONS, type Reference, type ReleaseEntry, type Section} from "./conventional.js";

const TEXT = {
    en: {
        sections: {
            breaking: "Breaking changes",
            features: "Features",
            fixes: "Fixes",
            performance: "Performance",
            security: "Security",
            documentation: "Documentation",
            other: "Other changes"
        },
        since: (previous: string) => `Changes since ${previous}`,
        initial: "First release",
        compare: "full comparison",
        empty: "No notable changes."
    },
    fr: {
        sections: {
            breaking: "Changements incompatibles",
            features: "Nouveautés",
            fixes: "Corrections",
            performance: "Performances",
            security: "Sécurité",
            documentation: "Documentation",
            other: "Autres changements"
        },
        since: (previous: string) => `Changements depuis ${previous}`,
        initial: "Première version",
        compare: "comparaison complète",
        empty: "Aucun changement notable."
    }
} satisfies Record<Language, unknown>;

export function sectionTitle(section: Section, language: Language): string {
    return TEXT[language].sections[section];
}

/** Where commits, issues, merge requests and tickets live. Without a URL, references stay plain text. */
export interface LinkOptions {
    /** e.g. https://gitlab.example.com/group/project (no trailing slash needed). */
    repositoryUrl?: string;
    forge?: "github" | "gitlab";
    /** Ticket URL template with `{key}`, e.g. https://acme.atlassian.net/browse/{key}. */
    ticketUrl?: string;
}

const base = (links: LinkOptions) => links.repositoryUrl?.replace(/\/+$/, "");

export function commitLink(sha: string, links: LinkOptions): string {
    const short = sha.slice(0, 7);
    const repo = base(links);
    if (!repo) return `\`${short}\``;
    return `[\`${short}\`](${repo}${links.forge === "gitlab" ? "/-" : ""}/commit/${sha})`;
}

export function referenceLink(ref: Reference, links: LinkOptions): string {
    const repo = base(links);
    const number = ref.id.slice(1);
    if (ref.kind === "ticket")
        return links.ticketUrl ? `[${ref.id}](${links.ticketUrl.replace("{key}", ref.id)})` : ref.id;
    if (!repo) return ref.id;
    if (links.forge === "gitlab") {
        return `[${ref.id}](${repo}/-/${ref.kind === "issue" ? "issues" : "merge_requests"}/${number})`;
    }
    // GitHub redirects /issues/N to the pull request when N is one; "!N" means nothing there.
    return ref.kind === "issue" ? `[${ref.id}](${repo}/issues/${number})` : ref.id;
}

export function compareLink(previous: string, tag: string, links: LinkOptions): string | undefined {
    const repo = base(links);
    if (!repo) return undefined;
    return `${repo}${links.forge === "gitlab" ? "/-" : ""}/compare/${previous}...${tag}`;
}

/** Single-line Markdown text: no line breaks, no heading or list markers at the start. */
export function inline(text: string): string {
    return text
        .replace(/\s+/g, " ")
        .replace(/^[-*#>\s]+/, "")
        .trim();
}

/** One deterministic bullet: `**scope:** description (sha, refs)`. */
export function entryBullet(entry: ReleaseEntry, links: LinkOptions): string {
    const scope = entry.scope ? `**${inline(entry.scope)}:** ` : "";
    const note = entry.breakingNote ? ` — ${inline(entry.breakingNote)}` : "";
    const refs = [commitLink(entry.sha, links), ...entry.references.map((ref) => referenceLink(ref, links))];
    return `- ${scope}${inline(entry.description)}${note} (${refs.join(", ")})`;
}

export interface NotesSection {
    section: Section;
    bullets: string[];
}

/** Release notes Markdown: heading, range line, then one `###` block per non-empty section in `SECTIONS` order. */
export function renderNotes(
    sections: NotesSection[],
    options: {tag: string; previousTag?: string; date?: string; language: Language; links: LinkOptions}
): string {
    const t = TEXT[options.language];
    const heading = `## ${options.tag}${options.date ? ` (${options.date})` : ""}`;
    const compare = options.previousTag ? compareLink(options.previousTag, options.tag, options.links) : undefined;
    const range = options.previousTag
        ? `_${t.since(options.previousTag)}${compare ? ` · [${t.compare}](${compare})` : ""}_`
        : `_${t.initial}_`;
    const blocks = sections
        .filter((section) => section.bullets.length > 0)
        .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section))
        .map((section) => [`### ${t.sections[section.section]}`, "", ...section.bullets].join("\n"));
    return [heading, range, ...(blocks.length > 0 ? blocks : [`_${t.empty}_`])].join("\n\n");
}
