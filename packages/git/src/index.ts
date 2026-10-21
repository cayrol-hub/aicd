import {execFile} from "node:child_process";
import {promisify} from "node:util";

const exec = promisify(execFile);

export interface Commit {
    sha: string;
    author: string;
    authoredAt: string;
    committedAt: string;
    subject: string;
    body: string;
    files: string[];
}

export interface GitOptions {
    cwd?: string;
}

const SEP = "\u001f";
const END = "\u001e";

/** Runs a read-only git command. Arguments are passed without a shell. */
export async function git(args: string[], options: GitOptions = {}): Promise<string> {
    const {stdout} = await exec("git", args, {cwd: options.cwd ?? process.cwd(), maxBuffer: 64 * 1024 * 1024});
    return stdout;
}

export async function isGitRepository(options: GitOptions = {}): Promise<boolean> {
    try {
        return (await git(["rev-parse", "--is-inside-work-tree"], options)).trim() === "true";
    } catch {
        return false;
    }
}

/** Commits of a range (`base..head`, a ref, or `--all`), most recent first, with the files they touch. */
export async function log(
    range: string | undefined,
    options: GitOptions & {maxCount?: number; paths?: string[]; grep?: string} = {}
): Promise<Commit[]> {
    const args = [
        "log",
        `--format=${END}%H${SEP}%an${SEP}%aI${SEP}%cI${SEP}%s${SEP}%b${SEP}`,
        "--name-only",
        "--no-renames"
    ];
    if (options.maxCount) args.push(`--max-count=${options.maxCount}`);
    if (options.grep) args.push(`--grep=${options.grep}`, "--regexp-ignore-case", "--extended-regexp");
    if (range) args.push(range);
    if (options.paths?.length) args.push("--", ...options.paths);
    let output: string;
    try {
        output = await git(args, options);
    } catch {
        return [];
    }
    return output
        .split(END)
        .filter((chunk) => chunk.trim().length > 0)
        .map((chunk) => {
            const [sha = "", author = "", authoredAt = "", committedAt = "", subject = "", body = "", rest = ""] =
                chunk.split(SEP);
            return {
                sha,
                author,
                authoredAt,
                committedAt,
                subject,
                body: body.trim(),
                files: rest
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
            };
        });
}

export async function changedFiles(base: string, head = "HEAD", options: GitOptions = {}): Promise<string[]> {
    const output = await git(["diff", "--name-only", "--no-renames", `${base}...${head}`], options);
    return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

export async function diff(base: string, head = "HEAD", options: GitOptions = {}): Promise<string> {
    return git(["diff", "--no-color", "--no-ext-diff", `${base}...${head}`], options);
}

export async function mergeBase(a: string, b: string, options: GitOptions = {}): Promise<string | undefined> {
    try {
        return (await git(["merge-base", a, b], options)).trim() || undefined;
    } catch {
        return undefined;
    }
}

export async function revParse(ref: string, options: GitOptions = {}): Promise<string | undefined> {
    try {
        return (await git(["rev-parse", "--verify", `${ref}^{commit}`], options)).trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Tags sorted by creation date, most recent first. */
export async function tags(options: GitOptions = {}): Promise<{name: string; sha: string; date: string}[]> {
    const output = await git(
        [
            "for-each-ref",
            "--sort=-v:refname",
            "--sort=-creatordate",
            `--format=%(refname:short)${SEP}%(objectname)${SEP}%(creatordate:iso-strict)`,
            "refs/tags"
        ],
        options
    );
    return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [name = "", sha = "", date = ""] = line.split(SEP);
            return {name, sha, date};
        });
}

/** The tag before `tag` in creation order, if any. */
export async function previousTag(tag: string, options: GitOptions = {}): Promise<string | undefined> {
    const all = await tags(options);
    const index = all.findIndex((candidate) => candidate.name === tag);
    return index === -1 ? all[0]?.name : all[index + 1]?.name;
}

/**
 * Files changed together with each of `files` in the last commits: the co-change signal used
 * when no per-test coverage exists. Returns, for each file, the other files and how often.
 */
export async function coChanges(
    files: string[],
    options: GitOptions & {maxCommits?: number; ref?: string} = {}
): Promise<Map<string, Map<string, number>>> {
    const commits = await log(options.ref ?? "HEAD", {...options, maxCount: options.maxCommits ?? 500});
    const wanted = new Set(files);
    const result = new Map<string, Map<string, number>>();
    for (const commit of commits) {
        if (commit.files.length > 50) continue; // mass changes (formatting, renames) carry no signal
        for (const file of commit.files) {
            if (!wanted.has(file)) continue;
            const counts = result.get(file) ?? new Map<string, number>();
            for (const other of commit.files) if (other !== file) counts.set(other, (counts.get(other) ?? 0) + 1);
            result.set(file, counts);
        }
    }
    return result;
}

/**
 * How many commits that look like fixes touched each file recently. Pass `ref` (e.g. the merge request's
 * base commit) so the change under review does not count in its own history.
 */
export async function fixCounts(
    files: string[],
    options: GitOptions & {maxCommits?: number; ref?: string} = {}
): Promise<Map<string, number>> {
    const commits = await log(options.ref ?? "HEAD", {
        ...options,
        maxCount: options.maxCommits ?? 1000,
        grep: "(^|[^a-z])(fix|fixes|fixed|hotfix|bugfix|revert)([^a-z]|$)"
    });
    const wanted = new Set(files);
    const counts = new Map<string, number>(files.map((file) => [file, 0]));
    for (const commit of commits)
        for (const file of commit.files) if (wanted.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
    return counts;
}
