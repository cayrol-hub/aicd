import {readFileSync} from "node:fs";
import {relative} from "node:path";
import {
    buildCoverageMap,
    DEFAULT_FORCE_FULL_PATTERNS,
    DEFAULT_IGNORE_PATTERNS,
    discoverTests,
    formatSelection,
    missedRegressions,
    parseCobertura,
    parseJaCoCo,
    parseLcov,
    runTestSelection,
    saveCoverageMap,
    type Selection
} from "@aicd/agent-test-selection";
import {EXIT, findFiles, readTests, type GlobalOptions} from "../shared.js";
import {conclude} from "../outcome.js";
import {Session} from "../session.js";
import {RISK_COLLECTION} from "./review.js";

export interface SelectOptions extends GlobalOptions {
    ci?: string;
    format?: "lines" | "json" | "args";
    full?: boolean;
}

/**
 * `aicd tests select`: prints the tests the change needs, before the test job. Empty output for
 * `lines` / `args` means "run the whole suite": `npx vitest run $(aicd tests select --format args)`.
 */
export async function selectTestsCommand(options: SelectOptions): Promise<number> {
    const session = await Session.open({...options, noLlm: true});
    const {config, context, state} = session;
    try {
        if (!config.agents.test_selection.enabled) {
            process.stdout.write(
                options.format === "json" ? `${JSON.stringify({full: true, reasons: ["disabled"]})}\n` : ""
            );
            return EXIT.ok;
        }
        const ts = config.agents.test_selection;
        const risk = context.commitSha
            ? await state.getRecord<{forceFullSuite?: boolean}>(RISK_COLLECTION, context.commitSha)
            : undefined;
        const coveredFiles = await aggregateCoverage(session.cwd, [...ts.coverage.cobertura, ...ts.coverage.jacoco]);
        const result = await runTestSelection(session.runtime("test-selection"), {
            cwd: session.cwd,
            options: {
                ...(context.branch ? {branch: context.branch} : {}),
                ...(context.defaultBranch ? {defaultBranch: context.defaultBranch} : {}),
                ...(context.tag ? {tag: context.tag} : {}),
                fullSuiteOn: ts.full_suite_on,
                forceFullPatterns: [...DEFAULT_FORCE_FULL_PATTERNS, ...ts.force_full_patterns],
                ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, ...ts.ignore_patterns],
                ...(ts.test_patterns.length > 0 ? {testPatterns: ts.test_patterns} : {}),
                maxChangedFiles: ts.max_changed_files,
                unmappedSource: ts.unmapped_source,
                unmappedTests: ts.unmapped_tests,
                mapMaxAgeDays: ts.map_max_age_days,
                forceFull: Boolean(options.full || risk?.value.forceFullSuite),
                ...(coveredFiles.length > 0 ? {coveredFiles} : {}),
                comment: ts.comment,
                language: config.comment.language
            }
        });
        process.stdout.write(`${formatSelection(result.report as Selection, options.format ?? "lines")}\n`);
        await conclude(session, [{agent: "test_selection", result}], {dryRun: options.dryRun ?? false});
        return EXIT.ok;
    } finally {
        await session.close();
    }
}

async function aggregateCoverage(cwd: string, patterns: string[]): Promise<string[]> {
    const files = await findFiles(patterns, cwd);
    return files.flatMap((file) => {
        const content = readFileSync(file, "utf8");
        const parse = content.includes("<report") ? parseJaCoCo : parseCobertura;
        try {
            return parse(content, {root: cwd}).covered;
        } catch {
            return [];
        }
    });
}

/**
 * `aicd tests map`: rebuilds the test → source map from per-test lcov coverage, naming conventions
 * and git co-change. Run on the default branch after a full test run, at least every
 * `map_max_age_days`.
 */
export async function mapTestsCommand(options: GlobalOptions & {lcov?: string[]}): Promise<number> {
    const session = await Session.open({...options, noLlm: true});
    const {config, context, logger} = session;
    try {
        const ts = config.agents.test_selection;
        const perTest = new Map<string, string[]>();
        for (const file of await findFiles(options.lcov ?? ts.coverage.lcov, session.cwd)) {
            for (const [test, sources] of parseLcov(readFileSync(file, "utf8"), {root: session.cwd}).perTest) {
                perTest.set(test, [...new Set([...(perTest.get(test) ?? []), ...sources])]);
            }
        }
        const tests = await discoverTests({
            cwd: session.cwd,
            ...(ts.test_patterns.length > 0 ? {patterns: ts.test_patterns} : {})
        });
        const map = await buildCoverageMap({
            tests,
            cwd: session.cwd,
            ...(perTest.size > 0 ? {perTestCoverage: perTest} : {}),
            conventions: ts.conventions,
            coChanges: {threshold: ts.co_change_threshold},
            ...(ts.test_patterns.length > 0 ? {testPatterns: ts.test_patterns} : {}),
            logger
        });
        await saveCoverageMap(session.state, map, context.commitSha);
        logger.info(`coverage map saved: ${map.entries.size} test(s), ${perTest.size} with per-test coverage`);
        return EXIT.ok;
    } finally {
        await session.close();
    }
}

/** `aicd tests missed`: merge requests whose selection skipped a test that later failed on the default branch. */
export async function missedTestsCommand(options: GlobalOptions & {junit?: string[]; since?: string}): Promise<number> {
    const session = await Session.open({...options, noLlm: true, readOnly: true});
    try {
        const failed = (await readTests(options.junit ?? session.config.inputs.junit, session.logger, session.cwd))
            .filter((test) => test.status === "failed")
            .map((test) => (test.file ? `${relative(session.cwd, test.file)}::${test.name}` : test.id));
        const missed = await missedRegressions(session.state, {
            failedOnDefaultBranch: failed,
            ...(options.since ? {since: options.since} : {})
        });
        process.stdout.write(
            options.json
                ? `${JSON.stringify(missed, null, 2)}\n`
                : missed.length === 0
                  ? "no regression missed by test selection\n"
                  : `${missed.map((entry) => `${entry.runId} (${entry.commitSha ?? "?"}): ${entry.tests.join(", ")}`).join("\n")}\n`
        );
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
