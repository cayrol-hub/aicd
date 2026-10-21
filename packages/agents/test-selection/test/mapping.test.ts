import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    buildCoverageMap,
    conventionSources,
    discoverTests,
    indexSources,
    isTestPath,
    loadCoverageMap,
    resolveTestKey,
    saveCoverageMap,
    testSubject
} from "@aicd-ci/agent-test-selection";
import {COLLECTIONS} from "@aicd-ci/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function write(root: string, path: string, content = "x\n") {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), content);
}

function gitIn(root: string, ...args: string[]) {
    execFileSync("git", args, {cwd: root, stdio: "ignore"});
}

describe("discoverTests", () => {
    let root: string;
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "aicd-ts-discover-"));
        for (const path of [
            "src/a.ts",
            "src/a.test.ts",
            "web/b.spec.jsx",
            "web/__tests__/c.ts",
            "web/__tests__/__snapshots__/c.ts.snap",
            "py/test_d.py",
            "py/e_test.py",
            "go/f_test.go",
            "java/src/test/java/com/x/GTest.java",
            "java/src/test/java/com/x/Helper.java",
            "java/src/test/resources/data.json",
            "kt/HTest.kt",
            "rb/spec/i_spec.rb",
            "node_modules/pkg/z.test.js",
            "vendor/y_test.go",
            "dist/a.test.js"
        ]) {
            write(root, path);
        }
    });
    afterAll(() => rmSync(root, {recursive: true, force: true}));

    it("finds tests of every supported ecosystem and skips vendored and built code", async () => {
        expect(await discoverTests({cwd: root})).toEqual([
            "go/f_test.go",
            "java/src/test/java/com/x/GTest.java",
            "java/src/test/java/com/x/Helper.java",
            "kt/HTest.kt",
            "py/e_test.py",
            "py/test_d.py",
            "rb/spec/i_spec.rb",
            "src/a.test.ts",
            "web/__tests__/c.ts",
            "web/b.spec.jsx"
        ]);
    });

    it("accepts custom patterns", async () => {
        expect(await discoverTests({cwd: root, patterns: ["py/**/*.py"]})).toEqual(["py/e_test.py", "py/test_d.py"]);
    });
});

describe("naming conventions", () => {
    it("derives the subject of a test by language", () => {
        expect(testSubject("src/foo/bar.test.ts")).toEqual({stem: "bar", family: "js"});
        expect(testSubject("src/__tests__/bar.tsx")).toEqual({stem: "bar", family: "js"});
        expect(testSubject("tests/test_bar.py")).toEqual({stem: "bar", family: "py"});
        expect(testSubject("pkg/bar_test.go")).toEqual({stem: "bar", family: "go"});
        expect(testSubject("src/test/java/a/BarTest.java")).toEqual({stem: "Bar", family: "jvm"});
        expect(testSubject("spec/models/bar_spec.rb")).toEqual({stem: "bar", family: "rb"});
        expect(testSubject("tests/helpers.ts")).toBeUndefined();
    });

    const sources = [
        "src/foo/bar.ts",
        "packages/a/src/bar.ts",
        "packages/b/src/bar.ts",
        "pkg/bar.go",
        "src/main/java/a/Bar.java",
        "app/models/bar.rb",
        "mylib/parser.py",
        "mylib/util.py",
        "other/util.py"
    ];
    const index = indexSources(sources);

    it("pairs same directory and mirrored test directories", () => {
        expect(conventionSources("src/foo/bar.test.ts", index)).toEqual(["src/foo/bar.ts"]);
        expect(conventionSources("test/foo/bar.spec.ts", index)).toEqual(["src/foo/bar.ts"]);
        expect(conventionSources("packages/b/test/bar.test.ts", index)).toEqual(["packages/b/src/bar.ts"]);
        expect(conventionSources("pkg/bar_test.go", index)).toEqual(["pkg/bar.go"]);
        expect(conventionSources("src/test/java/a/BarTest.java", index)).toEqual(["src/main/java/a/Bar.java"]);
        expect(conventionSources("spec/models/bar_spec.rb", index)).toEqual(["app/models/bar.rb"]);
    });

    it("accepts a loose directory match only when it is unambiguous", () => {
        expect(conventionSources("tests/test_parser.py", index)).toEqual(["mylib/parser.py"]);
        expect(conventionSources("tests/test_util.py", index)).toEqual([]);
        expect(conventionSources("tests/bar.test.ts", index)).toEqual([]);
    });

    it("resolves per-test coverage keys to test files", () => {
        const tests = ["tests/test_a.py", "src/a.test.ts"];
        expect(resolveTestKey("tests/test_a.py::test_x", tests)).toBe("tests/test_a.py");
        expect(resolveTestKey("/repo/src/a.test.ts > suite > case", tests, "/repo")).toBe("src/a.test.ts");
        expect(resolveTestKey("tests/test_ab.py", tests)).toBeUndefined();
    });
});

describe("buildCoverageMap", () => {
    let root: string;
    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "aicd-ts-map-"));
        gitIn(root, "init", "-q");
        gitIn(root, "config", "user.email", "test@example.com");
        gitIn(root, "config", "user.name", "Test");
        gitIn(root, "config", "commit.gpgsign", "false");
        write(root, "src/calc.ts");
        write(root, "src/calc.test.ts");
        write(root, "src/format.ts");
        write(root, "src/rare.ts");
        write(root, "test/integration.test.ts");
        gitIn(root, "add", ".");
        gitIn(root, "commit", "-q", "-m", "init");
        // calc.ts and the integration test change together three times; rare.ts only once.
        for (let i = 0; i < 3; i++) {
            write(root, "src/calc.ts", `v${i}\n`);
            write(root, "test/integration.test.ts", `v${i}\n`);
            if (i === 0) write(root, "src/rare.ts", "v\n");
            gitIn(root, "commit", "-q", "-am", `change ${i}`);
        }
    });
    afterAll(() => rmSync(root, {recursive: true, force: true}));

    it("combines per-test coverage, conventions and co-change with their trust order", async () => {
        const tests = await discoverTests({cwd: root});
        expect(tests).toEqual(["src/calc.test.ts", "test/integration.test.ts"]);
        const map = await buildCoverageMap({
            tests,
            cwd: root,
            perTestCoverage: {[`${root}/src/calc.test.ts > adds`]: [`${root}/src/calc.ts`, `${root}/src/format.ts`]},
            now: () => new Date("2026-10-01T00:00:00Z"),
            logger
        });
        expect(map.generatedAt).toBe("2026-10-01T00:00:00.000Z");
        expect(map.entries.get("src/calc.test.ts")).toMatchObject({
            files: ["src/calc.ts", "src/format.ts"],
            source: "per_test_coverage",
            via: {"src/calc.ts": "per_test_coverage", "src/format.ts": "per_test_coverage"}
        });
        expect(map.entries.get("test/integration.test.ts")).toMatchObject({
            files: ["src/calc.ts"],
            source: "co_change",
            via: {"src/calc.ts": "co_change"}
        });
    });

    it("honours the co-change threshold and can disable signals", async () => {
        const tests = ["src/calc.test.ts", "test/integration.test.ts"];
        const loose = await buildCoverageMap({tests, cwd: root, coChanges: {threshold: 1}});
        // The initial commit (every file) now counts too.
        expect(loose.entries.get("test/integration.test.ts")?.files).toEqual([
            "src/calc.ts",
            "src/format.ts",
            "src/rare.ts"
        ]);
        expect(loose.entries.get("src/calc.test.ts")).toMatchObject({
            source: "convention",
            via: {"src/calc.ts": "convention", "src/rare.ts": "co_change"}
        });
        const none = await buildCoverageMap({tests, cwd: root, coChanges: false, conventions: false});
        expect(none.entries.size).toBe(0);
    });

    it("works without git (co-change skipped)", async () => {
        const plain = mkdtempSync(join(tmpdir(), "aicd-ts-nogit-"));
        try {
            write(plain, "lib/x.py");
            write(plain, "tests/test_x.py");
            const map = await buildCoverageMap({tests: ["tests/test_x.py"], cwd: plain, logger});
            expect(map.entries.get("tests/test_x.py")).toMatchObject({files: ["lib/x.py"], source: "convention"});
        } finally {
            rmSync(plain, {recursive: true, force: true});
        }
    });
});

describe("coverage map storage", () => {
    it("round-trips through the state store and replaces the previous map", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.coverageMap, "gone.test.ts", {
            test: "gone.test.ts",
            files: [],
            source: "convention"
        });
        const entries = new Map([
            [
                "a.test.ts",
                {
                    test: "a.test.ts",
                    files: ["a.ts", "b.ts"],
                    source: "per_test_coverage" as const,
                    via: {"a.ts": "per_test_coverage" as const, "b.ts": "co_change" as const}
                }
            ]
        ]);
        await saveCoverageMap(state, {entries, generatedAt: "2026-10-01T00:00:00.000Z"}, "abc123");
        const loaded = await loadCoverageMap(state);
        expect(loaded?.generatedAt).toBe("2026-10-01T00:00:00.000Z");
        expect(loaded?.commitSha).toBe("abc123");
        expect([...(loaded?.entries.keys() ?? [])]).toEqual(["a.test.ts"]);
        expect(loaded?.entries.get("a.test.ts")?.via).toEqual({"a.ts": "per_test_coverage", "b.ts": "co_change"});
        const raw = await state.getRecord(COLLECTIONS.coverageMap, "a.test.ts");
        expect(raw?.value).toMatchObject({test: "a.test.ts", files: ["a.ts", "b.ts"], source: "per_test_coverage"});
    });

    it("reads records written by other tools and returns undefined when empty", async () => {
        const state = new SqliteStateStore(":memory:");
        expect(await loadCoverageMap(state)).toBeUndefined();
        await state.putRecord(COLLECTIONS.coverageMap, "t.test.ts", {
            test: "t.test.ts",
            files: ["./t.ts"],
            source: "convention"
        });
        const loaded = await loadCoverageMap(state);
        expect(loaded?.entries.get("t.test.ts")).toMatchObject({files: ["t.ts"], via: {"t.ts": "convention"}});
        // Dated by the store when the record carries no date.
        expect(loaded?.generatedAt).toEqual(expect.any(String));
    });

    it("recognises test paths", () => {
        expect(isTestPath("a/b.test.ts")).toBe(true);
        expect(isTestPath("a/b.ts")).toBe(false);
    });
});
