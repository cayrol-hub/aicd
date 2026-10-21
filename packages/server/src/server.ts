import {createHash} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {
    COLLECTIONS,
    type DeploymentRecord,
    type IncidentRecord,
    type Logger,
    type QuarantineRecord,
    type StateStore
} from "@aicd/plugin-sdk";
import {ALERT_SOURCES, normalizeAlert} from "./alerts.js";
import {bearerToken, matchesAnyToken, safeEqual, verifyGitHubSignature, verifyHmacSha256} from "./auth.js";
import {PayloadError, type AicdEvent, type AlertSource, type EventHandlers} from "./events.js";
import {normalizeGitHub} from "./github.js";
import {normalizeGitLab} from "./gitlab.js";
import {header, HttpError, parseJson, readBody, requireJson, sendError, sendJson} from "./http.js";
import {obj} from "./json.js";
import {EventQueue} from "./queue.js";

export interface DoraParams {
    environment?: string;
    /** Window in days, 1 to 365. Default 30. */
    days: number;
}

export interface McpEndpoint {
    /** Handles one JSON-RPC message; `undefined` for a notification or a response (answered 202). */
    handle(message: unknown): Promise<object | undefined>;
}

export interface AicdServerOptions {
    state: StateStore;
    logger: Logger;
    /** Bearer tokens accepted on `/api/*` and `/mcp`. Empty: both refuse every call. */
    apiTokens: string[];
    webhooks: {
        /** Secret of the GitHub webhook (`X-Hub-Signature-256`). Unset: `/webhooks/github` answers 404. */
        githubSecret?: string;
        /** Secret token of the GitLab webhook (`X-Gitlab-Token`). Unset: `/webhooks/gitlab` answers 404. */
        gitlabToken?: string;
        /** Token of `/webhooks/alerts/:source`, in `Authorization: Bearer` or `X-Aicd-Token`. */
        alertsToken?: string;
        /** Client secret of a Sentry integration: Sentry cannot send custom headers, it signs (`Sentry-Hook-Signature`). */
        sentryClientSecret?: string;
    };
    handlers: EventHandlers;
    /** Injected so that the server stays generic (DORA lives in `@aicd/metrics`). */
    api?: {dora?(params: DoraParams): Promise<unknown>};
    mcp?: McpEndpoint;
    /** Default 2. */
    concurrency?: number;
    /** Default 3. */
    maxAttempts?: number;
    /** Default 1000, doubled on each retry. */
    retryDelayMs?: number;
    /** Default 1 MiB. */
    bodyLimitBytes?: number;
    now?: () => Date;
}

export interface AicdServer {
    /** Resumes the queue, then listens. Port 0 picks a free port, returned. */
    listen(port: number, host?: string): Promise<{port: number}>;
    /** Stops accepting connections, finishes running requests and handlers. Queued events stay in the state store. */
    close(): Promise<void>;
    readonly queue: EventQueue;
}

interface Context {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    params: string[];
}

type Handler = (context: Context) => Promise<void>;

interface Route {
    pattern: RegExp;
    methods: Partial<Record<"GET" | "POST", Handler>>;
}

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_LIST_LIMIT = 1000;

function sha256(body: Uint8Array): string {
    return createHash("sha256").update(body).digest("hex");
}

/** Integer query parameter within bounds, or 400. */
function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, "invalid_parameter", `${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function stringParam(url: URL, name: string): string | undefined {
    return url.searchParams.get(name) || undefined;
}

/**
 * aicd's server mode on `node:http`: authenticated webhooks (GitHub, GitLab, alerts) normalized into `AicdEvent`s
 * and processed by a durable queue, a read-only JSON API and the MCP endpoint (streamable HTTP, JSON responses).
 */
export function createAicdServer(options: AicdServerOptions): AicdServer {
    const {state, logger, webhooks} = options;
    const now = options.now ?? (() => new Date());
    const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
    const queue = new EventQueue({
        state,
        logger,
        handlers: options.handlers,
        ...(options.concurrency !== undefined ? {concurrency: options.concurrency} : {}),
        ...(options.maxAttempts !== undefined ? {maxAttempts: options.maxAttempts} : {}),
        ...(options.retryDelayMs !== undefined ? {retryDelayMs: options.retryDelayMs} : {}),
        now
    });
    let closing = false;

    const requireApiToken = (req: IncomingMessage): void => {
        const token = bearerToken(header(req, "authorization"));
        if (!token) {
            throw new HttpError(401, "unauthorized", "bearer token required", {
                "WWW-Authenticate": 'Bearer realm="aicd"'
            });
        }
        if (!matchesAnyToken(token, options.apiTokens)) throw new HttpError(403, "forbidden", "invalid token");
    };

    const accept = async (res: ServerResponse, deliveryKey: string, events: AicdEvent[]): Promise<void> => {
        if (events.length === 0) {
            sendJson(res, 202, {accepted: 0, duplicates: 0, ignored: true});
            return;
        }
        let result;
        try {
            result = await queue.enqueue(deliveryKey, events);
        } catch (error) {
            logger.error(
                `server: cannot queue ${deliveryKey}: ${error instanceof Error ? error.message : String(error)}`
            );
            throw new HttpError(503, "unavailable", "cannot queue the event, retry later", {"Retry-After": "5"});
        }
        logger.debug(`server: ${deliveryKey}: ${result.accepted} event(s) queued, ${result.duplicates} duplicate(s)`);
        sendJson(res, 202, result);
    };

    const github: Handler = async ({req, res}) => {
        if (!webhooks.githubSecret) throw new HttpError(404, "not_configured", "GitHub webhook is not configured");
        const signature = header(req, "x-hub-signature-256");
        if (!signature) throw new HttpError(401, "unauthorized", "X-Hub-Signature-256 required");
        requireJson(req);
        const body = await readBody(req, bodyLimit);
        if (!verifyGitHubSignature(webhooks.githubSecret, body, signature)) {
            throw new HttpError(403, "forbidden", "invalid signature");
        }
        const eventName = header(req, "x-github-event");
        if (!eventName) throw new HttpError(400, "invalid_request", "X-GitHub-Event required");
        const events = normalizeGitHub(eventName, parseJson(body), now());
        await accept(res, `github:${header(req, "x-github-delivery") ?? sha256(body)}`, events);
    };

    const gitlab: Handler = async ({req, res}) => {
        if (!webhooks.gitlabToken) throw new HttpError(404, "not_configured", "GitLab webhook is not configured");
        const token = header(req, "x-gitlab-token");
        if (!token) throw new HttpError(401, "unauthorized", "X-Gitlab-Token required");
        if (!safeEqual(token, webhooks.gitlabToken)) throw new HttpError(403, "forbidden", "invalid token");
        requireJson(req);
        const body = await readBody(req, bodyLimit);
        const eventName = header(req, "x-gitlab-event");
        if (!eventName) throw new HttpError(400, "invalid_request", "X-Gitlab-Event required");
        const events = normalizeGitLab(eventName, parseJson(body), now());
        await accept(res, `gitlab:${header(req, "x-gitlab-event-uuid") ?? sha256(body)}`, events);
    };

    const alerts: Handler = async ({req, res, params}) => {
        const source = params[0] as AlertSource;
        if (!ALERT_SOURCES.includes(source)) throw new HttpError(404, "not_found", "unknown alert source");
        const sentrySignature =
            source === "sentry" && webhooks.sentryClientSecret ? header(req, "sentry-hook-signature") : undefined;
        if (!webhooks.alertsToken && !(source === "sentry" && webhooks.sentryClientSecret)) {
            throw new HttpError(404, "not_configured", "alert webhooks are not configured");
        }
        const token = bearerToken(header(req, "authorization")) ?? header(req, "x-aicd-token");
        if (token) {
            if (!webhooks.alertsToken || !safeEqual(token, webhooks.alertsToken)) {
                throw new HttpError(403, "forbidden", "invalid token");
            }
        } else if (!sentrySignature) {
            throw new HttpError(401, "unauthorized", "token required", {"WWW-Authenticate": 'Bearer realm="aicd"'});
        }
        requireJson(req);
        const body = await readBody(req, bodyLimit);
        if (!token && !verifyHmacSha256(webhooks.sentryClientSecret ?? "", body, sentrySignature ?? "")) {
            throw new HttpError(403, "forbidden", "invalid signature");
        }
        let events;
        try {
            events = normalizeAlert(source, parseJson(body), now());
        } catch (error) {
            if (error instanceof PayloadError) throw new HttpError(400, "invalid_payload", error.message);
            throw error;
        }
        await accept(res, `alerts:${source}:${sha256(body)}`, events);
    };

    const api =
        (body: (context: Context) => Promise<unknown>): Handler =>
        async (context) => {
            requireApiToken(context.req);
            sendJson(context.res, 200, await body(context));
        };

    const filtered = async <T extends {environment?: string}>(collection: string, url: URL): Promise<T[]> => {
        const limit = intParam(url, "limit", 100, 1, MAX_LIST_LIMIT);
        const environment = stringParam(url, "environment");
        const records = await state.listRecords<T>(collection);
        return records
            .map((record) => record.value)
            .filter((value) => !environment || value.environment === environment)
            .slice(0, limit);
    };

    const mcp: Handler = async ({req, res}) => {
        requireApiToken(req);
        const endpoint = options.mcp;
        if (!endpoint) throw new HttpError(404, "not_configured", "MCP is not configured");
        requireJson(req);
        const body = await readBody(req, bodyLimit);
        let message: unknown;
        try {
            message = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
            sendJson(res, 400, {jsonrpc: "2.0", id: null, error: {code: -32700, message: "Parse error"}});
            return;
        }
        const handleOne = async (one: unknown): Promise<object | undefined> => {
            try {
                return await endpoint.handle(one);
            } catch (error) {
                logger.error(`server: MCP handler failed: ${error instanceof Error ? error.message : String(error)}`);
                const id = obj(one)?.id;
                return {jsonrpc: "2.0", id: id ?? null, error: {code: -32603, message: "Internal error"}};
            }
        };
        if (Array.isArray(message)) {
            const replies: object[] = [];
            for (const one of message) {
                const reply = await handleOne(one);
                if (reply) replies.push(reply);
            }
            if (replies.length === 0) sendJson(res, 202, undefined);
            else sendJson(res, 200, replies);
            return;
        }
        const reply = await handleOne(message);
        if (reply) sendJson(res, 200, reply);
        else sendJson(res, 202, undefined);
    };

    const routes: Route[] = [
        {pattern: /^\/healthz$/, methods: {GET: async ({res}) => sendJson(res, 200, {status: "ok"})}},
        {
            pattern: /^\/readyz$/,
            methods: {
                GET: async ({res}) => {
                    if (closing) throw new HttpError(503, "unavailable", "shutting down");
                    try {
                        // A primary-key lookup: cheap on every store, unlike listing runs.
                        await state.getRecord(COLLECTIONS.events, "readyz-probe");
                    } catch {
                        throw new HttpError(503, "unavailable", "state store unreachable");
                    }
                    sendJson(res, 200, {status: "ready", queue: queue.stats});
                }
            }
        },
        {pattern: /^\/webhooks\/github$/, methods: {POST: github}},
        {pattern: /^\/webhooks\/gitlab$/, methods: {POST: gitlab}},
        {pattern: /^\/webhooks\/alerts\/([^/]+)$/, methods: {POST: alerts}},
        {
            pattern: /^\/api\/runs$/,
            methods: {
                GET: api(async ({url}) => ({runs: await state.listRuns(intParam(url, "limit", 50, 1, MAX_LIST_LIMIT))}))
            }
        },
        {
            pattern: /^\/api\/runs\/([^/]+)$/,
            methods: {
                GET: api(async ({params}) => {
                    const runId = params[0] ?? "";
                    const entries = await state.listAudit(runId);
                    if (entries.length === 0) throw new HttpError(404, "not_found", "run not found");
                    return {runId, entries};
                })
            }
        },
        {
            pattern: /^\/api\/quarantine$/,
            methods: {
                GET: api(async () => ({
                    quarantine: (await state.listRecords<QuarantineRecord>(COLLECTIONS.quarantine)).map(
                        (record) => record.value
                    )
                }))
            }
        },
        {
            pattern: /^\/api\/deployments$/,
            methods: {
                GET: api(async ({url}) => ({
                    deployments: await filtered<DeploymentRecord>(COLLECTIONS.deployments, url)
                }))
            }
        },
        {
            pattern: /^\/api\/incidents$/,
            methods: {
                GET: api(async ({url}) => {
                    const status = stringParam(url, "status");
                    if (status && status !== "open" && status !== "resolved") {
                        throw new HttpError(400, "invalid_parameter", "status must be open or resolved");
                    }
                    const incidents = await filtered<IncidentRecord>(COLLECTIONS.incidents, url);
                    return {
                        incidents: status
                            ? incidents.filter((incident) => (status === "open") === !incident.resolvedAt)
                            : incidents
                    };
                })
            }
        },
        {
            pattern: /^\/api\/metrics\/dora$/,
            methods: {
                GET: api(async ({url}) => {
                    const dora = options.api?.dora;
                    if (!dora) throw new HttpError(404, "not_configured", "DORA metrics are not configured");
                    const environment = stringParam(url, "environment");
                    return dora({days: intParam(url, "days", 30, 1, 365), ...(environment ? {environment} : {})});
                })
            }
        },
        {pattern: /^\/mcp$/, methods: {POST: mcp}}
    ];

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? "/", "http://aicd.invalid");
        let params: string[] = [];
        const route = routes.find((candidate) => {
            let path = url.pathname;
            if (path.length > 1) path = path.replace(/\/+$/, "");
            const match = candidate.pattern.exec(path);
            if (match) params = match.slice(1);
            return match !== null;
        });
        try {
            if (!route) throw new HttpError(404, "not_found", "no such route");
            const method = req.method === "GET" || req.method === "POST" ? req.method : undefined;
            const handler = method ? route.methods[method] : undefined;
            if (!handler) {
                throw new HttpError(405, "method_not_allowed", "method not allowed", {
                    Allow: Object.keys(route.methods).join(", ")
                });
            }
            try {
                params = params.map((param) => decodeURIComponent(param));
            } catch {
                throw new HttpError(400, "invalid_request", "malformed URL");
            }
            await handler({req, res, url, params});
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (error instanceof HttpError) {
                sendError(res, error);
                return;
            }
            logger.error(
                `server: ${req.method ?? "?"} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`
            );
            sendError(res, new HttpError(500, "internal_error", "internal error"));
        }
    };

    const server = createServer((req, res) => {
        void handle(req, res);
    });

    return {
        queue,
        async listen(port, host) {
            await queue.start();
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, host, () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            const address = server.address() as AddressInfo;
            logger.info(`server: listening on ${host ?? "*"}:${address.port}`);
            return {port: address.port};
        },
        async close() {
            closing = true;
            if (server.listening) {
                const closed = new Promise<void>((resolve) => server.close(() => resolve()));
                server.closeIdleConnections();
                await closed;
            }
            await queue.close();
        }
    };
}
