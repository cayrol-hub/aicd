import type {Language} from "@aicd/plugin-sdk";
import {DEFAULT_TEST_PATTERNS, isTestPath} from "./discover.js";
import type {CoverageMap, CoverageSource} from "./mapping.js";
import {branchMatches, firstMatch, normalizePath} from "./paths.js";
import {describeDecision} from "./render.js";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

/** A changed path (repository-relative), or a path with its git status. */
export type ChangedFile = string | {path: string; status?: ChangeStatus; previousPath?: string};

/** Files whose change can affect any test: dependencies, CI, build, test configuration and fixtures. */
export const DEFAULT_FORCE_FULL_PATTERNS: readonly string[] = [
    // Lockfiles
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "pdm.lock",
    "Gemfile.lock",
    "go.sum",
    "Cargo.lock",
    "composer.lock",
    "*.lockfile",
    // Package manifests and toolchain versions
    "package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".yarnrc*",
    "requirements*.txt",
    "constraints*.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "go.mod",
    "go.work",
    "Gemfile",
    "*.gemspec",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle/**",
    "Cargo.toml",
    "composer.json",
    ".nvmrc",
    ".node-version",
    ".python-version",
    ".ruby-version",
    ".tool-versions",
    // CI configuration
    ".gitlab-ci.yml",
    ".gitlab/ci/**",
    ".github/workflows/**",
    ".github/actions/**",
    ".circleci/**",
    "Jenkinsfile",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".aicd.yaml",
    ".aicd.yml",
    // Build configuration
    "tsconfig*.json",
    "jsconfig.json",
    "babel.config.*",
    ".babelrc*",
    ".swcrc",
    "webpack.config.*",
    "vite.config.*",
    "rollup.config.*",
    "esbuild.config.*",
    "turbo.json",
    "nx.json",
    "Makefile",
    "*.mk",
    "CMakeLists.txt",
    "Dockerfile",
    "Dockerfile.*",
    "*.dockerfile",
    ".dockerignore",
    "docker-compose*.{yml,yaml}",
    "compose*.{yml,yaml}",
    ".env*",
    // Test configuration, setup and shared fixtures
    "jest.config.*",
    "jest.setup.*",
    "vitest.config.*",
    "vitest.workspace.*",
    "vitest.setup.*",
    "karma.conf.*",
    ".mocharc*",
    "playwright.config.*",
    "cypress.config.*",
    "pytest.ini",
    "conftest.py",
    "tox.ini",
    "noxfile.py",
    ".coveragerc",
    ".rspec",
    "spec_helper.rb",
    "rails_helper.rb",
    "test_helper.rb",
    "setupTests.*",
    "setup-tests.*",
    "test-setup.*",
    "test-utils.*",
    "**/test/setup.*",
    "**/tests/setup.*",
    "**/test-utils/**",
    "**/__mocks__/**",
    "**/fixtures/**",
    "**/__fixtures__/**",
    "**/testdata/**"
];

/** Files with no effect on tests (outside test directories): documentation and repository metadata. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
    "*.md",
    "*.mdx",
    "*.rst",
    "*.adoc",
    "docs/**",
    "LICENSE*",
    "NOTICE*",
    "CODEOWNERS",
    ".gitignore",
    ".gitattributes",
    ".editorconfig"
];

export const DEFAULT_FULL_SUITE_BRANCHES: readonly string[] = ["main", "master", "release/*"];

/** Directory names that hold test code: a non-test file there is test support (helpers, data). */
const TEST_DIRS = new Set([
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "fixtures",
    "__fixtures__",
    "__mocks__",
    "__snapshots__",
    "testdata",
    "test-data",
    "testing"
]);

export interface SelectionOptions {
    /** Current branch: full suite on `defaultBranch` and on `fullSuiteOn` patterns. */
    branch?: string;
    defaultBranch?: string;
    /** Tag pipelines always run the full suite. */
    tag?: string;
    /** Branch patterns (`*` spans slashes). Default `["main", "master", "release/*"]`. */
    fullSuiteOn?: readonly string[];
    /** A changed file matching one of them runs the full suite. Default `DEFAULT_FORCE_FULL_PATTERNS`. */
    forceFullPatterns?: readonly string[];
    /** Changed files without test impact. Default `DEFAULT_IGNORE_PATTERNS` (documentation). */
    ignorePatterns?: readonly string[];
    testPatterns?: readonly string[];
    /** More changed files than this runs the full suite. Default 50. */
    maxChangedFiles?: number;
    /** A changed source file no test is mapped to: run everything ("full", default) or nothing for it. */
    unmappedSource?: "full" | "ignore";
    /** Tests absent from the map: run them ("run", default) or skip them. */
    unmappedTests?: "run" | "skip";
    /** A map older than this (days) runs the full suite. Default 14. */
    mapMaxAgeDays?: number;
    /** Set by the risk agent on high-risk merge requests. */
    forceFull?: boolean;
    /**
     * Aggregate coverage (Cobertura, JaCoCo, lcov): a changed file executed by the suite but mapped to no test
     * runs the full suite even with `unmappedSource: "ignore"`. Entries may be path suffixes.
     */
    coveredFiles?: readonly string[];
    /** Language of `reasons`. Default "en". */
    language?: Language;
    now?: () => Date;
}

export interface SelectInput {
    changedFiles: readonly ChangedFile[];
    /** Every test file of the repository. */
    tests: readonly string[];
    map?: CoverageMap;
    options?: SelectionOptions;
}

/** One decision of the selection, rendered by `describeDecision`. */
export type SelectionDecision =
    | {kind: "forced"}
    | {kind: "tag"; tag: string}
    | {kind: "default_branch"; branch: string}
    | {kind: "full_branch"; branch: string; pattern: string}
    | {kind: "no_changes"}
    | {kind: "too_many_changes"; count: number; max: number}
    | {kind: "force_full_file"; file: string; pattern: string}
    | {kind: "no_map"}
    | {kind: "undated_map"}
    | {kind: "stale_map"; ageDays: number; max: number}
    | {kind: "no_tests"}
    | {kind: "test_support_file"; file: string}
    | {kind: "covered_unmapped"; file: string}
    | {kind: "unmapped_source"; file: string}
    | {kind: "all_selected"}
    | {kind: "changed_test"; test: string}
    | {kind: "snapshot"; test: string; file: string}
    | {kind: "covers"; test: string; file: string; source: CoverageSource}
    | {kind: "unmapped_tests"; tests: string[]}
    | {kind: "deleted_test"; test: string}
    | {kind: "ignored_file"; file: string; pattern: string}
    | {kind: "ignored_unmapped"; file: string}
    | {kind: "skipped"; count: number}
    | {kind: "nothing_affected"};

export interface Selection {
    /** True: run the whole suite (ignore `selected`). */
    full: boolean;
    /** Human-readable reason for every decision, in `options.language`. */
    reasons: string[];
    /** Tests to run (every test when `full`). */
    selected: string[];
    skipped: string[];
    /** Changed source files no test is mapped to. */
    uncoveredChangedFiles: string[];
    decisions: SelectionDecision[];
}

const DAY_MS = 86_400_000;

interface Change {
    path: string;
    deleted: boolean;
}

function normalizeChanges(changedFiles: readonly ChangedFile[]): Change[] {
    const changes = new Map<string, Change>();
    const put = (path: string, deleted: boolean) => {
        const normalized = normalizePath(path);
        if (!normalized) return;
        // A path both deleted and re-added in the same diff exists.
        const current = changes.get(normalized);
        changes.set(normalized, {path: normalized, deleted: current ? current.deleted && deleted : deleted});
    };
    for (const change of changedFiles) {
        if (typeof change === "string") {
            put(change, false);
            continue;
        }
        put(change.path, change.status === "deleted");
        if (change.previousPath) put(change.previousPath, true);
    }
    return [...changes.values()];
}

function isTestSupport(path: string): boolean {
    return path
        .split("/")
        .slice(0, -1)
        .some((segment) => TEST_DIRS.has(segment));
}

/** A JVM file under `src/test` not named like a test class is a helper other tests use. */
function isJvmTestHelper(path: string): boolean {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!/\.(java|kt)$/.test(name)) return false;
    if (/(Utils?|Helpers?|Fixtures?|Support|Base|Factory|Data|Config)\.(java|kt)$/.test(name)) return true;
    return !/(^Test[A-Z0-9_].*|Tests?|IT|Spec)\.(java|kt)$/.test(name);
}

function aggregateCovers(path: string, coveredFiles: readonly string[]): boolean {
    return coveredFiles.some((entry) => {
        const covered = normalizePath(entry);
        return covered !== "" && (covered === path || path.endsWith(`/${covered}`));
    });
}

/**
 * Picks the tests a change needs. Any doubt runs the full suite: forced, protected branch or tag, unknown or
 * too large change, dependency/CI/build/test-config file, missing, undated or stale map, no tests, test support
 * code, or a changed source file no test is mapped to (unless `unmappedSource: "ignore"`). Otherwise: changed
 * tests, tests mapped to a changed file, and tests the map knows nothing about.
 */
export function selectTests(input: SelectInput): Selection {
    const options = input.options ?? {};
    const language = options.language ?? "en";
    const testPatterns = options.testPatterns ?? DEFAULT_TEST_PATTERNS;
    const forceFullPatterns = options.forceFullPatterns ?? DEFAULT_FORCE_FULL_PATTERNS;
    const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    const maxChangedFiles = options.maxChangedFiles ?? 50;
    const mapMaxAgeDays = options.mapMaxAgeDays ?? 14;
    const unmappedSource = options.unmappedSource ?? "full";
    const now = options.now?.() ?? new Date();
    const map = input.map;

    const tests = [...new Set(input.tests.map((test) => normalizePath(test)).filter(Boolean))].sort();
    const testSet = new Set(tests);
    const changes = normalizeChanges(input.changedFiles);
    const full: SelectionDecision[] = [];
    const decisions: SelectionDecision[] = [];
    const selected = new Set<string>();
    const uncovered: string[] = [];

    if (options.forceFull) full.push({kind: "forced"});
    if (options.tag) full.push({kind: "tag", tag: options.tag});
    if (options.branch) {
        const pattern = (options.fullSuiteOn ?? DEFAULT_FULL_SUITE_BRANCHES).find((candidate) =>
            branchMatches(options.branch as string, candidate)
        );
        if (options.defaultBranch && options.branch === options.defaultBranch) {
            full.push({kind: "default_branch", branch: options.branch});
        } else if (pattern) {
            full.push({kind: "full_branch", branch: options.branch, pattern});
        }
    }
    if (changes.length === 0) full.push({kind: "no_changes"});
    if (input.changedFiles.length > maxChangedFiles) {
        full.push({kind: "too_many_changes", count: input.changedFiles.length, max: maxChangedFiles});
    }
    if (!map || map.entries.size === 0) {
        full.push({kind: "no_map"});
    } else {
        const generated = map.generatedAt ? Date.parse(map.generatedAt) : Number.NaN;
        if (Number.isNaN(generated)) full.push({kind: "undated_map"});
        else if (now.getTime() - generated > mapMaxAgeDays * DAY_MS) {
            full.push({
                kind: "stale_map",
                ageDays: Math.floor((now.getTime() - generated) / DAY_MS),
                max: mapMaxAgeDays
            });
        }
    }
    if (tests.length === 0) full.push({kind: "no_tests"});

    // File → tests mapped to it (only tests that still exist).
    const linked = new Map<string, {test: string; source: CoverageSource}[]>();
    for (const entry of map?.entries.values() ?? []) {
        if (!testSet.has(entry.test)) continue;
        for (const file of entry.files) {
            linked.set(file, [
                ...(linked.get(file) ?? []),
                {test: entry.test, source: entry.via[file] ?? entry.source}
            ]);
        }
    }

    for (const {path, deleted} of changes) {
        const forcing = firstMatch(path, forceFullPatterns);
        if (forcing) {
            full.push({kind: "force_full_file", file: path, pattern: forcing});
            continue;
        }
        if (isTestPath(path, testPatterns) && !isJvmTestHelper(path)) {
            if (deleted) {
                decisions.push({kind: "deleted_test", test: path});
            } else {
                selected.add(path);
                decisions.push({kind: "changed_test", test: path});
            }
            continue;
        }
        const snapshot = /^(?:(.*)\/)?__snapshots__\/([^/]+)\.snap$/.exec(path);
        if (snapshot) {
            const test = snapshot[1] ? `${snapshot[1]}/${snapshot[2]}` : (snapshot[2] as string);
            if (testSet.has(test)) {
                selected.add(test);
                decisions.push({kind: "snapshot", test, file: path});
            } else {
                full.push({kind: "test_support_file", file: path});
            }
            continue;
        }
        const links = linked.get(path) ?? [];
        // Shared test code is used by tests that conventions and co-change cannot see: only coverage counts.
        if (isTestSupport(path)) {
            const trusted = links.filter((link) => link.source === "per_test_coverage");
            if (trusted.length === 0) {
                full.push({kind: "test_support_file", file: path});
                continue;
            }
            for (const link of trusted) {
                selected.add(link.test);
                decisions.push({kind: "covers", test: link.test, file: path, source: link.source});
            }
            continue;
        }
        if (links.length > 0) {
            for (const link of links) {
                selected.add(link.test);
                decisions.push({kind: "covers", test: link.test, file: path, source: link.source});
            }
            continue;
        }
        const ignored = firstMatch(path, ignorePatterns);
        if (ignored) {
            decisions.push({kind: "ignored_file", file: path, pattern: ignored});
            continue;
        }
        uncovered.push(path);
        if (options.coveredFiles && aggregateCovers(path, options.coveredFiles)) {
            full.push({kind: "covered_unmapped", file: path});
        } else if (unmappedSource === "full") {
            full.push({kind: "unmapped_source", file: path});
        } else {
            decisions.push({kind: "ignored_unmapped", file: path});
        }
    }

    if ((options.unmappedTests ?? "run") === "run") {
        const unmapped = tests.filter((test) => !selected.has(test) && !map?.entries.get(test)?.files.length);
        if (unmapped.length > 0) {
            for (const test of unmapped) selected.add(test);
            decisions.push({kind: "unmapped_tests", tests: unmapped});
        }
    }

    const finish = (result: Omit<Selection, "reasons" | "uncoveredChangedFiles">): Selection => ({
        ...result,
        reasons: result.decisions.map((decision) => describeDecision(decision, language)),
        uncoveredChangedFiles: uncovered.sort()
    });

    if (full.length > 0) {
        // Without a map every file is unmapped: "no map" says it once.
        const noMap = full.some((decision) => decision.kind === "no_map");
        const unmappedKinds = ["test_support_file", "covered_unmapped", "unmapped_source"];
        const reasons = noMap ? full.filter((decision) => !unmappedKinds.includes(decision.kind)) : full;
        return finish({full: true, selected: tests, skipped: [], decisions: reasons});
    }

    const skipped = tests.filter((test) => !selected.has(test));
    if (skipped.length === 0) {
        return finish({full: true, selected: tests, skipped: [], decisions: [...decisions, {kind: "all_selected"}]});
    }
    if (selected.size === 0) decisions.push({kind: "nothing_affected"});
    decisions.push({kind: "skipped", count: skipped.length});
    return finish({full: false, selected: [...selected].sort(), skipped, decisions});
}
