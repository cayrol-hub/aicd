import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {buildProgram, ciFromEvent} from "@aicd/cli";

let cwd: string;
let base: string;
const originalCwd = process.cwd();
const savedEnv = {...process.env};

/** Runs the CLI in-process and captures stdout and the exit code. */
async function aicd(...args: string[]): Promise<{code: number; stdout: string; stderr: string}> {
    let code = 0;
    let stdout = "";
    let stderr = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
    });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
    });
    try {
        await buildProgram((value) => (code = value)).parseAsync(["node", "aicd", ...args]);
    } finally {
        write.mockRestore();
        errors.mockRestore();
    }
    return {code, stdout, stderr};
}

const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=dev", "-c", "user.email=dev@example.com", ...args], {cwd, encoding: "utf8"});

const junit = (failed: boolean) =>
    `<testsuite name="s"><testcase classname="sync" name="completes">${failed ? '<failure message="timeout"/>' : ""}</testcase></testsuite>`;

beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "aicd-cli-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "pricing.ts"), "export const cap = (pct: number) => Math.min(pct, 50);\n");
    git("add", "-A");
    git("commit", "-qm", "feat: pricing");
    git("tag", "v1.0.0");
    base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(cwd, "pricing.ts"), "export const cap = (pct: number) => pct;\n");
    git("commit", "-qam", "fix(pricing): remove the cap");
    git("tag", "v1.1.0");
    writeFileSync(
        join(cwd, ".aicd.yaml"),
        "llm:\n  provider: none\nagents:\n  flaky:\n    autonomy: act\n    min_runs: 3\n    quarantine_after: 1\n"
    );
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (/^(GITHUB_|GITLAB_|CI_|AICD_)/.test(key)) delete process.env[key];
});

afterAll(() => {
    process.chdir(originalCwd);
    process.env = savedEnv;
});

describe("aicd CLI", () => {
    it("analyze: comments the triage of a failing test and records the run", async () => {
        writeFileSync(join(cwd, "junit.xml"), junit(true));
        const {code, stdout, stderr} = await aicd("analyze", "--ci", "local", "--junit", "junit.xml");
        expect(code).toBe(0);
        // Local comments go to stderr: stdout stays clean for --json and `tests select`.
        expect(stderr).toContain("<!-- aicd:triage -->");
        expect(stdout).toBe("");
        const explained = await aicd("explain");
        expect(explained.stdout).toMatch(/triage: .*regression/);
    });

    it("quarantines a test that flips on the same commit, then lets the gate pass", async () => {
        process.env.AICD_COMMIT_SHA = "c1";
        for (const failed of [false, true, false, true]) {
            writeFileSync(join(cwd, "junit.xml"), junit(failed));
            await aicd("analyze", "--ci", "local", "--junit", "junit.xml", "-q");
        }
        delete process.env.AICD_COMMIT_SHA;
        expect((await aicd("quarantine", "list", "--json")).stdout).toContain("sync::completes");
        expect((await aicd("quarantine", "check", "--junit", "junit.xml")).code).toBe(0);
        writeFileSync(
            join(cwd, "other.xml"),
            '<testsuite name="s"><testcase classname="x" name="y"><failure/></testcase></testsuite>'
        );
        expect((await aicd("quarantine", "check", "--junit", "other.xml")).code).toBe(1);
    });

    it("review: risk and intent on a merge request diff", async () => {
        writeFileSync(join(cwd, "mr.diff"), git("diff", "v1.0.0", "v1.1.0"));
        process.env.AICD_MR_TITLE = "fix(pricing): remove the cap";
        process.env.AICD_BASE_SHA = base;
        const {code, stdout} = await aicd("review", "--ci", "local", "--diff", "mr.diff", "--json");
        delete process.env.AICD_MR_TITLE;
        delete process.env.AICD_BASE_SHA;
        expect(code).toBe(0);
        const result = JSON.parse(stdout.slice(stdout.indexOf("{\n"))) as {agents: {agent: string}[]};
        expect(result.agents.map((agent) => agent.agent)).toEqual(["risk", "intent"]);
    });

    it("release-notes, deploy record and dora", async () => {
        const notes = await aicd("release-notes", "--tag", "v1.1.0", "-q");
        expect(notes.stdout).toContain("remove the cap");
        await aicd(
            "deploy",
            "record",
            "--env",
            "production",
            "--status",
            "success",
            "--id",
            "d1",
            "--sha",
            git("rev-parse", "HEAD").trim(),
            "-q"
        );
        const dora = await aicd("dora", "--env", "production", "--json");
        expect(JSON.parse(dora.stdout)).toMatchObject({deploymentFrequency: {count: 1}});
    });

    it("survives log lines that a redaction mask used to turn into invalid JSON", async () => {
        writeFileSync(join(cwd, "job.log"), 'curl -H "x-api-key: abcd1234efgh" https://api\nError: request failed\n');
        const {code, stdout} = await aicd(
            "analyze",
            "--ci",
            "local",
            "--log",
            "job.log",
            "--junit",
            "none.xml",
            "--json"
        );
        expect(code).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({agents: [{agent: "triage"}]});
    });

    it("dry run leaves the state untouched", async () => {
        const before = (await aicd("explain", "--json")).stdout;
        await aicd("analyze", "--ci", "local", "--junit", "junit.xml", "--dry-run", "-q");
        expect((await aicd("explain", "--json")).stdout).toBe(before);
    });

    it("deploy record accepts --release-version and is not shadowed by aicd's --version", async () => {
        const {stdout} = await aicd(
            "deploy",
            "record",
            "--env",
            "staging",
            "--status",
            "success",
            "--id",
            "d2",
            "--release-version",
            "2.3.0",
            "--json"
        );
        expect(JSON.parse(stdout)).toMatchObject({id: "d2", version: "2.3.0"});
    });

    it("ignores a fork's own security, plugins and extends", async () => {
        writeFileSync(
            join(cwd, ".aicd.fork.yaml"),
            "security: {allow_forks: true}\nplugins: [evil]\nllm: {provider: none}\n"
        );
        process.env.GITHUB_ACTIONS = "true";
        process.env.GITHUB_REPOSITORY = "acme/app";
        process.env.GITHUB_EVENT_PATH = join(cwd, "event.json");
        writeFileSync(
            process.env.GITHUB_EVENT_PATH,
            JSON.stringify({
                pull_request: {
                    number: 1,
                    html_url: "",
                    title: "x",
                    body: null,
                    head: {ref: "f", sha: "a", repo: {full_name: "mallory/app", fork: true}},
                    base: {ref: "main", sha: "b", repo: {full_name: "acme/app"}}
                }
            })
        );
        const {code, stderr} = await aicd("doctor", "--config", ".aicd.fork.yaml", "--ci", "github");
        for (const key of ["GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH"]) delete process.env[key];
        expect(code).toBe(0);
        expect(stderr).toContain("code from a fork");
        expect(stderr).not.toContain('plugin "evil" not found');
    });

    it("refuses an invalid configuration with exit code 2", async () => {
        expect((await aicd("validate", "--set", "agents.triage.autonomy=yolo")).code).toBe(2);
        expect((await aicd("analyze", "--set", "nope.key=1")).code).toBe(2);
        expect((await aicd("replay", "--fixtures", ".", "--min-accuracy", "abc")).code).toBe(2);
    });
});

describe("server mode adapters", () => {
    it("builds a GitHub adapter from a pipeline event with the server's token only", async () => {
        const ci = ciFromEvent(
            {
                type: "pipeline_completed",
                provider: "github",
                repository: "acme/app",
                pipelineId: "42",
                status: "failed",
                sha: "abc",
                mergeRequestId: "7"
            },
            {AICD_GITHUB_TOKEN: "server-token"}
        );
        expect(await ci.getContext()).toMatchObject({
            provider: "github",
            repository: "acme/app",
            pipelineId: "42",
            mergeRequest: {id: "7"}
        });
    });

    it("builds a GitLab adapter from a merge request event", async () => {
        const ci = ciFromEvent(
            {
                type: "merge_request_updated",
                provider: "gitlab",
                repository: "group/app",
                id: "5",
                title: "feat: x",
                description: "",
                sourceBranch: "feat/x",
                targetBranch: "main",
                sha: "def",
                url: "https://gitlab.example.com/group/app/-/merge_requests/5",
                fork: false
            },
            {}
        );
        expect(await ci.getContext()).toMatchObject({
            provider: "gitlab",
            repository: "group/app",
            mergeRequest: {id: "5", title: "feat: x"}
        });
    });
});
