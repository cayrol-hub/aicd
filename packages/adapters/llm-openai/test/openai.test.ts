import {describe, expect, it, vi} from "vitest";
import {z} from "zod";
import {
    llmFactories,
    OpenAICompatibleProvider,
    stripOptionalNulls,
    toStrictJsonSchema
} from "@aicd-ci/adapter-llm-openai";
import {LLMError, type FactoryContext} from "@aicd-ci/plugin-sdk";

const schema = z.object({
    category: z.enum(["regression", "flaky_test"]),
    cause: z.string().optional(),
    evidence: z.array(z.object({quote: z.string(), line: z.number().optional()}))
});

function completion(content: string, extra: Record<string, unknown> = {}) {
    return {
        model: "gpt-test-2026",
        choices: [{finish_reason: "stop", message: {content, refusal: null}}],
        usage: {prompt_tokens: 1_000, completion_tokens: 200},
        ...extra
    };
}

type Reply = {status: number; body: unknown; headers?: Record<string, string>} | Error;

function fakeFetch(...replies: Reply[]) {
    const queue = [...replies];
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
        const reply = queue.shift();
        if (!reply) throw new Error("unexpected call");
        if (reply instanceof Error) throw reply;
        return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
            status: reply.status,
            ...(reply.headers ? {headers: reply.headers} : {})
        });
    });
}

const ok = (content: unknown, extra?: Record<string, unknown>): Reply => ({
    status: 200,
    body: completion(typeof content === "string" ? content : JSON.stringify(content), extra)
});

const request = {system: "system prompt", prompt: "<log>data</log>", schema};

function provider(fetchMock: ReturnType<typeof fakeFetch>, options: Record<string, unknown> = {}) {
    return new OpenAICompatibleProvider({
        model: "gpt-test",
        apiKey: "sk-test",
        fetch: fetchMock,
        sleep: async () => undefined,
        ...options
    });
}

const bodyOf = (fetchMock: ReturnType<typeof fakeFetch>, call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body)) as Record<string, any>;

describe("toStrictJsonSchema", () => {
    it("requires every property, forbids extra ones and makes optional ones nullable", () => {
        const {schema: json} = toStrictJsonSchema(schema);
        expect(json.$schema).toBeUndefined();
        expect(json).toMatchObject({
            type: "object",
            additionalProperties: false,
            required: ["category", "cause", "evidence"],
            properties: {cause: {anyOf: [{type: "string"}, {type: "null"}]}}
        });
        const item = (json.properties as any).evidence.items;
        expect(item).toMatchObject({additionalProperties: false, required: ["quote", "line"]});
    });

    it("keeps nullable fields as they are and drops unsupported keywords", () => {
        const {schema: json} = toStrictJsonSchema(
            z.object({a: z.string().nullable().optional(), b: z.string().min(2).default("xx")})
        );
        expect((json.properties as any).a).toEqual({type: ["string", "null"]});
        // A default makes the field optional on input: nullable, then the default applies.
        expect((json.properties as any).b).toEqual({anyOf: [{type: "string"}, {type: "null"}]});
    });

    it("removes the nulls of optional properties only, nested included", () => {
        const strict = toStrictJsonSchema(schema);
        expect(
            stripOptionalNulls({category: "regression", cause: null, evidence: [{quote: "q", line: null}]}, strict)
        ).toEqual({category: "regression", evidence: [{quote: "q"}]});
        expect(stripOptionalNulls({category: null}, strict)).toEqual({category: null});
    });

    it("handles recursive schemas through $ref", () => {
        type Node = {name: string; note?: string; children: Node[]};
        const node: z.ZodType<Node> = z.object({
            name: z.string(),
            note: z.string().optional(),
            get children() {
                return z.array(node);
            }
        });
        const strict = toStrictJsonSchema(node);
        expect(
            stripOptionalNulls({name: "a", note: null, children: [{name: "b", note: null, children: []}]}, strict)
        ).toEqual({name: "a", children: [{name: "b", children: []}]});
    });
});

describe("OpenAICompatibleProvider", () => {
    it("sends a strict json_schema request and returns the validated output with its usage and cost", async () => {
        const fetchMock = fakeFetch(ok({category: "regression", cause: null, evidence: [{quote: "boom", line: 3}]}));
        const result = await provider(fetchMock, {prices: {input: 2, output: 8}}).generateStructured(request);
        expect(result.output).toEqual({category: "regression", evidence: [{quote: "boom", line: 3}]});
        expect(result.usage).toEqual({
            model: "gpt-test-2026",
            inputTokens: 1_000,
            outputTokens: 200,
            costUsd: (1_000 * 2 + 200 * 8) / 1_000_000
        });
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe("https://api.openai.com/v1/chat/completions");
        expect(init?.headers).toMatchObject({Authorization: "Bearer sk-test", "Content-Type": "application/json"});
        const body = bodyOf(fetchMock);
        expect(body.model).toBe("gpt-test");
        expect(body.messages).toEqual([
            {role: "system", content: "system prompt"},
            {role: "user", content: "<log>data</log>"}
        ]);
        expect(body.response_format).toMatchObject({
            type: "json_schema",
            json_schema: {name: "aicd_output", strict: true}
        });
        expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
        expect(body.max_completion_tokens).toBeUndefined();
    });

    it("costs nothing by default, uses max_tokens for local servers and sends no key", async () => {
        const fetchMock = fakeFetch(ok({category: "flaky_test", evidence: []}));
        const local = new OpenAICompatibleProvider({
            model: "llama3.3",
            name: "ollama",
            baseUrl: "http://localhost:11434/v1/",
            maxTokens: 4_000,
            fetch: fetchMock,
            extraHeaders: {"X-Extra": "1"}
        });
        const result = await local.generateStructured(request);
        expect(result.usage.costUsd).toBe(0);
        expect(local.name).toBe("ollama");
        expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({"Content-Type": "application/json", "X-Extra": "1"});
        expect(bodyOf(fetchMock).max_tokens).toBe(4_000);
    });

    it("uses max_completion_tokens for OpenAI, the request's maxTokens first", async () => {
        const fetchMock = fakeFetch(ok({category: "flaky_test", evidence: []}));
        await provider(fetchMock, {maxTokens: 100}).generateStructured({...request, maxTokens: 50});
        expect(bodyOf(fetchMock).max_completion_tokens).toBe(50);
    });

    it("accepts JSON wrapped in a markdown fence", async () => {
        const fetchMock = fakeFetch(ok('```json\n{"category": "regression", "evidence": []}\n```'));
        const result = await provider(fetchMock).generateStructured(request);
        expect(result.output.category).toBe("regression");
    });

    it.each([
        [
            "a refusal",
            ok("", {choices: [{finish_reason: "stop", message: {content: null, refusal: "I can't"}}]}),
            "declined"
        ],
        ["a cut response", ok("", {choices: [{finish_reason: "length", message: {content: '{"categ'}}]}), "max_tokens"],
        ["invalid JSON", ok("not json at all"), "not valid JSON"],
        ["a schema mismatch", ok({category: "other", evidence: []}), "did not match the expected schema: category"],
        ["no choice", ok("", {choices: []}), "no choice"]
    ])("throws an LLMError with the usage on %s", async (_name, reply, message) => {
        const error = await provider(fakeFetch(reply), {prices: {input: 1, output: 1}})
            .generateStructured(request)
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LLMError);
        expect((error as LLMError).message).toContain(message);
        expect((error as LLMError).usage).toMatchObject({inputTokens: 1_000, outputTokens: 200, costUsd: 0.0012});
    });

    it("retries 429 and 5xx with backoff, honouring Retry-After", async () => {
        const sleep = vi.fn(async () => undefined);
        const fetchMock = fakeFetch(
            {status: 429, body: {error: {message: "rate"}}, headers: {"retry-after": "3"}},
            {status: 503, body: "unavailable"},
            ok({category: "regression", evidence: []})
        );
        const result = await provider(fetchMock, {sleep}).generateStructured(request);
        expect(result.output.category).toBe("regression");
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual([[3_000], [2_000]]);
    });

    it("gives up after 2 retries and does not retry client errors", async () => {
        const failing = fakeFetch(
            {status: 500, body: "a"},
            {status: 500, body: "b"},
            {status: 500, body: {error: {message: "server exploded"}}}
        );
        await expect(provider(failing).generateStructured(request)).rejects.toThrow("openai: HTTP 500 server exploded");
        expect(failing).toHaveBeenCalledTimes(3);

        const unauthorized = fakeFetch({status: 401, body: {error: {message: "Incorrect API key provided"}}});
        const error = (await provider(unauthorized)
            .generateStructured(request)
            .catch((e: unknown) => e)) as Error;
        expect(error).not.toBeInstanceOf(LLMError);
        expect(error.message).toBe("openai: HTTP 401 Incorrect API key provided");
        expect(unauthorized).toHaveBeenCalledOnce();
    });

    it("retries network errors and reports timeouts", async () => {
        const fetchMock = fakeFetch(new TypeError("fetch failed"), ok({category: "regression", evidence: []}));
        await expect(provider(fetchMock).generateStructured(request)).resolves.toBeDefined();

        const timeout = Object.assign(new Error("timed out"), {name: "TimeoutError"});
        await expect(provider(fakeFetch(timeout), {timeoutMs: 5}).generateStructured(request)).rejects.toThrow(
            "openai: no response within 5 ms"
        );
    });
});

describe("llmFactories", () => {
    const context = (env: NodeJS.ProcessEnv, fetchMock = fakeFetch()): FactoryContext => ({
        env,
        fetch: fetchMock as unknown as typeof fetch,
        logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    });
    const factory = (name: string) => llmFactories.find((f) => f.name === name)!;

    it("provides openai and ollama", () => {
        expect(llmFactories.map((f) => f.name)).toEqual(["openai", "ollama"]);
    });

    it("openai reads OPENAI_API_KEY or api_key_env, and uses the context fetch", async () => {
        const fetchMock = fakeFetch(ok({category: "regression", evidence: []}));
        const llm = factory("openai").create(
            {model: "gpt-test", api_key_env: "MY_KEY", prices: {input: 1, output: 4}, timeout_ms: 1000},
            context({MY_KEY: "sk-mine"}, fetchMock)
        );
        expect(llm).toMatchObject({name: "openai", model: "gpt-test"});
        const result = await llm.generateStructured(request);
        expect(result.usage.costUsd).toBeCloseTo((1_000 + 800) / 1_000_000);
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({Authorization: "Bearer sk-mine"});
        expect(() => factory("openai").create({model: "m"}, context({OPENAI_API_KEY: "k"}))).not.toThrow();
    });

    it("openai requires a key for the OpenAI API, not for another base_url", () => {
        expect(() => factory("openai").create({model: "m"}, context({}))).toThrow(
            'llm "openai": OPENAI_API_KEY is not set'
        );
        expect(() => factory("openai").create({model: "m", api_key_env: "X"}, context({}))).toThrow("X is not set");
        const vllm = factory("openai").create({model: "m", base_url: "http://vllm:8000/v1", name: "vllm"}, context({}));
        expect(vllm.name).toBe("vllm");
    });

    it("ollama defaults to localhost without a key", async () => {
        const fetchMock = fakeFetch(ok({category: "regression", evidence: []}));
        const llm = factory("ollama").create({model: "qwen3"}, context({OPENAI_API_KEY: "ignored"}, fetchMock));
        await llm.generateStructured(request);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
        expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
        expect(bodyOf(fetchMock)).not.toHaveProperty("max_completion_tokens");
    });

    it("validates the configuration", () => {
        expect(() => factory("ollama").create({}, context({}))).toThrow('llm "ollama": model is required');
        expect(() => factory("ollama").create({model: "m", prices: {input: 1}}, context({}))).toThrow("prices must be");
        expect(() => factory("ollama").create({model: "m", timeout_ms: "x"}, context({}))).toThrow(
            "timeout_ms must be a non-negative number"
        );
        expect(() => factory("ollama").create({model: "m", max_tokens_field: "tokens"}, context({}))).toThrow(
            "max_tokens_field must be"
        );
    });
});
