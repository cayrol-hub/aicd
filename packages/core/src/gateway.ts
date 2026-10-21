import {
    COLLECTIONS,
    describeAction,
    type CIProvider,
    type Deployer,
    type IssueTracker,
    type Logger,
    type Notifier,
    type ProposedAction,
    type QuarantineRecord,
    type StateStore
} from "@aicd-ci/plugin-sdk";
import type {Decision} from "./policy.js";

/** Everything the gateway may act on. Missing targets make the matching actions skipped. */
export interface GatewayTargets {
    ci: CIProvider;
    state?: StateStore;
    tracker?: IssueTracker;
    deployer?: Deployer;
    notifiers?: Notifier[];
}

export interface GatewayOptions extends GatewayTargets {
    logger: Logger;
    dryRun?: boolean;
    /** Marker used for comments that do not carry their own. */
    commentMarker: string;
    now?: () => Date;
    /** Branches a fix merge request may never be opened from or pushed to. */
    protectedBranches?: string[];
    onAction?: (decision: Decision, outcome: "done" | "skipped" | "failed", detail?: string) => void;
}

const DEFAULT_PROTECTED = ["main", "master", "develop", "development", "production", "release/*"];

export function isProtectedBranch(branch: string, patterns: string[] = DEFAULT_PROTECTED): boolean {
    return patterns.some((pattern) =>
        pattern.endsWith("/*") ? branch.startsWith(pattern.slice(0, -1)) : branch === pattern
    );
}

class Skip extends Error {}

async function run(action: ProposedAction, options: GatewayOptions): Promise<string | undefined> {
    const {ci} = options;
    switch (action.type) {
        case "comment":
            await ci.upsertComment(action.marker ?? options.commentMarker, action.body);
            return undefined;
        case "notify":
            if (!options.notifiers?.length) throw new Skip("no notifier configured");
            await Promise.all(options.notifiers.map((notifier) => notifier.send(action.notification)));
            return undefined;
        case "label":
            await ci.addLabels(action.labels);
            return undefined;
        case "set_status":
            await ci.setStatus(action.status);
            return undefined;
        case "retry_job":
            await ci.retryJob(action.jobId);
            return undefined;
        case "quarantine_test":
        case "release_quarantine": {
            if (!options.state) throw new Skip("no state store");
            for (const testId of action.testIds) {
                if (action.type === "release_quarantine") {
                    await options.state.deleteRecord(COLLECTIONS.quarantine, testId);
                } else {
                    const existing = await options.state.getRecord<QuarantineRecord>(COLLECTIONS.quarantine, testId);
                    const record: QuarantineRecord = existing?.value ?? {
                        testId,
                        since: (options.now?.() ?? new Date()).toISOString(),
                        reason: action.reason,
                        flakyScore: action.flakyScore ?? 0
                    };
                    await options.state.putRecord(COLLECTIONS.quarantine, testId, record);
                }
            }
            return undefined;
        }
        case "open_fix_mr": {
            if (isProtectedBranch(action.fix.branch, options.protectedBranches)) {
                throw new Error(`refusing to push to protected branch ${action.fix.branch}`);
            }
            const result = await ci.openFixMergeRequest(action.fix);
            return result.url;
        }
        case "create_issue": {
            if (!options.tracker) throw new Skip("no issue tracker configured");
            const issue = await options.tracker.createIssue(action.issue);
            return issue.url ?? issue.key;
        }
        case "draft_release": {
            const release = await ci.createRelease(action.release);
            return release.url;
        }
        case "pause_deployment":
            if (!options.deployer) throw new Skip("no deployer configured");
            await options.deployer.pause(action.deployment);
            return undefined;
        case "rollback_deployment":
            if (!options.deployer) throw new Skip("no deployer configured");
            await options.deployer.rollback(action.deployment);
            return undefined;
    }
}

/**
 * The only place where aicd acts on the outside world. Runs `apply` decisions only;
 * a failed action is logged and never fails the pipeline.
 */
export async function executeDecisions(decisions: Decision[], options: GatewayOptions): Promise<void> {
    const {logger, dryRun = false, onAction} = options;
    for (const decision of decisions) {
        if (decision.verdict !== "apply") continue;
        const label = describeAction(decision.action);
        if (dryRun) {
            logger.info(`dry run: would ${label}`);
            onAction?.(decision, "skipped", "dry run");
            continue;
        }
        try {
            const detail = await run(decision.action, options);
            logger.debug(`done: ${label}${detail ? ` (${detail})` : ""}`);
            onAction?.(decision, "done", detail);
        } catch (error) {
            if (error instanceof Skip) {
                logger.warn(`${label}: skipped, ${error.message}`);
                onAction?.(decision, "skipped", error.message);
            } else {
                logger.warn(`${label}: failed, ${(error as Error).message}`);
                onAction?.(decision, "failed", (error as Error).message);
            }
        }
    }
}
