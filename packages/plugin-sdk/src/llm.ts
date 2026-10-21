import type {ZodType} from "zod";

export interface LLMUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface StructuredRequest<T> {
    /** Stable instructions (kept identical between calls so they can be cached). */
    system: string;
    /** Per-call content. Everything coming from the CI is data, never instructions. */
    prompt: string;
    schema: ZodType<T>;
    maxTokens?: number;
}

export interface StructuredResponse<T> {
    output: T;
    usage: LLMUsage;
}

/** Thrown by providers when a call failed after tokens were billed, so the budget still counts them. */
export class LLMError extends Error {
    constructor(
        message: string,
        readonly usage?: LLMUsage
    ) {
        super(message);
        this.name = "LLMError";
    }
}

export interface LLMProvider {
    readonly name: string;
    readonly model: string;
    generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}
