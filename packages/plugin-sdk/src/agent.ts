import type {CIProvider, PipelineContext} from "./ci.js";
import type {LLMProvider} from "./llm.js";
import type {Budget, Logger} from "./runtime.js";
import type {StateStore} from "./state.js";

export type Language = "en" | "fr";

/** The read-only part of a CI adapter: what agents may use. Writes go through the gateway. */
export type ReadonlyCI = Pick<
    CIProvider,
    "name" | "getContext" | "listFailedJobs" | "listJobs" | "listRecentPipelines" | "getJobLog" | "getDiff" | "readFile"
>;

export interface LlmCallEvent {
    agent: string;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    /** False when the call failed or its output was rejected by verification. */
    accepted: boolean;
    detail?: string;
}

/** What every agent receives. Agents never write to the CI themselves: they return actions. */
export interface AgentRuntime {
    runId: string;
    context: PipelineContext;
    state: StateStore;
    /** Absent when the LLM is disabled, unavailable, or the code comes from a fork. */
    llm?: LLMProvider;
    budget: Budget;
    logger: Logger;
    /** Applied to every piece of CI data before it is analysed or sent anywhere. */
    redact: (text: string) => string;
    language: Language;
    /** What code may be sent to the LLM. */
    sendCode: "none" | "diff_only" | "full";
    now: () => Date;
    onLlmCall?: (event: LlmCallEvent) => void;
}
