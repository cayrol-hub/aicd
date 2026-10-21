import {
    LLMError,
    type LLMProvider,
    type LLMUsage,
    type StructuredRequest,
    type StructuredResponse
} from "@aicd-ci/plugin-sdk";
import {stripOptionalNulls, toStrictJsonSchema} from "./schema.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface OpenAICompatibleOptions {
    /** Default https://api.openai.com/v1. Ollama: http://localhost:11434/v1. */
    baseUrl?: string;
    /** Sent as `Authorization: Bearer`. Local servers usually need none. */
    apiKey?: string;
    model: string;
    /** Provider name in the audit log: "openai", "ollama", "vllm"… Default "openai". */
    name?: string;
    /** USD per million tokens. Default 0 (local servers are free). */
    prices?: {input: number; output: number};
    /** Per attempt. Default 120000. */
    timeoutMs?: number;
    /** Output token cap; omitted from the request when not set (the server default applies). */
    maxTokens?: number;
    /** Default "max_completion_tokens" for "openai", "max_tokens" for every other server. */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    /** Retries on 429, 5xx and network errors. Default 2. */
    maxRetries?: number;
    /** E.g. `{"api-key": …}` for Azure. */
    extraHeaders?: Record<string, string>;
    /** Injected in tests. */
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

interface ChatCompletion {
    model?: string;
    choices?: {finish_reason?: string | null; message?: {content?: string | null; refusal?: string | null}}[];
    usage?: {prompt_tokens?: number; completion_tokens?: number};
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Some local models wrap JSON in a markdown fence despite the response format. */
function parseJson(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(content);
        if (!fenced) throw new Error("not JSON");
        return JSON.parse(fenced[1] ?? "");
    }
}

async function errorDetail(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    try {
        const message = (JSON.parse(text) as {error?: {message?: string}}).error?.message;
        if (message) return truncate(message, 300);
    } catch {
        // Not JSON: use the raw text.
    }
    return truncate(text.trim(), 300);
}

/**
 * LLM provider for OpenAI and every server speaking its Chat Completions API (Ollama, vLLM, LM Studio, Azure
 * OpenAI v1 endpoints). Structured output through `response_format: json_schema` in strict mode, validated
 * again with the zod schema. Plain fetch, no SDK.
 */
export class OpenAICompatibleProvider implements LLMProvider {
    readonly name: string;
    readonly model: string;
    readonly #options: OpenAICompatibleOptions;
    readonly #baseUrl: string;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<void>;

    constructor(options: OpenAICompatibleOptions) {
        this.#options = options;
        this.name = options.name ?? "openai";
        this.model = options.model;
        this.#baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
        this.#fetch = options.fetch ?? fetch;
        this.#sleep = options.sleep ?? defaultSleep;
    }

    async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
        const strict = toStrictJsonSchema(request.schema);
        const maxTokens = request.maxTokens ?? this.#options.maxTokens;
        const maxTokensField =
            this.#options.maxTokensField ?? (this.name === "openai" ? "max_completion_tokens" : "max_tokens");
        const body = {
            model: this.model,
            messages: [
                {role: "system", content: request.system},
                {role: "user", content: request.prompt}
            ],
            response_format: {
                type: "json_schema",
                json_schema: {name: "aicd_output", strict: true, schema: strict.schema}
            },
            ...(maxTokens !== undefined ? {[maxTokensField]: maxTokens} : {})
        };

        const completion = await this.#post(body);
        const usage: LLMUsage = {
            model: completion.model ?? this.model,
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0,
            costUsd: 0
        };
        const prices = this.#options.prices ?? {input: 0, output: 0};
        usage.costUsd = (usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000;

        const choice = completion.choices?.[0];
        if (!choice) throw new LLMError("the response has no choice", usage);
        if (choice.message?.refusal) {
            throw new LLMError(`the model declined the request: ${truncate(choice.message.refusal, 200)}`, usage);
        }
        if (choice.finish_reason === "length") throw new LLMError("the response was cut at max_tokens", usage);
        let parsed: unknown;
        try {
            parsed = parseJson(choice.message?.content ?? "");
        } catch {
            throw new LLMError("the response is not valid JSON", usage);
        }
        const result = request.schema.safeParse(stripOptionalNulls(parsed, strict));
        if (!result.success) {
            const issues = result.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; ");
            throw new LLMError(`the response did not match the expected schema: ${issues}`, usage);
        }
        return {output: result.data, usage};
    }

    /** POST /chat/completions with retries on 429, 5xx and network errors. Nothing is billed on these. */
    async #post(body: unknown): Promise<ChatCompletion> {
        const {apiKey, extraHeaders, timeoutMs = 120_000, maxRetries = 2} = this.#options;
        const url = `${this.#baseUrl}/chat/completions`;
        for (let attempt = 0; ; attempt++) {
            const retriesLeft = attempt < maxRetries;
            let response: Response;
            try {
                response = await this.#fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(apiKey ? {Authorization: `Bearer ${apiKey}`} : {}),
                        ...extraHeaders
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs)
                });
            } catch (error) {
                const timedOut = (error as Error).name === "TimeoutError";
                if (timedOut) throw new Error(`${this.name}: no response within ${timeoutMs} ms`);
                if (!retriesLeft) throw new Error(`${this.name}: request failed: ${(error as Error).message}`);
                await this.#sleep(1000 * 2 ** attempt);
                continue;
            }
            if (response.ok) return (await response.json()) as ChatCompletion;
            const retryable = response.status === 429 || response.status >= 500;
            if (retryable && retriesLeft) {
                const retryAfter = Number(response.headers.get("retry-after"));
                await response.body?.cancel().catch(() => undefined);
                await this.#sleep(
                    Number.isFinite(retryAfter) && retryAfter > 0
                        ? Math.min(retryAfter, 30) * 1000
                        : 1000 * 2 ** attempt
                );
                continue;
            }
            throw new Error(`${this.name}: HTTP ${response.status} ${await errorDetail(response)}`.trim());
        }
    }
}
