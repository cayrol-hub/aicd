import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {git} from "@aicd-ci/git";
import type {
    CIProvider,
    CIProviderFactory,
    CIProviderOptions,
    CommitStatus,
    FailedJob,
    FixRequest,
    JobInfo,
    PipelineContext,
    PipelineSummary,
    ReleaseDraft
} from "@aicd-ci/plugin-sdk";

/**
 * Any CI, or a developer's machine: logs come from files, comments go to stdout and
 * fixes or releases are written under `.aicd/`. Never calls a remote API.
 */
export class LocalCIProvider implements CIProvider {
    readonly name = "local";
    readonly #cwd: string;

    constructor(private readonly options: CIProviderOptions) {
        this.#cwd = options.cwd ?? process.cwd();
    }

    /** Comments go to stderr by default: stdout carries command output (`--json`, `tests select`). */
    #write(text: string): void {
        (this.options.write ?? ((value) => process.stderr.write(value)))(text);
    }

    async getContext(): Promise<PipelineContext> {
        const env = this.options.env;
        return {
            provider: this.name,
            repository: env.AICD_REPOSITORY ?? basename(this.#cwd),
            ...(env.AICD_BRANCH ? {branch: env.AICD_BRANCH} : {}),
            ...(env.AICD_DEFAULT_BRANCH ? {defaultBranch: env.AICD_DEFAULT_BRANCH} : {}),
            ...(env.AICD_COMMIT_SHA ? {commitSha: env.AICD_COMMIT_SHA} : {}),
            ...(env.AICD_BASE_SHA ? {baseSha: env.AICD_BASE_SHA} : {}),
            ...(env.AICD_TAG ? {tag: env.AICD_TAG} : {}),
            ...(env.AICD_MR_TITLE
                ? {mergeRequest: {id: "local", title: env.AICD_MR_TITLE, description: env.AICD_MR_DESCRIPTION ?? ""}}
                : {}),
            isFork: false
        };
    }

    async listFailedJobs(): Promise<FailedJob[]> {
        return (this.options.logFiles ?? []).map((file) => ({
            id: file,
            name: basename(file),
            log: readFileSync(file, "utf8")
        }));
    }

    async listJobs(): Promise<JobInfo[]> {
        return (this.options.logFiles ?? []).map((file) => ({id: file, name: basename(file), status: "failed"}));
    }

    async listRecentPipelines(): Promise<PipelineSummary[]> {
        return [];
    }

    async getJobLog(jobId: string): Promise<string> {
        return readFileSync(jobId, "utf8");
    }

    async getDiff(): Promise<string | undefined> {
        return this.options.diffFile ? readFileSync(this.options.diffFile, "utf8") : undefined;
    }

    async readFile(path: string, ref?: string): Promise<string | undefined> {
        if (ref) {
            try {
                return await git(["show", `${ref}:${path}`], {cwd: this.#cwd});
            } catch {
                return undefined;
            }
        }
        const absolute = resolve(this.#cwd, path);
        if (!absolute.startsWith(resolve(this.#cwd)) || !existsSync(absolute)) return undefined;
        return readFileSync(absolute, "utf8");
    }

    async upsertComment(_marker: string, body: string): Promise<void> {
        this.#write(`${body}\n`);
    }

    async setStatus(status: CommitStatus): Promise<void> {
        process.stderr.write(`[aicd] local: status ${status.context} = ${status.state} (${status.description})\n`);
    }

    async retryJob(jobId: string): Promise<void> {
        process.stderr.write(`[aicd] local: would retry ${jobId}\n`);
    }

    async addLabels(labels: string[]): Promise<void> {
        process.stderr.write(`[aicd] local: would add labels ${labels.join(", ")}\n`);
    }

    /** Writes the changed files under `.aicd/fixes/<branch>/` for a human to review and apply. */
    async openFixMergeRequest(fix: FixRequest): Promise<{id: string; url?: string}> {
        const root = join(this.#cwd, ".aicd", "fixes", fix.branch.replace(/[^\w.-]+/g, "_"));
        for (const change of fix.changes) {
            const target = join(root, change.path);
            mkdirSync(dirname(target), {recursive: true});
            writeFileSync(target, change.content);
        }
        writeFileSync(join(root, "FIX.md"), `# ${fix.title}\n\n${fix.body}\n`);
        process.stderr.write(`[aicd] local: fix written to ${root}\n`);
        return {id: root};
    }

    async createRelease(release: ReleaseDraft): Promise<{url?: string}> {
        const dir = join(this.#cwd, ".aicd", "releases");
        mkdirSync(dir, {recursive: true});
        const file = join(dir, `${release.tag.replace(/[^\w.-]+/g, "_")}.md`);
        writeFileSync(file, `# ${release.name}\n\n${release.body}\n`);
        process.stderr.write(`[aicd] local: release notes written to ${file}\n`);
        return {};
    }
}

export const localProvider: CIProviderFactory = {
    name: "local",
    detect: () => true,
    create: (options) => new LocalCIProvider(options)
};
