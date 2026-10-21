import type {Evidence, Language} from "@aicd-ci/plugin-sdk";
import {ownersOf, parseCodeowners} from "./codeowners.js";
import {parseUnifiedDiff, type DiffFile} from "./diff.js";
import {firstMatch} from "./glob.js";

export type RiskLevel = "low" | "medium" | "high";

export type SignalId =
    | "size"
    | "files"
    | "sensitive_paths"
    | "migrations"
    | "destructive_sql"
    | "fix_history"
    | "missing_tests"
    | "dependencies"
    | "ci_config"
    | "owners";

export const SIGNAL_IDS: readonly SignalId[] = [
    "size",
    "files",
    "sensitive_paths",
    "migrations",
    "destructive_sql",
    "fix_history",
    "missing_tests",
    "dependencies",
    "ci_config",
    "owners"
];

/** Maximum points of each signal. They add up to more than 100: the score is capped. */
export const DEFAULT_WEIGHTS: Record<SignalId, number> = {
    size: 20,
    files: 10,
    sensitive_paths: 25,
    migrations: 15,
    destructive_sql: 30,
    fix_history: 15,
    missing_tests: 10,
    dependencies: 10,
    ci_config: 10,
    owners: 10
};

/** Matched case-insensitively. A glob without a slash matches a file or directory name at any depth. */
export const DEFAULT_SENSITIVE_PATHS = [
    "*auth*",
    "*login*",
    "*session*",
    "*password*",
    "*payment*",
    "*billing*",
    "*invoice*",
    "*wallet*",
    "*crypto*",
    "*security*",
    "*permission*",
    "*admin*",
    "*migration*",
    "infra",
    "infrastructure",
    "*terraform*",
    "*.tf",
    "k8s",
    "kubernetes",
    "helm",
    "Dockerfile*",
    "*.dockerfile",
    ".gitlab-ci.yml",
    ".github/workflows",
    "Jenkinsfile*",
    ".circleci"
];

export const DEFAULT_MIGRATION_PATHS = [
    "migrations",
    "**/db/migrate",
    "alembic",
    "**/prisma/migrations",
    "*.sql",
    "liquibase",
    "flyway"
];

export const DEFAULT_TEST_PATHS = [
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "e2e",
    "cypress",
    "*.test.*",
    "*.spec.*",
    "*_test.*",
    "*_spec.*",
    "test_*.py",
    "*Test.java",
    "*Test.kt",
    "*Tests.cs",
    "*Tests.swift"
];

export const DEFAULT_CI_PATHS = [
    ".gitlab-ci.yml",
    ".gitlab-ci",
    ".gitlab/ci",
    ".github/workflows",
    ".github/actions",
    "Jenkinsfile*",
    ".circleci",
    "azure-pipelines*.yml",
    "bitbucket-pipelines.yml",
    ".travis.yml",
    ".drone.yml",
    ".buildkite",
    "Dockerfile*",
    "*.dockerfile",
    "docker-compose*.y*ml",
    "compose.y*ml",
    "*.tf",
    "*.tfvars",
    "terraform",
    "k8s",
    "kubernetes",
    "helm",
    "charts",
    "Chart.yaml",
    "kustomization.y*ml",
    "infra",
    "infrastructure",
    "ansible"
];

/** Lockfiles: generated, so their lines do not count in the size signal. */
export const DEFAULT_LOCKFILES = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "go.sum",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "gradle.lockfile",
    "packages.lock.json",
    "mix.lock",
    "Podfile.lock",
    "Package.resolved",
    "pubspec.lock"
];

export const DEFAULT_MANIFESTS = [
    "package.json",
    "go.mod",
    "Cargo.toml",
    "requirements*.txt",
    "Pipfile",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Gemfile",
    "*.gemspec",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "libs.versions.toml",
    "*.csproj",
    "Directory.Packages.props",
    "mix.exs",
    "Podfile",
    "Package.swift",
    "pubspec.yaml"
];

const SOURCE_EXTENSIONS = new Set([
    "ts",
    "tsx",
    "mts",
    "cts",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "vue",
    "svelte",
    "py",
    "go",
    "java",
    "kt",
    "scala",
    "rb",
    "php",
    "cs",
    "fs",
    "swift",
    "m",
    "mm",
    "rs",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "dart",
    "ex",
    "exs",
    "erl",
    "clj",
    "lua"
]);

export interface RiskOptions {
    thresholds: {medium: number; high: number};
    weights: Record<SignalId, number>;
    sensitivePaths: string[];
    migrationPaths: string[];
    testPaths: string[];
    ciPaths: string[];
    manifests: string[];
    lockfiles: string[];
    /** A file counts in the fix history signal from this many fix commits. */
    fixHotspotMin: number;
    /** Approvals the merge request should get, per level. */
    requiredApprovals: Record<RiskLevel, number>;
    /** Language of `explanation` in the report. */
    language: Language;
}

export type RiskOptionsInput = Partial<Omit<RiskOptions, "thresholds" | "weights" | "requiredApprovals">> & {
    thresholds?: Partial<RiskOptions["thresholds"]>;
    weights?: Partial<Record<SignalId, number>>;
    requiredApprovals?: Partial<Record<RiskLevel, number>>;
};

export function resolveRiskOptions(input: RiskOptionsInput = {}): RiskOptions {
    return {
        thresholds: {medium: 40, high: 70, ...input.thresholds},
        weights: {...DEFAULT_WEIGHTS, ...input.weights},
        sensitivePaths: input.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS,
        migrationPaths: input.migrationPaths ?? DEFAULT_MIGRATION_PATHS,
        testPaths: input.testPaths ?? DEFAULT_TEST_PATHS,
        ciPaths: input.ciPaths ?? DEFAULT_CI_PATHS,
        manifests: input.manifests ?? DEFAULT_MANIFESTS,
        lockfiles: input.lockfiles ?? DEFAULT_LOCKFILES,
        fixHotspotMin: input.fixHotspotMin ?? 2,
        requiredApprovals: {low: 1, medium: 1, high: 2, ...input.requiredApprovals},
        language: input.language ?? "en"
    };
}

export interface RiskInput {
    /** Unified diff of the merge request. */
    diff?: string;
    /** Changed paths, when no diff is available (or in addition to it). */
    changedFiles?: string[];
    /** Fix commits per file, e.g. from `@aicd-ci/git` `fixCounts`. */
    fixCounts?: ReadonlyMap<string, number> | Record<string, number>;
    /** Content of the CODEOWNERS file. */
    codeowners?: string;
}

export interface RiskSignal {
    id: SignalId;
    points: number;
    maxPoints: number;
    /** Numbers the explanation is built from (see `explainSignal`). */
    facts: Record<string, number>;
    explanation: string;
    evidence: Evidence[];
}

export interface RiskReport {
    /** 0–100. */
    score: number;
    /** Sum of the signal points before the cap. */
    rawScore: number;
    level: RiskLevel;
    thresholds: {medium: number; high: number};
    signals: RiskSignal[];
    files: number;
    linesChanged: number;
    /** True at high: run the whole test suite, not a selection. */
    forceFullSuite: boolean;
    requiredApprovals: number;
}

export interface DestructiveStatement {
    path: string;
    line: number;
    kind: string;
    text: string;
}

const DESTRUCTIVE: {kind: string; pattern: RegExp}[] = [
    {kind: "DROP TABLE", pattern: /\bdrop\s+table\b|\bdrop_table\b/i},
    {kind: "DROP COLUMN", pattern: /\bdrop\s+column\b|\bdrop_column\b|\bremove_column\b/i},
    {kind: "DROP SCHEMA", pattern: /\bdrop\s+(?:schema|database)\b/i},
    {kind: "TRUNCATE", pattern: /\btruncate\s+(?:table\s+)?\S/i},
    {kind: "ALTER COLUMN TYPE", pattern: /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b|\bmodify\s+column\b/i},
    {kind: "RENAME", pattern: /\brename\s+(?:column\s+\S+\s+)?to\b|\brename\s+column\b|\brename_(?:column|table)\b/i}
];

const SET_NOT_NULL = /\bset\s+not\s+null\b/i;
const ADD_NOT_NULL = /\badd\s+(?:column\s+)?\S+\s+[^;]*\bnot\s+null\b/i;

/**
 * Destructive SQL in the added lines of migration files: one entry per statement and kind.
 * `SET NOT NULL` (or a new NOT NULL column) counts only when no DEFAULT is given in the file's additions.
 */
export function findDestructiveSql(file: DiffFile): DestructiveStatement[] {
    const found: DestructiveStatement[] = [];
    const lines = file.added.filter((line) => !/^\s*(--|#|\/\/)/.test(line.text));
    const hasDefault = lines.some((line) => /\bdefault\b/i.test(line.text));
    const check = (text: string, line: number) => {
        for (const {kind, pattern} of DESTRUCTIVE)
            if (pattern.test(text)) found.push({path: file.path, line, kind, text});
        if ((SET_NOT_NULL.test(text) || ADD_NOT_NULL.test(text)) && !hasDefault) {
            found.push({path: file.path, line, kind: "SET NOT NULL", text});
        }
    };
    // Migration DSLs (Rails, Alembic, Knex…) have no ";": one statement per line.
    if (!lines.some((line) => line.text.includes(";"))) {
        for (const line of lines) if (line.text.trim()) check(line.text.replace(/\s+/g, " ").trim(), line.line);
        return found;
    }
    // SQL statements may span lines: reported at their first line.
    let statement = "";
    let firstLine = 0;
    for (const line of lines) {
        const parts = line.text.split(";");
        parts.forEach((part, index) => {
            if (!statement.trim()) firstLine = line.line;
            statement += ` ${part}`;
            if (index < parts.length - 1) {
                if (statement.trim()) check(statement.replace(/\s+/g, " ").trim(), firstLine);
                statement = "";
            }
        });
    }
    if (statement.trim()) check(statement.replace(/\s+/g, " ").trim(), firstLine);
    return found;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Log-scaled: 0 up to `low`, 1 from `high`. */
const logScale = (value: number, low: number, high: number) =>
    value <= low ? 0 : clamp(Math.log(value / low) / Math.log(high / low));

const EXPLAIN: Record<Language, Record<SignalId, (facts: Record<string, number>) => string>> = {
    en: {
        size: (f) =>
            `${f.lines ?? 0} lines changed (+${f.additions ?? 0} / -${f.deletions ?? 0})` +
            (f.excluded ? `, ${f.excluded} lockfile lines not counted` : "") +
            (f.binary ? `, ${f.binary} binary file(s)` : "") +
            (f.unknown ? "; no diff, size unknown" : ""),
        files: (f) => `${f.files ?? 0} file(s) changed`,
        sensitive_paths: (f) => `${f.files ?? 0} file(s) in sensitive paths`,
        migrations: (f) => `${f.files ?? 0} database migration file(s)`,
        destructive_sql: (f) => `${f.statements ?? 0} destructive SQL statement(s) added`,
        fix_history: (f) => `${f.files ?? 0} file(s) fixed often recently (${f.fixes ?? 0} fix commits)`,
        missing_tests: (f) => `${f.sourceFiles ?? 0} source file(s) changed, no test changed`,
        dependencies: (f) => `${f.manifests ?? 0} dependency manifest(s), ${f.lockfiles ?? 0} lockfile(s) changed`,
        ci_config: (f) => `${f.files ?? 0} CI or infrastructure file(s) changed`,
        owners: (f) => `${f.owners ?? 0} code owners involved`
    },
    fr: {
        size: (f) =>
            `${f.lines ?? 0} lignes modifiées (+${f.additions ?? 0} / -${f.deletions ?? 0})` +
            (f.excluded ? `, ${f.excluded} lignes de lockfiles non comptées` : "") +
            (f.binary ? `, ${f.binary} fichier(s) binaire(s)` : "") +
            (f.unknown ? " ; pas de diff, taille inconnue" : ""),
        files: (f) => `${f.files ?? 0} fichier(s) modifié(s)`,
        sensitive_paths: (f) => `${f.files ?? 0} fichier(s) dans des chemins sensibles`,
        migrations: (f) => `${f.files ?? 0} fichier(s) de migration de base de données`,
        destructive_sql: (f) => `${f.statements ?? 0} instruction(s) SQL destructrice(s) ajoutée(s)`,
        fix_history: (f) =>
            `${f.files ?? 0} fichier(s) souvent corrigé(s) récemment (${f.fixes ?? 0} commits de correction)`,
        missing_tests: (f) => `${f.sourceFiles ?? 0} fichier(s) source modifié(s), aucun test modifié`,
        dependencies: (f) =>
            `${f.manifests ?? 0} manifeste(s) de dépendances, ${f.lockfiles ?? 0} lockfile(s) modifié(s)`,
        ci_config: (f) => `${f.files ?? 0} fichier(s) de CI ou d'infrastructure modifié(s)`,
        owners: (f) => `${f.owners ?? 0} propriétaires de code concernés`
    }
};

/** Human-readable explanation of a signal, in `language`. */
export function explainSignal(signal: Pick<RiskSignal, "id" | "facts">, language: Language): string {
    return EXPLAIN[language][signal.id](signal.facts);
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extension = (path: string) => {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Files of the diff plus changed paths the diff does not mention, sorted by path, without duplicates. */
function collectFiles(input: RiskInput): {files: DiffFile[]; hasDiff: boolean} {
    const byPath = new Map<string, DiffFile>();
    const hasDiff = typeof input.diff === "string" && input.diff.trim().length > 0;
    if (hasDiff) for (const file of parseUnifiedDiff(input.diff as string)) byPath.set(file.path, file);
    for (const path of input.changedFiles ?? []) {
        const clean = path.trim();
        if (clean && !byPath.has(clean)) {
            byPath.set(clean, {
                path: clean,
                status: "modified",
                binary: false,
                additions: 0,
                deletions: 0,
                added: [],
                removed: []
            });
        }
    }
    const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {files, hasDiff};
}

/** Every path a file is known by: a rename out of a sensitive directory is sensitive too. */
const pathsOf = (file: DiffFile) => (file.oldPath ? [file.path, file.oldPath] : [file.path]);

function matchAny(file: DiffFile, globs: readonly string[]): string | undefined {
    for (const path of pathsOf(file)) {
        const glob = firstMatch(path, globs);
        if (glob) return glob;
    }
    return undefined;
}

const fileEvidence = (file: DiffFile, glob?: string): Evidence => ({
    kind: "diff",
    ref: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
    ...(glob ? {quote: glob} : {})
});

/**
 * Scores a merge request from its diff and/or changed files. Pure and deterministic: no I/O,
 * same input and options → same report. Each signal gets points up to its weight, with an
 * explanation and evidence; the total is capped at 100.
 */
export function scoreMergeRequest(input: RiskInput, optionsInput: RiskOptionsInput = {}): RiskReport {
    const options = resolveRiskOptions(optionsInput);
    const {files, hasDiff} = collectFiles(input);
    const signals: RiskSignal[] = [];
    const add = (id: SignalId, fraction: number, facts: Record<string, number>, evidence: Evidence[] = []) => {
        const maxPoints = Math.max(0, options.weights[id]);
        const signal = {id, points: Math.round(maxPoints * clamp(fraction)), maxPoints, facts, evidence};
        signals.push({...signal, explanation: explainSignal(signal, options.language)});
    };

    const isLockfile = (file: DiffFile) => firstMatch(file.path, options.lockfiles, false) !== undefined;
    const migrationFiles = files.filter((file) => matchAny(file, options.migrationPaths));
    const ciFiles = files.filter((file) => matchAny(file, options.ciPaths));
    const dedicated = new Set([...migrationFiles, ...ciFiles].map((file) => file.path));

    // Size: lockfiles are generated, binary files have no lines.
    const counted = files.filter((file) => !isLockfile(file) && !file.binary);
    const additions = counted.reduce((sum, file) => sum + file.additions, 0);
    const deletions = counted.reduce((sum, file) => sum + file.deletions, 0);
    const excluded = files.filter(isLockfile).reduce((sum, file) => sum + file.additions + file.deletions, 0);
    const binary = files.filter((file) => file.binary).length;
    const lines = additions + deletions;
    const largest = [...counted].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 5);
    add(
        "size",
        hasDiff ? logScale(lines, 10, 1000) : 0,
        {lines, additions, deletions, excluded, binary, unknown: hasDiff ? 0 : 1},
        largest
            .filter((file) => file.additions + file.deletions > 0)
            .map((file) => ({kind: "diff", ref: `${file.path} (+${file.additions} / -${file.deletions})`}))
    );

    add("files", logScale(files.length, 3, 50), {files: files.length});

    const sensitive = files
        .filter((file) => !dedicated.has(file.path))
        .map((file) => ({file, glob: matchAny(file, options.sensitivePaths)}))
        .filter((entry): entry is {file: DiffFile; glob: string} => entry.glob !== undefined);
    add(
        "sensitive_paths",
        sensitive.length === 0 ? 0 : 0.6 + 0.2 * (sensitive.length - 1),
        {files: sensitive.length},
        sensitive.slice(0, 10).map(({file, glob}) => fileEvidence(file, glob))
    );

    add(
        "migrations",
        migrationFiles.length > 0 ? 1 : 0,
        {files: migrationFiles.length},
        migrationFiles.slice(0, 10).map((file) => fileEvidence(file, matchAny(file, options.migrationPaths)))
    );

    const destructive = migrationFiles.flatMap(findDestructiveSql);
    add(
        "destructive_sql",
        destructive.length === 0 ? 0 : 0.8 + 0.1 * (destructive.length - 1),
        {statements: destructive.length},
        destructive.slice(0, 10).map((statement) => ({
            kind: "diff",
            ref: `${statement.path}:${statement.line} (${statement.kind})`,
            quote: statement.text.slice(0, 200)
        }))
    );

    const fixCounts =
        input.fixCounts instanceof Map
            ? input.fixCounts
            : new Map(Object.entries((input.fixCounts as Record<string, number> | undefined) ?? {}));
    const hotspots = files
        .map((file) => ({path: file.path, fixes: fixCounts.get(file.path) ?? 0}))
        .filter((entry) => entry.fixes >= options.fixHotspotMin && !firstMatch(entry.path, options.lockfiles, false))
        .sort((a, b) => b.fixes - a.fixes || (a.path < b.path ? -1 : 1));
    const fixes = hotspots.reduce((sum, entry) => sum + entry.fixes, 0);
    add(
        "fix_history",
        fixes === 0 ? 0 : Math.log2(1 + fixes) / Math.log2(21),
        {files: hotspots.length, fixes},
        hotspots.slice(0, 10).map((entry) => ({kind: "history", ref: `${entry.path} (${entry.fixes} fix commits)`}))
    );

    const tests = files.filter((file) => matchAny(file, options.testPaths));
    const sources = files.filter(
        (file) =>
            file.status !== "deleted" &&
            SOURCE_EXTENSIONS.has(extension(file.path)) &&
            !matchAny(file, options.testPaths) &&
            !dedicated.has(file.path)
    );
    add(
        "missing_tests",
        sources.length > 0 && tests.length === 0 ? 1 : 0,
        {sourceFiles: tests.length === 0 ? sources.length : 0},
        tests.length === 0 ? sources.slice(0, 10).map((file) => fileEvidence(file)) : []
    );

    const manifests = files.filter((file) => firstMatch(file.path, options.manifests, false));
    const lockfiles = files.filter(isLockfile);
    add(
        "dependencies",
        manifests.length > 0 ? 1 : lockfiles.length > 0 ? 0.5 : 0,
        {manifests: manifests.length, lockfiles: lockfiles.length},
        [...manifests, ...lockfiles].slice(0, 10).map((file) => fileEvidence(file))
    );

    add(
        "ci_config",
        ciFiles.length > 0 ? 1 : 0,
        {files: ciFiles.length},
        ciFiles.slice(0, 10).map((file) => fileEvidence(file, matchAny(file, options.ciPaths)))
    );

    const rules = input.codeowners ? parseCodeowners(input.codeowners) : [];
    const ownerFiles = new Map<string, string[]>();
    if (rules.length > 0) {
        for (const file of files) {
            for (const owner of ownersOf(file.path, rules)) {
                ownerFiles.set(owner, [...(ownerFiles.get(owner) ?? []), file.path]);
            }
        }
    }
    const owners = [...ownerFiles.keys()].sort();
    add(
        "owners",
        (owners.length - 1) / 4,
        {owners: owners.length},
        owners.slice(0, 10).map((owner) => {
            const paths = ownerFiles.get(owner) ?? [];
            return {kind: "code", ref: `${owner}: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}`};
        })
    );

    const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0);
    const score = Math.min(100, rawScore);
    // Destroying data cannot be undone by a rollback: a destructive migration is high risk on its own.
    const losesData = signals.some((signal) => signal.id === "destructive_sql" && signal.points > 0);
    const level: RiskLevel =
        losesData || score >= options.thresholds.high ? "high" : score >= options.thresholds.medium ? "medium" : "low";
    return {
        score,
        rawScore,
        level,
        thresholds: {...options.thresholds},
        signals,
        files: files.length,
        linesChanged: lines,
        forceFullSuite: level === "high",
        requiredApprovals: options.requiredApprovals[level]
    };
}
