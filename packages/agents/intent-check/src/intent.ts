import {callLlm} from "@aicd/core";
import type {AgentResult, AgentRuntime, Evidence, ProposedAction, Ticket} from "@aicd/plugin-sdk";
import {isTestFile, locateQuote, splitDiff} from "./diff.js";
import {buildPrompt, LlmIntentSchema, SYSTEM_PROMPT, type PromptCriterion} from "./llm.js";
import {COMMENT_MARKER, renderIntentComment, STATUS_CONTEXT, statusDescription} from "./render.js";

export const AGENT_NAME = "intent";

/** Most criteria sent to the LLM in one call; the others stay "unchecked". */
const MAX_LLM_CRITERIA = 40;

export interface IntentCheckOptions {
    /** Characters of (redacted) diff sent to the LLM at most. */
    max_diff_chars: number;
    /** Set the `aicd/intent` status to failure when a criterion is not covered. */
    fail_on_gaps: boolean;
}

export const DEFAULT_INTENT_OPTIONS: IntentCheckOptions = {max_diff_chars: 60_000, fail_on_gaps: false};

export interface IntentCheckInput {
    mergeRequest: {title: string; description?: string};
    diff?: string;
    changedFiles: string[];
    /** Tickets linked to the merge request (see `findTickets` of @aicd/adapter-issue-trackers). */
    tickets: Ticket[];
    options?: Partial<IntentCheckOptions>;
}

/** unchecked: no LLM verdict for this criterion. */
export type CriterionStatus = "covered" | "not_covered" | "unclear" | "unchecked";

export interface CriterionResult {
    id: string;
    ticket: string;
    text: string;
    status: CriterionStatus;
    explanation?: string;
    evidence: Evidence[];
    /** Why the LLM status was lowered to "unclear". */
    downgraded?: "no_verified_quote" | "diff_truncated" | "missing_verdict";
}

export interface UnrequestedChange {
    file: string;
    quote: string;
    reason: string;
}

export interface IntentFinding {
    code: "no_ticket" | "no_criteria";
    ticket?: string;
    message: string;
}

/**
 * llm: verdicts from a verified LLM analysis. Otherwise why there is none: no ticket, no diff, code not
 * allowed in prompts (send_code: none), no LLM (disabled, fork, budget) or a failed call.
 */
export type IntentAnalysis = "llm" | "no_ticket" | "no_diff" | "send_code_none" | "unavailable" | "failed";

export interface IntentReport {
    tickets: {key: string; title: string; url?: string; status?: string; criteria: number}[];
    criteria: CriterionResult[];
    unrequestedChanges: UnrequestedChange[];
    changedFiles: string[];
    testFiles: string[];
    testsChanged: boolean;
    findings: IntentFinding[];
    analysis: IntentAnalysis;
    /** Only with an LLM analysis that assessed at least one criterion. */
    verdict?: "pass" | "gaps";
    diffTruncated: boolean;
    /** LLM quotes not found in the diff (their claims were dropped or downgraded). */
    rejectedQuotes: number;
}

/** Cuts at the last full line before `max` characters. */
function truncate(text: string, max: number): {text: string; truncated: boolean} {
    if (text.length <= max) return {text, truncated: false};
    const cut = text.slice(0, max);
    const newline = cut.lastIndexOf("\n");
    return {text: newline > 0 ? cut.slice(0, newline) : cut, truncated: true};
}

/**
 * Checks a merge request against its tickets. Deterministic part: linked tickets, their acceptance criteria,
 * changed files and whether tests changed. With a diff, an LLM and `sendCode` allowing it: one verdict per
 * criterion (covered / not_covered / unclear) and the changes no ticket asks for, each backed by quotes that
 * must be found in the diff — "covered" without a verified quote becomes "unclear".
 * Proposes one comment, and a commit status only when an LLM verdict exists.
 */
export async function runIntentCheck(
    runtime: AgentRuntime,
    input: IntentCheckInput
): Promise<AgentResult<IntentReport>> {
    const options = {...DEFAULT_INTENT_OPTIONS, ...input.options};
    const redact = runtime.redact;
    const tickets = input.tickets.map((ticket) => ({
        ...ticket,
        title: redact(ticket.title),
        description: redact(ticket.description),
        acceptanceCriteria: ticket.acceptanceCriteria.map(redact)
    }));
    const changedFiles = [...new Set(input.changedFiles.map(redact))];
    const testFiles = changedFiles.filter(isTestFile);

    const findings: IntentFinding[] = [];
    if (tickets.length === 0) {
        findings.push({code: "no_ticket", message: "No ticket is linked to the merge request."});
    }
    const criteria: CriterionResult[] = [];
    for (const ticket of tickets) {
        if (ticket.acceptanceCriteria.length === 0) {
            findings.push({
                code: "no_criteria",
                ticket: ticket.key,
                message: `Ticket ${ticket.key} has no acceptance criteria.`
            });
        }
        for (const text of ticket.acceptanceCriteria) {
            criteria.push({id: `C${criteria.length + 1}`, ticket: ticket.key, text, status: "unchecked", evidence: []});
        }
    }

    const report: IntentReport = {
        tickets: tickets.map((ticket) => ({
            key: ticket.key,
            title: ticket.title,
            ...(ticket.url ? {url: ticket.url} : {}),
            ...(ticket.status ? {status: ticket.status} : {}),
            criteria: ticket.acceptanceCriteria.length
        })),
        criteria,
        unrequestedChanges: [],
        changedFiles,
        testFiles,
        testsChanged: testFiles.length > 0,
        findings,
        analysis: "unavailable",
        diffTruncated: false,
        rejectedQuotes: 0
    };

    let llmCalls = 0;
    let costUsd = 0;
    if (tickets.length === 0) report.analysis = "no_ticket";
    else if (!input.diff?.trim()) report.analysis = "no_diff";
    else if (runtime.sendCode === "none") report.analysis = "send_code_none";
    else if (!runtime.llm || runtime.context.isFork) report.analysis = "unavailable";
    else {
        const diff = truncate(redact(input.diff), options.max_diff_chars);
        report.diffTruncated = diff.truncated;
        const asked = criteria.slice(0, MAX_LLM_CRITERIA);
        const counting: AgentRuntime = {
            ...runtime,
            onLlmCall: (event) => {
                llmCalls++;
                costUsd += event.costUsd;
                runtime.onLlmCall?.(event);
            }
        };
        const response = await callLlm(counting, AGENT_NAME, {
            system: SYSTEM_PROMPT,
            prompt: buildPrompt({
                mergeRequest: {
                    title: redact(input.mergeRequest.title),
                    description: redact(input.mergeRequest.description ?? "")
                },
                tickets,
                criteria: asked.map((criterion): PromptCriterion => ({
                    id: criterion.id,
                    ticket: criterion.ticket,
                    text: criterion.text
                })),
                diff: diff.text,
                truncated: diff.truncated,
                language: runtime.language
            }),
            schema: LlmIntentSchema
        });
        if (!response) report.analysis = "failed";
        else {
            report.analysis = "llm";
            const sections = splitDiff(diff.text);
            const verdicts = new Map<string, (typeof response.output.criteria)[number]>();
            for (const verdict of response.output.criteria) {
                const id = verdict.id.trim().toUpperCase();
                if (!verdicts.has(id)) verdicts.set(id, verdict);
            }
            for (const criterion of asked) {
                const verdict = verdicts.get(criterion.id);
                if (!verdict) {
                    criterion.status = "unclear";
                    criterion.downgraded = "missing_verdict";
                    continue;
                }
                for (const item of verdict.evidence.slice(0, 3)) {
                    const file = locateQuote(item.quote, item.file, sections);
                    if (file) criterion.evidence.push({kind: "diff", ref: file, quote: item.quote.trim()});
                    else report.rejectedQuotes++;
                }
                criterion.status = verdict.status;
                if (verdict.explanation.trim()) criterion.explanation = verdict.explanation.trim();
                if (verdict.status === "covered" && criterion.evidence.length === 0) {
                    criterion.status = "unclear";
                    criterion.downgraded = "no_verified_quote";
                } else if (verdict.status === "not_covered" && diff.truncated) {
                    // The missing part of the diff may implement it: no proof, no claim.
                    criterion.status = "unclear";
                    criterion.downgraded = "diff_truncated";
                }
            }
            for (const change of response.output.unrequested_changes.slice(0, 5)) {
                const file = locateQuote(change.quote, change.file, sections);
                if (file)
                    report.unrequestedChanges.push({file, quote: change.quote.trim(), reason: change.reason.trim()});
                else report.rejectedQuotes++;
            }
            if (report.rejectedQuotes > 0) {
                runtime.logger.info(
                    `${AGENT_NAME}: ${report.rejectedQuotes} LLM quote(s) not found in the diff, dropped`
                );
            }
            if (asked.length > 0) {
                report.verdict = asked.some((criterion) => criterion.status === "not_covered") ? "gaps" : "pass";
            }
        }
    }

    const actions: ProposedAction[] = [
        {
            type: "comment",
            marker: COMMENT_MARKER,
            body: renderIntentComment(report, {language: runtime.language, runId: runtime.runId}),
            reason:
                tickets.length === 0
                    ? "no ticket linked to the merge request"
                    : `intent check against ${tickets.map((ticket) => ticket.key).join(", ")}`
        }
    ];
    if (report.verdict) {
        const failure = options.fail_on_gaps && report.verdict === "gaps";
        actions.push({
            type: "set_status",
            status: {
                state: failure ? "failure" : "success",
                context: STATUS_CONTEXT,
                description: statusDescription(report, runtime.language)
            },
            reason: failure
                ? "an acceptance criterion is not covered and fail_on_gaps is on"
                : "intent check verdict of the merge request"
        });
    }

    return {agent: AGENT_NAME, actions, report, llmCalls, costUsd};
}
