import type {Factory, FactoryContext, MetricsSource} from "@aicd/plugin-sdk";
import {DatadogSource} from "./datadog.js";
import {PrometheusSource} from "./prometheus.js";
import {SentrySource} from "./sentry.js";

function optionalString(config: Record<string, unknown>, key: string, factory: string): string | undefined {
    const value = config[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${factory}: "${key}" must be a string`);
    return value;
}

function requiredString(config: Record<string, unknown>, key: string, factory: string): string {
    const value = optionalString(config, key, factory);
    if (!value) throw new Error(`${factory}: "${key}" is required`);
    return value;
}

/** Secrets never live in the configuration: it names the environment variable that holds them. */
function secret(
    config: Record<string, unknown>,
    key: string,
    fallbackEnv: string | undefined,
    context: FactoryContext,
    factory: string,
    required: boolean
): string | undefined {
    const name = optionalString(config, key, factory) ?? fallbackEnv;
    const value = name ? context.env[name] : undefined;
    if (required && !value) throw new Error(`${factory}: environment variable ${name ?? `(${key})`} is not set`);
    return value || undefined;
}

function headers(config: Record<string, unknown>, factory: string): Record<string, string> | undefined {
    const value = config.headers;
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${factory}: "headers" must be a map of strings`);
    }
    const entries = Object.entries(value);
    if (entries.some(([, v]) => typeof v !== "string"))
        throw new Error(`${factory}: "headers" must be a map of strings`);
    return Object.fromEntries(entries) as Record<string, string>;
}

/** `{url, bearer_token_env?, headers?}`. */
export const prometheusFactory: Factory<MetricsSource> = {
    name: "prometheus",
    create(config, context) {
        const bearerToken = secret(config, "bearer_token_env", undefined, context, "prometheus", false);
        const extra = headers(config, "prometheus");
        return new PrometheusSource({
            url: requiredString(config, "url", "prometheus"),
            ...(bearerToken ? {bearerToken} : {}),
            ...(extra ? {headers: extra} : {}),
            fetch: context.fetch
        });
    }
};

/** `{site = "datadoghq.com", api_key_env = "DD_API_KEY", app_key_env = "DD_APP_KEY"}`. */
export const datadogFactory: Factory<MetricsSource> = {
    name: "datadog",
    create(config, context) {
        const site = optionalString(config, "site", "datadog");
        return new DatadogSource({
            ...(site ? {site} : {}),
            apiKey: secret(config, "api_key_env", "DD_API_KEY", context, "datadog", true) as string,
            appKey: secret(config, "app_key_env", "DD_APP_KEY", context, "datadog", true) as string,
            fetch: context.fetch
        });
    }
};

/** `{url = "https://sentry.io", organization, project, token_env = "SENTRY_AUTH_TOKEN"}`. */
export const sentryFactory: Factory<MetricsSource> = {
    name: "sentry",
    create(config, context) {
        const url = optionalString(config, "url", "sentry");
        return new SentrySource({
            ...(url ? {url} : {}),
            organization: requiredString(config, "organization", "sentry"),
            project: requiredString(config, "project", "sentry"),
            token: secret(config, "token_env", "SENTRY_AUTH_TOKEN", context, "sentry", true) as string,
            fetch: context.fetch
        });
    }
};

export const metricsSourceFactories: Factory<MetricsSource>[] = [prometheusFactory, datadogFactory, sentryFactory];
