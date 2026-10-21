import {appendFileSync, existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import type {
    CIProvider,
    CIProviderFactory,
    CIProviderOptions,
    CommitStatus,
    FailedJob,
    FixRequest,
    JobInfo,
    JobStatus,
    PipelineContext,
    PipelineSummary,
    ReleaseDraft
} from "@aicd-ci/plugin-sdk";

interface GitHubEvent {
    pull_request?: {
        number: number;
        html_url: string;
        title: string;
        body: string | null;
        head: {ref: string; sha: string; repo: {full_name: string; fork: boolean} | null};
        base: {ref: string; sha: string; repo: {full_name: string}};
    };
    repository?: {default_branch?: string};
}

interface GitHubComment {
    id: number;
    body?: string;
    user?: {login?: string; type?: string};
}

interface GitHubJob {
    id: number;
    name: string;
    html_url: string;
    status: string;
    conclusion: string | null;
    created_at?: string;
    started_at?: string | null;
    completed_at?: string | null;
}

interface GitHubRun {
    id: number;
    head_branch: string | null;
    head_sha: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
    run_started_at?: string;
    html_url: string;
}

function jobStatus(status: string, conclusion: string | null): JobStatus {
    if (status === "queued" || status === "waiting" || status === "pending") return "pending";
    if (status === "in_progress") return "running";
    switch (conclusion) {
        case "success":
            return "success";
        case "failure":
        case "timed_out":
            return "failed";
        case "cancelled":
            return "canceled";
        case "skipped":
            return "skipped";
        default:
            return "other";
    }
}

const seconds = (from?: string | null, to?: string | null) =>
    from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : undefined;

function toJob(job: GitHubJob): JobInfo {
    const duration = seconds(job.started_at, job.completed_at);
    const queued = seconds(job.created_at, job.started_at);
    return {
        id: String(job.id),
        name: job.name,
        status: jobStatus(job.status, job.conclusion),
        url: job.html_url,
        ...(job.started_at ? {startedAt: job.started_at} : {}),
        ...(job.completed_at ? {finishedAt: job.completed_at} : {}),
        ...(duration !== undefined ? {durationSeconds: duration} : {}),
        ...(queued !== undefined ? {queuedSeconds: queued} : {})
    };
}

/**
 * GitHub Actions. aicd runs as its own job (`needs: [...]`, `if: failure()`), reads the
 * jobs of the same workflow run and keeps one comment per agent up to date on the pull request.
 * Token: `GITHUB_TOKEN` with `actions: read` and `pull-requests: write`
 * (`actions: write` to retry, `statuses: write` for statuses, `contents: write` for fixes and releases).
 */
export class GitHubCIProvider implements CIProvider {
    readonly name = "github";
    readonly #env: NodeJS.ProcessEnv;
    readonly #fetch: typeof fetch;
    readonly #api: string;
    readonly #repo: string;
    readonly #cwd: string;
    #event: GitHubEvent | undefined;

    constructor(options: CIProviderOptions) {
        if (options.event && typeof options.event === "object") this.#event = options.event as GitHubEvent;
        this.#env = options.env;
        this.#fetch = options.fetch ?? fetch;
        this.#api = this.#env.GITHUB_API_URL ?? "https://api.github.com";
        this.#repo = this.#env.GITHUB_REPOSITORY ?? "";
        this.#cwd = options.cwd ?? process.cwd();
    }

    #readEvent(): GitHubEvent {
        if (!this.#event) {
            const path = this.#env.GITHUB_EVENT_PATH;
            this.#event = path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GitHubEvent) : {};
        }
        return this.#event;
    }

    async #request(path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
        const token = this.#env.AICD_GITHUB_TOKEN ?? this.#env.GITHUB_TOKEN;
        if (!token) throw new Error("GITHUB_TOKEN is not set");
        const response = await this.#fetch(`${this.#api}${path}`, {
            ...init,
            headers: {
                Accept: accept,
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(init.body ? {"Content-Type": "application/json"} : {}),
                ...init.headers
            }
        });
        if (!response.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
        return response;
    }

    async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
        return (await (await this.#request(path, init)).json()) as T;
    }

    #ownLogin: Promise<string | undefined> | undefined;

    /** Login of the token's user; undefined for the Actions token, which cannot read `/user` (its comments are by a bot). */
    #login(): Promise<string | undefined> {
        this.#ownLogin ??= this.#json<{login?: string}>("/user")
            .then((user) => user.login)
            .catch(() => undefined);
        return this.#ownLogin;
    }

    #pullNumber(): number | undefined {
        return this.#readEvent().pull_request?.number;
    }

    async getContext(): Promise<PipelineContext> {
        const event = this.#readEvent();
        const pr = event.pull_request;
        const server = this.#env.GITHUB_SERVER_URL ?? "https://github.com";
        const isFork = pr
            ? pr.head.repo === null || pr.head.repo.fork || pr.head.repo.full_name !== pr.base.repo.full_name
            : false;
        const branch = pr?.head.ref ?? (this.#env.GITHUB_HEAD_REF || this.#env.GITHUB_REF_NAME);
        const sha = pr?.head.sha ?? this.#env.GITHUB_SHA;
        return {
            provider: this.name,
            repository: this.#repo,
            ...(branch ? {branch} : {}),
            ...(event.repository?.default_branch ? {defaultBranch: event.repository.default_branch} : {}),
            ...(sha ? {commitSha: sha} : {}),
            ...(pr ? {baseSha: pr.base.sha} : {}),
            ...(this.#env.GITHUB_RUN_ID
                ? {
                      pipelineId: this.#env.GITHUB_RUN_ID,
                      pipelineUrl: `${server}/${this.#repo}/actions/runs/${this.#env.GITHUB_RUN_ID}`
                  }
                : {}),
            ...(pr
                ? {
                      mergeRequest: {
                          id: String(pr.number),
                          url: pr.html_url,
                          title: pr.title,
                          description: pr.body ?? "",
                          sourceBranch: pr.head.ref,
                          targetBranch: pr.base.ref
                      }
                  }
                : {}),
            ...(this.#env.GITHUB_REF_TYPE === "tag" && this.#env.GITHUB_REF_NAME
                ? {tag: this.#env.GITHUB_REF_NAME}
                : {}),
            isFork
        };
    }

    async #runJobs(runId: string): Promise<GitHubJob[]> {
        const {jobs} = await this.#json<{jobs: GitHubJob[]}>(
            `/repos/${this.#repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
        );
        return jobs;
    }

    async listFailedJobs(): Promise<FailedJob[]> {
        const runId = this.#env.GITHUB_RUN_ID;
        if (!runId) return [];
        const failed = (await this.#runJobs(runId)).filter((job) => job.conclusion === "failure");
        return Promise.all(
            failed.map(async (job) => ({
                id: String(job.id),
                name: job.name,
                url: job.html_url,
                log: await this.getJobLog(String(job.id))
            }))
        );
    }

    async listJobs(): Promise<JobInfo[]> {
        const runId = this.#env.GITHUB_RUN_ID;
        return runId ? (await this.#runJobs(runId)).map(toJob) : [];
    }

    async listRecentPipelines(options: {branch?: string; limit: number}): Promise<PipelineSummary[]> {
        const query = new URLSearchParams({per_page: String(Math.min(options.limit, 100)), status: "completed"});
        if (options.branch) query.set("branch", options.branch);
        const {workflow_runs: runs} = await this.#json<{workflow_runs: GitHubRun[]}>(
            `/repos/${this.#repo}/actions/runs?${query.toString()}`
        );
        return Promise.all(
            runs.slice(0, options.limit).map(async (run) => {
                const duration = seconds(run.run_started_at ?? run.created_at, run.updated_at);
                return {
                    id: String(run.id),
                    ...(run.head_branch ? {branch: run.head_branch} : {}),
                    commitSha: run.head_sha,
                    status: jobStatus(run.status, run.conclusion),
                    createdAt: run.created_at,
                    ...(duration !== undefined ? {durationSeconds: duration} : {}),
                    url: run.html_url,
                    jobs: (await this.#runJobs(String(run.id))).map(toJob)
                };
            })
        );
    }

    async getJobLog(jobId: string): Promise<string> {
        return (await this.#request(`/repos/${this.#repo}/actions/jobs/${jobId}/logs`)).text();
    }

    async getDiff(): Promise<string | undefined> {
        const number = this.#pullNumber();
        if (!number) return undefined;
        const response = await this.#request(`/repos/${this.#repo}/pulls/${number}`, {}, "application/vnd.github.diff");
        return response.text();
    }

    async readFile(path: string, ref?: string): Promise<string | undefined> {
        if (!ref) {
            const local = resolve(this.#cwd, path);
            if (local.startsWith(resolve(this.#cwd)) && existsSync(local)) return readFileSync(local, "utf8");
        }
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        try {
            const response = await this.#request(
                `/repos/${this.#repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`,
                {},
                "application/vnd.github.raw+json"
            );
            return await response.text();
        } catch (error) {
            if ((error as Error).message.includes("HTTP 404")) return undefined;
            throw error;
        }
    }

    async upsertComment(marker: string, body: string): Promise<void> {
        const number = this.#pullNumber();
        if (!number) {
            process.stderr.write("[aicd] github: not a pull request, report written to the job summary\n");
            const summary = this.#env.GITHUB_STEP_SUMMARY;
            if (summary) appendFileSync(summary, `${body}\n`);
            return;
        }
        const login = await this.#login();
        // Only aicd's own comment is updated: a marker pasted by someone else is ignored.
        const isOwn = (comment: GitHubComment) =>
            comment.body?.includes(marker) === true &&
            (login !== undefined ? comment.user?.login === login : comment.user?.type === "Bot");
        let existing: GitHubComment | undefined;
        for (let page = 1; page <= 10 && !existing; page++) {
            const comments = await this.#json<GitHubComment[]>(
                `/repos/${this.#repo}/issues/${number}/comments?per_page=100&page=${page}`
            );
            existing = comments.find(isOwn);
            if (comments.length < 100) break;
        }
        if (existing) {
            await this.#request(`/repos/${this.#repo}/issues/comments/${existing.id}`, {
                method: "PATCH",
                body: JSON.stringify({body})
            });
        } else {
            await this.#request(`/repos/${this.#repo}/issues/${number}/comments`, {
                method: "POST",
                body: JSON.stringify({body})
            });
        }
    }

    async setStatus(status: CommitStatus): Promise<void> {
        const sha = (await this.getContext()).commitSha;
        if (!sha) throw new Error("no commit to set a status on");
        await this.#request(`/repos/${this.#repo}/statuses/${sha}`, {
            method: "POST",
            body: JSON.stringify({
                state: status.state,
                context: status.context,
                description: status.description.slice(0, 140),
                ...(status.url ? {target_url: status.url} : {})
            })
        });
    }

    async retryJob(jobId: string): Promise<void> {
        await this.#request(`/repos/${this.#repo}/actions/jobs/${jobId}/rerun`, {method: "POST"});
    }

    async addLabels(labels: string[]): Promise<void> {
        const number = this.#pullNumber();
        if (!number || labels.length === 0) return;
        await this.#request(`/repos/${this.#repo}/issues/${number}/labels`, {
            method: "POST",
            body: JSON.stringify({labels})
        });
    }

    async openFixMergeRequest(fix: FixRequest): Promise<{id: string; url?: string}> {
        const context = await this.getContext();
        const base = fix.baseBranch ?? context.mergeRequest?.sourceBranch ?? context.defaultBranch ?? "main";
        const ref = await this.#json<{object: {sha: string}}>(
            `/repos/${this.#repo}/git/ref/heads/${encodeURIComponent(base)}`
        );
        await this.#request(`/repos/${this.#repo}/git/refs`, {
            method: "POST",
            body: JSON.stringify({ref: `refs/heads/${fix.branch}`, sha: ref.object.sha})
        });
        for (const change of fix.changes) {
            const path = change.path.split("/").map(encodeURIComponent).join("/");
            let sha: string | undefined;
            try {
                sha = (
                    await this.#json<{sha: string}>(
                        `/repos/${this.#repo}/contents/${path}?ref=${encodeURIComponent(fix.branch)}`
                    )
                ).sha;
            } catch {
                sha = undefined;
            }
            await this.#request(`/repos/${this.#repo}/contents/${path}`, {
                method: "PUT",
                body: JSON.stringify({
                    message: `${fix.title}\n\nProposed by aicd.`,
                    content: Buffer.from(change.content, "utf8").toString("base64"),
                    branch: fix.branch,
                    ...(sha ? {sha} : {})
                })
            });
        }
        const pull = await this.#json<{number: number; html_url: string}>(`/repos/${this.#repo}/pulls`, {
            method: "POST",
            body: JSON.stringify({title: fix.title, body: fix.body, head: fix.branch, base, draft: true})
        });
        return {id: String(pull.number), url: pull.html_url};
    }

    async createRelease(release: ReleaseDraft): Promise<{url?: string}> {
        const created = await this.#json<{html_url: string}>(`/repos/${this.#repo}/releases`, {
            method: "POST",
            body: JSON.stringify({tag_name: release.tag, name: release.name, body: release.body, draft: release.draft})
        });
        return {url: created.html_url};
    }
}

export const githubProvider: CIProviderFactory = {
    name: "github",
    detect: (env) => env.GITHUB_ACTIONS === "true",
    create: (options) => new GitHubCIProvider(options)
};
