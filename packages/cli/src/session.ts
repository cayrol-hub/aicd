import {copyFileSync, existsSync, mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PostgresStateStore} from "@aicd-ci/adapter-state-postgres";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    Auditor,
    autonomyFor,
    ConfigError,
    loadPlugins,
    newRunId,
    RunBudget,
    type AgentName,
    type AicdConfig,
    type ComponentRegistry,
    type Policies
} from "@aicd-ci/core";
import type {
    AgentRuntime,
    Autonomy,
    CIProvider,
    CIProviderFactory,
    Deployer,
    FactoryContext,
    IssueTracker,
    LLMProvider,
    Logger,
    MetricsSource,
    Notifier,
    PipelineContext,
    StateStore
} from "@aicd-ci/plugin-sdk";
import {builtInRegistry} from "./registry.js";
import {makeLogger, makeRedactor, resolveConfig, type GlobalOptions} from "./shared.js";

export interface SessionOptions extends GlobalOptions {
    /** CI adapter name, or "auto". */
    ci?: string;
    logFiles?: string[];
    diffFile?: string;
    /** Overrides `state.path` (SQLite). */
    statePath?: string;
    cwd?: string;
    /** Server mode: an adapter built from a webhook. */
    ciProvider?: CIProvider;
    /** Do not create an LLM provider (commands that never need one). */
    noLlm?: boolean;
    /** Environment variables (default `process.env`). */
    processEnv?: NodeJS.ProcessEnv;
    /** Server mode shares one state store between sessions; the session will not close it. */
    sharedState?: StateStore;
    /** Read-only commands (explain, doctor, dora…) leave no run in the audit log. */
    readOnly?: boolean;
    /** Where the repository's files are (git, CODEOWNERS, reports). Default: `cwd`. The server uses an empty one. */
    workspace?: string;
    /** Dry run: a SQLite state is copied first, so nothing persists. */
    dryRun?: boolean;
}

/** Strips the keys aicd itself uses from an integration before handing it to the adapter. */
function adapterConfig(integration: Record<string, unknown>): Record<string, unknown> {
    const {type: _type, on: _on, ...rest} = integration;
    return rest;
}

/** Sends a notification only when its severity is listed in the notifier's `on` (all when absent). */
function filtered(notifier: Notifier, on?: string[]): Notifier {
    if (!on?.length) return notifier;
    return {
        name: notifier.name,
        send: async (notification) => (on.includes(notification.severity) ? notifier.send(notification) : undefined)
    };
}

/** The session's state; in dry run, a copy of the SQLite file so that nothing persists. */
async function openSessionState(
    config: AicdConfig,
    registry: ComponentRegistry,
    context: FactoryContext,
    options: SessionOptions
): Promise<StateStore> {
    if (!options.dryRun) return openStateStore(config, registry, context, options.statePath);
    if (config.state.backend !== "sqlite") {
        context.logger.warn(
            `dry run: the ${config.state.backend} state is not copied, agents' bookkeeping is still written`
        );
        return openStateStore(config, registry, context, options.statePath);
    }
    const path = options.statePath ?? config.state.path;
    if (path === ":memory:" || !existsSync(path)) return new SqliteStateStore(":memory:");
    const copy = join(mkdtempSync(join(tmpdir(), "aicd-dry-run-")), "state.db");
    for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
    return new SqliteStateStore(copy);
}

export async function openStateStore(
    config: AicdConfig,
    registry: ComponentRegistry,
    context: FactoryContext,
    statePath?: string
): Promise<StateStore> {
    const {backend} = config.state;
    if (backend === "sqlite") return new SqliteStateStore(statePath ?? config.state.path);
    if (backend === "postgres") {
        const connectionString = context.env[config.state.url_env];
        if (!connectionString)
            throw new ConfigError(`state.backend is postgres but ${config.state.url_env} is not set`);
        return PostgresStateStore.connect({connectionString, logger: context.logger});
    }
    return registry.create("state", backend, {...config.state}, context);
}

/**
 * Everything a command needs, resolved once: configuration and policies, plugins, state, CI adapter,
 * pipeline context, LLM, redaction, budget and audit. Fork safety is applied here: no LLM, observe only.
 */
export class Session {
    readonly runId = newRunId();
    readonly budget: RunBudget;
    readonly audit: Auditor;
    readonly redact: (text: string) => string;
    #trackers: IssueTracker[] | undefined;
    #notifiers: Notifier[] | undefined;
    #deployer: Deployer | null | undefined;
    #sources: Record<string, MetricsSource> | undefined;

    private constructor(
        readonly config: AicdConfig,
        readonly policies: Policies,
        readonly warnings: string[],
        readonly configFile: string | undefined,
        readonly logger: Logger,
        readonly registry: ComponentRegistry,
        readonly factoryContext: FactoryContext,
        readonly state: StateStore,
        readonly ci: CIProvider,
        readonly context: PipelineContext,
        readonly llm: LLMProvider | undefined,
        readonly cwd: string,
        private readonly ownsState: boolean
    ) {
        this.budget = new RunBudget(config.llm.budget_per_run_usd);
        this.redact = makeRedactor(config, factoryContext.env);
        this.audit = new Auditor(state, this.runId, config.audit.jsonl, this.redact, (error) =>
            this.logger.warn(`audit entry not written: ${error.message}`)
        );
    }

    /** Throws ConfigError on invalid configuration, plugins or integrations. */
    static async open(options: SessionOptions): Promise<Session> {
        const env = options.processEnv ?? process.env;
        const cwd = options.cwd ?? process.cwd();
        const workspace = options.workspace ?? cwd;
        const logger = makeLogger(options);
        let resolved = await resolveConfig({...options}, env, cwd);
        const registry = builtInRegistry();
        const factoryContext: FactoryContext = {env, fetch, logger};

        // A plugin may provide the CI adapter: then plugins load first (the operator asked for it explicitly).
        // Otherwise the pipeline context comes first, so that code from a fork never loads a plugin.
        const requested = options.ci && options.ci !== "auto" ? options.ci : undefined;
        const pluginCi = requested !== undefined && !registry.ci.some((factory) => factory.name === requested);
        if (pluginCi && resolved.config.plugins.length > 0) {
            await loadPlugins(resolved.config.plugins, registry, {cwd, logger});
        }
        const ci =
            options.ciProvider ??
            pickProvider(options.ci, env, registry.ci).create({
                env,
                cwd: workspace,
                ...(options.logFiles ? {logFiles: options.logFiles} : {}),
                ...(options.diffFile ? {diffFile: options.diffFile} : {})
            });
        const context = await ci.getContext();
        if (context.isFork) {
            // The fork controls the repository's .aicd.yaml: its security, plugins and extends keys are ignored.
            resolved = await resolveConfig({...options}, env, cwd, true);
            logger.warn("code from a fork: .aicd.yaml security, plugins and extends ignored; no plugin loaded");
        } else if (!pluginCi && resolved.config.plugins.length > 0) {
            await loadPlugins(resolved.config.plugins, registry, {cwd, logger});
        }
        resolved.warnings.forEach((warning) => logger.warn(warning));
        const {config} = resolved;
        const state = options.sharedState ?? (await openSessionState(config, registry, factoryContext, options));

        let llm: LLMProvider | undefined;
        if (options.noLlm || config.llm.provider === "none") {
            llm = undefined;
        } else if (context.isFork && !config.security.allow_forks) {
            logger.warn("code from a fork: no LLM call and no action (security.allow_forks is false)");
        } else {
            try {
                llm = registry.create("llm", config.llm.provider, {...config.llm}, factoryContext);
            } catch (error) {
                if (error instanceof ConfigError) throw error;
                logger.warn(
                    `LLM ${config.llm.provider} unavailable, running with rules only: ${(error as Error).message}`
                );
            }
        }
        const session = new Session(
            config,
            resolved.policies,
            resolved.warnings,
            resolved.file,
            logger,
            registry,
            factoryContext,
            state,
            ci,
            context,
            llm,
            workspace,
            !options.sharedState
        );
        if (!options.readOnly)
            session.audit.record("aicd", "run", {
                provider: ci.name,
                context,
                llm: llm ? `${llm.name}/${llm.model}` : "none",
                configFile: resolved.file,
                warnings: resolved.warnings
            });
        return session;
    }

    get forkLocked(): boolean {
        return this.context.isFork && !this.config.security.allow_forks;
    }

    /** Autonomy of an agent, per environment when it has one; observe for code from forks. */
    autonomy(agent: AgentName, environment?: string): Autonomy {
        if (this.forkLocked) return "observe";
        const value = (this.config.agents[agent] as {autonomy?: Autonomy | Record<string, Autonomy>}).autonomy;
        return value === undefined ? "advise" : autonomyFor(value, environment);
    }

    runtime(agent: string): AgentRuntime {
        return {
            runId: this.runId,
            // `security.allow_forks` (never from a fork's own file) lets agents treat fork code like any other.
            context:
                this.context.isFork && this.config.security.allow_forks
                    ? {...this.context, isFork: false}
                    : this.context,
            state: this.state,
            ...(this.llm ? {llm: this.llm} : {}),
            budget: this.budget,
            logger: this.logger,
            redact: this.redact,
            language: this.config.comment.language,
            sendCode: this.config.privacy.send_code,
            now: () => new Date(),
            onLlmCall: (event) => this.audit.record(event.agent || agent, "llm_call", event)
        };
    }

    trackers(): IssueTracker[] {
        this.#trackers ??= this.config.integrations.trackers.map((integration) =>
            this.registry.create("trackers", integration.type, adapterConfig(integration), this.factoryContext)
        );
        return this.#trackers;
    }

    notifiers(): Notifier[] {
        this.#notifiers ??= this.config.integrations.notifiers.map((integration) =>
            filtered(
                this.registry.create("notifiers", integration.type, adapterConfig(integration), this.factoryContext),
                integration.on
            )
        );
        return this.#notifiers;
    }

    deployer(): Deployer | undefined {
        if (this.#deployer === undefined) {
            const integration = this.config.integrations.deployer;
            this.#deployer = integration
                ? this.registry.create("deployers", integration.type, adapterConfig(integration), this.factoryContext)
                : null;
        }
        return this.#deployer ?? undefined;
    }

    metricsSources(): Record<string, MetricsSource> {
        this.#sources ??= Object.fromEntries(
            Object.entries(this.config.integrations.metrics_sources).map(([name, integration]) => [
                name,
                this.registry.create("metrics", integration.type, adapterConfig(integration), this.factoryContext)
            ])
        );
        return this.#sources;
    }

    async close(): Promise<void> {
        await this.audit.flush();
        if (this.ownsState) await this.state.close();
    }
}

export function pickProvider(
    name: string | undefined,
    env: NodeJS.ProcessEnv,
    providers: CIProviderFactory[]
): CIProviderFactory {
    if (name && name !== "auto") {
        const provider = providers.find((candidate) => candidate.name === name);
        if (!provider) {
            throw new ConfigError(`unknown --ci "${name}" (expected auto, ${providers.map((p) => p.name).join(", ")})`);
        }
        return provider;
    }
    return (
        providers.find((candidate) => candidate.name !== "local" && candidate.detect(env)) ??
        (providers.find((candidate) => candidate.name === "local") as CIProviderFactory)
    );
}
