import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    COMMENT_MARKER,
    findDestructiveSql,
    globToRegExp,
    ownersOf,
    parseCodeowners,
    parseUnifiedDiff,
    renderRiskComment,
    runRiskScore,
    scoreMergeRequest,
    type RiskSignal,
    type SignalId
} from "@aicd-ci/agent-risk-score";
import {RunBudget} from "@aicd-ci/core";
import type {AgentRuntime} from "@aicd-ci/plugin-sdk";

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

/** Unified diff of one file: every line added (or removed with `status: "deleted"`). */
function fileDiff(path: string, lines: string[], status: "added" | "modified" | "deleted" = "modified"): string {
    const header = [`diff --git a/${path} b/${path}`];
    if (status === "added") header.push("new file mode 100644");
    if (status === "deleted") header.push("deleted file mode 100644");
    header.push("index 0000000..1111111");
    header.push(status === "added" ? "--- /dev/null" : `--- a/${path}`);
    header.push(status === "deleted" ? "+++ /dev/null" : `+++ b/${path}`);
    const sign = status === "deleted" ? "-" : "+";
    const hunk = status === "deleted" ? `@@ -1,${lines.length} +0,0 @@` : `@@ -0,0 +1,${lines.length} @@`;
    return [...header, hunk, ...lines.map((line) => `${sign}${line}`)].join("\n");
}

const range = (n: number, prefix = "line") => Array.from({length: n}, (_, i) => `${prefix} ${i}`);

const signal = (signals: RiskSignal[], id: SignalId) => signals.find((s) => s.id === id) as RiskSignal;

const migration = fileDiff(
    "db/migrations/20261020_cleanup.sql",
    [
        "-- remove what is left of v1",
        "ALTER TABLE users DROP COLUMN legacy_id;",
        "DROP TABLE",
        "  sessions_old;",
        "ALTER TABLE orders ALTER COLUMN amount TYPE bigint;"
    ],
    "added"
);

describe("parseUnifiedDiff", () => {
    it("reads statuses, renames, binaries and line numbers", () => {
        const diff = [
            "diff --git a/src/a.ts b/src/a.ts",
            "index 1..2 100644",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -10,3 +10,3 @@ function x() {",
            " keep",
            "--- not a header, a removed line",
            "+++ not a header, an added line",
            " keep",
            "diff --git a/old/name.ts b/new/name.ts",
            "similarity index 100%",
            "rename from old/name.ts",
            "rename to new/name.ts",
            "diff --git a/logo.png b/logo.png",
            "Binary files a/logo.png and b/logo.png differ",
            fileDiff("gone.txt", ["bye"], "deleted")
        ].join("\n");
        const files = parseUnifiedDiff(diff);
        expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
            ["src/a.ts", "modified", false],
            ["new/name.ts", "renamed", false],
            ["logo.png", "modified", true],
            ["gone.txt", "deleted", false]
        ]);
        expect(files[0]?.added).toEqual([{line: 11, text: "++ not a header, an added line"}]);
        expect(files[0]?.removed).toEqual([{line: 11, text: "-- not a header, a removed line"}]);
        expect(files[1]?.oldPath).toBe("old/name.ts");
    });

    it("reads plain diffs and survives malformed input", () => {
        const files = parseUnifiedDiff(
            "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n--- y.txt\n+++ y.txt\n@@ -1 +1,2 @@\n a\n+c\n"
        );
        expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
            ["x.txt", 1, 1],
            ["y.txt", 1, 0]
        ]);
        expect(parseUnifiedDiff("")).toEqual([]);
        expect(parseUnifiedDiff("garbage\n@@ nonsense @@\n+++")).toEqual([]);
        expect(parseUnifiedDiff("diff --git a/t.ts b/t.ts\n@@ -1,5 +1,5 @@\n+x")[0]?.additions).toBe(1);
    });
});

describe("globs and CODEOWNERS", () => {
    it("follows gitignore semantics", () => {
        expect(globToRegExp("*.sql").test("db/x/001.sql")).toBe(true);
        expect(globToRegExp("/docs").test("docs/a/b.md")).toBe(true);
        expect(globToRegExp("/docs").test("src/docs/a.md")).toBe(false);
        expect(globToRegExp("**/db/migrate").test("api/db/migrate/1_x.rb")).toBe(true);
        expect(globToRegExp("*auth*", true).test("src/OAuth/Client.ts")).toBe(true);
        expect(globToRegExp("docker-compose*.y*ml").test("deploy/docker-compose.prod.yaml")).toBe(true);
        expect(globToRegExp("src/{a,b}/*.ts").test("src/b/x.ts")).toBe(true);
    });

    it("parses GitHub and GitLab files, last match per section wins", () => {
        const rules = parseCodeowners(
            [
                "# owners",
                "*            @acme/core",
                "/src/payments/ @acme/payments billing@acme.io # money",
                "",
                "[Database][2] @acme/dba",
                "*.sql",
                "^[Docs]",
                "docs/ @acme/docs"
            ].join("\n")
        );
        expect(rules).toHaveLength(4);
        expect(ownersOf("src/payments/pay.ts", rules)).toEqual(["@acme/payments", "billing@acme.io"]);
        expect(ownersOf("db/1.sql", rules)).toEqual(["@acme/core", "@acme/dba"]);
        expect(ownersOf("docs/a.md", rules)).toEqual(["@acme/core", "@acme/docs"]);
        expect(parseCodeowners("")).toEqual([]);
    });
});

describe("findDestructiveSql", () => {
    it("finds multi-line statements and DSL calls, ignores comments", () => {
        const [file] = parseUnifiedDiff(migration);
        expect(findDestructiveSql(file!).map((s) => [s.kind, s.line])).toEqual([
            ["DROP COLUMN", 2],
            ["DROP TABLE", 3],
            ["ALTER COLUMN TYPE", 5]
        ]);
        const [rails] = parseUnifiedDiff(
            fileDiff("db/migrate/2_x.rb", ["remove_column :users, :age", "rename_table :a, :b", "# drop_table :c"])
        );
        expect(findDestructiveSql(rails!).map((s) => s.kind)).toEqual(["DROP COLUMN", "RENAME"]);
    });

    it("flags NOT NULL only without a default", () => {
        const [bare] = parseUnifiedDiff(fileDiff("m/1.sql", ["ALTER TABLE t ALTER COLUMN c SET NOT NULL;"]));
        const [safe] = parseUnifiedDiff(
            fileDiff("m/2.sql", [
                "ALTER TABLE t ALTER COLUMN c SET DEFAULT 0;",
                "ALTER TABLE t ALTER COLUMN c SET NOT NULL;"
            ])
        );
        const [added] = parseUnifiedDiff(fileDiff("m/3.sql", ["ALTER TABLE t ADD COLUMN c int NOT NULL;"]));
        expect(findDestructiveSql(bare!).map((s) => s.kind)).toEqual(["SET NOT NULL"]);
        expect(findDestructiveSql(safe!)).toEqual([]);
        expect(findDestructiveSql(added!).map((s) => s.kind)).toEqual(["SET NOT NULL"]);
    });
});

describe("scoreMergeRequest", () => {
    it("scores a small documentation change low", () => {
        const report = scoreMergeRequest({diff: fileDiff("README.md", ["typo"])});
        expect(report).toMatchObject({score: 0, level: "low", forceFullSuite: false, requiredApprovals: 1, files: 1});
    });

    it("weighs migrations and destructive SQL, with evidence", () => {
        const report = scoreMergeRequest({diff: migration});
        expect(signal(report.signals, "migrations").points).toBe(15);
        expect(signal(report.signals, "destructive_sql")).toMatchObject({points: 30, facts: {statements: 3}});
        expect(signal(report.signals, "destructive_sql").evidence[0]).toEqual({
            kind: "diff",
            ref: "db/migrations/20261020_cleanup.sql:2 (DROP COLUMN)",
            quote: "ALTER TABLE users DROP COLUMN legacy_id"
        });
        // Counted by the migration signal, not again as a sensitive path.
        expect(signal(report.signals, "sensitive_paths").points).toBe(0);
        // Data loss cannot be rolled back: high risk whatever the score.
        expect(report).toMatchObject({score: 45, level: "high", forceFullSuite: true});
    });

    it("reaches high on a large sensitive change with a migration, dependencies and no tests", () => {
        const diff = [
            migration,
            fileDiff("src/auth/login.ts", range(200)),
            fileDiff("package.json", ['"left-pad": "1.0.0"']),
            fileDiff("pnpm-lock.yaml", range(5000))
        ].join("\n");
        const report = scoreMergeRequest(
            {diff, fixCounts: {"src/auth/login.ts": 5, "package.json": 1}},
            {requiredApprovals: {high: 3}}
        );
        expect(signal(report.signals, "size").facts).toMatchObject({lines: 206, excluded: 5000});
        expect(signal(report.signals, "sensitive_paths").evidence).toEqual([
            {kind: "diff", ref: "src/auth/login.ts", quote: "*auth*"}
        ]);
        expect(signal(report.signals, "fix_history").facts).toEqual({files: 1, fixes: 5});
        expect(signal(report.signals, "missing_tests").points).toBe(10);
        expect(signal(report.signals, "dependencies").points).toBe(10);
        expect(report).toMatchObject({level: "high", forceFullSuite: true, requiredApprovals: 3});
        expect(report.score).toBeLessThanOrEqual(100);
        // Same input, same report.
        expect(
            scoreMergeRequest(
                {diff, fixCounts: {"src/auth/login.ts": 5, "package.json": 1}},
                {requiredApprovals: {high: 3}}
            )
        ).toEqual(report);
    });

    it("does not count missing tests when tests changed, and caps the score at 100", () => {
        const withTests = scoreMergeRequest({changedFiles: ["src/a.ts", "src/a.test.ts"]});
        expect(signal(withTests.signals, "missing_tests").points).toBe(0);
        expect(signal(withTests.signals, "size").facts.unknown).toBe(1);

        const everything = scoreMergeRequest(
            {
                diff: [
                    migration,
                    fileDiff(".gitlab-ci.yml", range(50)),
                    fileDiff("src/wallet/pay.ts", range(2000))
                ].join("\n"),
                changedFiles: ["go.mod", ...range(60, "src/x").map((p) => `${p.replace(" ", "")}.go`)],
                codeowners: "*.go @a\n/src/wallet @b\n*.sql @c\n.gitlab-ci.yml @d @e"
            },
            {weights: {owners: 40}}
        );
        expect(everything.rawScore).toBeGreaterThan(100);
        expect(everything.score).toBe(100);
        expect(signal(everything.signals, "owners")).toMatchObject({points: 40, facts: {owners: 5}});
        expect(signal(everything.signals, "ci_config").points).toBe(10);
    });

    it("uses the configured thresholds, weights and paths", () => {
        const input = {changedFiles: ["src/secret-sauce/x.py"]};
        expect(scoreMergeRequest(input).level).toBe("low");
        const tuned = scoreMergeRequest(input, {
            sensitivePaths: ["secret-sauce"],
            weights: {sensitive_paths: 50},
            thresholds: {medium: 20, high: 60}
        });
        expect(tuned).toMatchObject({score: 40, level: "medium"});
        expect(scoreMergeRequest({})).toMatchObject({score: 0, level: "low", files: 0});
    });
});

describe("renderRiskComment", () => {
    const report = scoreMergeRequest({diff: migration});

    it("renders the breakdown in English", () => {
        const body = renderRiskComment(report, {language: "en", runId: "run_1"});
        expect(body.startsWith(COMMENT_MARKER)).toBe(true);
        expect(body).toContain(
            "**Risk: high (45/100)** · high whatever the score: the migration destroys data, which a rollback cannot restore · full test suite required · 2 approvals required"
        );
        expect(body).toContain("| Destructive SQL | 30/30 | 3 destructive SQL statement(s) added |");
        expect(body).toContain("`ALTER TABLE users DROP COLUMN legacy_id`");
        expect(body).not.toContain("| Size |");
    });

    it("renders the breakdown in French", () => {
        const body = renderRiskComment(
            {...report, level: "high", forceFullSuite: true, requiredApprovals: 2},
            {
                language: "fr",
                runId: "run_1"
            }
        );
        expect(body).toContain(
            "**Risque : élevé (45/100)** · élevé quel que soit le score : la migration détruit des données, qu'un rollback ne restaure pas · suite de tests complète requise · 2 approbations requises"
        );
        expect(body).toContain("| SQL destructeur | 30/30 | 3 instruction(s) SQL destructrice(s) ajoutée(s) |");
        expect(body).toContain("<summary>Preuves</summary>");
    });
});

describe("runRiskScore", () => {
    let repo: string;
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
            cwd: repo,
            stdio: "pipe"
        }).toString();
    const commit = (path: string, content: string, message: string) => {
        mkdirSync(dirname(join(repo, path)), {recursive: true});
        writeFileSync(join(repo, path), content);
        git("add", path);
        git("commit", "-q", "-m", message);
    };

    beforeAll(() => {
        repo = mkdtempSync(join(tmpdir(), "aicd-risk-"));
        git("init", "-q", "-b", "main");
        commit("src/billing/invoice.ts", "v1", "feat: invoices");
        commit("src/billing/invoice.ts", "v2", "fix: rounding of invoices");
        commit("src/billing/invoice.ts", "v3", "hotfix: totals");
        commit("src/billing/invoice.ts", "v4", 'Revert "feat: discounts"');
        commit("CODEOWNERS", "/src/billing/ @acme/billing\n*.sql @acme/dba\n", "chore: owners");
    });

    afterAll(() => rmSync(repo, {recursive: true, force: true}));

    it("reads the fix history and CODEOWNERS, proposes label, status and comment", async () => {
        const diff = [migration, fileDiff("src/billing/invoice.ts", range(120))].join("\n");
        const result = await runRiskScore(runtime(), {diff, cwd: repo});
        expect(signal(result.report.signals, "fix_history").facts).toEqual({files: 1, fixes: 3});
        expect(signal(result.report.signals, "owners").facts).toEqual({owners: 2});
        expect(result.report.level).toBe("high");
        expect(result.llmCalls).toBe(0);
        expect(result.actions.map((a) => a.type)).toEqual(["label", "set_status", "comment"]);
        expect(result.actions[0]).toMatchObject({labels: ["risk:high"]});
        expect(result.actions[1]).toMatchObject({status: {state: "success", context: "aicd/risk"}});
        expect(result.actions[2]).toMatchObject({marker: "<!-- aicd:risk -->"});

        const strict = await runRiskScore(runtime({language: "fr"}), {
            diff,
            cwd: repo,
            options: {failOnHigh: true, labelPrefix: "aicd::risk::"}
        });
        expect(strict.actions[0]).toMatchObject({labels: ["aicd::risk::high"]});
        expect(strict.actions[1]).toMatchObject({status: {state: "failure", description: "Risk high: 91/100"}});
        expect(strict.actions[2]).toMatchObject({body: expect.stringContaining("Score de risque")});
    });

    it("does not comment at low unless asked, and does nothing without changes", async () => {
        const low = await runRiskScore(runtime(), {changedFiles: ["README.md"], cwd: repo, codeowners: ""});
        expect(low.actions.map((a) => a.type)).toEqual(["label", "set_status"]);
        const verbose = await runRiskScore(runtime(), {
            changedFiles: ["README.md"],
            cwd: repo,
            options: {commentOnLow: true}
        });
        expect(verbose.actions.map((a) => a.type)).toEqual(["label", "set_status", "comment"]);
        const empty = await runRiskScore(runtime(), {diff: "", cwd: repo});
        expect(empty.actions).toEqual([]);
    });

    it("redacts the diff and falls back to the git diff of the base commit", async () => {
        const base = git("rev-parse", "HEAD").trim();
        commit("db/migrations/2.sql", "TRUNCATE audit_log;\n", "feat: purge");
        const redact = vi.fn((text: string) => text.replace(/audit_log/g, "[REDACTED]"));
        const result = await runRiskScore(
            runtime({redact, context: {provider: "gitlab", repository: "acme/app", isFork: false, baseSha: base}}),
            {
                cwd: repo
            }
        );
        expect(redact).toHaveBeenCalled();
        expect(signal(result.report.signals, "destructive_sql").evidence[0]).toMatchObject({
            quote: "TRUNCATE [REDACTED]"
        });

        const outside = await runRiskScore(runtime(), {changedFiles: ["a.ts"], cwd: join(repo, "missing")});
        expect(outside.report.files).toBe(1);
    });
});
