import type {Factory, FactoryContext, LLMProvider} from "@aicd-ci/plugin-sdk";
import {OPENAI_BASE_URL, OpenAICompatibleProvider, type OpenAICompatibleOptions} from "./provider.js";

export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

function optionalString(factory: string, config: Record<string, unknown>, key: string): string | undefined {
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0) throw new Error(`llm "${factory}": ${key} must be a string`);
    return value;
}

function optionalNumber(factory: string, config: Record<string, unknown>, key: string): number | undefined {
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`llm "${factory}": ${key} must be a non-negative number`);
    }
    return value;
}

function prices(factory: string, config: Record<string, unknown>): {input: number; output: number} | undefined {
    const value = config.prices;
    if (value === undefined) return undefined;
    const section = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const input = optionalNumber(factory, section, "input");
    const output = optionalNumber(factory, section, "output");
    if (input === undefined || output === undefined) {
        throw new Error(`llm "${factory}": prices must be {input, output} in USD per million tokens`);
    }
    return {input, output};
}

function headers(factory: string, config: Record<string, unknown>): Record<string, string> | undefined {
    const value = config.extra_headers;
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`llm "${factory}": extra_headers must be a map of header names to strings`);
    }
    const entries = Object.entries(value);
    if (entries.some(([, header]) => typeof header !== "string")) {
        throw new Error(`llm "${factory}": extra_headers values must be strings`);
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

/** Options shared by both factories, from snake_case configuration keys. */
function options(
    factory: string,
    config: Record<string, unknown>,
    context: FactoryContext,
    defaults: {baseUrl: string; name: string}
): Omit<OpenAICompatibleOptions, "apiKey"> {
    const model = optionalString(factory, config, "model");
    if (!model) throw new Error(`llm "${factory}": model is required`);
    const timeoutMs = optionalNumber(factory, config, "timeout_ms");
    const maxTokens = optionalNumber(factory, config, "max_tokens");
    const maxRetries = optionalNumber(factory, config, "max_retries");
    const maxTokensField = optionalString(factory, config, "max_tokens_field");
    if (maxTokensField && maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") {
        throw new Error(`llm "${factory}": max_tokens_field must be max_tokens or max_completion_tokens`);
    }
    const price = prices(factory, config);
    const extraHeaders = headers(factory, config);
    return {
        model,
        baseUrl: optionalString(factory, config, "base_url") ?? defaults.baseUrl,
        name: optionalString(factory, config, "name") ?? defaults.name,
        fetch: context.fetch,
        ...(timeoutMs !== undefined ? {timeoutMs} : {}),
        ...(maxTokens !== undefined ? {maxTokens} : {}),
        ...(maxRetries !== undefined ? {maxRetries} : {}),
        ...(maxTokensField ? {maxTokensField: maxTokensField as OpenAICompatibleOptions["maxTokensField"]} : {}),
        ...(price ? {prices: price} : {}),
        ...(extraHeaders ? {extraHeaders} : {})
    };
}

/**
 * "openai": key from the env var named in `api_key_env` (default `OPENAI_API_KEY`); required for the OpenAI
 * API and when `api_key_env` is set, optional for another `base_url` (a vLLM server without auth).
 * "ollama": `base_url` defaults to http://localhost:11434/v1, no key unless `api_key_env` is set.
 */
export const llmFactories: Factory<LLMProvider>[] = [
    {
        name: "openai",
        create(config, context) {
            const base = options("openai", config, context, {baseUrl: OPENAI_BASE_URL, name: "openai"});
            const keyEnv = optionalString("openai", config, "api_key_env");
            const apiKey = context.env[keyEnv ?? "OPENAI_API_KEY"];
            if (!apiKey && (keyEnv || base.baseUrl === OPENAI_BASE_URL)) {
                throw new Error(`llm "openai": ${keyEnv ?? "OPENAI_API_KEY"} is not set`);
            }
            return new OpenAICompatibleProvider({...base, ...(apiKey ? {apiKey} : {})});
        }
    },
    {
        name: "ollama",
        create(config, context) {
            const base = options("ollama", config, context, {baseUrl: OLLAMA_BASE_URL, name: "ollama"});
            const keyEnv = optionalString("ollama", config, "api_key_env");
            const apiKey = keyEnv ? context.env[keyEnv] : undefined;
            if (keyEnv && !apiKey) throw new Error(`llm "ollama": ${keyEnv} is not set`);
            return new OpenAICompatibleProvider({...base, ...(apiKey ? {apiKey} : {})});
        }
    }
];
