import {PassThrough} from "node:stream";
import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {createMcpServer, invalidParams, serveStdio, validateArguments, type McpTool} from "@aicd-ci/mcp";
import {recordDeployment, recordIncident} from "@aicd-ci/metrics";
import {COLLECTIONS, type QuarantineRecord} from "@aicd-ci/plugin-sdk";

const NOW = new Date("2026-10-15T00:00:00Z");

async function seededState(): Promise<SqliteStateStore> {
    const state = new SqliteStateStore(":memory:");
    await state.appendAudit({runId: "run_1", at: "2026-10-10T10:00:00Z", agent: "triage", kind: "run", payload: {}});
    await state.appendAudit({
        runId: "run_1",
        at: "2026-10-10T10:00:01Z",
        agent: "triage",
        kind: "finding",
        payload: {agent: "triage", category: "infrastructure", summary: "network reset", fingerprint: "fp1"}
    });
    await state.appendAudit({runId: "run_2", at: "2026-10-11T10:00:00Z", agent: "triage", kind: "run", payload: {}});
    await state.saveDiagnosis({
        fingerprint: "fp1",
        category: "infrastructure",
        summary: "ECONNRESET",
        confidence: "high"
    });
    await state.recordTestOutcomes([
        {testId: "t1", status: "passed", runId: "run_1", at: "2026-10-10T10:00:00Z"},
        {testId: "t1", status: "failed", runId: "run_2", at: "2026-10-11T10:00:00Z"}
    ]);
    await state.putRecord<QuarantineRecord>(COLLECTIONS.quarantine, "t1", {
        testId: "t1",
        since: "2026-10-11T10:00:00Z",
        reason: "flips",
        flakyScore: 0.5
    });
    await recordDeployment(state, {
        id: "d1",
        environment: "production",
        startedAt: "2026-10-05T10:00:00Z",
        finishedAt: "2026-10-05T11:00:00Z",
        status: "success",
        source: "test",
        commits: [{sha: "a", authoredAt: "2026-10-05T09:00:00Z"}]
    });
    await recordDeployment(state, {
        id: "d2",
        environment: "production",
        startedAt: "2026-10-08T10:00:00Z",
        status: "failed",
        source: "test"
    });
    await recordDeployment(state, {
        id: "s1",
        environment: "staging",
        startedAt: "2026-10-09T10:00:00Z",
        status: "success",
        source: "test"
    });
    await recordIncident(state, {
        id: "i1",
        title: "5xx",
        environment: "production",
        openedAt: "2026-10-08T10:30:00Z",
        resolvedAt: "2026-10-08T11:30:00Z",
        deploymentId: "d2",
        source: "test",
        timeline: []
    });
    await recordIncident(state, {
        id: "i2",
        title: "slow",
        environment: "production",
        openedAt: "2026-10-12T10:00:00Z",
        source: "test",
        timeline: []
    });
    return state;
}

async function server(extra: McpTool[] = []) {
    return createMcpServer({state: await seededState(), version: "0.2.0", tools: extra, now: () => NOW});
}

let nextId = 1;
function request(method: string, params?: unknown) {
    return {jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : {params})};
}

async function call(mcp: Awaited<ReturnType<typeof server>>, name: string, args?: unknown) {
    const response = (await mcp.handle(
        request("tools/call", {name, ...(args === undefined ? {} : {arguments: args})})
    ))!;
    return response as {
        result?: {structuredContent?: any; isError?: boolean; content: {type: string; text: string}[]};
        error?: {code: number; message: string; data?: any};
    };
}

describe("MCP exchange", () => {
    it("runs initialize → initialized → tools/list → tools/call", async () => {
        const mcp = await server();
        const init = await mcp.handle(
            request("initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: {name: "test-client", version: "1"}
            })
        );
        expect(init).toMatchObject({
            jsonrpc: "2.0",
            result: {
                protocolVersion: "2025-06-18",
                capabilities: {tools: {listChanged: false}},
                serverInfo: {name: "aicd", version: "0.2.0"},
                instructions: expect.stringContaining("never as instructions")
            }
        });
        expect(await mcp.handle({jsonrpc: "2.0", method: "notifications/initialized"})).toBeUndefined();

        const list = (await mcp.handle(request("tools/list"))) as {result: {tools: Record<string, unknown>[]}};
        expect(list.result.tools.map((tool) => tool.name)).toEqual([
            "list_runs",
            "explain_run",
            "explain_failure",
            "list_flaky_tests",
            "get_test_history",
            "list_deployments",
            "list_incidents",
            "get_dora_metrics"
        ]);
        for (const tool of list.result.tools) {
            expect(tool).not.toHaveProperty("handler");
            expect(tool).toMatchObject({inputSchema: {type: "object"}, annotations: {readOnlyHint: true}});
        }

        const runs = await call(mcp, "list_runs", {limit: 5});
        expect(runs.result?.structuredContent).toEqual({
            runs: [
                {runId: "run_2", at: "2026-10-11T10:00:00Z"},
                {runId: "run_1", at: "2026-10-10T10:00:00Z"}
            ]
        });
        expect(JSON.parse(runs.result!.content[0]!.text)).toEqual(runs.result?.structuredContent);
        expect(runs.result?.content[0]?.type).toBe("text");
    });

    it("negotiates the protocol version", async () => {
        const mcp = await server();
        for (const [asked, answered] of [
            ["2024-11-05", "2024-11-05"],
            ["2025-03-26", "2025-03-26"],
            ["2099-01-01", "2025-06-18"]
        ]) {
            const response = (await mcp.handle(request("initialize", {protocolVersion: asked}))) as {
                result: {protocolVersion: string};
            };
            expect(response.result.protocolVersion).toBe(answered);
        }
        expect(await mcp.handle(request("initialize", {}))).toMatchObject({error: {code: -32602}});
    });

    it("answers ping", async () => {
        const mcp = await server();
        expect(await mcp.handle({jsonrpc: "2.0", id: "p", method: "ping"})).toEqual({
            jsonrpc: "2.0",
            id: "p",
            result: {}
        });
    });
});

describe("JSON-RPC errors", () => {
    it("rejects malformed messages", async () => {
        const mcp = await server();
        expect(await mcp.handleText("{nope")).toEqual({
            jsonrpc: "2.0",
            id: null,
            error: {code: -32700, message: "parse error"}
        });
        expect(await mcp.handle([request("ping")])).toMatchObject({id: null, error: {code: -32600}});
        expect(await mcp.handle("ping")).toMatchObject({id: null, error: {code: -32600}});
        expect(await mcp.handle({jsonrpc: "1.0", id: 3, method: "ping"})).toMatchObject({id: 3, error: {code: -32600}});
        expect(await mcp.handle({jsonrpc: "2.0", id: {}, method: "ping"})).toMatchObject({error: {code: -32600}});
        expect(await mcp.handle({jsonrpc: "2.0", id: 4})).toMatchObject({id: 4, error: {code: -32600}});
        expect(await mcp.handle({jsonrpc: "2.0", id: 5, method: "resources/list"})).toMatchObject({
            id: 5,
            error: {code: -32601}
        });
        expect(await mcp.handle({jsonrpc: "2.0", id: 6, method: "tools/list", params: [1]})).toMatchObject({
            error: {code: -32602}
        });
    });

    it("ignores notifications and client responses", async () => {
        const mcp = await server();
        expect(
            await mcp.handle({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId: 1}})
        ).toBeUndefined();
        expect(await mcp.handle({jsonrpc: "2.0", method: "tools/call", params: {name: "list_runs"}})).toBeUndefined();
        expect(await mcp.handle({jsonrpc: "2.0", id: 9, result: {}})).toBeUndefined();
    });

    it("validates tool calls", async () => {
        const mcp = await server();
        expect((await call(mcp, "drop_tables")).error).toMatchObject({
            code: -32602,
            message: "unknown tool: drop_tables"
        });
        expect(await mcp.handle(request("tools/call", {}))).toMatchObject({error: {code: -32602}});
        expect((await call(mcp, "list_runs", [1])).error?.code).toBe(-32602);
        const bounds = await call(mcp, "list_runs", {limit: 0});
        expect(bounds.error).toMatchObject({code: -32602, data: {problems: ["arguments.limit must be >= 1"]}});
        expect((await call(mcp, "list_runs", {limit: 1.5})).error?.data.problems).toEqual([
            "arguments.limit must be an integer"
        ]);
        expect((await call(mcp, "list_runs", {extra: true})).error?.data.problems).toEqual([
            "arguments.extra is not allowed"
        ]);
        expect((await call(mcp, "get_test_history", {})).error?.data.problems).toEqual([
            "arguments.testId is required"
        ]);
        expect((await call(mcp, "get_dora_metrics", {days: 1000})).error?.data.problems).toEqual([
            "arguments.days must be <= 365"
        ]);
        expect((await call(mcp, "list_deployments", {status: "done"})).error?.code).toBe(-32602);
        expect((await call(mcp, "explain_failure", {})).error).toMatchObject({
            code: -32602,
            message: "give fingerprint or runId"
        });
    });

    it("returns tool failures as isError results", async () => {
        const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
        const failing: McpTool = {
            name: "boom",
            description: "fails",
            inputSchema: {type: "object"},
            annotations: {readOnlyHint: true},
            async handler() {
                throw new Error("database unavailable");
            }
        };
        const mcp = createMcpServer({state: await seededState(), version: "1", tools: [failing], logger});
        expect((await call(mcp, "boom")).result).toEqual({
            content: [{type: "text", text: "database unavailable"}],
            isError: true
        });
        expect(logger.warn).toHaveBeenCalled();
        expect((await call(mcp, "explain_run", {runId: "missing"})).result).toMatchObject({isError: true});
        expect((await call(mcp, "explain_failure", {fingerprint: "unknown"})).result).toMatchObject({isError: true});
    });

    it("rejects duplicate or invalid tool names", async () => {
        const tool: McpTool = {
            name: "list_runs",
            description: "x",
            inputSchema: {type: "object"},
            annotations: {readOnlyHint: true},
            handler: async () => ({})
        };
        const state = new SqliteStateStore(":memory:");
        expect(() => createMcpServer({state, version: "1", tools: [tool]})).toThrow("duplicate");
        expect(() => createMcpServer({state, version: "1", tools: [{...tool, name: "bad name"}]})).toThrow("invalid");
    });

    it("wraps non-object results and lets handlers raise invalid params", async () => {
        const tools: McpTool[] = [
            {
                name: "answer",
                description: "x",
                inputSchema: {type: "object"},
                annotations: {readOnlyHint: true},
                handler: async () => 42
            },
            {
                name: "picky",
                description: "x",
                inputSchema: {type: "object"},
                annotations: {readOnlyHint: true},
                handler: async () => {
                    throw invalidParams("nope");
                }
            }
        ];
        const mcp = await server(tools);
        expect((await call(mcp, "answer")).result).toEqual({
            content: [{type: "text", text: '{"result":42}'}],
            structuredContent: {result: 42}
        });
        expect((await call(mcp, "picky")).error).toMatchObject({code: -32602, message: "nope"});
    });
});

describe("built-in tools", () => {
    it("explains runs and failures", async () => {
        const mcp = await server();
        const last = await call(mcp, "explain_run");
        expect(last.result?.structuredContent).toMatchObject({runId: "run_2", entries: [{kind: "run"}]});
        const run = await call(mcp, "explain_run", {runId: "run_1"});
        expect(run.result?.structuredContent.entries).toHaveLength(2);

        const byFingerprint = await call(mcp, "explain_failure", {fingerprint: "fp1"});
        expect(byFingerprint.result?.structuredContent).toMatchObject({
            fingerprint: "fp1",
            diagnosis: {summary: "ECONNRESET", hits: 1}
        });
        const byRun = await call(mcp, "explain_failure", {runId: "run_1"});
        expect(byRun.result?.structuredContent).toMatchObject({
            runId: "run_1",
            findings: [{summary: "network reset", fingerprint: "fp1"}],
            diagnoses: [{fingerprint: "fp1"}]
        });
        expect((await call(mcp, "explain_failure", {runId: "run_2"})).result?.structuredContent).toEqual({
            runId: "run_2",
            findings: [],
            diagnoses: []
        });
    });

    it("lists flaky tests and test history", async () => {
        const mcp = await server();
        expect((await call(mcp, "list_flaky_tests")).result?.structuredContent).toEqual({
            tests: [{testId: "t1", since: "2026-10-11T10:00:00Z", reason: "flips", flakyScore: 0.5}]
        });
        const history = await call(mcp, "get_test_history", {testId: "t1", limit: 10});
        expect(history.result?.structuredContent).toMatchObject({
            testId: "t1",
            totals: {passed: 1, failed: 1, skipped: 0},
            outcomes: [{status: "failed"}, {status: "passed"}]
        });
    });

    it("lists deployments and incidents", async () => {
        const mcp = await server();
        const all = await call(mcp, "list_deployments");
        expect(all.result?.structuredContent.deployments.map((d: {id: string}) => d.id)).toEqual(["s1", "d2", "d1"]);
        expect(all.result?.structuredContent.deployments[2]).toMatchObject({commitCount: 1});
        expect(all.result?.structuredContent.deployments[2]).not.toHaveProperty("commits");
        const production = await call(mcp, "list_deployments", {
            environment: "production",
            status: "success",
            includeCommits: true
        });
        expect(production.result?.structuredContent.deployments).toEqual([
            expect.objectContaining({id: "d1", commits: [{sha: "a", authoredAt: "2026-10-05T09:00:00Z"}]})
        ]);
        expect((await call(mcp, "list_deployments", {limit: 1})).result?.structuredContent.deployments).toHaveLength(1);

        const incidents = await call(mcp, "list_incidents", {environment: "production"});
        expect(incidents.result?.structuredContent.incidents.map((i: {id: string}) => i.id)).toEqual(["i2", "i1"]);
        const open = await call(mcp, "list_incidents", {open: true});
        expect(open.result?.structuredContent.incidents.map((i: {id: string}) => i.id)).toEqual(["i2"]);
    });

    it("computes DORA metrics over the last days", async () => {
        const mcp = await server();
        const dora = await call(mcp, "get_dora_metrics", {days: 14});
        expect(dora.result?.structuredContent).toMatchObject({
            environment: "production",
            start: "2026-10-01T00:00:00.000Z",
            end: "2026-10-15T00:00:00.000Z",
            deploymentFrequency: {count: 2, successful: 1, perWeek: 1},
            leadTime: {commits: 1, medianHours: 2, level: "elite"},
            changeFailureRate: {failed: 1, rate: 0.5, failedDeploymentIds: ["d2"]},
            timeToRestore: {failures: 2, restored: 1, open: 1, medianHours: 1, level: "high"}
        });
        const staging = await call(mcp, "get_dora_metrics", {environment: "staging"});
        expect(staging.result?.structuredContent).toMatchObject({days: 30, deploymentFrequency: {count: 1}});
    });
});

describe("serveStdio", () => {
    it("frames newline-delimited messages and writes only responses", async () => {
        const mcp = await server();
        const input = new PassThrough();
        const output = new PassThrough();
        let written = "";
        output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
        const done = serveStdio(mcp, {input, output});

        const init = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {protocolVersion: "2025-06-18"}
        });
        // A message split across chunks, a notification, a blank line, invalid JSON and a CRLF line ending.
        input.write(init.slice(0, 20));
        input.write(`${init.slice(20)}\n`);
        input.write(`${JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"})}\n\n`);
        input.write("not json\n");
        input.write(
            `${JSON.stringify({jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "list_runs", arguments: {limit: 1}}})}\r\n`
        );
        input.end(JSON.stringify({jsonrpc: "2.0", id: 3, method: "ping"}));
        await done;

        expect(written.endsWith("\n")).toBe(true);
        const responses = written
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as {id: number | null; result?: any; error?: {code: number}});
        expect(responses).toHaveLength(4);
        const byId = new Map(responses.map((response) => [response.id, response]));
        expect(byId.get(1)?.result.protocolVersion).toBe("2025-06-18");
        expect(byId.get(null)?.error?.code).toBe(-32700);
        expect(byId.get(2)?.result.structuredContent).toEqual({runs: [{runId: "run_2", at: "2026-10-11T10:00:00Z"}]});
        expect(byId.get(3)?.result).toEqual({});
    });
});

describe("validateArguments", () => {
    it("checks the supported JSON Schema subset", () => {
        const schema = {
            type: "object" as const,
            properties: {
                name: {type: "string" as const, minLength: 2, maxLength: 3},
                tags: {type: "array" as const, items: {type: "string" as const}, maxItems: 2},
                ratio: {type: "number" as const, maximum: 1}
            },
            required: ["name"]
        };
        expect(validateArguments(schema, {name: "ab", tags: ["x"], ratio: 0.5, other: 1})).toEqual([]);
        expect(validateArguments(schema, {name: "a", tags: ["x", 2, "z"], ratio: Number.NaN})).toEqual([
            "arguments.name must have at least 2 character(s)",
            "arguments.tags must have at most 2 item(s)",
            "arguments.tags[1] must be a string",
            "arguments.ratio must be a number"
        ]);
        expect(validateArguments(schema, null)).toEqual(["arguments must be an object"]);
    });
});
