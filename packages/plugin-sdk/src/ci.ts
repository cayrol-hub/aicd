export interface MergeRequestRef {
    id: string;
    url?: string;
    title?: string;
    description?: string;
    sourceBranch?: string;
    targetBranch?: string;
}

export interface PipelineContext {
    /** Adapter name: "github", "gitlab", "local"… */
    provider: string;
    repository: string;
    branch?: string;
    defaultBranch?: string;
    commitSha?: string;
    /** Base commit of the merge request, when known. */
    baseSha?: string;
    pipelineId?: string;
    pipelineUrl?: string;
    mergeRequest?: MergeRequestRef;
    /** Set on tag pipelines. */
    tag?: string;
    /** True when the code under test comes from a fork: no LLM call, no action. */
    isFork: boolean;
}

export interface FailedJob {
    id: string;
    name: string;
    url?: string;
    log: string;
}

export type JobStatus = "success" | "failed" | "canceled" | "skipped" | "running" | "pending" | "other";

export interface JobInfo {
    id: string;
    name: string;
    stage?: string;
    status: JobStatus;
    url?: string;
    startedAt?: string;
    finishedAt?: string;
    durationSeconds?: number;
    /** Time spent waiting for a runner. */
    queuedSeconds?: number;
}

export interface PipelineSummary {
    id: string;
    branch?: string;
    commitSha?: string;
    status: JobStatus;
    createdAt: string;
    durationSeconds?: number;
    url?: string;
    jobs: JobInfo[];
}

export interface CommitStatus {
    state: "success" | "failure" | "pending";
    /** Name of the check, e.g. "aicd/risk". */
    context: string;
    description: string;
    url?: string;
}

export interface FileChange {
    path: string;
    /** Full new content of the file. */
    content: string;
}

export interface FixRequest {
    title: string;
    body: string;
    /** Branch created for the fix. Never a protected branch. */
    branch: string;
    /** Target of the merge request; default: the current merge request's source branch, else the default branch. */
    baseBranch?: string;
    changes: FileChange[];
}

export interface ReleaseDraft {
    tag: string;
    name: string;
    body: string;
    /** Always true unless autonomy is act. */
    draft: boolean;
}

export interface CIProvider {
    readonly name: string;
    getContext(): Promise<PipelineContext>;
    listFailedJobs(): Promise<FailedJob[]>;
    /** Every job of the current pipeline, with timings when the CI gives them. */
    listJobs(): Promise<JobInfo[]>;
    /** Recent pipelines with their jobs, most recent first. */
    listRecentPipelines(options: {branch?: string; limit: number}): Promise<PipelineSummary[]>;
    getJobLog(jobId: string): Promise<string>;
    /** Unified diff of the merge request, when there is one. */
    getDiff(): Promise<string | undefined>;
    /** A file of the repository at `ref` (default: the current commit). */
    readFile(path: string, ref?: string): Promise<string | undefined>;
    /** Creates the comment carrying `marker`, or updates it if it already exists. */
    upsertComment(marker: string, body: string): Promise<void>;
    setStatus(status: CommitStatus): Promise<void>;
    retryJob(jobId: string): Promise<void>;
    addLabels(labels: string[]): Promise<void>;
    openFixMergeRequest(fix: FixRequest): Promise<{id: string; url?: string}>;
    createRelease(release: ReleaseDraft): Promise<{url?: string}>;
}

export interface CIProviderOptions {
    env: NodeJS.ProcessEnv;
    /** Local adapter only: log files to analyse. */
    logFiles?: string[];
    /** Local adapter only: diff file. */
    diffFile?: string;
    /** Repository root for local file reads. Default: process.cwd(). */
    cwd?: string;
    /** Where adapters without a remote (local) write comments. */
    write?: (text: string) => void;
    fetch?: typeof fetch;
    /**
     * Server mode: the webhook payload that triggered the run, used instead of the CI's own event
     * file (e.g. GitHub's `GITHUB_EVENT_PATH`). Adapters ignore what they do not understand.
     */
    event?: unknown;
}

export interface CIProviderFactory {
    readonly name: string;
    detect(env: NodeJS.ProcessEnv): boolean;
    create(options: CIProviderOptions): CIProvider;
}
