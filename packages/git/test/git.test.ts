import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {beforeAll, describe, expect, it} from "vitest";
import {changedFiles, coChanges, diff, fixCounts, git, isGitRepository, log, previousTag, tags} from "@aicd-ci/git";

let cwd: string;

async function commit(files: Record<string, string>, message: string): Promise<void> {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
    await git(["add", "-A"], {cwd});
    await git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message], {cwd});
}

beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "aicd-git-"));
    await git(["init", "-q", "-b", "main"], {cwd});
    await commit({"a.ts": "1", "a.test.ts": "1"}, "feat: a");
    await git(["tag", "v0.1.0"], {cwd});
    await commit({"a.ts": "2", "a.test.ts": "2"}, "fix: a overflow");
    await commit({"b.ts": "1"}, "feat: b");
    await git(["tag", "v0.2.0"], {cwd});
});

describe("git helpers", () => {
    it("detects a repository", async () => {
        expect(await isGitRepository({cwd})).toBe(true);
        expect(await isGitRepository({cwd: tmpdir()})).toBe(false);
    });

    it("reads the log with files, most recent first", async () => {
        const commits = await log("v0.1.0..HEAD", {cwd});
        expect(commits.map((c) => c.subject)).toEqual(["feat: b", "fix: a overflow"]);
        expect(commits[1]?.files.sort()).toEqual(["a.test.ts", "a.ts"]);
        expect(commits[0]?.authoredAt).toMatch(/^\d{4}-/);
    });

    it("lists changed files and the diff between refs", async () => {
        expect(await changedFiles("v0.1.0", "HEAD", {cwd})).toEqual(["a.test.ts", "a.ts", "b.ts"]);
        expect(await diff("v0.1.0", "HEAD", {cwd})).toContain("+2");
    });

    it("finds tags and the previous tag", async () => {
        expect((await tags({cwd})).map((t) => t.name).sort()).toEqual(["v0.1.0", "v0.2.0"]);
        expect(await previousTag("v0.2.0", {cwd})).toBe("v0.1.0");
    });

    it("computes co-changes and fix counts", async () => {
        const co = await coChanges(["a.ts"], {cwd});
        expect(co.get("a.ts")?.get("a.test.ts")).toBe(2);
        expect((await fixCounts(["a.ts", "b.ts"], {cwd})).get("a.ts")).toBe(1);
    });
});
