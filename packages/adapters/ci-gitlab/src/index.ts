import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
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
} from "@aicd/plugin-sdk";

interface GitLabJob {
    id: number;
    name: string;
    stage?: string;
    web_url: string;
    status: string;
    started_at?: string | null;
    finished_at?: string | null;
    duration?: number | null;
    queued_duration?: number | null;
}

interface GitLabPipeline {
    id: number;
    ref?: string;
    sha?: string;
    status: string;
    created_at: string;
    updated_at?: string;
    web_url?: string;
}

function jobStatus(status: string): JobStatus {
    switch (status) {
        case "success":
            return "success";
        case "failed":
            return "failed";
        case "canceled":
            return "canceled";
        case "skipped":
        case "manual":
            return "skipped";
        case "running":
            return "running";
        case "pending":
        case "created":
        case "waiting_for_resource":
        case "preparing":
        case "scheduled":
            return "pending";
        default:
            return "other";
    }
}

function toJob(job: GitLabJob): JobInfo {
    return {
        id: String(job.id),
        name: job.name,
        ...(job.stage ? {stage: job.stage} : {}),
        status: jobStatus(job.status),
        url: job.web_url,
        ...(job.started_at ? {startedAt: job.started_at} : {}),
        ...(job.finished_at ? {finishedAt: job.finished_at} : {}),
        ...(typeof job.duration === "number" ? {durationSeconds: job.duration} : {}),
        ...(typeof job.queued_duration === "number" ? {queuedSeconds: job.queued_duration} : {})
    };
}

/**
 * GitLab CI. aicd runs as a `.post` job with `when: on_failure` (or always, for the history),
 * reads the jobs of the pipeline and keeps one note per agent up to date on the merge request.
 * Token: `AICD_GITLAB_TOKEN` (project access token, scope `api`, role Developer for retries and fixes).
 */
export class GitLabCIProvider implements CIProvider {
    readonly name = "gitlab";
    readonly #env: NodeJS.ProcessEnv;
    readonly #fetch: typeof fetch;
    readonly #api: string;
    readonly #project: string;
    readonly #cwd: string;

    constructor(options: CIProviderOptions) {
        this.#env = options.env;
        this.#fetch = options.fetch ?? fetch;
        this.#api = this.#env.CI_API_V4_URL ?? "https://gitlab.com/api/v4";
        this.#project = encodeURIComponent(this.#env.CI_PROJECT_ID ?? "");
        this.#cwd = options.cwd ?? process.cwd();
    }

    async #request(path: string, init: RequestInit = {}): Promise<Response> {
        const token = this.#env.AICD_GITLAB_TOKEN;
        if (!token) throw new Error("AICD_GITLAB_TOKEN is not set (CI_JOB_TOKEN cannot read job logs or post notes)");
        const response = await this.#fetch(`${this.#api}${path}`, {
            ...init,
            headers: {
                "PRIVATE-TOKEN": token,
                ...(init.body ? {"Content-Type": "application/json"} : {}),
                ...init.headers
            }
        });
        if (!response.ok) throw new Error(`GitLab API ${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
        return response;
    }

    async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
        return (await (await this.#request(path, init)).json()) as T;
    }

    #ownId: Promise<number | undefined> | undefined;

    #userId(): Promise<number | undefined> {
        this.#ownId ??= this.#json<{id?: number}>("/user")
            .then((user) => user.id)
            .catch(() => undefined);
        return this.#ownId;
    }

    #mergeRequestIid(): string | undefined {
        return this.#env.CI_MERGE_REQUEST_IID || undefined;
    }

    async getContext(): Promise<PipelineContext> {
        const env = this.#env;
        const iid = this.#mergeRequestIid();
        const sourceProject = env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID;
        const branch = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.CI_COMMIT_REF_NAME;
        return {
            provider: this.name,
            repository: env.CI_PROJECT_PATH ?? "",
            ...(branch ? {branch} : {}),
            ...(env.CI_DEFAULT_BRANCH ? {defaultBranch: env.CI_DEFAULT_BRANCH} : {}),
            ...(env.CI_COMMIT_SHA ? {commitSha: env.CI_COMMIT_SHA} : {}),
            ...(env.CI_MERGE_REQUEST_DIFF_BASE_SHA ? {baseSha: env.CI_MERGE_REQUEST_DIFF_BASE_SHA} : {}),
            ...(env.CI_PIPELINE_ID ? {pipelineId: env.CI_PIPELINE_ID} : {}),
            ...(env.CI_PIPELINE_URL ? {pipelineUrl: env.CI_PIPELINE_URL} : {}),
            ...(env.CI_COMMIT_TAG ? {tag: env.CI_COMMIT_TAG} : {}),
            ...(iid
                ? {
                      mergeRequest: {
                          id: iid,
                          ...(env.CI_MERGE_REQUEST_PROJECT_URL
                              ? {url: `${env.CI_MERGE_REQUEST_PROJECT_URL}/-/merge_requests/${iid}`}
                              : {}),
                          ...(env.CI_MERGE_REQUEST_TITLE ? {title: env.CI_MERGE_REQUEST_TITLE} : {}),
                          ...(env.CI_MERGE_REQUEST_DESCRIPTION ? {description: env.CI_MERGE_REQUEST_DESCRIPTION} : {}),
                          ...(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
                              ? {sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME}
                              : {}),
                          ...(env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME
                              ? {targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}
                              : {})
                      }
                  }
                : {}),
            isFork: Boolean(sourceProject && env.CI_PROJECT_ID && sourceProject !== env.CI_PROJECT_ID)
        };
    }

    async #pipelineJobs(pipelineId: string, scope?: string): Promise<GitLabJob[]> {
        const query = `per_page=100${scope ? `&scope[]=${scope}` : ""}`;
        return this.#json<GitLabJob[]>(`/projects/${this.#project}/pipelines/${pipelineId}/jobs?${query}`);
    }

    async listFailedJobs(): Promise<FailedJob[]> {
        const pipeline = this.#env.CI_PIPELINE_ID;
        if (!pipeline) return [];
        const jobs = (await this.#pipelineJobs(pipeline, "failed")).filter(
            (job) => String(job.id) !== this.#env.CI_JOB_ID
        );
        return Promise.all(
            jobs.map(async (job) => ({
                id: String(job.id),
                name: job.name,
                url: job.web_url,
                log: await this.getJobLog(String(job.id))
            }))
        );
    }

    async listJobs(): Promise<JobInfo[]> {
        const pipeline = this.#env.CI_PIPELINE_ID;
        if (!pipeline) return [];
        return (await this.#pipelineJobs(pipeline)).filter((job) => String(job.id) !== this.#env.CI_JOB_ID).map(toJob);
    }

    async listRecentPipelines(options: {branch?: string; limit: number}): Promise<PipelineSummary[]> {
        const query = new URLSearchParams({per_page: String(Math.min(options.limit, 100)), scope: "finished"});
        if (options.branch) query.set("ref", options.branch);
        const pipelines = await this.#json<GitLabPipeline[]>(
            `/projects/${this.#project}/pipelines?${query.toString()}`
        );
        return Promise.all(
            pipelines.slice(0, options.limit).map(async (pipeline) => {
                const duration =
                    pipeline.updated_at !== undefined
                        ? Math.max(0, (Date.parse(pipeline.updated_at) - Date.parse(pipeline.created_at)) / 1000)
                        : undefined;
                return {
                    id: String(pipeline.id),
                    ...(pipeline.ref ? {branch: pipeline.ref} : {}),
                    ...(pipeline.sha ? {commitSha: pipeline.sha} : {}),
                    status: jobStatus(pipeline.status),
                    createdAt: pipeline.created_at,
                    ...(duration !== undefined ? {durationSeconds: duration} : {}),
                    ...(pipeline.web_url ? {url: pipeline.web_url} : {}),
                    jobs: (await this.#pipelineJobs(String(pipeline.id))).map(toJob)
                };
            })
        );
    }

    async getJobLog(jobId: string): Promise<string> {
        return (await this.#request(`/projects/${this.#project}/jobs/${jobId}/trace`)).text();
    }

    async getDiff(): Promise<string | undefined> {
        const iid = this.#mergeRequestIid();
        if (!iid) return undefined;
        const files = await this.#json<{old_path: string; new_path: string; diff: string}[]>(
            `/projects/${this.#project}/merge_requests/${iid}/diffs?per_page=100`
        );
        return files.map((file) => `--- a/${file.old_path}\n+++ b/${file.new_path}\n${file.diff}`).join("\n");
    }

    async readFile(path: string, ref?: string): Promise<string | undefined> {
        if (!ref) {
            const local = resolve(this.#cwd, path);
            if (local.startsWith(resolve(this.#cwd)) && existsSync(local)) return readFileSync(local, "utf8");
        }
        const at = ref ?? this.#env.CI_COMMIT_SHA ?? "HEAD";
        try {
            return await (
                await this.#request(
                    `/projects/${this.#project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(at)}`
                )
            ).text();
        } catch (error) {
            if ((error as Error).message.includes("HTTP 404")) return undefined;
            throw error;
        }
    }

    async upsertComment(marker: string, body: string): Promise<void> {
        const iid = this.#mergeRequestIid();
        if (!iid) {
            process.stderr.write(`[aicd] gitlab: not a merge request pipeline, report printed below\n${body}\n`);
            return;
        }
        const base = `/projects/${this.#project}/merge_requests/${iid}/notes`;
        const notes = await this.#json<{id: number; body?: string; author?: {id?: number}}[]>(
            `${base}?per_page=100&sort=desc`
        );
        // Only aicd's own note is updated: a marker pasted by someone else is ignored.
        const ownId = await this.#userId();
        const existing = notes.find(
            (note) => note.body?.includes(marker) && (ownId === undefined || note.author?.id === ownId)
        );
        if (existing) await this.#request(`${base}/${existing.id}`, {method: "PUT", body: JSON.stringify({body})});
        else await this.#request(base, {method: "POST", body: JSON.stringify({body})});
    }

    async setStatus(status: CommitStatus): Promise<void> {
        const sha = this.#env.CI_COMMIT_SHA;
        if (!sha) throw new Error("no commit to set a status on");
        const query = new URLSearchParams({
            state: status.state === "failure" ? "failed" : status.state,
            name: status.context,
            description: status.description.slice(0, 255),
            ...(status.url ? {target_url: status.url} : {})
        });
        await this.#request(`/projects/${this.#project}/statuses/${sha}?${query.toString()}`, {method: "POST"});
    }

    async retryJob(jobId: string): Promise<void> {
        await this.#request(`/projects/${this.#project}/jobs/${jobId}/retry`, {method: "POST"});
    }

    async addLabels(labels: string[]): Promise<void> {
        const iid = this.#mergeRequestIid();
        if (!iid || labels.length === 0) return;
        await this.#request(`/projects/${this.#project}/merge_requests/${iid}`, {
            method: "PUT",
            body: JSON.stringify({add_labels: labels.join(",")})
        });
    }

    async openFixMergeRequest(fix: FixRequest): Promise<{id: string; url?: string}> {
        const context = await this.getContext();
        const base = fix.baseBranch ?? context.mergeRequest?.sourceBranch ?? context.defaultBranch ?? "main";
        const actions = await Promise.all(
            fix.changes.map(async (change) => ({
                action: (await this.readFile(change.path, base)) === undefined ? "create" : "update",
                file_path: change.path,
                content: change.content
            }))
        );
        await this.#request(`/projects/${this.#project}/repository/commits`, {
            method: "POST",
            body: JSON.stringify({
                branch: fix.branch,
                start_branch: base,
                commit_message: `${fix.title}\n\nProposed by aicd.`,
                actions
            })
        });
        const mr = await this.#json<{iid: number; web_url: string}>(`/projects/${this.#project}/merge_requests`, {
            method: "POST",
            body: JSON.stringify({
                source_branch: fix.branch,
                target_branch: base,
                title: `Draft: ${fix.title}`,
                description: fix.body,
                remove_source_branch: true
            })
        });
        return {id: String(mr.iid), url: mr.web_url};
    }

    /** GitLab has no draft releases: a draft is written to `.aicd/releases/` (keep it as a job artifact). */
    async createRelease(release: ReleaseDraft): Promise<{url?: string}> {
        if (release.draft) {
            const dir = join(this.#cwd, ".aicd", "releases");
            mkdirSync(dir, {recursive: true});
            writeFileSync(
                join(dir, `${release.tag.replace(/[^\w.-]+/g, "_")}.md`),
                `# ${release.name}\n\n${release.body}\n`
            );
            return {};
        }
        const created = await this.#json<{_links?: {self?: string}}>(`/projects/${this.#project}/releases`, {
            method: "POST",
            body: JSON.stringify({tag_name: release.tag, name: release.name, description: release.body})
        });
        return created._links?.self ? {url: created._links.self} : {};
    }
}

export const gitlabProvider: CIProviderFactory = {
    name: "gitlab",
    detect: (env) => env.GITLAB_CI === "true",
    create: (options) => new GitLabCIProvider(options)
};
