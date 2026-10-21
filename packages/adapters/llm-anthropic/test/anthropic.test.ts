import type Anthropic from "@anthropic-ai/sdk";
import {describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {AnthropicProvider, costOf} from "@aicd/adapter-llm-anthropic";
import {LLMError} from "@aicd/plugin-sdk";

const usage = {input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4_000};

function fakeClient(response: Record<string, unknown>) {
    const parse = vi.fn(async () => ({model: "claude-opus-5-5", usage, ...response}));
    return {client: {beta: {messages: {parse}}} as unknown as Anthropic, parse};
}

describe("AnthropicProvider", () => {
    const schema = z.object({category: z.string()});

    it("returns the parsed output with its cost, and asks for server-side fallbacks", async () => {
        const {client, parse} = fakeClient({stop_reason: "end_turn", parsed_output: {category: "regression"}});
        const provider = new AnthropicProvider({model: "claude-opus-5-5", client});
        const result = await provider.generateStructured({system: "s", prompt: "p", schema});
        expect(result.output).toEqual({category: "regression"});
        expect(result.usage).toMatchObject({inputTokens: 5_000, outputTokens: 200});
        expect(result.usage.costUsd).toBeCloseTo((1_000 * 4 + 4_000 * 0.4 + 200 * 20) / 1_000_000);
        expect(parse).toHaveBeenCalledWith(
            expect.objectContaining({fallbacks: "default", betas: ["server-side-fallback-2026-07-01"]})
        );
    });

    it("throws an LLMError that still carries the usage on a refusal", async () => {
        const {client} = fakeClient({stop_reason: "refusal", parsed_output: null});
        const provider = new AnthropicProvider({model: "claude-opus-5-5", client});
        const error = await provider.generateStructured({system: "s", prompt: "p", schema}).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LLMError);
        expect((error as LLMError).usage?.costUsd).toBeGreaterThan(0);
    });

    it("prices unknown models at 0 and warns once", () => {
        const warn = vi.fn();
        new AnthropicProvider({model: "some-future-model", client: fakeClient({}).client, warn});
        expect(warn).toHaveBeenCalledOnce();
        expect(costOf("some-future-model", usage)).toBe(0);
    });
});
