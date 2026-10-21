import {existsSync, readFileSync} from "node:fs";
import {dirname, isAbsolute, resolve} from "node:path";
import {parse as parseYaml} from "yaml";
import {z} from "zod";
import {minAutonomy, type Autonomy} from "@aicd/plugin-sdk";

const autonomy = z.enum(["observe", "advise", "propose", "act"]);
const sendCode = z.enum(["none", "diff_only", "full"]);
const redactRule = z.enum(["secrets", "emails", "ip_addresses", "high_entropy"]);
const confidence = z.enum(["low", "medium", "high"]);
const severity = z.enum(["critical", "high", "medium", "low", "note"]);
const globs = (defaults: string[] = []) => z.array(z.string()).default(defaults);
// `prefault({})` parses the empty object, so nested defaults apply when a section is omitted.
const strict = <T extends z.ZodRawShape>(shape: T) =>
    z
        .object(shape)
        .strict()
        .prefault({} as never);

/** Autonomy of an agent that acts on environments: one level, or one per environment (`default` as fallback). */
const environmentAutonomy = z.union([autonomy, z.record(z.string(), autonomy)]);

/** An integration: its `type` picks the adapter (built-in or plugin), other keys are the adapter's options. */
const integration = z.object({type: z.string().min(1)}).catchall(z.unknown());

/** `.aicd.yaml` of a repository. Every field is optional: an empty file is a valid configuration. */
export const ConfigSchema = z
    .object({
        extends: z.string().optional().describe("Organisation policies: a file path or an https URL."),
        plugins: z.array(z.string()).default([]).describe("Plugin packages to load (installed in the repository)."),
        llm: strict({
            provider: z
                .string()
                .default("anthropic")
                .describe("anthropic | openai | ollama | none | a plugin provider"),
            model: z.string().default("claude-opus-5-5"),
            effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
            budget_per_run_usd: z.number().nonnegative().default(0.3),
            base_url: z.string().optional().describe("OpenAI-compatible servers (Ollama, vLLM…)."),
            api_key_env: z.string().optional().describe("Name of the environment variable holding the key."),
            prices: z
                .object({input: z.number().nonnegative(), output: z.number().nonnegative()})
                .strict()
                .optional()
                .describe("USD per million tokens, for providers aicd has no price for.")
        }),
        agents: strict({
            triage: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise"),
                retry_flaky: z.boolean().default(true),
                flaky_window: z.number().int().positive().default(20),
                flaky_min_flips: z.number().int().positive().default(2)
            }),
            flaky: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise"),
                window: z.number().int().positive().default(30),
                min_flips: z.number().int().positive().default(2),
                min_runs: z.number().int().positive().default(3),
                quarantine_after: z.number().int().positive().default(3),
                release_after: z.number().int().positive().default(10),
                create_issues: z.boolean().default(false)
            }),
            test_selection: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise").describe("Only for its merge request comment."),
                full_suite_on: globs(["main", "master", "release/*"]),
                force_full_patterns: globs([]).describe(
                    "Added to the built-in list (lockfiles, CI and build config…)."
                ),
                max_changed_files: z.number().int().positive().default(50),
                unmapped_source: z.enum(["full", "ignore"]).default("full"),
                map_max_age_days: z.number().int().positive().default(14),
                ignore_patterns: globs([]).describe(
                    "Changed files without test impact, added to the built-in list (docs)."
                ),
                test_patterns: globs([]).describe("Overrides the built-in test file patterns when set."),
                unmapped_tests: z.enum(["run", "skip"]).default("run"),
                conventions: z.boolean().default(true).describe("Map tests to sources by naming conventions."),
                co_change_threshold: z.number().int().positive().default(3),
                comment: z.boolean().default(true),
                coverage: strict({lcov: globs(["**/lcov.info"]), cobertura: globs([]), jacoco: globs([])})
            }),
            security_triage: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise"),
                ignore_paths: globs([]).describe("Added to the built-in list (tests, fixtures, vendor, generated…)."),
                max_alerts: z.number().int().positive().default(10),
                context_lines: z.number().int().min(0).default(20),
                never_dismiss: z.array(severity).default(["critical"]),
                fail_on: severity.default("high"),
                fix_proposal: z.boolean().default(false)
            }),
            pipeline_optimizer: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("propose"),
                config_files: globs([]).describe("Default: .gitlab-ci.yml or .github/workflows/*.yml."),
                history_limit: z.number().int().positive().default(50),
                min_runs: z.number().int().positive().default(5),
                slow_job_share: z.number().min(0).max(1).default(0.25),
                slow_job_min_minutes: z.number().nonnegative().default(5),
                queue_threshold_seconds: z.number().nonnegative().default(120),
                retry_rate: z.number().min(0).max(1).default(0.1),
                max_llm_findings: z.number().int().min(0).default(3),
                fix_proposal: z.boolean().default(true)
            }),
            intent_check: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise"),
                max_diff_chars: z.number().int().positive().default(60_000),
                fail_on_gaps: z.boolean().default(false)
            }),
            risk_score: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("advise"),
                sensitive_paths: globs([]).describe("Added to the built-in list."),
                medium_threshold: z.number().int().min(0).max(100).default(40),
                high_threshold: z.number().int().min(0).max(100).default(70),
                weights: z.record(z.string(), z.number().min(0)).default({}).describe("Maximum points per signal."),
                fix_hotspot_min: z.number().int().positive().default(2),
                label_prefix: z.string().default("risk:"),
                fail_on_high: z.boolean().default(false),
                comment_on_low: z.boolean().default(false),
                required_approvals: strict({
                    low: z.number().int().min(0).default(1),
                    medium: z.number().int().min(0).default(1),
                    high: z.number().int().min(0).default(2)
                })
            }),
            release_notes: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("propose"),
                audiences: z.array(z.enum(["technical", "users"])).default(["technical", "users"]),
                primary: z.enum(["technical", "users"]).default("technical"),
                use_llm: z.boolean().default(true),
                repository_url: z.string().optional().describe("Default: derived from the CI (GitHub)."),
                ticket_url: z
                    .string()
                    .optional()
                    .describe("Template with {key}, e.g. https://acme.atlassian.net/browse/{key}."),
                ticket_prefixes: globs([]),
                release_name: z.string().default("{tag}")
            }),
            release_guardian: strict({
                enabled: z.boolean().default(true),
                autonomy: environmentAutonomy.default({default: "propose", staging: "act", production: "propose"}),
                metrics: z
                    .array(
                        z
                            .object({
                                name: z.string(),
                                source: z.string(),
                                query: z.string(),
                                bad: z.enum(["up", "down"]).default("up"),
                                absolute_min: z.number().nonnegative().default(0)
                            })
                            .strict()
                    )
                    .default([]),
                error_source: z
                    .string()
                    .optional()
                    .describe("Name of a metrics source that reports new errors (Sentry)."),
                baseline_minutes: z.number().int().positive().default(60),
                observe_minutes: z.number().int().positive().default(15),
                step_seconds: z.number().int().positive().default(60),
                relative_increase: z.number().positive().default(0.5),
                severe_factor: z.number().positive().default(2),
                new_errors_threshold: z.number().int().min(0).default(3)
            }),
            postmortem: strict({
                enabled: z.boolean().default(true),
                autonomy: autonomy.default("propose"),
                lookback_hours: z.number().int().positive().default(24)
            })
        }),
        integrations: strict({
            trackers: z.array(integration).default([]).describe("jira | github | linear | markdown | plugin trackers"),
            metrics_sources: z
                .record(z.string(), integration)
                .default({})
                .describe("prometheus | datadog | sentry, by name"),
            deployer: integration.optional().describe("argocd | webhook"),
            notifiers: z
                .array(integration.and(z.object({on: z.array(z.string()).optional()})))
                .default([])
                .describe("slack | teams | webhook; `on` filters by severity or agent")
        }),
        inputs: strict({
            junit: globs(["**/junit*.xml", "**/TEST-*.xml", "**/test-results/**/*.xml"]),
            sarif: globs(["**/*.sarif", "**/*.sarif.json"])
        }),
        privacy: strict({
            send_code: sendCode.default("diff_only"),
            redact: z.array(redactRule).default(["secrets", "emails", "ip_addresses", "high_entropy"]),
            extra_patterns: z.array(z.string()).default([])
        }),
        comment: strict({
            language: z.enum(["en", "fr"]).default("en"),
            min_confidence: confidence.default("low")
        }),
        state: strict({
            backend: z.string().default("sqlite").describe("sqlite | postgres | a plugin store"),
            path: z.string().default(".aicd/state.db"),
            url_env: z.string().default("AICD_DATABASE_URL").describe("Postgres connection string variable.")
        }),
        server: strict({
            host: z.string().default("0.0.0.0"),
            port: z.number().int().min(0).max(65535).default(8080),
            api_tokens_env: z.string().default("AICD_API_TOKENS").describe("Comma-separated bearer tokens."),
            github_secret_env: z.string().default("AICD_GITHUB_WEBHOOK_SECRET"),
            gitlab_token_env: z.string().default("AICD_GITLAB_WEBHOOK_TOKEN"),
            alerts_token_env: z.string().default("AICD_ALERTS_TOKEN"),
            sentry_client_secret_env: z
                .string()
                .default("AICD_SENTRY_CLIENT_SECRET")
                .describe("Sentry integrations sign their webhooks instead of sending a token."),
            concurrency: z.number().int().positive().default(2)
        }),
        audit: strict({jsonl: z.string().optional()}),
        security: strict({
            allow_forks: z.boolean().default(false),
            protected_branches: globs(["main", "master", "develop", "development", "production", "release/*"])
        }),
        fail_on_internal_error: z.boolean().default(false)
    })
    .strict();

export type AicdConfig = z.output<typeof ConfigSchema>;
export type AicdConfigInput = z.input<typeof ConfigSchema>;
export type AgentName = keyof AicdConfig["agents"];

/** Organisation policies: ceilings no repository can exceed. */
export const PoliciesSchema = z
    .object({
        autonomy_max: z
            .record(z.string(), environmentAutonomy)
            .default({})
            .describe("Per agent (or `default`); an agent acting on environments may take one level per environment."),
        forbidden_actions: z.array(z.string()).default([]),
        llm: strict({
            allowed_providers: z.array(z.string()).optional(),
            max_budget_per_run_usd: z.number().nonnegative().optional()
        }),
        privacy: strict({send_code_max: sendCode.optional()}),
        plugins: strict({allowed: z.array(z.string()).optional().describe("Only these plugins may be loaded.")})
    })
    .strict();

export type Policies = z.output<typeof PoliciesSchema>;

export class ConfigError extends Error {
    constructor(
        message: string,
        readonly issues: string[] = []
    ) {
        super(issues.length > 0 ? `${message}\n${issues.map((issue) => `  - ${issue}`).join("\n")}` : message);
        this.name = "ConfigError";
    }
}

export interface LoadConfigOptions {
    cwd?: string;
    /** Path of the config file. Default: `.aicd.yaml` (or `.aicd.yml`) in `cwd`. */
    file?: string;
    env?: NodeJS.ProcessEnv;
    /** `key.path=value` pairs from `--set`, highest priority. */
    overrides?: string[];
    /**
     * The repository's file is not trusted (code from a fork): its `security`, `plugins` and `extends` keys are
     * ignored, so a fork cannot lift its own restrictions or the organisation's ceilings.
     */
    untrustedFile?: boolean;
    fetch?: typeof fetch;
}

export interface ResolvedConfig {
    config: AicdConfig;
    policies: Policies;
    /** Config file actually read, if any. */
    file?: string;
    warnings: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: Json, patch: Json): Json {
    const out: Json = {...base};
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key] as Json, value) : value;
    }
    return out;
}

function getPath(target: Json, path: string[]): unknown {
    let node: unknown = target;
    for (const key of path) node = isObject(node) ? node[key] : undefined;
    return node;
}

function setPath(target: Json, path: string[], value: unknown): void {
    let node = target;
    for (const key of path.slice(0, -1)) {
        if (!isObject(node[key])) node[key] = {};
        node = node[key] as Json;
    }
    node[path.at(-1) as string] = value;
}

type LeafKind = "string" | "number" | "boolean" | "array";

interface SchemaNode {
    type?: string;
    properties?: Record<string, SchemaNode>;
    additionalProperties?: SchemaNode | boolean;
    anyOf?: SchemaNode[];
}

function kindOf(node: SchemaNode): LeafKind {
    const types = node.anyOf ? node.anyOf.map((option) => option.type) : [node.type];
    if (types.includes("string")) return "string";
    if (types.includes("number") || types.includes("integer")) return "number";
    if (types.includes("boolean")) return "boolean";
    if (types.includes("array")) return "array";
    return "string";
}

/**
 * Keys that env vars and `--set` may target, from the configuration's JSON Schema (optional keys included).
 * `open` marks keys under which free sub-keys are accepted: maps, and unions with a map such as
 * `agents.release_guardian.autonomy`.
 */
function schemaLeaves(node: SchemaNode, prefix: string[] = []): {path: string[]; kind: LeafKind; open: boolean}[] {
    if (node.type === "object" && node.properties && Object.keys(node.properties).length > 0) {
        return Object.entries(node.properties).flatMap(([key, child]) => schemaLeaves(child, [...prefix, key]));
    }
    const isMap = (candidate: SchemaNode) => candidate.type === "object" && !candidate.properties;
    if (isMap(node)) return [{path: prefix, kind: "string", open: true}];
    return [{path: prefix, kind: kindOf(node), open: Boolean(node.anyOf?.some(isMap))}];
}

function coerce(raw: string, kind: LeafKind, name: string): unknown {
    if (kind === "array") {
        return raw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (kind === "number") {
        const number = Number(raw);
        if (raw.trim() === "" || Number.isNaN(number)) throw new ConfigError(`${name} must be a number, got "${raw}"`);
        return number;
    }
    if (kind === "boolean") {
        if (!["true", "false", "1", "0"].includes(raw.toLowerCase())) {
            throw new ConfigError(`${name} must be true or false, got "${raw}"`);
        }
        return ["true", "1"].includes(raw.toLowerCase());
    }
    return raw;
}

/** A value under an open key: JSON when it parses (numbers, booleans, lists), else the raw string. */
function looseValue(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
}

const LEAVES = schemaLeaves(z.toJSONSchema(ConfigSchema, {io: "input"}) as SchemaNode);

/** `AICD_AGENTS_TRIAGE_AUTONOMY=act` → `{agents: {triage: {autonomy: "act"}}}`. */
export function envLayer(env: NodeJS.ProcessEnv): Json {
    const layer: Json = {};
    for (const {path, kind} of LEAVES) {
        const name = `AICD_${path.join("_").toUpperCase()}`;
        const raw = env[name];
        if (raw !== undefined && raw !== "") setPath(layer, path, coerce(raw, kind, name));
    }
    return layer;
}

/** `["agents.triage.autonomy=act"]` → `{agents: {triage: {autonomy: "act"}}}`. */
export function overridesLayer(overrides: string[]): Json {
    const layer: Json = {};
    for (const override of overrides) {
        const separator = override.indexOf("=");
        if (separator <= 0) throw new ConfigError(`--set expects key=value, got "${override}"`);
        const key = override.slice(0, separator).trim();
        const raw = override.slice(separator + 1).trim();
        const leaf = LEAVES.find(({path}) => path.join(".") === key);
        if (leaf) {
            setPath(layer, key.split("."), coerce(raw, leaf.kind, key));
            continue;
        }
        const parent = LEAVES.find(({path, open}) => open && key.startsWith(`${path.join(".")}.`));
        if (!parent) throw new ConfigError(`--set: unknown key "${key}"`);
        // A sub-key of a union with a map: a plain value set earlier (e.g. "advise") becomes the map's default.
        const current = getPath(layer, parent.path);
        if (current !== undefined && !isObject(current)) setPath(layer, parent.path, {default: current});
        setPath(layer, key.split("."), looseValue(raw));
    }
    return layer;
}

function formatIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

async function loadPolicies(source: string, baseDir: string, fetchImpl: typeof fetch): Promise<Policies> {
    let raw: string;
    if (/^https:\/\//.test(source)) {
        const response = await fetchImpl(source);
        if (!response.ok) throw new ConfigError(`extends: cannot fetch ${source} (HTTP ${response.status})`);
        raw = await response.text();
    } else if (/^[a-z]+:\/\//i.test(source)) {
        throw new ConfigError(`extends: only https URLs and file paths are supported, got ${source}`);
    } else {
        const path = isAbsolute(source) ? source : resolve(baseDir, source);
        if (!existsSync(path)) throw new ConfigError(`extends: file not found: ${path}`);
        raw = readFileSync(path, "utf8");
    }
    const parsed = PoliciesSchema.safeParse(parseYaml(raw) ?? {});
    if (!parsed.success) throw new ConfigError(`Invalid policies in ${source}`, formatIssues(parsed.error));
    return parsed.data;
}

const SEND_CODE_ORDER = ["none", "diff_only", "full"] as const;

type EnvironmentAutonomy = Autonomy | Record<string, Autonomy>;

/** The autonomy an agent has for an environment (or overall when it has a single level). */
export function autonomyFor(value: EnvironmentAutonomy, environment?: string): Autonomy {
    if (typeof value === "string") return value;
    return (environment ? value[environment] : undefined) ?? value.default ?? "observe";
}

function capAutonomy(value: EnvironmentAutonomy, ceiling: EnvironmentAutonomy): EnvironmentAutonomy {
    if (typeof value === "string" && typeof ceiling === "string") return minAutonomy(value, ceiling);
    const values = typeof value === "string" ? {default: value} : value;
    const environments = new Set([
        ...Object.keys(values),
        ...(typeof ceiling === "string" ? [] : Object.keys(ceiling))
    ]);
    return Object.fromEntries(
        [...environments].map((environment) => [
            environment,
            minAutonomy(autonomyFor(values, environment), autonomyFor(ceiling, environment))
        ])
    );
}

/** Lowers the configuration to the organisation ceilings. Never raises anything. */
export function applyPolicies(config: AicdConfig, policies: Policies): {config: AicdConfig; warnings: string[]} {
    const warnings: string[] = [];
    const next = structuredClone(config);

    const agents = next.agents as Record<string, {autonomy?: EnvironmentAutonomy}>;
    for (const [name, agent] of Object.entries(agents)) {
        const ceiling = policies.autonomy_max[name] ?? policies.autonomy_max.default;
        if (!ceiling || agent.autonomy === undefined) continue;
        const capped = capAutonomy(agent.autonomy, ceiling);
        if (JSON.stringify(capped) !== JSON.stringify(agent.autonomy)) {
            warnings.push(
                `agents.${name}.autonomy lowered from ${JSON.stringify(agent.autonomy)} to ${JSON.stringify(capped)} by policy`
            );
            agent.autonomy = capped;
        }
    }

    const allowed = policies.llm.allowed_providers;
    if (allowed && next.llm.provider !== "none" && !allowed.includes(next.llm.provider)) {
        warnings.push(`llm.provider ${next.llm.provider} is not allowed by policy: LLM disabled`);
        next.llm.provider = "none";
    }
    const maxBudget = policies.llm.max_budget_per_run_usd;
    if (maxBudget !== undefined && next.llm.budget_per_run_usd > maxBudget) {
        warnings.push(`llm.budget_per_run_usd lowered from ${next.llm.budget_per_run_usd} to ${maxBudget} by policy`);
        next.llm.budget_per_run_usd = maxBudget;
    }

    const sendMax = policies.privacy.send_code_max;
    if (sendMax && SEND_CODE_ORDER.indexOf(next.privacy.send_code) > SEND_CODE_ORDER.indexOf(sendMax)) {
        warnings.push(`privacy.send_code lowered from ${next.privacy.send_code} to ${sendMax} by policy`);
        next.privacy.send_code = sendMax;
    }

    const allowedPlugins = policies.plugins.allowed;
    if (allowedPlugins) {
        const refused = next.plugins.filter((plugin) => !allowedPlugins.includes(plugin));
        if (refused.length > 0) {
            warnings.push(`plugins not allowed by policy, not loaded: ${refused.join(", ")}`);
            next.plugins = next.plugins.filter((plugin) => allowedPlugins.includes(plugin));
        }
    }
    return {config: next, warnings};
}

/**
 * Resolves the configuration, lowest to highest priority:
 * defaults → `.aicd.yaml` → `AICD_*` environment variables → `--set` overrides,
 * then caps it with the organisation policies (`extends`).
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const candidates = options.file
        ? [resolve(cwd, options.file)]
        : [resolve(cwd, ".aicd.yaml"), resolve(cwd, ".aicd.yml")];
    const file = candidates.find((path) => existsSync(path));
    if (options.file && !file) throw new ConfigError(`Config file not found: ${candidates[0]}`);

    let fileLayer: Json = {};
    if (file) {
        let parsed: unknown;
        try {
            parsed = parseYaml(readFileSync(file, "utf8")) ?? {};
        } catch (error) {
            throw new ConfigError(`Invalid YAML in ${file}: ${(error as Error).message}`);
        }
        if (!isObject(parsed)) throw new ConfigError(`${file} must contain a YAML mapping`);
        fileLayer = parsed;
        if (options.untrustedFile) {
            const {security: _security, plugins: _plugins, extends: _extends, ...trusted} = fileLayer;
            fileLayer = trusted;
        }
    }

    const merged = [envLayer(env), overridesLayer(options.overrides ?? [])].reduce(deepMerge, fileLayer);
    const result = ConfigSchema.safeParse(merged);
    if (!result.success)
        throw new ConfigError(`Invalid configuration${file ? ` (${file})` : ""}`, formatIssues(result.error));

    let policies = PoliciesSchema.parse({});
    if (result.data.extends) {
        policies = await loadPolicies(result.data.extends, file ? dirname(file) : cwd, options.fetch ?? fetch);
    }
    const capped = applyPolicies(result.data, policies);
    return {config: capped.config, policies, ...(file ? {file} : {}), warnings: capped.warnings};
}

/** JSON Schema of `.aicd.yaml`, for editor autocompletion. */
export function configJsonSchema(): unknown {
    return z.toJSONSchema(ConfigSchema, {io: "input"});
}

export function policiesJsonSchema(): unknown {
    return z.toJSONSchema(PoliciesSchema, {io: "input"});
}
