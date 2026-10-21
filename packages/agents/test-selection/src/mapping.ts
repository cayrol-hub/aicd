import {posix} from "node:path";
import {coChanges as gitCoChanges, git, isGitRepository} from "@aicd-ci/git";
import {COLLECTIONS, type CoverageMapRecord, type Logger, type StateStore} from "@aicd-ci/plugin-sdk";
import {DEFAULT_TEST_PATTERNS, isTestPath, listSourceFiles} from "./discover.js";
import {normalizePath} from "./paths.js";

export type CoverageSource = CoverageMapRecord["source"];

/** From the most to the least trusted. */
export const SOURCE_TRUST: readonly CoverageSource[] = ["per_test_coverage", "convention", "co_change"];

/** A stored `CoverageMapRecord`, plus the source of each file and the date of the map. */
export interface CoverageMapEntry extends CoverageMapRecord {
    /** File → the most trusted source that links it to the test. */
    via: Record<string, CoverageSource>;
    generatedAt?: string;
}

export interface CoverageMap {
    /** Test file → what it exercises. */
    entries: Map<string, CoverageMapEntry>;
    /** When the map was built (ISO). Selection refuses a map without a date or older than `mapMaxAgeDays`. */
    generatedAt?: string;
    commitSha?: string;
}

export interface CoChangeOptions {
    /** Minimum number of commits that touched both the test and the file. Default 3. */
    threshold?: number;
    /** Commits of history read. Default 500. */
    maxCommits?: number;
}

export interface BuildCoverageMapOptions {
    /** Test files, relative to `cwd`. */
    tests: string[];
    /** Repository root. */
    cwd: string;
    /** Test (file or test id such as `tests/test_x.py::test_y`) → source files it executed. */
    perTestCoverage?: Map<string, string[]> | Record<string, string[]>;
    /** Source files paired by naming conventions. Default: listed under `cwd`. */
    sourceFiles?: string[];
    /** Naming conventions (`bar.ts` ↔ `bar.test.ts`…). Default true. */
    conventions?: boolean;
    /** Git co-change. Default enabled with threshold 3; `false` disables it. */
    coChanges?: false | CoChangeOptions;
    testPatterns?: readonly string[];
    ignore?: readonly string[];
    now?: () => Date;
    logger?: Logger;
}

const FAMILIES: Record<string, string> = {
    js: "js",
    jsx: "js",
    ts: "js",
    tsx: "js",
    mjs: "js",
    cjs: "js",
    py: "py",
    go: "go",
    java: "jvm",
    kt: "jvm",
    rb: "rb"
};

/** Directory names that only say "this is test code" or "this is source code" and are ignored when pairing. */
const NEUTRAL_DIRS = new Set([
    "test",
    "tests",
    "__tests__",
    "__test__",
    "spec",
    "specs",
    "src",
    "lib",
    "main",
    "app",
    "unit",
    "integration",
    "java",
    "kotlin"
]);

function splitName(path: string): {dir: string; name: string; ext: string} {
    const dir = posix.dirname(path);
    const base = posix.basename(path);
    const dot = base.lastIndexOf(".");
    return {
        dir: dir === "." ? "" : dir,
        name: dot > 0 ? base.slice(0, dot) : base,
        ext: dot > 0 ? base.slice(dot + 1) : ""
    };
}

/** The source file name a test file is about, by the conventions of its language. */
export function testSubject(test: string): {stem: string; family: string} | undefined {
    const {dir, name, ext} = splitName(test);
    const family = FAMILIES[ext];
    if (!family) return undefined;
    let stem: string | undefined;
    if (family === "js") {
        stem = /^(.+)\.(test|spec)$/.exec(name)?.[1] ?? (dir.split("/").includes("__tests__") ? name : undefined);
    } else if (family === "py") {
        stem = /^test_(.+)$/.exec(name)?.[1] ?? /^(.+)_test$/.exec(name)?.[1];
    } else if (family === "go") {
        stem = /^(.+)_test$/.exec(name)?.[1];
    } else if (family === "jvm") {
        stem = /^(.+?)Tests?$/.exec(name)?.[1] ?? /^Test(.+)$/.exec(name)?.[1];
    } else if (family === "rb") {
        stem = /^(.+)_(spec|test)$/.exec(name)?.[1];
    }
    return stem ? {stem, family} : undefined;
}

function dirKey(path: string): string {
    return splitName(path)
        .dir.split("/")
        .filter((segment) => segment && !NEUTRAL_DIRS.has(segment))
        .join("/");
}

const endsWithSegments = (longer: string, shorter: string) =>
    shorter === "" || longer === shorter || longer.endsWith(`/${shorter}`);

/** Indexes source files by language family and file name, for `conventionSources`. */
export function indexSources(sourceFiles: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const file of sourceFiles) {
        const {name, ext} = splitName(file);
        const family = FAMILIES[ext];
        if (!family) continue;
        const key = `${family}:${name}`;
        index.set(key, [...(index.get(key) ?? []), file]);
    }
    return index;
}

/**
 * Source files a test is about by naming convention: same name, same language family, and the same directory
 * once test/source directory names (`test`, `src`, `__tests__`, `src/main/java`…) are removed, so that
 * `src/foo/bar.ts` ↔ `test/foo/bar.test.ts` and `src/main/java/a/Bar.java` ↔ `src/test/java/a/BarTest.java`.
 * When no directory matches, a single candidate whose directory ends like the test's is accepted.
 */
export function conventionSources(test: string, index: Map<string, string[]>): string[] {
    const subject = testSubject(test);
    if (!subject) return [];
    const candidates = index.get(`${subject.family}:${subject.stem}`) ?? [];
    const key = dirKey(test);
    const exact = candidates.filter((candidate) => dirKey(candidate) === key);
    if (exact.length > 0) return exact;
    const loose = candidates.filter((candidate) => {
        const other = dirKey(candidate);
        return endsWithSegments(other, key) || endsWithSegments(key, other);
    });
    return loose.length === 1 ? loose : [];
}

/** Maps a per-test coverage key (`file`, `file::name`, `file > suite > name`…) to a known test file. */
export function resolveTestKey(key: string, tests: readonly string[], root?: string): string | undefined {
    const normalized = normalizePath(key, root);
    if (tests.includes(normalized)) return normalized;
    let best: string | undefined;
    for (const test of tests) {
        if (!normalized.startsWith(test)) continue;
        const next = normalized.charAt(test.length);
        if ([":", "#", " ", ">", "("].includes(next) && (!best || test.length > best.length)) best = test;
    }
    return best;
}

function add(links: Map<string, Map<string, CoverageSource>>, test: string, file: string, source: CoverageSource) {
    const files = links.get(test) ?? new Map<string, CoverageSource>();
    const current = files.get(file);
    if (!current || SOURCE_TRUST.indexOf(source) < SOURCE_TRUST.indexOf(current)) files.set(file, source);
    links.set(test, files);
}

/**
 * Builds the test → source files map from, in order of trust: per-test coverage, naming conventions and git
 * co-change. Signals are combined (more links only select more tests); each file keeps its most trusted source.
 */
export async function buildCoverageMap(options: BuildCoverageMapOptions): Promise<CoverageMap> {
    const patterns = options.testPatterns ?? DEFAULT_TEST_PATTERNS;
    const tests = [...new Set(options.tests.map((test) => normalizePath(test)))];
    const links = new Map<string, Map<string, CoverageSource>>();
    const isSource = (file: string) => file !== "" && !isTestPath(file, patterns);

    if (options.perTestCoverage) {
        const entries =
            options.perTestCoverage instanceof Map
                ? [...options.perTestCoverage]
                : Object.entries(options.perTestCoverage);
        let unresolved = 0;
        for (const [key, files] of entries) {
            const test = resolveTestKey(key, tests, options.cwd);
            if (!test) {
                unresolved++;
                continue;
            }
            for (const file of files) {
                const path = normalizePath(file, options.cwd);
                if (isSource(path)) add(links, test, path, "per_test_coverage");
            }
        }
        if (unresolved > 0)
            options.logger?.debug(`coverage map: ${unresolved} per-test coverage key(s) match no test file`);
    }

    if (options.conventions !== false) {
        const sources =
            options.sourceFiles?.map((file) => normalizePath(file, options.cwd)) ??
            (await listSourceFiles({cwd: options.cwd, patterns, ...(options.ignore ? {ignore: options.ignore} : {})}));
        const index = indexSources(sources.filter(isSource));
        for (const test of tests)
            for (const file of conventionSources(test, index)) add(links, test, file, "convention");
    }

    if (options.coChanges !== false && tests.length > 0) {
        const threshold = options.coChanges?.threshold ?? 3;
        try {
            if (await isGitRepository({cwd: options.cwd})) {
                // Git paths are relative to the repository root, tests to `cwd`.
                const prefix = (await git(["rev-parse", "--show-prefix"], {cwd: options.cwd})).trim();
                const result = await gitCoChanges(
                    tests.map((test) => prefix + test),
                    {cwd: options.cwd, maxCommits: options.coChanges?.maxCommits ?? 500}
                );
                for (const [file, counts] of result) {
                    const test = file.slice(prefix.length);
                    for (const [other, count] of counts) {
                        if (count < threshold || !other.startsWith(prefix)) continue;
                        const path = other.slice(prefix.length);
                        if (isSource(path)) add(links, test, path, "co_change");
                    }
                }
            }
        } catch (error) {
            options.logger?.warn(`coverage map: git co-change unavailable: ${(error as Error).message}`);
        }
    }

    const generatedAt = (options.now?.() ?? new Date()).toISOString();
    const entries = new Map<string, CoverageMapEntry>();
    for (const test of [...links.keys()].sort()) {
        const files = links.get(test) as Map<string, CoverageSource>;
        if (files.size === 0) continue;
        const via = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
        const source = SOURCE_TRUST.find((candidate) => Object.values(via).includes(candidate)) as CoverageSource;
        entries.set(test, {test, files: Object.keys(via), source, via, generatedAt});
    }
    return {entries, generatedAt};
}

/** Replaces the stored map (`COLLECTIONS.coverageMap`, one record per test) with `map`. */
export async function saveCoverageMap(state: StateStore, map: CoverageMap, commitSha?: string): Promise<void> {
    const generatedAt = map.generatedAt ?? new Date().toISOString();
    const existing = await state.listRecords<CoverageMapEntry>(COLLECTIONS.coverageMap);
    for (const record of existing) {
        if (!map.entries.has(record.id)) await state.deleteRecord(COLLECTIONS.coverageMap, record.id);
    }
    for (const [test, entry] of map.entries) {
        const sha = commitSha ?? entry.commitSha ?? map.commitSha;
        const record: CoverageMapEntry = {...entry, test, generatedAt, ...(sha ? {commitSha: sha} : {})};
        await state.putRecord(COLLECTIONS.coverageMap, test, record);
    }
}

/**
 * Loads the stored map, or undefined when there is none. Its date is the oldest record's, so that a partly
 * refreshed map still counts as old. Records written by other tools without `via` get every file from `source`.
 */
export async function loadCoverageMap(state: StateStore): Promise<CoverageMap | undefined> {
    const records = await state.listRecords<Partial<CoverageMapEntry>>(COLLECTIONS.coverageMap);
    const entries = new Map<string, CoverageMapEntry>();
    let generatedAt: string | undefined;
    let commitSha: string | undefined;
    for (const record of records) {
        const value = record.value;
        const files = Array.isArray(value.files) ? value.files.map((file) => normalizePath(String(file))) : [];
        const source = SOURCE_TRUST.includes(value.source as CoverageSource)
            ? (value.source as CoverageSource)
            : "co_change";
        const test = normalizePath(value.test ?? record.id);
        const via: Record<string, CoverageSource> = {};
        for (const file of files) via[file] = value.via?.[file] ?? source;
        const date = value.generatedAt ?? record.updatedAt;
        if (!generatedAt || date < generatedAt) generatedAt = date;
        commitSha ??= value.commitSha;
        entries.set(test, {
            test,
            files,
            source,
            via,
            generatedAt: date,
            ...(value.commitSha ? {commitSha: value.commitSha} : {})
        });
    }
    if (entries.size === 0) return undefined;
    return {entries, ...(generatedAt ? {generatedAt} : {}), ...(commitSha ? {commitSha} : {})};
}
