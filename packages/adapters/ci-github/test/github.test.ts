import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {GitHubCIProvider} from "@aicd-ci/adapter-ci-github";

const API = "https://api.github.com";

function eventFile(): string {
    const path = join(mkdtempSync(join(tmpdir(), "aicd-gh-")), "event.json");
    writeFileSync(
        path,
        JSON.stringify({
            pull_request: {
                number: 7,
                html_url: "u",
                title: "t",
                body: null,
                head: {ref: "f", sha: "a", repo: {full_name: "acme/app", fork: false}},
                base: {ref: "main", sha: "b", repo: {full_name: "acme/app"}}
            }
        })
    );
    return path;
}

function fakeFetch(routes: Record<string, unknown>, calls: string[]) {
    return (async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url.replace(API, "")}`;
        calls.push(key);
        const body = routes[key];
        if (body === undefined) return new Response("{}", {status: 404});
        return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
}

describe("GitHubCIProvider.upsertComment", () => {
    const env = {GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "t", GITHUB_EVENT_PATH: eventFile()};

    it("updates its own bot comment, never someone else's copy of the marker", async () => {
        const calls: string[] = [];
        const provider = new GitHubCIProvider({
            env,
            fetch: fakeFetch(
                {
                    "GET /repos/acme/app/issues/7/comments?per_page=100&page=1": [
                        {id: 1, body: "<!-- aicd:risk --> fake", user: {login: "mallory", type: "User"}},
                        {id: 2, body: "<!-- aicd:risk --> old", user: {login: "github-actions[bot]", type: "Bot"}}
                    ],
                    "PATCH /repos/acme/app/issues/comments/2": {}
                },
                calls
            )
        });
        await provider.upsertComment("<!-- aicd:risk -->", "new");
        expect(calls.at(-1)).toBe("PATCH /repos/acme/app/issues/comments/2");
    });

    it("with a personal token, matches its own login and pages through long threads", async () => {
        const calls: string[] = [];
        const page1 = Array.from({length: 100}, (_, i) => ({
            id: 100 + i,
            body: "chat",
            user: {login: "dev", type: "User"}
        }));
        const provider = new GitHubCIProvider({
            env,
            fetch: fakeFetch(
                {
                    "GET /user": {login: "aicd-bot"},
                    "GET /repos/acme/app/issues/7/comments?per_page=100&page=1": page1,
                    "GET /repos/acme/app/issues/7/comments?per_page=100&page=2": [
                        {id: 9, body: "<!-- aicd:risk --> old", user: {login: "aicd-bot", type: "User"}}
                    ],
                    "PATCH /repos/acme/app/issues/comments/9": {}
                },
                calls
            )
        });
        await provider.upsertComment("<!-- aicd:risk -->", "new");
        expect(calls.at(-1)).toBe("PATCH /repos/acme/app/issues/comments/9");
    });

    it("creates a comment when none of its own exists", async () => {
        const calls: string[] = [];
        const provider = new GitHubCIProvider({
            env,
            fetch: fakeFetch(
                {
                    "GET /repos/acme/app/issues/7/comments?per_page=100&page=1": [
                        {id: 1, body: "<!-- aicd:risk -->", user: {login: "mallory", type: "User"}}
                    ],
                    "POST /repos/acme/app/issues/7/comments": {}
                },
                calls
            )
        });
        await provider.upsertComment("<!-- aicd:risk -->", "new");
        expect(calls.at(-1)).toBe("POST /repos/acme/app/issues/7/comments");
    });
});
