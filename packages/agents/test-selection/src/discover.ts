import {glob} from "tinyglobby";
import {firstMatch, normalizePath} from "./paths.js";

/** Test files of the usual ecosystems. `src/test` and `__tests__` are limited to code files (not resources). */
export const DEFAULT_TEST_PATTERNS: readonly string[] = [
    "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
    "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}",
    "**/test_*.py",
    "**/*_test.py",
    "**/*_test.go",
    "**/*Test.{java,kt}",
    "**/src/test/**/*.{java,kt}",
    "**/*_spec.rb"
];

export const DEFAULT_IGNORE: readonly string[] = ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/.git/**"];

/** Source extensions the naming conventions know about. */
export const SOURCE_EXTENSIONS: readonly string[] = [
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "py",
    "go",
    "java",
    "kt",
    "rb"
];

export interface DiscoverOptions {
    cwd: string;
    patterns?: readonly string[];
    ignore?: readonly string[];
}

/** True when `path` (repository-relative) looks like a test file. */
export function isTestPath(path: string, patterns: readonly string[] = DEFAULT_TEST_PATTERNS): boolean {
    return firstMatch(normalizePath(path), patterns) !== undefined;
}

/** Test files under `cwd`, relative to it, sorted. */
export async function discoverTests(options: DiscoverOptions): Promise<string[]> {
    const found = await glob([...(options.patterns ?? DEFAULT_TEST_PATTERNS)], {
        cwd: options.cwd,
        ignore: [...(options.ignore ?? DEFAULT_IGNORE)],
        onlyFiles: true,
        dot: false
    });
    return [...new Set(found.map((path) => normalizePath(path)))].sort();
}

/** Source files under `cwd` that the naming conventions can pair with a test (tests excluded). */
export async function listSourceFiles(options: DiscoverOptions): Promise<string[]> {
    const found = await glob([`**/*.{${SOURCE_EXTENSIONS.join(",")}}`], {
        cwd: options.cwd,
        ignore: [...(options.ignore ?? DEFAULT_IGNORE)],
        onlyFiles: true,
        dot: false
    });
    const patterns = options.patterns ?? DEFAULT_TEST_PATTERNS;
    return found
        .map((path) => normalizePath(path))
        .filter((path) => !isTestPath(path, patterns))
        .sort();
}
