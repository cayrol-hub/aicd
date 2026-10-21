import {githubProvider} from "@aicd-ci/adapter-ci-github";
import {gitlabProvider} from "@aicd-ci/adapter-ci-gitlab";
import {localProvider} from "@aicd-ci/adapter-ci-local";
import {deployerFactories} from "@aicd-ci/adapter-deployers";
import {trackerFactories} from "@aicd-ci/adapter-issue-trackers";
import {AnthropicProvider, type Effort} from "@aicd-ci/adapter-llm-anthropic";
import {llmFactories} from "@aicd-ci/adapter-llm-openai";
import {metricsSourceFactories} from "@aicd-ci/adapter-metrics-sources";
import {notifierFactories} from "@aicd-ci/adapter-notifiers";
import {ComponentRegistry} from "@aicd-ci/core";
import type {Factory, LLMProvider} from "@aicd-ci/plugin-sdk";

/** Anthropic: key from `api_key_env`, else `AICD_LLM_API_KEY`, else `ANTHROPIC_API_KEY`. */
const anthropicFactory: Factory<LLMProvider> = {
    name: "anthropic",
    create: (config, {env, logger}) => {
        const keyEnv = typeof config.api_key_env === "string" ? config.api_key_env : undefined;
        const apiKey = keyEnv ? env[keyEnv] : env.AICD_LLM_API_KEY || env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(`no API key (${keyEnv ?? "AICD_LLM_API_KEY or ANTHROPIC_API_KEY"} is not set)`);
        }
        return new AnthropicProvider({
            apiKey,
            model: String(config.model ?? "claude-opus-5-5"),
            ...(typeof config.effort === "string" ? {effort: config.effort as Effort} : {}),
            warn: (message) => logger.warn(message)
        });
    }
};

/** Every component aicd ships with. Plugins are added on top by `loadPlugins`. */
export function builtInRegistry(): ComponentRegistry {
    const registry = new ComponentRegistry();
    for (const factory of [githubProvider, gitlabProvider, localProvider]) registry.registerCI(factory);
    registry.register("llm", anthropicFactory);
    for (const factory of llmFactories) registry.register("llm", factory);
    for (const factory of trackerFactories) registry.register("trackers", factory);
    for (const factory of metricsSourceFactories) registry.register("metrics", factory);
    for (const factory of deployerFactories) registry.register("deployers", factory);
    for (const factory of notifierFactories) registry.register("notifiers", factory);
    return registry;
}
