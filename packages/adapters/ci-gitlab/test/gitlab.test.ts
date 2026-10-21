import {describe, expect, it} from "vitest";
import {GitLabCIProvider, gitlabProvider} from "@aicd/adapter-ci-gitlab";

const env = {
    GITLAB_CI: "true",
    CI_API_V4_URL: "https://gitlab.example.com/api/v4",
    CI_PROJECT_ID: "12",
    CI_PROJECT_PATH: "acme/app",
    CI_PIPELINE_ID: "99",
    CI_JOB_ID: "1003",
    CI_COMMIT_SHA: "abc",
    CI_MERGE_REQUEST_IID: "5",
    CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.example.com/acme/app",
    AICD_GITLAB_TOKEN: "glpat-test"
};

function fakeFetch(routes: Record<string, unknown>, calls: string[]) {
    return (async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? "GET"} ${url.replace(env.CI_API_V4_URL, "")}`;
        calls.push(key);
        const body = routes[key];
        if (body === undefined) return new Response("not found", {status: 404});
        return new Response(typeof body === "string" ? body : JSON.stringify(body));
    }) as unknown as typeof fetch;
}

describe("GitLabCIProvider", () => {
    it("is detected from GITLAB_CI", () => {
        expect(gitlabProvider.detect(env)).toBe(true);
        expect(gitlabProvider.detect({})).toBe(false);
    });

    it("reads the context and flags fork merge requests", async () => {
        const context = await new GitLabCIProvider({
            env: {...env, CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "77"}
        }).getContext();
        expect(context).toMatchObject({repository: "acme/app", mergeRequest: {id: "5"}, isFork: true});
    });

    it("lists failed jobs with their trace, excluding its own job", async () => {
        const calls: string[] = [];
        const provider = new GitLabCIProvider({
            env,
            fetch: fakeFetch(
                {
                    "GET /projects/12/pipelines/99/jobs?per_page=100&scope[]=failed": [
                        {id: 1001, name: "test", web_url: "u", status: "failed"},
                        {id: 1003, name: "aicd", web_url: "u", status: "failed"}
                    ],
                    "GET /projects/12/jobs/1001/trace": "boom"
                },
                calls
            )
        });
        expect(await provider.listFailedJobs()).toEqual([{id: "1001", name: "test", url: "u", log: "boom"}]);
    });

    it("updates the existing note instead of posting a new one", async () => {
        const calls: string[] = [];
        const provider = new GitLabCIProvider({
            env,
            fetch: fakeFetch(
                {
                    "GET /user": {id: 77},
                    "GET /projects/12/merge_requests/5/notes?per_page=100&sort=desc": [
                        {id: 9, body: "copy of <!-- aicd:triage --> by someone", author: {id: 3}},
                        {id: 8, body: "<!-- aicd:triage --> old", author: {id: 77}}
                    ],
                    "PUT /projects/12/merge_requests/5/notes/8": {id: 8}
                },
                calls
            )
        });
        await provider.upsertComment("<!-- aicd:triage -->", "new");
        expect(calls.at(-1)).toBe("PUT /projects/12/merge_requests/5/notes/8");
    });
});
