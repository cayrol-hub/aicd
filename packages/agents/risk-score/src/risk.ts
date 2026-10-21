import {readFileSync} from "node:fs";
import {join} from "node:path";
import {diff as gitDiff, fixCounts} from "@aicd/git";
import type {AgentResult, AgentRuntime, ProposedAction} from "@aicd/plugin-sdk";
import {parseUnifiedDiff} from "./diff.js";
import {COMMENT_MARKER, renderRiskComment} from "./render.js";
import {scoreMergeRequest, type RiskOptionsInput, type RiskReport} from "./score.js";

export const AGENT_NAME = "risk";

export const STATUS_CONTEXT = "aicd/risk";

export interface RiskAgentOptions extends RiskOptionsInput {
    /** Labels are `<prefix><level>`. Default "risk:". */
    labelPrefix?: string;
    /** Set the `aicd/risk` status to failure at high. Default false. */
    failOnHigh?: boolean;
    /** Also comment when the risk is low. Default false. */
    commentOnLow?: boolean;
    /** Commits scanned for the fix history. Default 1000. */
    maxFixCommits?: number;
}

export interface RiskScoreInput {
    diff?: string;
    changedFiles?: string[];
    /** Repository root, for the fix history and the CODEOWNERS file. */
    cwd: string;
    /** CODEOWNERS content; read from the repository when absent. */
    codeowners?: string;
    options?: RiskAgentOptions;
}

const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS"];

function readCodeowners(cwd: string): string | undefined {
    for (const path of CODEOWNERS_PATHS) {
        try {
            return readFileSync(join(cwd, path), "utf8");
        } catch {
            // next candidate
        }
    }
    return undefined;
}

/**
 * Scores the merge request and proposes a `risk:<level>` label, the `aicd/risk` status and, at
 * medium and high (or always with `commentOnLow`), a comment with the breakdown. No LLM.
 * Without a diff or changed files, the diff of the pipeline's base commit is read from git.
 */
export async function runRiskScore(runtime: AgentRuntime, input: RiskScoreInput): Promise<AgentResult<RiskReport>> {
    const {logger, context} = runtime;
    const options = input.options ?? {};
    let diff = input.diff;
    if (diff === undefined && !input.changedFiles?.length && context.baseSha) {
        try {
            diff = await gitDiff(context.baseSha, context.commitSha ?? "HEAD", {cwd: input.cwd});
        } catch (error) {
            logger.warn(`${AGENT_NAME}: cannot read the diff from git: ${(error as Error).message}`);
        }
    }
    if (diff !== undefined) diff = runtime.redact(diff);

    const paths = new Set(input.changedFiles ?? []);
    if (diff)
        for (const file of parseUnifiedDiff(diff))
            for (const path of [file.path, file.oldPath]) if (path) paths.add(path);

    let counts = new Map<string, number>();
    if (paths.size > 0) {
        try {
            // History up to the base commit: the merge request's own commits must not count.
            const ref = runtime.context.baseSha;
            counts = await fixCounts([...paths].sort(), {
                cwd: input.cwd,
                maxCommits: options.maxFixCommits ?? 1000,
                ...(ref ? {ref} : {})
            });
        } catch (error) {
            logger.warn(`${AGENT_NAME}: no fix history: ${(error as Error).message}`);
        }
    }

    const codeowners = input.codeowners ?? readCodeowners(input.cwd);
    const report = scoreMergeRequest(
        {
            ...(diff !== undefined ? {diff} : {}),
            ...(input.changedFiles ? {changedFiles: input.changedFiles} : {}),
            fixCounts: counts,
            ...(codeowners !== undefined ? {codeowners} : {})
        },
        {language: runtime.language, ...options}
    );

    if (report.files === 0) {
        logger.info(`${AGENT_NAME}: no changed file, nothing to score`);
        return {agent: AGENT_NAME, actions: [], report, llmCalls: 0, costUsd: 0};
    }

    const reason = `risk ${report.level} (${report.score}/100)`;
    const actions: ProposedAction[] = [
        {type: "label", labels: [`${options.labelPrefix ?? "risk:"}${report.level}`], reason},
        {
            type: "set_status",
            status: {
                state: report.level === "high" && options.failOnHigh ? "failure" : "success",
                context: STATUS_CONTEXT,
                description: `Risk ${report.level}: ${report.score}/100`
            },
            reason
        }
    ];
    if (report.level !== "low" || options.commentOnLow) {
        actions.push({
            type: "comment",
            marker: COMMENT_MARKER,
            body: renderRiskComment(report, {language: runtime.language, runId: runtime.runId}),
            reason
        });
    }
    logger.info(`${AGENT_NAME}: ${reason}`);
    return {agent: AGENT_NAME, actions, report, llmCalls: 0, costUsd: 0};
}
