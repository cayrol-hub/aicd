import type {ActionType} from "./actions.js";
import type {CIProviderFactory} from "./ci.js";
import type {Deployer} from "./deploy.js";
import type {LLMProvider} from "./llm.js";
import type {Notifier} from "./notify.js";
import type {MetricsSource} from "./observability.js";
import type {Logger} from "./runtime.js";
import type {StateStore} from "./state.js";
import type {IssueTracker} from "./trackers.js";

/** Version of this contract. A plugin built for another major version is refused. */
export const PLUGIN_API_VERSION = 1;

/** What a factory receives: its own section of the configuration, and runtime helpers. */
export interface FactoryContext {
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    logger: Logger;
}

export interface Factory<T> {
    readonly name: string;
    create(config: Record<string, unknown>, context: FactoryContext): T;
}

export interface PluginManifest {
    name: string;
    version: string;
    apiVersion: typeof PLUGIN_API_VERSION;
    provides: {
        ci?: CIProviderFactory[];
        llm?: Factory<LLMProvider>[];
        trackers?: Factory<IssueTracker>[];
        metrics?: Factory<MetricsSource>[];
        deployers?: Factory<Deployer>[];
        notifiers?: Factory<Notifier>[];
        state?: Factory<StateStore>[];
    };
    /** Actions the plugin's components may trigger. A forbidden action makes the plugin refused. */
    actions?: ActionType[];
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
    return manifest;
}
