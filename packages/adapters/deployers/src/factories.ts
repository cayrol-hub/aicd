import type {Deployer, Factory, FactoryContext} from "@aicd-ci/plugin-sdk";
import {ArgoCDDeployer} from "./argocd.js";
import {WebhookDeployer} from "./webhook.js";

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
function secretFromEnv(
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

/**
 * `{url, application, token_env = "ARGOCD_AUTH_TOKEN", mode = "application", rollout_name?, namespace?,
 * app_namespace?, environment?}`.
 */
export const argocdFactory: Factory<Deployer> = {
    name: "argocd",
    create(config, context) {
        const mode = optionalString(config, "mode", "argocd") ?? "application";
        if (mode !== "application" && mode !== "rollout") {
            throw new Error(`argocd: "mode" must be "application" or "rollout"`);
        }
        const rolloutName = optionalString(config, "rollout_name", "argocd");
        const namespace = optionalString(config, "namespace", "argocd");
        const appNamespace = optionalString(config, "app_namespace", "argocd");
        const environment = optionalString(config, "environment", "argocd");
        return new ArgoCDDeployer({
            url: requiredString(config, "url", "argocd"),
            token: secretFromEnv(config, "token_env", "ARGOCD_AUTH_TOKEN", context, "argocd", true) as string,
            application: requiredString(config, "application", "argocd"),
            mode,
            ...(rolloutName ? {rolloutName} : {}),
            ...(namespace ? {namespace} : {}),
            ...(appNamespace ? {appNamespace} : {}),
            ...(environment ? {environment} : {}),
            fetch: context.fetch
        });
    }
};

/** `{url, secret_env?, secret_header = "X-Aicd-Signature", environment?, services?}`. */
export const webhookDeployerFactory: Factory<Deployer> = {
    name: "webhook",
    create(config, context) {
        const services = config.services;
        if (services !== undefined && (!Array.isArray(services) || services.some((s) => typeof s !== "string"))) {
            throw new Error(`webhook: "services" must be a list of strings`);
        }
        const secret = secretFromEnv(config, "secret_env", undefined, context, "webhook", !!config.secret_env);
        const secretHeader = optionalString(config, "secret_header", "webhook");
        const environment = optionalString(config, "environment", "webhook");
        if (!secret) context.logger.warn("webhook deployer: no secret_env configured, requests are not signed");
        return new WebhookDeployer({
            url: requiredString(config, "url", "webhook"),
            ...(secret ? {secret} : {}),
            ...(secretHeader ? {secretHeader} : {}),
            ...(environment ? {environment} : {}),
            ...(services ? {services: services as string[]} : {}),
            fetch: context.fetch
        });
    }
};

export const deployerFactories: Factory<Deployer>[] = [argocdFactory, webhookDeployerFactory];
