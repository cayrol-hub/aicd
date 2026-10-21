import {callLlm} from "@aicd/core";
import {log, previousTag as findPreviousTag, revParse, tags} from "@aicd/git";
import type {AgentResult, AgentRuntime, Language, ProposedAction} from "@aicd/plugin-sdk";
import {INTERNAL_TYPES, SECTIONS, skipReason, toEntry, type ReleaseEntry} from "./conventional.js";
import {buildPrompt, LlmNotesSchema, SYSTEM_PROMPT, verifyNotes, type Audience} from "./llm.js";
import {commitLink, entryBullet, inline, renderNotes, type LinkOptions, type NotesSection} from "./render.js";

export const AGENT_NAME = "release-notes";

export interface ReleaseNotesOptions extends LinkOptions {
    /** Default: the runtime language. */
    language?: Language;
    /** Audience whose notes go into the release. Default "technical" (or the first audience generated). */
    primaryAudience?: Audience;
    /** Rewrite the notes with the LLM when one is available. Default true. */
    useLlm?: boolean;
    /** Release name; `{tag}` is replaced. Default: the tag. */
    releaseName?: string;
    /** Only these ticket prefixes count as ticket keys. */
    ticketPrefixes?: string[];
    /** Commits read at most. Default 1000. */
    maxCommits?: number;
}

export interface ReleaseNotesInput {
    cwd: string;
    tag: string;
    /** Default: the tag before `tag` (`@aicd/git` `previousTag`). */
    previousTag?: string;
    audiences?: Audience[];
    /** Titles of merge / pull requests by reference ("!45", "#12"): classify squash commits, context for the LLM. */
    mergeRequestTitles?: Record<string, string>;
    options?: ReleaseNotesOptions;
}

export interface AudienceNotes {
    audience: Audience;
    markdown: string;
    /** llm: rewritten and verified; deterministic: conventional commit draft. */
    source: "deterministic" | "llm";
    bullets: number;
    /** LLM bullets dropped because they cited unknown SHAs or references. */
    dropped: number;
}

export interface ReleaseNotesReport {
    tag: string;
    previousTag?: string;
    range: string;
    commits: number;
    skipped: {sha: string; subject: string; reason: "merge" | "release"}[];
    entries: ReleaseEntry[];
    notes: Partial<Record<Audience, AudienceNotes>>;
    primary?: Audience;
}

/** Entries of an audience: users never see internal work (chore, ci, test, refactor, build, style). */
export function entriesFor(entries: ReleaseEntry[], audience: Audience): ReleaseEntry[] {
    if (audience === "technical") return entries;
    return entries.filter((entry) => entry.breaking || !entry.type || !INTERNAL_TYPES.includes(entry.type));
}

/** Deterministic sections: one bullet per entry, in log order, grouped in `SECTIONS` order. */
export function draftSections(entries: ReleaseEntry[], links: LinkOptions): NotesSection[] {
    return SECTIONS.map((section) => ({
        section,
        bullets: entries.filter((entry) => entry.section === section).map((entry) => entryBullet(entry, links))
    })).filter((section) => section.bullets.length > 0);
}

function linksFor(runtime: AgentRuntime, options: ReleaseNotesOptions): LinkOptions {
    const provider = runtime.context.provider;
    const forge = options.forge ?? (provider === "gitlab" ? "gitlab" : provider === "github" ? "github" : undefined);
    const repositoryUrl =
        options.repositoryUrl ??
        (forge === "github" && runtime.context.repository
            ? `https://github.com/${runtime.context.repository}`
            : undefined);
    return {
        ...(forge ? {forge} : {}),
        ...(repositoryUrl ? {repositoryUrl} : {}),
        ...(options.ticketUrl ? {ticketUrl: options.ticketUrl} : {})
    };
}

/**
 * Release notes for `tag`: commits since the previous tag, sorted into conventional-commit
 * sections (always available, no LLM), then optionally rewritten per audience by the LLM.
 * LLM bullets must cite SHAs of the input commits; if fewer than half survive, the draft is kept.
 * Proposes a `draft_release` with the primary audience's notes.
 */
export async function generateReleaseNotes(
    runtime: AgentRuntime,
    input: ReleaseNotesInput
): Promise<AgentResult<ReleaseNotesReport>> {
    const {logger, budget} = runtime;
    const options = input.options ?? {};
    const language = options.language ?? runtime.language;
    const audiences = [...new Set(input.audiences?.length ? input.audiences : (["technical"] as Audience[]))];
    const links = linksFor(runtime, options);
    const git = {cwd: input.cwd};

    const head = (await revParse(input.tag, git)) ? input.tag : "HEAD";
    if (head === "HEAD") logger.warn(`${AGENT_NAME}: tag ${input.tag} not found, using HEAD`);
    const previousTag = input.previousTag ?? (await findPreviousTag(input.tag, git));
    const range = previousTag ? `${previousTag}..${head}` : head;
    const date = (await tags(git).catch(() => [])).find((tag) => tag.name === input.tag)?.date.slice(0, 10);

    const commits = await log(range, {...git, maxCount: options.maxCommits ?? 1000});
    const skipped: ReleaseNotesReport["skipped"] = [];
    const entries: ReleaseEntry[] = [];
    const bodies = new Map<string, string>();
    const titles = Object.fromEntries(
        Object.entries(input.mergeRequestTitles ?? {}).map(([id, title]) => [id, runtime.redact(title)])
    );
    for (const commit of commits) {
        const subject = runtime.redact(commit.subject);
        const body = runtime.redact(commit.body);
        const reason = skipReason({subject});
        if (reason) {
            skipped.push({sha: commit.sha, subject, reason});
            continue;
        }
        bodies.set(commit.sha, body);
        entries.push(
            toEntry(
                {sha: commit.sha, subject, body},
                {titles, ...(options.ticketPrefixes ? {ticketPrefixes: options.ticketPrefixes} : {})}
            )
        );
    }

    const spentBefore = budget.spentUsd;
    let llmCalls = 0;
    const notes: ReleaseNotesReport["notes"] = {};
    const render = (sections: NotesSection[]) =>
        renderNotes(sections, {
            tag: input.tag,
            ...(previousTag ? {previousTag} : {}),
            ...(date ? {date} : {}),
            language,
            links
        });

    for (const audience of audiences) {
        const audienceEntries = entriesFor(entries, audience);
        const draft = draftSections(audienceEntries, links);
        const deterministic: AudienceNotes = {
            audience,
            markdown: render(draft),
            source: "deterministic",
            bullets: audienceEntries.length,
            dropped: 0
        };
        notes[audience] = deterministic;
        if (options.useLlm === false || audienceEntries.length === 0) continue;

        const response = await callLlm(runtime, AGENT_NAME, {
            system: SYSTEM_PROMPT,
            prompt: buildPrompt({
                tag: input.tag,
                ...(previousTag ? {previousTag} : {}),
                audience,
                language,
                entries: audienceEntries,
                bodies,
                titles
            }),
            schema: LlmNotesSchema
        });
        if (!response) continue;
        llmCalls++;
        const verified = verifyNotes(
            response.output,
            audienceEntries,
            options.ticketPrefixes ? {ticketPrefixes: options.ticketPrefixes} : {}
        );
        if (verified.bullets.length === 0 || verified.bullets.length * 2 < verified.total) {
            logger.warn(
                `${AGENT_NAME}: ${verified.dropped}/${verified.total} ${audience} bullets cite unknown commits, keeping the draft`
            );
            notes[audience] = {...deterministic, dropped: verified.dropped};
            continue;
        }
        const sections = SECTIONS.map((section) => ({
            section,
            bullets: verified.bullets
                .filter((bullet) => bullet.section === section)
                .map(
                    (bullet) =>
                        `- ${inline(bullet.text)} (${bullet.shas.map((sha) => commitLink(sha, links)).join(", ")})`
                )
        }));
        notes[audience] = {
            audience,
            markdown: render(sections),
            source: "llm",
            bullets: verified.bullets.length,
            dropped: verified.dropped
        };
    }

    const primary = options.primaryAudience && notes[options.primaryAudience] ? options.primaryAudience : audiences[0];
    const report: ReleaseNotesReport = {
        tag: input.tag,
        ...(previousTag ? {previousTag} : {}),
        range,
        commits: commits.length,
        skipped,
        entries,
        notes,
        ...(primary ? {primary} : {})
    };
    const actions: ProposedAction[] = [];
    const body = primary ? notes[primary]?.markdown : undefined;
    if (body && entries.length > 0) {
        actions.push({
            type: "draft_release",
            release: {
                tag: input.tag,
                name: (options.releaseName ?? "{tag}").replace("{tag}", input.tag),
                body,
                draft: true
            },
            reason: `${entries.length} change(s) since ${previousTag ?? "the first commit"}`
        });
    } else {
        logger.info(`${AGENT_NAME}: no change in ${range}, no release drafted`);
    }
    return {
        agent: AGENT_NAME,
        actions,
        report,
        llmCalls,
        costUsd: Math.max(0, budget.spentUsd - spentBefore)
    };
}
