import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {
    commitLink,
    findReferences,
    generateReleaseNotes,
    referenceLink,
    renderNotes,
    parseConventionalSubject,
    SYSTEM_PROMPT,
    toEntry,
    type LlmNotes
} from "@aicd/agent-release-notes";
import {RunBudget} from "@aicd/core";
import {LLMError, type AgentRuntime, type LLMProvider, type StructuredRequest} from "@aicd/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_test",
        context: {provider: "gitlab", repository: "acme/app", isFork: false},
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text,
        language: "en",
        sendCode: "diff_only",
        now: () => new Date("2026-10-21T10:00:00Z"),
        ...overrides
    };
}

/** Fake provider: builds its answer from the SHAs listed in the prompt. */
function fakeLlm(answer: (shas: string[]) => LlmNotes | Error): LLMProvider & {requests: StructuredRequest<unknown>[]} {
    const provider = {
        name: "fake",
        model: "fake-model",
        requests: [] as StructuredRequest<unknown>[],
        async generateStructured<T>(request: StructuredRequest<T>) {
            provider.requests.push(request as StructuredRequest<unknown>);
            const shas = [...request.prompt.matchAll(/sha=([0-9a-f]+)/g)].map((m) => m[1] as string);
            const output = answer(shas);
            if (output instanceof Error) throw output;
            return {
                output: request.schema.parse(output),
                usage: {model: "fake-model", inputTokens: 100, outputTokens: 50, costUsd: 0.002}
            };
        }
    };
    return provider;
}

let repo: string;
const sha: Record<string, string> = {};
let day = 1;

function git(...args: string[]): string {
    const date = `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`;
    return execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
        cwd: repo,
        stdio: "pipe",
        env: {...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date}
    }).toString();
}

function commit(key: string, message: string): void {
    day++;
    git("commit", "-q", "--allow-empty", "-m", message);
    sha[key] = git("rev-parse", "HEAD").trim();
}

beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "aicd-notes-"));
    git("init", "-q", "-b", "main");
    commit("old", "feat: before the previous release");
    git("tag", "v1.0.0");
    commit("feat", "feat(api): add the tokens endpoint (#12)");
    commit("fix", "fix: handle a missing phone number\n\nRefs PROJ-7, encoding stays UTF-8.");
    commit("perf", "perf(db): index tokens by user");
    commit("docs", "docs: describe the tokens API");
    commit("chore", "chore(deps): bump fastify");
    commit("ci", "ci: cache node_modules");
    commit("breaking", "feat!: drop Node 18");
    commit("refactor", "refactor(config): rename keys\n\nBREAKING CHANGE: `token.ttl` is now `token.ttl_seconds`");
    commit("merge", "Merge branch 'feature/x' into 'main'");
    commit("release", "chore(release): 1.0.1 [skip ci]");
    commit("squash", 'Resolve "Faster login"\n\nSee merge request acme/app!45');
    commit("security", "security: escape names in receipts");
    commit("other", "update readme wording");
    git("tag", "v1.1.0");
});

afterAll(() => rmSync(repo, {recursive: true, force: true}));

describe("conventional commits", () => {
    it("parses subjects, breaking markers and references", () => {
        expect(parseConventionalSubject("feat(api)!: add x")).toEqual({
            type: "feat",
            scope: "api",
            breaking: true,
            description: "add x"
        });
        expect(parseConventionalSubject("Update readme")).toBeUndefined();
        expect(findReferences("fix #12 and !45 for PROJ-7, UTF-8, SHA-256, acme/app#3, &#38;")).toEqual([
            {kind: "issue", id: "#12"},
            {kind: "merge_request", id: "!45"},
            {kind: "ticket", id: "PROJ-7"}
        ]);
        expect(findReferences("ABC-1 PROJ-2", {ticketPrefixes: ["proj"]})).toEqual([{kind: "ticket", id: "PROJ-2"}]);
    });

    it("classifies a squash commit by its merge request title", () => {
        const entry = toEntry(
            {sha: "a".repeat(40), subject: 'Resolve "Faster login"', body: "See merge request acme/app!45"},
            {titles: {"!45": "perf(auth): faster login"}}
        );
        expect(entry).toMatchObject({section: "performance", type: "perf", scope: "auth", description: "faster login"});
    });
});

describe("rendering", () => {
    it("links GitHub references and orders sections", () => {
        const links = {repositoryUrl: "https://github.com/acme/app/", forge: "github" as const};
        expect(commitLink("abcdef1234", links)).toBe("[`abcdef1`](https://github.com/acme/app/commit/abcdef1234)");
        expect(referenceLink({kind: "issue", id: "#3"}, links)).toBe("[#3](https://github.com/acme/app/issues/3)");
        expect(referenceLink({kind: "merge_request", id: "!4"}, links)).toBe("!4");
        expect(referenceLink({kind: "ticket", id: "PROJ-1"}, links)).toBe("PROJ-1");
        const markdown = renderNotes(
            [
                {section: "other", bullets: ["- b"]},
                {section: "fixes", bullets: ["- a"]},
                {section: "features", bullets: []}
            ],
            {tag: "v2", previousTag: "v1", language: "fr", links}
        );
        expect(markdown).toBe(
            "## v2\n\n_Changements depuis v1 · [comparaison complète](https://github.com/acme/app/compare/v1...v2)_\n\n### Corrections\n\n- a\n\n### Autres changements\n\n- b"
        );
    });
});

describe("generateReleaseNotes (deterministic)", () => {
    it("drafts sections since the previous tag, with links", async () => {
        const result = await generateReleaseNotes(runtime(), {
            cwd: repo,
            tag: "v1.1.0",
            audiences: ["technical"],
            mergeRequestTitles: {"!45": "perf(auth): faster login"},
            options: {
                repositoryUrl: "https://gitlab.example.com/acme/app",
                ticketUrl: "https://jira.example.com/browse/{key}"
            }
        });
        const {report} = result;
        expect(report.previousTag).toBe("v1.0.0");
        expect(report.range).toBe("v1.0.0..v1.1.0");
        expect(report.skipped.map((s) => s.reason)).toEqual(["release", "merge"]);
        expect(report.entries.map((e) => e.sha)).not.toContain(sha.old);
        const bySection = Object.fromEntries(report.entries.map((e) => [e.shortSha, e.section]));
        expect(bySection[sha.breaking!.slice(0, 7)]).toBe("breaking");
        expect(bySection[sha.refactor!.slice(0, 7)]).toBe("breaking");
        expect(bySection[sha.squash!.slice(0, 7)]).toBe("performance");
        expect(bySection[sha.security!.slice(0, 7)]).toBe("security");
        expect(bySection[sha.other!.slice(0, 7)]).toBe("other");

        const markdown = report.notes.technical!.markdown;
        expect(markdown).toContain("## v1.1.0 (2026-10-15)");
        expect(markdown).toContain(
            "_Changes since v1.0.0 · [full comparison](https://gitlab.example.com/acme/app/-/compare/v1.0.0...v1.1.0)_"
        );
        const titles = [...markdown.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        expect(titles).toEqual([
            "Breaking changes",
            "Features",
            "Fixes",
            "Performance",
            "Security",
            "Documentation",
            "Other changes"
        ]);
        expect(markdown).toContain(
            `- **api:** add the tokens endpoint (#12) ([\`${sha.feat!.slice(0, 7)}\`](https://gitlab.example.com/acme/app/-/commit/${sha.feat}), [#12](https://gitlab.example.com/acme/app/-/issues/12))`
        );
        expect(markdown).toContain("[PROJ-7](https://jira.example.com/browse/PROJ-7))");
        expect(markdown).not.toContain("UTF-8](");
        expect(markdown).toContain("rename keys — `token.ttl` is now `token.ttl_seconds`");
        expect(markdown).toContain("[!45](https://gitlab.example.com/acme/app/-/merge_requests/45)");
        expect(markdown).not.toContain("Merge branch");
        expect(markdown).not.toContain("chore(release)");

        expect(result.llmCalls).toBe(0);
        expect(result.actions).toEqual([
            {
                type: "draft_release",
                release: {tag: "v1.1.0", name: "v1.1.0", body: markdown, draft: true},
                reason: "11 change(s) since v1.0.0"
            }
        ]);
    });

    it("leaves internal work out of the users notes and localizes titles", async () => {
        const result = await generateReleaseNotes(runtime({language: "fr"}), {
            cwd: repo,
            tag: "v1.1.0",
            audiences: ["technical", "users"],
            options: {primaryAudience: "users", releaseName: "Version {tag}"}
        });
        const users = result.report.notes.users!.markdown;
        expect(users).toContain("_Changements depuis v1.0.0_");
        expect(users).toContain("### Changements incompatibles");
        expect(users).toContain("### Nouveautés");
        expect(users).not.toContain("bump fastify");
        expect(users).not.toContain("cache node_modules");
        expect(users).toContain("rename keys"); // breaking refactors stay
        expect(result.report.notes.technical!.markdown).toContain("bump fastify");
        expect(result.actions[0]).toMatchObject({release: {name: "Version v1.1.0", body: users}});
    });

    it("uses HEAD for an unknown tag and proposes nothing for an empty range", async () => {
        const ahead = await generateReleaseNotes(runtime(), {cwd: repo, tag: "v9.9.9", previousTag: "v1.1.0"});
        expect(ahead.report.range).toBe("v1.1.0..HEAD");
        expect(ahead.report.notes.technical!.markdown).toContain("_No notable changes._");
        expect(ahead.actions).toEqual([]);
        const first = await generateReleaseNotes(runtime(), {cwd: repo, tag: "v1.0.0"});
        expect(first.report.range).toBe("v1.0.0");
        expect(first.report.notes.technical!.markdown).toContain("_First release_");
    });
});

describe("generateReleaseNotes (LLM)", () => {
    it("keeps verified bullets and drops those citing unknown SHAs", async () => {
        const llm = fakeLlm((shas) => ({
            sections: [
                {section: "features", bullets: [{text: "New endpoint to list saved tokens (#12).", shas: [shas[0]!]}]},
                {section: "fixes", bullets: shas.slice(1).map((s) => ({text: `Change ${s}`, shas: [s]}))},
                {section: "other", bullets: [{text: "Invented change", shas: ["deadbee"]}]}
            ]
        }));
        const result = await generateReleaseNotes(runtime({llm}), {cwd: repo, tag: "v1.1.0", audiences: ["technical"]});
        const notes = result.report.notes.technical!;
        expect(notes).toMatchObject({source: "llm", dropped: 1, bullets: 11});
        expect(notes.markdown).toContain(`- New endpoint to list saved tokens (#12). (\`${sha.other!.slice(0, 7)}\`)`);
        expect(notes.markdown).not.toContain("Invented change");
        // The breaking change is kept in its section whatever the model said.
        expect(notes.markdown).toMatch(/### Breaking changes\n\n- Change [0-9a-f]{7}/);
        expect(result.llmCalls).toBe(1);
        expect(result.costUsd).toBeCloseTo(0.002);
        expect(llm.requests[0]?.system).toBe(SYSTEM_PROMPT);
        expect(llm.requests[0]?.prompt).toContain("<commits>");
        expect(result.actions[0]).toMatchObject({release: {body: notes.markdown, draft: true}});
    });

    it("drops bullets citing unknown references and falls back when fewer than half survive", async () => {
        const llm = fakeLlm((shas) => ({
            sections: [
                {
                    section: "features",
                    bullets: [
                        {text: "Real change", shas: [shas[0]!]},
                        {text: "Fixes #999", shas: [shas[1]!]},
                        {text: "No SHA", shas: []},
                        {text: "Half invented", shas: [shas[2]!, "0123456"]}
                    ]
                }
            ]
        }));
        const result = await generateReleaseNotes(runtime({llm}), {cwd: repo, tag: "v1.1.0", audiences: ["users"]});
        expect(result.report.notes.users).toMatchObject({source: "deterministic", dropped: 3});
        expect(result.report.notes.users!.markdown).not.toContain("Real change");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("keeping the draft"));
        // The users prompt only lists the commits users may see.
        expect(llm.requests[0]?.prompt).not.toContain(sha.chore!.slice(0, 7));
    });

    it("falls back to the draft when the LLM fails, is disabled or the code comes from a fork", async () => {
        const failing = fakeLlm(() => new LLMError("boom"));
        const failed = await generateReleaseNotes(runtime({llm: failing}), {cwd: repo, tag: "v1.1.0"});
        expect(failed.report.notes.technical?.source).toBe("deterministic");
        expect(failed.llmCalls).toBe(0);

        const unused = fakeLlm(() => ({sections: []}));
        await generateReleaseNotes(runtime({llm: unused}), {cwd: repo, tag: "v1.1.0", options: {useLlm: false}});
        await generateReleaseNotes(
            runtime({llm: unused, context: {provider: "gitlab", repository: "acme/app", isFork: true}}),
            {cwd: repo, tag: "v1.1.0"}
        );
        expect(unused.requests).toHaveLength(0);

        const empty = fakeLlm(() => ({sections: []}));
        const none = await generateReleaseNotes(runtime({llm: empty}), {cwd: repo, tag: "v1.1.0"});
        expect(none.report.notes.technical?.source).toBe("deterministic");
    });
});
