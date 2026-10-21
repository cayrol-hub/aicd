import type {Factory, FactoryContext, IssueTracker} from "@aicd/plugin-sdk";
import {GitHubIssuesTracker} from "./github.js";
import {JiraTracker} from "./jira.js";
import {LinearTracker} from "./linear.js";
import {MarkdownSpecTracker} from "./markdown.js";

function optionalString(config: Record<string, unknown>, key: string, tracker: string): string | undefined {
    const value = config[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${tracker}: "${key}" must be a string`);
    return value;
}

function stringList(config: Record<string, unknown>, key: string, tracker: string): string[] | undefined {
    const value = config[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`${tracker}: "${key}" must be a list of strings`);
    }
    return value;
}

/** Secrets never come from the configuration file: only from the environment variable it names. */
function secret(
    config: Record<string, unknown>,
    context: FactoryContext,
    tracker: string,
    option: string,
    defaultEnv: string
): string | undefined {
    const plain = option.replace(/_env$/, "");
    if (config[plain] !== undefined) {
        throw new Error(
            `${tracker}: do not put "${plain}" in the configuration, set "${option}" to an environment variable name`
        );
    }
    const name = optionalString(config, option, tracker) ?? defaultEnv;
    return context.env[name] || undefined;
}

/** `jira`: base_url (required), email, api_token_env (JIRA_API_TOKEN), bearer_token_env, project_key, issue_type, project_keys. */
const jira: Factory<IssueTracker> = {
    name: "jira",
    create(config, context) {
        const baseUrl = optionalString(config, "base_url", "jira") ?? context.env.JIRA_BASE_URL;
        if (!baseUrl) throw new Error('jira: "base_url" is required');
        const email = optionalString(config, "email", "jira") ?? context.env.JIRA_EMAIL;
        const apiToken = secret(config, context, "jira", "api_token_env", "JIRA_API_TOKEN");
        const bearerToken = secret(config, context, "jira", "bearer_token_env", "JIRA_BEARER_TOKEN");
        const projectKey = optionalString(config, "project_key", "jira");
        const issueType = optionalString(config, "issue_type", "jira");
        const projectKeys = stringList(config, "project_keys", "jira");
        return new JiraTracker({
            baseUrl,
            ...(email ? {email} : {}),
            ...(apiToken ? {apiToken} : {}),
            ...(bearerToken ? {bearerToken} : {}),
            ...(projectKey ? {projectKey} : {}),
            ...(issueType ? {issueType} : {}),
            ...(projectKeys ? {projectKeys} : {}),
            fetch: context.fetch
        });
    }
};

/** `github`: repository (default GITHUB_REPOSITORY), token_env (GITHUB_TOKEN), api_url (default GITHUB_API_URL). */
const github: Factory<IssueTracker> = {
    name: "github",
    create(config, context) {
        const repository = optionalString(config, "repository", "github") ?? context.env.GITHUB_REPOSITORY;
        const token = secret(config, context, "github", "token_env", "GITHUB_TOKEN");
        const apiUrl = optionalString(config, "api_url", "github") ?? context.env.GITHUB_API_URL;
        return new GitHubIssuesTracker({
            ...(repository ? {repository} : {}),
            ...(token ? {token} : {}),
            ...(apiUrl ? {apiUrl} : {}),
            fetch: context.fetch
        });
    }
};

/** `linear`: api_key_env (LINEAR_API_KEY), team_id, team_keys. */
const linear: Factory<IssueTracker> = {
    name: "linear",
    create(config, context) {
        const apiKey = secret(config, context, "linear", "api_key_env", "LINEAR_API_KEY");
        if (!apiKey)
            throw new Error(
                `linear: environment variable ${String(config.api_key_env ?? "LINEAR_API_KEY")} is not set`
            );
        const teamId = optionalString(config, "team_id", "linear");
        const teamKeys = stringList(config, "team_keys", "linear");
        return new LinearTracker({
            apiKey,
            ...(teamId ? {teamId} : {}),
            ...(teamKeys ? {teamKeys} : {}),
            fetch: context.fetch
        });
    }
};

/** `markdown`: cwd (default the working directory), roots (default ["docs/specs", "specs"]). */
const markdown: Factory<IssueTracker> = {
    name: "markdown",
    create(config) {
        const cwd = optionalString(config, "cwd", "markdown") ?? process.cwd();
        const roots = stringList(config, "roots", "markdown");
        return new MarkdownSpecTracker({cwd, ...(roots ? {roots} : {})});
    }
};

/** Factories of the built-in trackers, keyed by name: "jira", "github", "linear", "markdown". */
export const trackerFactories: Factory<IssueTracker>[] = [jira, github, linear, markdown];
