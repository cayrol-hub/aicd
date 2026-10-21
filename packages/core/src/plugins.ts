import {createRequire} from "node:module";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import type {
    CIProviderFactory,
    Deployer,
    Factory,
    FactoryContext,
    IssueTracker,
    LLMProvider,
    Logger,
    MetricsSource,
    Notifier,
    PluginManifest,
    StateStore
} from "@aicd/plugin-sdk";
import {checkPluginManifest} from "@aicd/plugin-sdk/testing";
import {ConfigError} from "./config.js";

export interface ComponentKinds {
    llm: LLMProvider;
    trackers: IssueTracker;
    metrics: MetricsSource;
    deployers: Deployer;
    notifiers: Notifier;
    state: StateStore;
}

export type ComponentKind = keyof ComponentKinds;

/** Built-in and plugin components, looked up by kind and name from the configuration. */
export class ComponentRegistry {
    readonly ci: CIProviderFactory[] = [];
    readonly #factories = new Map<ComponentKind, Map<string, {factory: Factory<unknown>; origin: string}>>();

    registerCI(factory: CIProviderFactory, origin = "built-in"): void {
        if (this.ci.some((existing) => existing.name === factory.name)) {
            throw new ConfigError(`${origin}: CI adapter "${factory.name}" is already registered`);
        }
        this.ci.push(factory);
    }

    register<K extends ComponentKind>(kind: K, factory: Factory<ComponentKinds[K]>, origin = "built-in"): void {
        const byName = this.#factories.get(kind) ?? new Map();
        const existing = byName.get(factory.name);
        if (existing) {
            throw new ConfigError(`${origin}: ${kind} "${factory.name}" is already provided by ${existing.origin}`);
        }
        byName.set(factory.name, {factory: factory as Factory<unknown>, origin});
        this.#factories.set(kind, byName);
    }

    names(kind: ComponentKind): string[] {
        return [...(this.#factories.get(kind)?.keys() ?? [])].sort();
    }

    create<K extends ComponentKind>(
        kind: K,
        name: string,
        config: Record<string, unknown>,
        context: FactoryContext
    ): ComponentKinds[K] {
        const entry = this.#factories.get(kind)?.get(name);
        if (!entry) {
            throw new ConfigError(`unknown ${kind} "${name}" (available: ${this.names(kind).join(", ") || "none"})`);
        }
        return entry.factory.create(config, context) as ComponentKinds[K];
    }

    /** Registers every component of a validated plugin manifest. */
    registerPlugin(manifest: PluginManifest): void {
        const origin = `plugin ${manifest.name}@${manifest.version}`;
        const {ci, ...others} = manifest.provides;
        for (const factory of ci ?? []) this.registerCI(factory, origin);
        for (const [kind, factories] of Object.entries(others) as [ComponentKind, Factory<never>[] | undefined][]) {
            for (const factory of factories ?? []) this.register(kind, factory, origin);
        }
    }
}

/**
 * Loads plugins by package name (resolved from the repository's node_modules) or path.
 * A plugin is refused when its manifest fails validation: wrong API version, duplicate names,
 * forbidden or unknown actions.
 */
export async function loadPlugins(
    specifiers: string[],
    registry: ComponentRegistry,
    options: {cwd: string; logger: Logger; importer?: (url: string) => Promise<Record<string, unknown>>}
): Promise<PluginManifest[]> {
    const require = createRequire(join(options.cwd, "package.json"));
    const importer = options.importer ?? ((url: string) => import(url) as Promise<Record<string, unknown>>);
    const loaded: PluginManifest[] = [];
    for (const specifier of specifiers) {
        let resolved: string;
        try {
            resolved = require.resolve(specifier);
        } catch {
            throw new ConfigError(`plugin "${specifier}" not found from ${options.cwd} (is it installed?)`);
        }
        const module = await importer(pathToFileURL(resolved).href);
        const manifest = (module.default ?? module.plugin) as PluginManifest | undefined;
        if (!manifest) throw new ConfigError(`plugin "${specifier}" exports no manifest (default export or "plugin")`);
        const failures = checkPluginManifest(manifest);
        if (failures.length > 0) {
            throw new ConfigError(
                `plugin "${specifier}" refused`,
                failures.map((failure) => `${failure.check}: ${failure.message}`)
            );
        }
        registry.registerPlugin(manifest);
        options.logger.debug(`loaded plugin ${manifest.name}@${manifest.version}`);
        loaded.push(manifest);
    }
    return loaded;
}
