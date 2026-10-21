import {decide, executeDecisions, finalizeAction, type AgentName, type Decision} from "@aicd/core";
import {describeAction, type AgentResult, type Language, type ProposedAction} from "@aicd/plugin-sdk";
import type {Session} from "./session.js";

export interface AgentRun {
    /** Configuration key of the agent (its autonomy is read there). */
    agent: AgentName;
    result: AgentResult;
    /** For agents acting on environments (release guardian). */
    environment?: string;
}

export interface ActionOutcome {
    agent: string;
    type: ProposedAction["type"];
    verdict: Decision["verdict"];
    outcome?: "done" | "skipped" | "failed";
    detail?: string;
}

export interface Conclusion {
    decisions: {agent: string; decision: Decision}[];
    outcomes: ActionOutcome[];
    /** True when an agent proposed a failing commit status, whatever the autonomy (`--strict`). */
    failingStatus: boolean;
}

const SUGGESTIONS: Record<Language, string> = {
    en: "Suggested actions (not run: autonomy too low)",
    fr: "Actions suggérées (non exécutées : autonomie insuffisante)"
};

function withSuggestions(body: string, suggestions: string[], language: Language): string {
    if (suggestions.length === 0) return body;
    return `${body}\n\n**${SUGGESTIONS[language]}**\n${suggestions.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * Policies decide, the gateway acts. Every agent's actions go through `decide` with that agent's
 * autonomy; actions above it become suggestions appended to the agent's own comment.
 */
export async function conclude(
    session: Session,
    runs: AgentRun[],
    options: {dryRun?: boolean} = {}
): Promise<Conclusion> {
    const forbidden = session.policies.forbidden_actions;
    const language = session.config.comment.language;
    const decisions: {agent: string; decision: Decision}[] = [];
    let failingStatus = false;

    for (const {agent, result, environment} of runs) {
        session.audit.record(result.agent, "finding", {
            report: result.report,
            llmCalls: result.llmCalls,
            costUsd: result.costUsd
        });
        const autonomy = session.autonomy(agent, environment);
        const comments = result.actions.filter((action) => action.type === "comment");
        const others = result.actions.filter((action) => action.type !== "comment");
        if (others.some((action) => action.type === "set_status" && action.status.state === "failure"))
            failingStatus = true;

        const decided = others.map((action) => decide(finalizeAction(action, autonomy), autonomy, {forbidden}));
        const suggestions = decided
            .filter((decision) => decision.verdict === "downgrade")
            .map((decision) => `${describeAction(decision.action)} — ${session.redact(decision.action.reason)}`);
        for (const comment of comments) {
            if (comment.type !== "comment") continue;
            decided.push(
                decide({...comment, body: withSuggestions(comment.body, suggestions, language)}, autonomy, {forbidden})
            );
        }
        if (comments.length === 0 && suggestions.length > 0) {
            session.logger.info(`${result.agent}: ${suggestions.length} suggestion(s): ${suggestions.join("; ")}`);
        }
        for (const decision of decided) {
            decisions.push({agent: result.agent, decision});
            session.audit.record(result.agent, "decision", {
                type: decision.action.type,
                verdict: decision.verdict,
                reason: decision.reason
            });
        }
    }

    const outcomes: ActionOutcome[] = decisions.map(({agent, decision}) => ({
        agent,
        type: decision.action.type,
        verdict: decision.verdict
    }));
    const byDecision = new Map(decisions.map(({decision}, index) => [decision, index]));
    // An integration that cannot be built (missing secret…) only skips the actions that need it.
    const build = <T>(label: string, make: () => T): T | undefined => {
        try {
            return make();
        } catch (error) {
            session.logger.warn(`${label} unavailable, its actions are skipped: ${(error as Error).message}`);
            return undefined;
        }
    };
    const deployer = needs(decisions, ["pause_deployment", "rollback_deployment"])
        ? build("deployer", () => session.deployer())
        : undefined;
    const tracker = needs(decisions, ["create_issue"])
        ? build("issue tracker", () => session.trackers()[0])
        : undefined;
    const notifiers = needs(decisions, ["notify"]) ? build("notifiers", () => session.notifiers()) : undefined;

    await executeDecisions(
        decisions.map(({decision}) => decision),
        {
            ci: session.ci,
            state: session.state,
            ...(tracker ? {tracker} : {}),
            ...(deployer ? {deployer} : {}),
            ...(notifiers ? {notifiers} : {}),
            logger: session.logger,
            dryRun: options.dryRun ?? false,
            commentMarker: "<!-- aicd -->",
            protectedBranches: session.config.security.protected_branches,
            onAction: (decision, outcome, detail) => {
                const index = byDecision.get(decision);
                const entry = index === undefined ? undefined : outcomes[index];
                if (entry) {
                    entry.outcome = outcome;
                    if (detail) entry.detail = detail;
                }
                session.audit.record(entry?.agent ?? "aicd", "action", {type: decision.action.type, outcome, detail});
            }
        }
    );
    return {decisions, outcomes, failingStatus};
}

function needs(decisions: {decision: Decision}[], types: ProposedAction["type"][]): boolean {
    return decisions.some(({decision}) => decision.verdict === "apply" && types.includes(decision.action.type));
}

/** One line per agent on stderr, the full result on stdout with `--json`. */
export function report(session: Session, runs: AgentRun[], conclusion: Conclusion, json?: boolean): void {
    if (json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    runId: session.runId,
                    agents: runs.map(({result}) => ({
                        agent: result.agent,
                        report: result.report,
                        llmCalls: result.llmCalls,
                        costUsd: result.costUsd
                    })),
                    actions: conclusion.outcomes
                },
                null,
                2
            )}\n`
        );
    }
    const applied = conclusion.outcomes.filter((outcome) => outcome.outcome === "done").length;
    const suggested = conclusion.outcomes.filter((outcome) => outcome.verdict === "downgrade").length;
    const llmCalls = runs.reduce((sum, run) => sum + run.result.llmCalls, 0);
    session.logger.info(
        `${runs.map((run) => run.result.agent).join(", ") || "no agent"} · ${applied} action(s) done, ${suggested} suggested · ` +
            `${llmCalls} LLM call(s) · ${session.budget.spentUsd.toFixed(4)} USD · aicd explain ${session.runId}`
    );
}
