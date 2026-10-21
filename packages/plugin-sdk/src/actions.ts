import type {CommitStatus, FixRequest, ReleaseDraft} from "./ci.js";
import type {DeploymentRef} from "./deploy.js";
import type {Notification} from "./notify.js";
import type {IssueDraft} from "./trackers.js";

/** How far an agent may go, from the most cautious to the freest. */
export type Autonomy = "observe" | "advise" | "propose" | "act";

export const AUTONOMY_LEVELS: readonly Autonomy[] = ["observe", "advise", "propose", "act"];

export function autonomyRank(level: Autonomy): number {
    return AUTONOMY_LEVELS.indexOf(level);
}

export function minAutonomy(a: Autonomy, b: Autonomy): Autonomy {
    return autonomyRank(a) <= autonomyRank(b) ? a : b;
}

/** Actions aicd never takes, whatever the configuration says. Enforced in code, not in config. */
export const FORBIDDEN_ACTIONS = ["merge", "push_protected_branch", "delete_branch"] as const;

interface ActionBase {
    /** Why the agent proposes it — shown to humans when the action is downgraded to a suggestion. */
    reason: string;
}

/**
 * Everything an agent can ask for. The policy engine decides, the gateway executes:
 * an agent never calls an adapter's write method itself.
 */
export type ProposedAction =
    | (ActionBase & {type: "comment"; body: string; /** One comment per marker, updated in place. */ marker?: string})
    | (ActionBase & {type: "notify"; notification: Notification})
    | (ActionBase & {type: "label"; labels: string[]})
    | (ActionBase & {type: "set_status"; status: CommitStatus})
    | (ActionBase & {type: "retry_job"; jobId: string})
    | (ActionBase & {
          type: "quarantine_test";
          testIds: string[];
          /** Flakiness score 0–1, kept on the record. */ flakyScore?: number;
      })
    | (ActionBase & {type: "release_quarantine"; testIds: string[]})
    | (ActionBase & {type: "open_fix_mr"; fix: FixRequest})
    | (ActionBase & {type: "create_issue"; issue: IssueDraft})
    | (ActionBase & {type: "draft_release"; release: ReleaseDraft})
    | (ActionBase & {type: "pause_deployment"; deployment: DeploymentRef})
    | (ActionBase & {type: "rollback_deployment"; deployment: DeploymentRef});

export type ActionType = ProposedAction["type"];

export const ACTION_TYPES: readonly ActionType[] = [
    "comment",
    "notify",
    "label",
    "set_status",
    "retry_job",
    "quarantine_test",
    "release_quarantine",
    "open_fix_mr",
    "create_issue",
    "draft_release",
    "pause_deployment",
    "rollback_deployment"
];

/** One line a human can read, used in suggestions and audit. */
export function describeAction(action: ProposedAction): string {
    switch (action.type) {
        case "comment":
            return "comment on the merge request";
        case "notify":
            return `notify: ${action.notification.title}`;
        case "label":
            return `add labels ${action.labels.join(", ")}`;
        case "set_status":
            return `set status ${action.status.context} to ${action.status.state}`;
        case "retry_job":
            return `retry job ${action.jobId}`;
        case "quarantine_test":
            return `quarantine ${action.testIds.join(", ")}`;
        case "release_quarantine":
            return `release ${action.testIds.join(", ")} from quarantine`;
        case "open_fix_mr":
            return `open a fix merge request "${action.fix.title}"`;
        case "create_issue":
            return `create issue "${action.issue.title}"`;
        case "draft_release":
            return `draft release ${action.release.tag}`;
        case "pause_deployment":
            return `pause deployment ${action.deployment.id} (${action.deployment.environment})`;
        case "rollback_deployment":
            return `roll back deployment ${action.deployment.id} (${action.deployment.environment})`;
    }
}
