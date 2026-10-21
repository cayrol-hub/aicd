import Anthropic from "@anthropic-ai/sdk";
import {betaZodOutputFormat} from "@anthropic-ai/sdk/helpers/beta/zod";
import {
    LLMError,
    type LLMProvider,
    type LLMUsage,
    type StructuredRequest,
    type StructuredResponse
} from "@aicd/plugin-sdk";

/** USD per million tokens [input, output]. Unknown models are priced at 0 with a warning. */
export const PRICES: Record<string, [number, number]> = {
    "claude-fable-5-1": [10, 50],
    "claude-opus-5-5": [4, 20],
    "claude-opus-5": [5, 25],
    "claude-sonnet-5-5": [2, 10],
    "claude-sonnet-5": [2, 10],
    "claude-haiku-4-5": [1, 5]
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
    apiKey?: string;
    model: string;
    effort?: Effort;
    maxTokens?: number;
    /** Injected in tests. */
    client?: Anthropic;
    warn?: (message: string) => void;
}

type Usage = Pick<
    Anthropic.Beta.BetaUsage,
    "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

export function costOf(model: string, usage: Usage): number {
    const price = PRICES[model];
    if (!price) return 0;
    const [input, output] = price;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    return (
        (usage.input_tokens * input +
            cacheWrite * input * 1.25 +
            cacheRead * input * 0.1 +
            usage.output_tokens * output) /
        1_000_000
    );
}

export class AnthropicProvider implements LLMProvider {
    readonly name = "anthropic";
    readonly model: string;
    readonly #client: Anthropic;
    readonly #effort: Effort;
    readonly #maxTokens: number;

    constructor(options: AnthropicProviderOptions) {
        this.model = options.model;
        this.#effort = options.effort ?? "medium";
        this.#maxTokens = options.maxTokens ?? 16_000;
        this.#client =
            options.client ??
            new Anthropic({...(options.apiKey ? {apiKey: options.apiKey} : {}), maxRetries: 2, timeout: 120_000});
        if (!PRICES[this.model])
            options.warn?.(`unknown price for model ${this.model}: cost reported as 0, budget not enforced`);
    }

    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
        const response = await this.#client.beta.messages.parse({
            model: this.model,
            // On a safety decline, the API re-runs the request on a suitable model within the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            max_tokens: request.maxTokens ?? this.#maxTokens,
            // The system prompt is identical on every call: cache it.
            system: [{type: "text", text: request.system, cache_control: {type: "ephemeral"}}],
            messages: [{role: "user", content: request.prompt}],
            output_config: {effort: this.#effort, format: betaZodOutputFormat(request.schema as never)}
        });

        const usage: LLMUsage = {
            model: response.model,
            inputTokens:
                response.usage.input_tokens +
                (response.usage.cache_read_input_tokens ?? 0) +
                (response.usage.cache_creation_input_tokens ?? 0),
            outputTokens: response.usage.output_tokens,
            // Priced on the model that actually answered (a fallback may have).
            costUsd: costOf(PRICES[response.model] ? response.model : this.model, response.usage)
        };
        if (response.stop_reason === "refusal") throw new LLMError("the model declined the request", usage);
        if (response.stop_reason === "max_tokens") throw new LLMError("the response was cut at max_tokens", usage);
        if (response.parsed_output == null) throw new LLMError("the response did not match the expected schema", usage);
        return {output: response.parsed_output as T, usage};
    }
}
