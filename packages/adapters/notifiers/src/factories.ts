import type {Factory, FactoryContext, Notifier} from "@aicd-ci/plugin-sdk";
import {SlackNotifier, TeamsNotifier, WebhookNotifier} from "./notifiers.js";

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Webhook URL of a notifier: from the env var named in `webhook_url_env` (recommended, URLs are secrets),
 * else `webhook_url`, else `url`.
 */
export function resolveWebhookUrl(name: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
    const envName = config.webhook_url_env;
    if (envName !== undefined) {
        if (!isString(envName)) throw new Error(`notifier "${name}": webhook_url_env must be an env var name`);
        const value = env[envName];
        if (!value) throw new Error(`notifier "${name}": env var ${envName} (webhook_url_env) is not set`);
        return value;
    }
    const url = config.webhook_url ?? config.url;
    if (!isString(url)) {
        throw new Error(`notifier "${name}": set webhook_url_env (recommended), webhook_url or url`);
    }
    return url;
}

/** Static `headers` plus `headers_env` ({header: ENV_VAR}) for secret header values. */
function resolveHeaders(name: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> {
    const headers: Record<string, string> = {};
    const sections = [
        ["headers", config.headers],
        ["headers_env", config.headers_env]
    ] as const;
    for (const [key, section] of sections) {
        if (section === undefined) continue;
        if (typeof section !== "object" || section === null || Array.isArray(section)) {
            throw new Error(`notifier "${name}": ${key} must be a map of header names to strings`);
        }
        for (const [header, value] of Object.entries(section)) {
            if (!isString(value)) throw new Error(`notifier "${name}": ${key}.${header} must be a string`);
            if (key === "headers") {
                headers[header] = value;
            } else {
                const resolved = env[value];
                if (!resolved)
                    throw new Error(`notifier "${name}": env var ${value} (headers_env.${header}) is not set`);
                headers[header] = resolved;
            }
        }
    }
    return headers;
}

const factory = (name: string, create: (config: Record<string, unknown>, context: FactoryContext) => Notifier) => ({
    name,
    create
});

/** Built-in notifier factories: "slack", "teams", "webhook". */
export const notifierFactories: Factory<Notifier>[] = [
    factory(
        "slack",
        (config, context) =>
            new SlackNotifier({webhookUrl: resolveWebhookUrl("slack", config, context.env), fetch: context.fetch})
    ),
    factory(
        "teams",
        (config, context) =>
            new TeamsNotifier({webhookUrl: resolveWebhookUrl("teams", config, context.env), fetch: context.fetch})
    ),
    factory(
        "webhook",
        (config, context) =>
            new WebhookNotifier({
                url: resolveWebhookUrl("webhook", config, context.env),
                headers: resolveHeaders("webhook", config, context.env),
                fetch: context.fetch
            })
    )
];
