import {LLMError, type AgentRuntime, type LLMUsage, type StructuredRequest} from "@aicd-ci/plugin-sdk";

/**
 * One LLM call with the safeguards every agent needs: no call without a provider or budget,
 * never for code from a fork, failed calls still counted, errors logged instead of thrown.
 * Returns undefined when the agent must fall back to its deterministic path.
 */
export async function callLlm<T>(
    runtime: AgentRuntime,
    agent: string,
    request: StructuredRequest<T>
): Promise<{output: T; usage: LLMUsage} | undefined> {
    const {llm, budget, logger} = runtime;
    if (!llm || runtime.context.isFork) return undefined;
    if (!budget.canSpend()) {
        logger.warn(
            `${agent}: LLM budget reached (${budget.spentUsd.toFixed(4)} / ${budget.limitUsd} USD), rules only`
        );
        return undefined;
    }
    try {
        const response = await llm.generateStructured(request);
        budget.record(response.usage);
        runtime.onLlmCall?.({agent, ...usageFields(response.usage), accepted: true});
        return response;
    } catch (error) {
        if (error instanceof LLMError && error.usage) {
            budget.record(error.usage);
            runtime.onLlmCall?.({agent, ...usageFields(error.usage), accepted: false, detail: error.message});
        }
        logger.warn(`${agent}: LLM call failed, falling back to rules: ${(error as Error).message}`);
        return undefined;
    }
}

function usageFields(usage: LLMUsage) {
    return {
        model: usage.model,
        costUsd: usage.costUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
    };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * True when `quote` appears verbatim (whitespace-insensitive) in one of the sources.
 * Line prefixes like "L12: " are ignored. Quotes shorter than 4 characters never match.
 */
export function quoteIsIn(quote: string, ...sources: (string | undefined)[]): boolean {
    const needle = squash(quote);
    if (needle.length < 4) return false;
    return sources.some((source) => source !== undefined && squash(source.replace(/^L\d+: /gm, "")).includes(needle));
}
