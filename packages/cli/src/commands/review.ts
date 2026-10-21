import {findTickets} from "@aicd-ci/adapter-issue-trackers";
import {runIntentCheck} from "@aicd-ci/agent-intent-check";
import {DEFAULT_SENSITIVE_PATHS, parseUnifiedDiff, runRiskScore} from "@aicd-ci/agent-risk-score";
import type {IssueTracker} from "@aicd-ci/plugin-sdk";
import {changedFiles as gitChangedFiles} from "@aicd-ci/git";
import {EXIT, type GlobalOptions} from "../shared.js";
import {conclude, report, type AgentRun} from "../outcome.js";
import {Session} from "../session.js";

export interface ReviewOptions extends GlobalOptions {
    ci?: string;
    diff?: string;
    strict?: boolean;
}

/** Collection where the risk of each commit is kept, so that `aicd tests select` can run everything when it is high. */
export const RISK_COLLECTION = "risk_results";

/**
 * `aicd review`: run early in merge request pipelines (it needs no test result). Scores the risk of the
 * change and checks it against its ticket.
 */
export async function review(options: ReviewOptions): Promise<number> {
    const session = await Session.open({...options, ...(options.diff ? {diffFile: options.diff} : {})});
    try {
        return await runReview(session, options);
    } finally {
        await session.close();
    }
}

/** The body of `aicd review`, on an open session (also used by the server on merge request events). */
export async function runReview(session: Session, options: ReviewOptions = {}): Promise<number> {
    const {config, ci, context, logger} = session;
    {
        const mergeRequest = context.mergeRequest;
        if (!mergeRequest && !options.diff) {
            logger.info("not a merge request pipeline: nothing to review");
            return EXIT.ok;
        }
        let diff = await ci.getDiff().catch(() => undefined);
        let changed = diff ? [...new Set(parseUnifiedDiff(diff).map((file) => file.path))] : [];
        if (!diff && context.baseSha) {
            changed = await gitChangedFiles(context.baseSha, context.commitSha ?? "HEAD", {cwd: session.cwd}).catch(
                () => []
            );
        }
        if (diff) diff = session.redact(diff);
        const runs: AgentRun[] = [];

        if (config.agents.risk_score.enabled) {
            const risk = config.agents.risk_score;
            const result = await runRiskScore(session.runtime("risk"), {
                ...(diff ? {diff} : {}),
                changedFiles: changed,
                cwd: session.cwd,
                options: {
                    thresholds: {medium: risk.medium_threshold, high: risk.high_threshold},
                    ...(Object.keys(risk.weights).length > 0 ? {weights: risk.weights} : {}),
                    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS, ...risk.sensitive_paths],
                    fixHotspotMin: risk.fix_hotspot_min,
                    requiredApprovals: risk.required_approvals,
                    labelPrefix: risk.label_prefix,
                    failOnHigh: risk.fail_on_high,
                    commentOnLow: risk.comment_on_low,
                    language: config.comment.language
                }
            });
            if (context.commitSha) {
                const {level, score, forceFullSuite} = result.report as {
                    level: string;
                    score: number;
                    forceFullSuite: boolean;
                };
                await session.state.putRecord(RISK_COLLECTION, context.commitSha, {
                    level,
                    score,
                    forceFullSuite,
                    runId: session.runId
                });
            }
            runs.push({agent: "risk_score", result});
        }

        if (config.agents.intent_check.enabled && mergeRequest) {
            let trackers: IssueTracker[] = [];
            try {
                trackers = session.trackers();
            } catch (error) {
                logger.warn(`issue trackers unavailable, intent check without tickets: ${(error as Error).message}`);
            }
            const tickets = trackers.length
                ? await findTickets(
                      trackers,
                      [mergeRequest.title ?? "", mergeRequest.description ?? "", mergeRequest.sourceBranch ?? ""],
                      {logger}
                  )
                : [];
            runs.push({
                agent: "intent_check",
                result: await runIntentCheck(session.runtime("intent"), {
                    mergeRequest: {
                        title: mergeRequest.title ?? "",
                        ...(mergeRequest.description ? {description: mergeRequest.description} : {})
                    },
                    ...(diff && config.privacy.send_code !== "none" ? {diff} : {}),
                    changedFiles: changed,
                    tickets,
                    options: {
                        max_diff_chars: config.agents.intent_check.max_diff_chars,
                        fail_on_gaps: config.agents.intent_check.fail_on_gaps
                    }
                })
            });
        }

        const conclusion = await conclude(session, runs, {dryRun: options.dryRun ?? false});
        report(session, runs, conclusion, options.json);
        return options.strict && conclusion.failingStatus ? EXIT.policyBlocked : EXIT.ok;
    }
}
