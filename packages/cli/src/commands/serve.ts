import {GitHubCIProvider} from "@aicd/adapter-ci-github";
import {GitLabCIProvider} from "@aicd/adapter-ci-gitlab";
import {createMcpServer} from "@aicd/mcp";
import {computeDora} from "@aicd/metrics";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GUARD_RESULTS_COLLECTION} from "@aicd/agent-release-guardian";
import {
    COLLECTIONS,
    type CIProvider,
    type DeploymentRecord,
    type IncidentRecord,
    type StateStore
} from "@aicd/plugin-sdk";
import {createAicdServer, type AicdEvent, type EventHandlers} from "@aicd/server";
import {EXIT, makeLogger, resolveConfig, VERSION, type GlobalOptions} from "../shared.js";
import {builtInRegistry} from "../registry.js";
import {openStateStore, Session} from "../session.js";
import {runAnalyze} from "./analyze.js";
import {guard, recordDeploymentFrom} from "./deploy.js";
import {correlate, postmortem, recordIncidentFrom} from "./incident.js";
import {runReview} from "./review.js";

type ForgeEvent = Extract<AicdEvent, {provider: "github" | "gitlab"}>;

/** The forge adapters cannot tell a fork from a webhook alone: the event's verdict wins. */
function withFork(ci: CIProvider, fork: boolean): CIProvider {
    if (!fork) return ci;
    return new Proxy(ci, {
        get(target, property, receiver) {
            if (property === "getContext") return async () => ({...(await target.getContext()), isFork: true});
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
    });
}

/**
 * Builds the CI adapter a webhook refers to, with the server's own credentials
 * (`AICD_GITHUB_TOKEN`, `AICD_GITLAB_TOKEN`) — never with anything taken from the payload.
 */
export function ciFromEvent(event: ForgeEvent, env: NodeJS.ProcessEnv): CIProvider {
    const fork = "fork" in event && event.fork;
    return withFork(forgeAdapter(event, env), fork);
}

function forgeAdapter(event: ForgeEvent, env: NodeJS.ProcessEnv): CIProvider {
    const sha = "sha" in event ? event.sha : undefined;
    if (event.provider === "github") {
        const mr = event.type === "merge_request_updated" ? event : undefined;
        const number = mr?.id ?? (event.type === "pipeline_completed" ? event.mergeRequestId : undefined);
        return new GitHubCIProvider({
            env: {
                GITHUB_ACTIONS: "true",
                GITHUB_REPOSITORY: event.repository,
                ...(env.AICD_GITHUB_API_URL ? {GITHUB_API_URL: env.AICD_GITHUB_API_URL} : {}),
                ...(env.AICD_GITHUB_TOKEN ? {GITHUB_TOKEN: env.AICD_GITHUB_TOKEN} : {}),
                ...(event.type === "pipeline_completed" ? {GITHUB_RUN_ID: event.pipelineId} : {}),
                ...(sha ? {GITHUB_SHA: sha} : {})
            },
            ...(number
                ? {
                      event: {
                          pull_request: {
                              number: Number(number),
                              html_url: mr?.url ?? "",
                              title: mr?.title ?? "",
                              body: mr?.description ?? null,
                              head: {
                                  ref: mr?.sourceBranch ?? "",
                                  sha: sha ?? "",
                                  repo: {full_name: event.repository, fork: false}
                              },
                              base: {ref: mr?.targetBranch ?? "", sha: "", repo: {full_name: event.repository}}
                          }
                      }
                  }
                : {})
        });
    }
    const mr = event.type === "merge_request_updated" ? event : undefined;
    const iid = mr?.id ?? (event.type === "pipeline_completed" ? event.mergeRequestId : undefined);
    return new GitLabCIProvider({
        env: {
            GITLAB_CI: "true",
            CI_API_V4_URL: env.AICD_GITLAB_API_URL ?? "https://gitlab.com/api/v4",
            CI_PROJECT_ID: event.repository,
            CI_PROJECT_PATH: event.repository,
            ...(env.AICD_GITLAB_TOKEN ? {AICD_GITLAB_TOKEN: env.AICD_GITLAB_TOKEN} : {}),
            ...(event.type === "pipeline_completed" ? {CI_PIPELINE_ID: event.pipelineId} : {}),
            ...(sha ? {CI_COMMIT_SHA: sha} : {}),
            ...(iid ? {CI_MERGE_REQUEST_IID: iid} : {}),
            ...(mr
                ? {
                      CI_MERGE_REQUEST_TITLE: mr.title,
                      CI_MERGE_REQUEST_DESCRIPTION: mr.description,
                      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: mr.sourceBranch,
                      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: mr.targetBranch
                  }
                : {})
        }
    });
}

/**
 * Event handlers: the same flows as the pipeline commands, on sessions sharing the server's state. Sessions get
 * an empty workspace: the server has no checkout of the repositories it serves, and must not read its own files.
 * Delivery is at-least-once, so every handler is idempotent.
 */
export function serverHandlers(
    options: GlobalOptions,
    state: StateStore,
    env: NodeJS.ProcessEnv,
    background: Set<Promise<unknown>> = new Set()
): EventHandlers {
    const workspace = mkdtempSync(join(tmpdir(), "aicd-server-"));
    const open = (extra: {ciProvider?: CIProvider} = {}) =>
        Session.open({...options, ...extra, sharedState: state, processEnv: env, ci: "local", workspace});
    const within = async (session: Session, body: () => Promise<unknown>) => {
        try {
            await body();
        } finally {
            await session.close();
        }
    };
    return {
        pipeline_completed: async (event) => {
            if (event.status !== "failed") return;
            const session = await open({ciProvider: ciFromEvent(event, env)});
            await within(session, () => runAnalyze(session, {remote: true}));
        },
        merge_request_updated: async (event) => {
            const session = await open({ciProvider: ciFromEvent(event, env)});
            await within(session, () => runReview(session));
        },
        deployment: async (event) => {
            const existing = (await state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, event.id))?.value;
            const session = await open();
            let record: DeploymentRecord | undefined;
            await within(session, async () => {
                record = await recordDeploymentFrom(state, {
                    id: event.id,
                    env: event.environment,
                    status: event.status,
                    startedAt: event.startedAt,
                    ...(event.sha ? {sha: event.sha} : {}),
                    ...(event.url ? {url: event.url} : {}),
                    cwd: session.cwd,
                    source: event.provider
                });
            });
            // Guard once per deployment, and never again once aicd paused or rolled it back.
            const guarded = await state.getRecord(GUARD_RESULTS_COLLECTION, event.id);
            if (
                event.status !== "success" ||
                !record ||
                guarded ||
                existing?.status === "rolled_back" ||
                existing?.status === "paused"
            ) {
                return;
            }
            // The guard waits for its observation window: it runs beside the queue so that it does not hold a worker.
            const deployment = record;
            const task = (async () => {
                const guardSession = await open();
                await within(guardSession, () => guard(guardSession, deployment));
            })().catch((error: Error) => guardFailed(options, error));
            background.add(task);
            void task.finally(() => background.delete(task));
        },
        tag_pushed: async (event) => {
            const session = await open();
            await within(session, async () =>
                session.logger.info(
                    `tag ${event.tag} on ${event.repository}: run \`aicd release-notes\` in the tag pipeline (it needs the repository)`
                )
            );
        },
        alert: async (event) => {
            const id = `${event.source}:${event.id}`;
            const existing = (await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, id))?.value;
            const session = await open();
            await within(session, async () => {
                await recordIncidentFrom(state, {
                    id,
                    title: event.title,
                    severity: event.severity,
                    source: event.source,
                    ...(event.environment ? {env: event.environment} : {}),
                    ...(event.url ? {url: event.url} : {}),
                    ...(event.status === "opened" ? {openedAt: event.at} : {resolvedAt: event.at})
                });
                // A re-sent alert (Alertmanager repeats firing alerts) must not open a second issue.
                if (event.status === "opened" && !existing) await correlate(session, id);
                if (event.status === "resolved" && !existing?.resolvedAt) await postmortem(session, id);
            });
        }
    };
}

function guardFailed(options: GlobalOptions, error: Error): void {
    makeLogger(options).error(`release guardian failed: ${error.message}`);
}

/** `aicd serve`: the server mode. Webhooks in, the same agents, a durable queue, an HTTP API and MCP. */
export async function serve(options: GlobalOptions & {port?: string; host?: string}): Promise<number> {
    const env = process.env;
    const logger = makeLogger(options);
    const {config} = await resolveConfig(options, env);
    const state = await openStateStore(config, builtInRegistry(), {env, fetch, logger});
    const secret = (name: string) => env[name] || undefined;
    const apiTokens = (env[config.server.api_tokens_env] ?? "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
    if (apiTokens.length === 0)
        logger.warn(`${config.server.api_tokens_env} is empty: /api and /mcp refuse every call`);

    const background = new Set<Promise<unknown>>();
    const server = createAicdServer({
        state,
        logger,
        apiTokens,
        webhooks: {
            ...(secret(config.server.github_secret_env) ? {githubSecret: secret(config.server.github_secret_env)} : {}),
            ...(secret(config.server.gitlab_token_env) ? {gitlabToken: secret(config.server.gitlab_token_env)} : {}),
            ...(secret(config.server.alerts_token_env) ? {alertsToken: secret(config.server.alerts_token_env)} : {}),
            ...(secret(config.server.sentry_client_secret_env)
                ? {sentryClientSecret: secret(config.server.sentry_client_secret_env)}
                : {})
        },
        handlers: serverHandlers(options, state, env, background),
        api: {
            dora: async ({environment, days}) => {
                const end = new Date();
                return computeDora(state, {
                    environment: environment ?? "production",
                    start: new Date(end.getTime() - days * 86_400_000),
                    end
                });
            }
        },
        mcp: createMcpServer({state, version: VERSION, logger}),
        concurrency: config.server.concurrency
    });
    const port = options.port !== undefined ? Number(options.port) : config.server.port;
    const {port: bound} = await server.listen(port, options.host ?? config.server.host);
    logger.info(`aicd ${VERSION} serving on ${options.host ?? config.server.host}:${bound}`);

    await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
    });
    logger.info("shutting down: finishing running handlers and release guards");
    await server.close();
    await Promise.allSettled([...background]);
    await state.close();
    return EXIT.ok;
}
