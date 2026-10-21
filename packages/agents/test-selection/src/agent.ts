import {existsSync} from "node:fs";
import {join} from "node:path";
import {changedFiles as gitChangedFiles} from "@aicd-ci/git";
import type {AgentResult, AgentRuntime, ProposedAction} from "@aicd-ci/plugin-sdk";
import {discoverTests} from "./discover.js";
import {recordSelection} from "./history.js";
import {loadCoverageMap, type CoverageMap} from "./mapping.js";
import {COMMENT_MARKER, renderSelectionSummary} from "./render.js";
import {selectTests, type ChangedFile, type Selection, type SelectionOptions} from "./select.js";

export const AGENT_NAME = "test-selection";

export interface TestSelectionOptions extends SelectionOptions {
    /** Ignore patterns for test discovery. */
    discoveryIgnore?: readonly string[];
    /** Propose the merge request comment when tests were skipped. Default true. */
    comment?: boolean;
}

export interface TestSelectionInput {
    /** Repository root. */
    cwd: string;
    /** Changed files; default: `git diff` between the merge request base (`context.baseSha`) and HEAD. */
    changedFiles?: readonly ChangedFile[];
    /** Test files; default: discovered under `cwd`. */
    tests?: readonly string[];
    /** Coverage map; default: the stored one. */
    map?: CoverageMap;
    options?: TestSelectionOptions;
}

/** Plain paths that no longer exist on disk are marked deleted, so that a removed test is never selected. */
function withStatus(cwd: string, changedFiles: readonly ChangedFile[]): ChangedFile[] {
    return changedFiles.map((change) =>
        typeof change === "string" && !existsSync(join(cwd, change)) ? {path: change, status: "deleted"} : change
    );
}

/**
 * Selects the tests a change needs, records the selection for the missed-regression metric, and proposes a
 * short merge request comment only when tests were skipped. Every failure (no map, no git, discovery error)
 * falls back to the full suite.
 */
export async function runTestSelection(
    runtime: AgentRuntime,
    input: TestSelectionInput
): Promise<AgentResult<Selection>> {
    const {context, logger} = runtime;
    const options = input.options ?? {};

    let map = input.map;
    if (!map) {
        try {
            map = await loadCoverageMap(runtime.state);
        } catch (error) {
            logger.warn(`test selection: coverage map unreadable, running the full suite: ${(error as Error).message}`);
        }
    }

    let tests = input.tests;
    if (!tests) {
        try {
            tests = await discoverTests({
                cwd: input.cwd,
                ...(options.testPatterns ? {patterns: options.testPatterns} : {}),
                ...(options.discoveryIgnore ? {ignore: options.discoveryIgnore} : {})
            });
        } catch (error) {
            logger.warn(`test selection: test discovery failed: ${(error as Error).message}`);
            tests = [];
        }
    }

    let changedFiles = input.changedFiles;
    if (!changedFiles) {
        changedFiles = [];
        if (context.baseSha) {
            try {
                changedFiles = await gitChangedFiles(context.baseSha, context.commitSha ?? "HEAD", {cwd: input.cwd});
            } catch (error) {
                logger.warn(`test selection: changed files unknown: ${(error as Error).message}`);
            }
        }
    }

    const branch = options.branch ?? context.branch;
    const defaultBranch = options.defaultBranch ?? context.defaultBranch;
    const tag = options.tag ?? context.tag;
    const selection = selectTests({
        changedFiles: withStatus(input.cwd, changedFiles),
        tests,
        ...(map ? {map} : {}),
        options: {
            ...options,
            language: options.language ?? runtime.language,
            now: options.now ?? runtime.now,
            ...(branch ? {branch} : {}),
            ...(defaultBranch ? {defaultBranch} : {}),
            ...(tag ? {tag} : {})
        }
    });
    logger.info(
        selection.full
            ? `test selection: full suite (${selection.reasons[0] ?? ""})`
            : `test selection: ${selection.selected.length} of ${selection.selected.length + selection.skipped.length} test files`
    );

    try {
        await recordSelection(runtime.state, {
            runId: runtime.runId,
            ...(context.commitSha ? {commitSha: context.commitSha} : {}),
            ...(context.baseSha ? {baseSha: context.baseSha} : {}),
            full: selection.full,
            selected: selection.selected,
            skipped: selection.skipped,
            reasons: selection.reasons,
            at: runtime.now().toISOString()
        });
    } catch (error) {
        logger.warn(`test selection: could not record the selection: ${(error as Error).message}`);
    }

    const actions: ProposedAction[] = [];
    if (options.comment !== false && !selection.full && selection.skipped.length > 0 && !context.isFork) {
        actions.push({
            type: "comment",
            marker: COMMENT_MARKER,
            body: runtime.redact(
                `${COMMENT_MARKER}\n${renderSelectionSummary(selection, {language: options.language ?? runtime.language})}`
            ),
            reason: `${selection.skipped.length} test file(s) skipped by test selection`
        });
    }

    return {agent: AGENT_NAME, actions, report: selection, llmCalls: 0, costUsd: 0};
}
