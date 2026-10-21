import type {TestCaseResult} from "@aicd/parsers";
import {
    confidenceAtLeast,
    type AgentResult,
    type AgentRuntime,
    type Confidence,
    type FailedJob
} from "@aicd/plugin-sdk";
import {COMMENT_MARKER, renderTriageComment} from "./render.js";
import {AGENT_NAME, runTriage, type TriageReport} from "./triage.js";

export interface TriageAgentInput {
    jobs: FailedJob[];
    tests: TestCaseResult[];
    diff?: string;
    options?: {retryFlaky?: boolean; flakyWindow?: number; flakyMinFlips?: number; minConfidence?: Confidence};
}

/**
 * The triage agent in the common agent shape: findings plus their actions, and one comment
 * (marker `<!-- aicd:triage -->`) listing the findings at or above `minConfidence`.
 */
export async function runTriageAgent(
    runtime: AgentRuntime,
    input: TriageAgentInput
): Promise<AgentResult<TriageReport>> {
    const options = input.options ?? {};
    const report = await runTriage({
        runId: runtime.runId,
        context: runtime.context,
        jobs: input.jobs,
        tests: input.tests,
        ...(input.diff ? {diff: input.diff} : {}),
        state: runtime.state,
        ...(runtime.llm ? {llm: runtime.llm} : {}),
        budget: runtime.budget,
        logger: runtime.logger,
        redact: runtime.redact,
        now: runtime.now,
        options: {
            useLlm: Boolean(runtime.llm),
            sendCode: runtime.sendCode,
            language: runtime.language,
            retryFlaky: options.retryFlaky ?? true,
            flakyWindow: options.flakyWindow ?? 20,
            flakyMinFlips: options.flakyMinFlips ?? 2
        },
        onLlmCall: (event) =>
            runtime.onLlmCall?.({
                agent: AGENT_NAME,
                model: event.model,
                costUsd: event.costUsd,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                accepted: event.accepted,
                ...(event.rejectedEvidence > 0 ? {detail: `${event.rejectedEvidence} unverifiable quote(s)`} : {})
            })
    });

    const actions = report.findings.flatMap((finding) => finding.actions);
    const shown = report.findings.filter((finding) =>
        confidenceAtLeast(finding.confidence, options.minConfidence ?? "low")
    );
    if (shown.length > 0) {
        actions.push({
            type: "comment",
            marker: COMMENT_MARKER,
            reason: "triage report",
            body: runtime.redact(renderTriageComment(shown, {runId: runtime.runId, language: runtime.language}))
        });
    }
    return {agent: AGENT_NAME, actions, report, llmCalls: report.llmCalls, costUsd: report.costUsd};
}
