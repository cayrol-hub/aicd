import {createHmac} from "node:crypto";
import {mkdtempSync, readFileSync} from "node:fs";
import {request} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {COLLECTIONS, type Logger, type StateStore} from "@aicd/plugin-sdk";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {
    createAicdServer,
    type AicdEvent,
    type AicdServer,
    type AicdServerOptions,
    type EventRecord
} from "@aicd/server";

const GITHUB_SECRET = "gh-secret-do-not-echo";
const GITLAB_TOKEN = "gl-token-do-not-echo";
const ALERTS_TOKEN = "alerts-token-do-not-echo";
const SENTRY_SECRET = "sentry-client-secret";
const API_TOKEN = "api-token";

function fixture(name: string): string {
    return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
}

function sign(body: string, secret = GITHUB_SECRET): string {
    return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function quietLogger(): Logger & {lines: string[]} {
    const lines: string[] = [];
    const push = (level: string) => (message: string) => lines.push(`${level}: ${message}`);
    return {lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error")};
}

interface Harness {
    server: AicdServer;
    base: string;
    state: StateStore;
    logger: ReturnType<typeof quietLogger>;
    received: AicdEvent[];
}

const running: AicdServer[] = [];

afterEach(async () => {
    while (running.length > 0) await running.pop()?.close();
});

async function start(options: Partial<AicdServerOptions> = {}): Promise<Harness> {
    const state = options.state ?? new SqliteStateStore(":memory:");
    const logger = quietLogger();
    const received: AicdEvent[] = [];
    const record = async (event: AicdEvent) => {
        received.push(event);
    };
    const server = createAicdServer({
        state,
        logger,
        apiTokens: [API_TOKEN],
        webhooks: {
            githubSecret: GITHUB_SECRET,
            gitlabToken: GITLAB_TOKEN,
            alertsToken: ALERTS_TOKEN,
            sentryClientSecret: SENTRY_SECRET
        },
        handlers: {
            pipeline_completed: record,
            merge_request_updated: record,
            deployment: record,
            tag_pushed: record,
            alert: record
        },
        retryDelayMs: 5,
        ...options
    });
    running.push(server);
    const {port} = await server.listen(0, "127.0.0.1");
    return {server, base: `http://127.0.0.1:${port}`, state, logger, received};
}

function github(base: string, event: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/webhooks/github`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": event,
            "X-Hub-Signature-256": sign(body),
            ...headers
        },
        body
    });
}

function gitlab(base: string, event: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Gitlab-Event": event,
            "X-Gitlab-Token": GITLAB_TOKEN,
            ...headers
        },
        body
    });
}

function alert(base: string, source: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/webhooks/alerts/${source}`, {
        method: "POST",
        headers: {"Content-Type": "application/json", Authorization: `Bearer ${ALERTS_TOKEN}`, ...headers},
        body
    });
}

function api(base: string, path: string, token = API_TOKEN): Promise<Response> {
    return fetch(`${base}${path}`, {headers: {Authorization: `Bearer ${token}`}});
}

async function events(state: StateStore): Promise<Record<string, EventRecord>> {
    const records = await state.listRecords<EventRecord>(COLLECTIONS.events);
    return Object.fromEntries(records.map((record) => [record.id, record.value]));
}

describe("health and routing", () => {
    it("answers health, readiness, 404 and 405 with JSON", async () => {
        const {base} = await start();
        const health = await fetch(`${base}/healthz`);
        expect(health.status).toBe(200);
        expect(health.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await health.json()).toEqual({status: "ok"});
        const ready = await fetch(`${base}/readyz`);
        expect(ready.status).toBe(200);
        expect(await ready.json()).toMatchObject({status: "ready"});
        const missing = await fetch(`${base}/nope`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({error: "not_found"});
        const wrongMethod = await fetch(`${base}/webhooks/github`);
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get("allow")).toBe("POST");
        const mcpGet = await fetch(`${base}/mcp`, {headers: {Authorization: `Bearer ${API_TOKEN}`}});
        expect(mcpGet.status).toBe(405);
        expect(mcpGet.headers.get("allow")).toBe("POST");
        expect((await fetch(`${base}/healthz/`)).status).toBe(200);
    });

    it("is not ready when the state store is unreachable", async () => {
        const state = new SqliteStateStore(":memory:");
        const broken = Object.assign(Object.create(state) as StateStore, {
            getRecord: async () => {
                throw new Error("connection refused");
            },
            listRecords: state.listRecords.bind(state)
        });
        const {base} = await start({state: broken});
        const ready = await fetch(`${base}/readyz`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({error: "unavailable", message: "state store unreachable"});
    });
});

describe("GitHub webhook", () => {
    it("accepts a signed delivery and hands the normalized event to its handler", async () => {
        const {base, server, received, state} = await start();
        const body = fixture("github-workflow-run");
        const response = await github(base, "workflow_run", body, {"X-GitHub-Delivery": "d-1"});
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({accepted: 1, duplicates: 0});
        await server.queue.onIdle();
        expect(received).toEqual([expect.objectContaining({type: "pipeline_completed", pipelineId: "11223344556"})]);
        expect((await events(state))["github:d-1:0"]).toMatchObject({
            status: "done",
            attempts: 1,
            deliveryId: "github:d-1"
        });
    });

    it("refuses missing and invalid signatures without echoing the secret", async () => {
        const {base, received} = await start();
        const body = fixture("github-push-tag");
        const missing = await fetch(`${base}/webhooks/github`, {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-GitHub-Event": "push"},
            body
        });
        expect(missing.status).toBe(401);
        const forged = await github(base, "push", body, {"X-Hub-Signature-256": sign(body, "guess")});
        expect(forged.status).toBe(403);
        const text = await forged.text();
        expect(text).not.toContain(GITHUB_SECRET);
        expect(JSON.parse(text)).toEqual({error: "forbidden", message: "invalid signature"});
        const garbage = await github(base, "push", body, {"X-Hub-Signature-256": "sha256=zz"});
        expect(garbage.status).toBe(403);
        const tampered = await github(base, "push", body.replace("v1.4.0", "v6.6.6"), {
            "X-Hub-Signature-256": sign(body)
        });
        expect(tampered.status).toBe(403);
        expect(received).toEqual([]);
    });

    it("answers 415, 400 and 202-ignored for the wrong media type, bad JSON and unknown events", async () => {
        const {base} = await start();
        const form = "payload=%7B%7D";
        const wrongType = await fetch(`${base}/webhooks/github`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-GitHub-Event": "push",
                "X-Hub-Signature-256": sign(form)
            },
            body: form
        });
        expect(wrongType.status).toBe(415);
        const badJson = await github(base, "push", "{nope");
        expect(badJson.status).toBe(400);
        expect(await badJson.json()).toMatchObject({error: "invalid_json"});
        const ping = await github(base, "ping", JSON.stringify({zen: "Design for failure."}));
        expect(ping.status).toBe(202);
        expect(await ping.json()).toEqual({accepted: 0, duplicates: 0, ignored: true});
        const noEvent = await fetch(`${base}/webhooks/github`, {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-Hub-Signature-256": sign("{}")},
            body: "{}"
        });
        expect(noEvent.status).toBe(400);
    });

    it("answers 404 when the webhook is not configured", async () => {
        const {base} = await start({webhooks: {}});
        const body = fixture("github-push-tag");
        expect((await github(base, "push", body)).status).toBe(404);
        expect((await gitlab(base, "Tag Push Hook", fixture("gitlab-tag-push"))).status).toBe(404);
        expect((await alert(base, "generic", fixture("generic-alert"))).status).toBe(404);
    });

    it("deduplicates by X-GitHub-Delivery, else by body hash", async () => {
        const {base, server, received} = await start();
        const body = fixture("github-pull-request");
        expect(await (await github(base, "pull_request", body, {"X-GitHub-Delivery": "same"})).json()).toEqual({
            accepted: 1,
            duplicates: 0
        });
        expect(await (await github(base, "pull_request", body, {"X-GitHub-Delivery": "same"})).json()).toEqual({
            accepted: 0,
            duplicates: 1
        });
        await server.queue.onIdle();
        expect(await (await github(base, "pull_request", body, {"X-GitHub-Delivery": "same"})).json()).toEqual({
            accepted: 0,
            duplicates: 1
        });
        const tag = fixture("github-push-tag");
        await github(base, "push", tag);
        expect(await (await github(base, "push", tag)).json()).toEqual({accepted: 0, duplicates: 1});
        await server.queue.onIdle();
        expect(received.map((event) => event.type)).toEqual(["merge_request_updated", "tag_pushed"]);
    });

    it("deduplicates concurrent identical deliveries", async () => {
        const {base, server, received} = await start();
        const body = fixture("github-deployment-status");
        const responses = await Promise.all(
            Array.from({length: 5}, () => github(base, "deployment_status", body, {"X-GitHub-Delivery": "burst"}))
        );
        const results = (await Promise.all(responses.map((response) => response.json()))) as {accepted: number}[];
        expect(results.reduce((sum, result) => sum + result.accepted, 0)).toBe(1);
        await server.queue.onIdle();
        expect(received).toHaveLength(1);
    });
});

describe("GitLab webhook", () => {
    it("checks X-Gitlab-Token and accepts each supported hook", async () => {
        const {base, server, received, state} = await start();
        const missing = await fetch(`${base}/webhooks/gitlab`, {
            method: "POST",
            headers: {"Content-Type": "application/json", "X-Gitlab-Event": "Pipeline Hook"},
            body: fixture("gitlab-pipeline")
        });
        expect(missing.status).toBe(401);
        const wrong = await gitlab(base, "Pipeline Hook", fixture("gitlab-pipeline"), {"X-Gitlab-Token": "nope"});
        expect(wrong.status).toBe(403);
        expect(await wrong.text()).not.toContain(GITLAB_TOKEN);
        for (const [event, name] of [
            ["Pipeline Hook", "gitlab-pipeline"],
            ["Merge Request Hook", "gitlab-merge-request"],
            ["Deployment Hook", "gitlab-deployment"],
            ["Tag Push Hook", "gitlab-tag-push"]
        ] as const) {
            const response = await gitlab(base, event, fixture(name), {"X-Gitlab-Event-UUID": `uuid-${name}`});
            expect(response.status).toBe(202);
            expect(await response.json()).toEqual({accepted: 1, duplicates: 0});
        }
        await server.queue.onIdle();
        expect(received.map((event) => event.type).sort()).toEqual([
            "deployment",
            "merge_request_updated",
            "pipeline_completed",
            "tag_pushed"
        ]);
        expect(Object.keys(await events(state))).toContain("gitlab:uuid-gitlab-pipeline:0");
    });
});

describe("alert webhooks", () => {
    it("accepts the token as Bearer or X-Aicd-Token and splits Alertmanager groups", async () => {
        const {base, server, received} = await start();
        const generic = await alert(base, "generic", fixture("generic-alert"));
        expect(generic.status).toBe(202);
        const prometheus = await alert(base, "alertmanager", fixture("alertmanager"), {
            Authorization: "",
            "X-Aicd-Token": ALERTS_TOKEN
        });
        expect(await prometheus.json()).toEqual({accepted: 2, duplicates: 0});
        const repeated = await alert(base, "alertmanager", fixture("alertmanager"));
        expect(await repeated.json()).toEqual({accepted: 0, duplicates: 2});
        await server.queue.onIdle();
        expect(received.map((event) => (event.type === "alert" ? `${event.source}:${event.status}` : ""))).toEqual([
            "generic:opened",
            "alertmanager:opened",
            "alertmanager:resolved"
        ]);
    });

    it("refuses missing or wrong tokens, unknown sources and invalid generic payloads", async () => {
        const {base} = await start();
        expect((await alert(base, "generic", fixture("generic-alert"), {Authorization: ""})).status).toBe(401);
        expect((await alert(base, "generic", fixture("generic-alert"), {Authorization: "Bearer wrong"})).status).toBe(
            403
        );
        expect((await alert(base, "pagerduty", fixture("generic-alert"))).status).toBe(404);
        const invalid = await alert(base, "generic", JSON.stringify({id: "x", status: "opened"}));
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({error: "invalid_payload", message: "alert title is required"});
        expect((await alert(base, "alertmanager", JSON.stringify({version: "4"}))).status).toBe(400);
    });

    it("accepts a Sentry delivery signed with the client secret", async () => {
        const {base, server, received} = await start();
        const body = fixture("sentry-issue");
        const signature = createHmac("sha256", SENTRY_SECRET).update(body).digest("hex");
        const signed = await alert(base, "sentry", body, {
            Authorization: "",
            "Sentry-Hook-Resource": "issue",
            "Sentry-Hook-Signature": signature
        });
        expect(signed.status).toBe(202);
        const forged = await alert(base, "sentry", body, {Authorization: "", "Sentry-Hook-Signature": "0".repeat(64)});
        expect(forged.status).toBe(403);
        await server.queue.onIdle();
        expect(received).toEqual([expect.objectContaining({source: "sentry", id: "4012345678", status: "opened"})]);
    });
});

describe("body limit", () => {
    it("refuses a declared body over the limit with 413", async () => {
        const {base, received} = await start({bodyLimitBytes: 256});
        const body = JSON.stringify({id: "x", status: "opened", title: "y".repeat(1000)});
        const response = await alert(base, "generic", body);
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({error: "payload_too_large"});
        expect(received).toEqual([]);
    });

    it("refuses a chunked body that grows over the limit", async () => {
        const {base} = await start({bodyLimitBytes: 256});
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(
                `${base}/webhooks/alerts/generic`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Aicd-Token": ALERTS_TOKEN,
                        "Transfer-Encoding": "chunked"
                    }
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                }
            );
            req.on("error", reject);
            req.write(`{"id":"x","status":"opened","title":"`);
            req.end(`${"y".repeat(600)}"}`);
        });
        expect(status).toBe(413);
    });
});

describe("queue", () => {
    it("retries a failing handler with backoff, then succeeds", async () => {
        let calls = 0;
        const {base, server, state} = await start({
            maxAttempts: 3,
            handlers: {
                tag_pushed: async () => {
                    calls++;
                    if (calls < 3) throw new Error(`flaky ${calls}`);
                }
            }
        });
        await github(base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "retry"});
        await server.queue.onIdle();
        expect(calls).toBe(3);
        const record = (await events(state))["github:retry:0"];
        expect(record).toMatchObject({status: "done", attempts: 3});
        expect(record).not.toHaveProperty("lastError");
    });

    it("marks an event failed after maxAttempts, keeps serving, and runs it again on redelivery", async () => {
        let calls = 0;
        const {base, server, state, logger} = await start({
            maxAttempts: 2,
            handlers: {
                tag_pushed: async () => {
                    calls++;
                    throw new Error("downstream is down");
                }
            }
        });
        await github(base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "doomed"});
        await server.queue.onIdle();
        expect(calls).toBe(2);
        expect((await events(state))["github:doomed:0"]).toMatchObject({
            status: "failed",
            attempts: 2,
            lastError: "downstream is down"
        });
        expect(logger.lines.some((line) => line.startsWith("error:") && line.includes("failed after 2"))).toBe(true);
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
        const redelivery = await github(base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "doomed"});
        expect(await redelivery.json()).toEqual({accepted: 1, duplicates: 0});
        await server.queue.onIdle();
        expect(calls).toBe(4);
    });

    it("marks events without a handler done", async () => {
        const {base, server, state} = await start({handlers: {}});
        await github(base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "orphan"});
        await server.queue.onIdle();
        expect((await events(state))["github:orphan:0"]).toMatchObject({status: "done", attempts: 1});
    });

    it("runs at most `concurrency` handlers at once", async () => {
        let active = 0;
        let peak = 0;
        const slow = async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active--;
        };
        const {base, server} = await start({concurrency: 2, handlers: {alert: slow}});
        await alert(base, "alertmanager", fixture("alertmanager"));
        await alert(base, "generic", fixture("generic-alert"));
        await alert(base, "generic", JSON.stringify({id: "other", status: "opened", title: "Other"}));
        await server.queue.onIdle();
        expect(peak).toBe(2);
    });

    it("resumes pending and interrupted events after a restart on the same SQLite file", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "aicd-server-")), "state.db");
        const first = await start({
            state: new SqliteStateStore(path),
            retryDelayMs: 60_000,
            handlers: {
                tag_pushed: async () => {
                    throw new Error("not yet");
                }
            }
        });
        await github(first.base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "survivor"});
        await new Promise<void>((resolve) => {
            const wait = () => (first.server.queue.stats.retrying > 0 ? resolve() : setTimeout(wait, 2));
            wait();
        });
        await first.server.close();
        await first.state.putRecord(COLLECTIONS.events, "github:crashed:0", {
            event: {type: "tag_pushed", provider: "github", repository: "acme/shop", tag: "v0.9.0", sha: "abc"},
            status: "processing",
            attempts: 1,
            receivedAt: "2026-10-21T08:00:00.000Z",
            deliveryId: "github:crashed"
        } satisfies EventRecord);
        expect((await events(first.state))["github:survivor:0"]).toMatchObject({status: "pending", attempts: 1});
        await first.state.close();

        const second = await start({state: new SqliteStateStore(path)});
        await second.server.queue.onIdle();
        expect(second.received.map((event) => (event.type === "tag_pushed" ? event.tag : ""))).toEqual([
            "v0.9.0",
            "v1.4.0"
        ]);
        const stored = await events(second.state);
        expect(stored["github:survivor:0"]).toMatchObject({status: "done", attempts: 2});
        expect(stored["github:crashed:0"]).toMatchObject({status: "done", attempts: 2});
        await second.server.close();
        await second.state.close();
    });

    it("prunes finished events past the retention window on start", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.events, "old", {
            event: {type: "tag_pushed", provider: "github", repository: "r", tag: "t", sha: "s"},
            status: "done",
            attempts: 1,
            receivedAt: "2020-01-01T00:00:00.000Z",
            deliveryId: "github:old"
        } satisfies EventRecord);
        await start({state});
        expect(await state.getRecord(COLLECTIONS.events, "old")).toBeUndefined();
    });

    it("finishes running handlers on close", async () => {
        let finished = false;
        const {base, server, state} = await start({
            handlers: {
                tag_pushed: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 30));
                    finished = true;
                }
            }
        });
        await github(base, "push", fixture("github-push-tag"), {"X-GitHub-Delivery": "drain"});
        await new Promise((resolve) => setTimeout(resolve, 5));
        await server.close();
        expect(finished).toBe(true);
        expect((await events(state))["github:drain:0"]).toMatchObject({status: "done"});
    });

    it("answers 503 when the event cannot be stored", async () => {
        const state = new SqliteStateStore(":memory:");
        const failing = Object.assign(Object.create(state) as StateStore, {
            listRecords: state.listRecords.bind(state),
            getRecord: state.getRecord.bind(state),
            putRecord: async () => {
                throw new Error("disk full");
            }
        });
        const {base} = await start({state: failing});
        const response = await github(base, "push", fixture("github-push-tag"));
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
    });
});

describe("API", () => {
    it("requires a valid bearer token", async () => {
        const {base} = await start();
        const anonymous = await fetch(`${base}/api/runs`);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
        expect((await api(base, "/api/runs", "wrong")).status).toBe(403);
        const none = await start({apiTokens: []});
        expect((await api(none.base, "/api/runs")).status).toBe(403);
    });

    it("lists runs, audit entries, quarantine, deployments and incidents", async () => {
        const {base, state} = await start();
        await state.appendAudit({
            runId: "run_1",
            at: "2026-10-21T08:00:00Z",
            agent: "triage",
            kind: "run",
            payload: {ok: true}
        });
        await state.appendAudit({
            runId: "run_2",
            at: "2026-10-21T09:00:00Z",
            agent: "flaky",
            kind: "run",
            payload: null
        });
        await state.putRecord(COLLECTIONS.quarantine, "t1", {
            testId: "t1",
            since: "2026-10-01",
            reason: "flaky",
            flakyScore: 0.4
        });
        await state.putRecord(COLLECTIONS.deployments, "d1", {
            id: "d1",
            environment: "staging",
            startedAt: "x",
            status: "success",
            source: "github"
        });
        await state.putRecord(COLLECTIONS.deployments, "d2", {
            id: "d2",
            environment: "production",
            startedAt: "y",
            status: "failed",
            source: "github"
        });
        await state.putRecord(COLLECTIONS.incidents, "i1", {
            id: "i1",
            title: "down",
            openedAt: "a",
            source: "generic",
            timeline: []
        });
        await state.putRecord(COLLECTIONS.incidents, "i2", {
            id: "i2",
            title: "slow",
            openedAt: "a",
            resolvedAt: "b",
            source: "generic",
            timeline: []
        });

        expect(await (await api(base, "/api/runs")).json()).toEqual({
            runs: [
                {runId: "run_2", at: "2026-10-21T09:00:00Z"},
                {runId: "run_1", at: "2026-10-21T08:00:00Z"}
            ]
        });
        expect(await (await api(base, "/api/runs?limit=1")).json()).toEqual({
            runs: [{runId: "run_2", at: "2026-10-21T09:00:00Z"}]
        });
        expect((await api(base, "/api/runs?limit=0")).status).toBe(400);
        expect(await (await api(base, "/api/runs/run_1")).json()).toMatchObject({
            runId: "run_1",
            entries: [{payload: {ok: true}}]
        });
        expect((await api(base, "/api/runs/missing")).status).toBe(404);
        expect((await api(base, "/api/runs/%E0%A4%A")).status).toBe(400);
        expect(await (await api(base, "/api/quarantine")).json()).toMatchObject({quarantine: [{testId: "t1"}]});
        const production = (await (await api(base, "/api/deployments?environment=production")).json()) as {
            deployments: {id: string}[];
        };
        expect(production.deployments.map((deployment) => deployment.id)).toEqual(["d2"]);
        const all = (await (await api(base, "/api/deployments")).json()) as {deployments: {id: string}[]};
        expect(all.deployments.map((deployment) => deployment.id)).toEqual(["d2", "d1"]);
        const open = (await (await api(base, "/api/incidents?status=open")).json()) as {incidents: {id: string}[]};
        expect(open.incidents.map((incident) => incident.id)).toEqual(["i1"]);
        expect((await api(base, "/api/incidents?status=maybe")).status).toBe(400);
    });

    it("serves DORA metrics through the injected function", async () => {
        const calls: unknown[] = [];
        const {base} = await start({
            api: {
                dora: async (params) => {
                    calls.push(params);
                    return {deploymentFrequency: 1.5};
                }
            }
        });
        expect(await (await api(base, "/api/metrics/dora?environment=production&days=7")).json()).toEqual({
            deploymentFrequency: 1.5
        });
        await api(base, "/api/metrics/dora");
        expect(calls).toEqual([{days: 7, environment: "production"}, {days: 30}]);
        expect((await api(base, "/api/metrics/dora?days=1000")).status).toBe(400);
        const unconfigured = await start();
        expect((await api(unconfigured.base, "/api/metrics/dora")).status).toBe(404);
    });
});

describe("MCP endpoint", () => {
    const post = (base: string, body: string, token = API_TOKEN, type = "application/json") =>
        fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": type,
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${token}`
            },
            body
        });

    it("answers requests with JSON, notifications with 202 and parse errors with JSON-RPC errors", async () => {
        const handled: unknown[] = [];
        const {base} = await start({
            mcp: {
                handle: async (message) => {
                    handled.push(message);
                    const id = (message as {id?: number}).id;
                    if ((message as {method?: string}).method === "boom") throw new Error("secret detail");
                    return id === undefined ? undefined : {jsonrpc: "2.0", id, result: {tools: []}};
                }
            }
        });
        const reply = await post(base, JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"}));
        expect(reply.status).toBe(200);
        expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await reply.json()).toEqual({jsonrpc: "2.0", id: 1, result: {tools: []}});
        const notification = await post(base, JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}));
        expect(notification.status).toBe(202);
        expect(await notification.text()).toBe("");
        const parse = await post(base, "{oops");
        expect(parse.status).toBe(400);
        expect(await parse.json()).toEqual({jsonrpc: "2.0", id: null, error: {code: -32700, message: "Parse error"}});
        const failure = await post(base, JSON.stringify({jsonrpc: "2.0", id: 9, method: "boom"}));
        const failureText = await failure.text();
        expect(failureText).not.toContain("secret detail");
        expect(JSON.parse(failureText)).toEqual({
            jsonrpc: "2.0",
            id: 9,
            error: {code: -32603, message: "Internal error"}
        });
        expect((await post(base, "{}", "wrong")).status).toBe(403);
        expect((await post(base, "{}", API_TOKEN, "text/plain")).status).toBe(415);
        expect(handled).toHaveLength(3);
    });

    it("answers 404 when MCP is not configured", async () => {
        const {base} = await start();
        expect((await post(base, "{}")).status).toBe(404);
    });
});
