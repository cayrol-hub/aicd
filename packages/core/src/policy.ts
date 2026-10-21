import {
    autonomyRank,
    FORBIDDEN_ACTIONS,
    type ActionType,
    type Autonomy,
    type ProposedAction
} from "@aicd-ci/plugin-sdk";

/** Minimum autonomy each action needs. */
export const REQUIRED_AUTONOMY: Record<ActionType, Autonomy> = {
    comment: "advise",
    notify: "advise",
    open_fix_mr: "propose",
    create_issue: "propose",
    draft_release: "propose",
    label: "act",
    set_status: "act",
    retry_job: "act",
    quarantine_test: "act",
    release_quarantine: "act",
    pause_deployment: "act",
    rollback_deployment: "act"
};

export type Verdict = "apply" | "downgrade" | "observe" | "deny";

export interface Decision {
    action: ProposedAction;
    verdict: Verdict;
    reason: string;
}

export interface DecideOptions {
    /** Extra forbidden actions from the organisation policies. */
    forbidden?: string[];
}

/**
 * Deterministic: no LLM is involved. An agent never gets past the autonomy it was given.
 * - apply: the gateway runs the action;
 * - downgrade: the action becomes a suggestion in the comment;
 * - observe: logged only;
 * - deny: refused.
 */
export function decide(action: ProposedAction, allowed: Autonomy, options: DecideOptions = {}): Decision {
    const forbidden = new Set<string>([...FORBIDDEN_ACTIONS, ...(options.forbidden ?? [])]);
    if (forbidden.has(action.type)) {
        return {action, verdict: "deny", reason: `${action.type} is forbidden`};
    }
    const required = REQUIRED_AUTONOMY[action.type];
    if (!required) {
        return {action, verdict: "deny", reason: `unknown action ${String(action.type)}`};
    }
    if (allowed === "observe") {
        return {action, verdict: "observe", reason: "autonomy is observe: logged only"};
    }
    if (autonomyRank(allowed) >= autonomyRank(required)) {
        return {action, verdict: "apply", reason: `autonomy ${allowed} allows ${action.type}`};
    }
    if (action.type !== "comment" && action.type !== "notify" && autonomyRank(allowed) >= autonomyRank("advise")) {
        return {
            action,
            verdict: "downgrade",
            reason: `${action.type} needs ${required}, autonomy is ${allowed}: shown as a suggestion`
        };
    }
    return {action, verdict: "deny", reason: `${action.type} needs ${required}, autonomy is ${allowed}`};
}

/** A release is published only with autonomy act; below that it stays a draft. */
export function finalizeAction(action: ProposedAction, allowed: Autonomy): ProposedAction {
    if (action.type === "draft_release") {
        return {...action, release: {...action.release, draft: autonomyRank(allowed) < autonomyRank("act")}};
    }
    return action;
}
