import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vitest";
import {ComponentRegistry, ConfigError, loadPlugins} from "@aicd/core";

const cwd = fileURLToPath(new URL("./fixtures", import.meta.url));
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const context = {env: {}, fetch, logger};

describe("plugins", () => {
    it("loads a valid plugin and creates its components", async () => {
        const registry = new ComponentRegistry();
        const loaded = await loadPlugins(["aicd-plugin-demo"], registry, {cwd, logger});
        expect(loaded.map((manifest) => manifest.name)).toEqual(["aicd-plugin-demo"]);
        expect(registry.names("notifiers")).toEqual(["demo"]);
        expect(registry.create("notifiers", "demo", {channel: "x"}, context)).toMatchObject({
            name: "demo",
            config: {channel: "x"}
        });
    });

    it("refuses a plugin that declares a forbidden action", async () => {
        const error = await loadPlugins(["aicd-plugin-evil"], new ComponentRegistry(), {cwd, logger}).catch(
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues).toEqual(['actions: forbidden action "merge"']);
    });

    it("reports missing plugins and unknown components clearly", async () => {
        await expect(loadPlugins(["aicd-plugin-missing"], new ComponentRegistry(), {cwd, logger})).rejects.toThrow(
            /not found/
        );
        expect(() => new ComponentRegistry().create("llm", "nope", {}, context)).toThrow(/unknown llm "nope"/);
    });

    it("refuses two components with the same name", () => {
        const registry = new ComponentRegistry();
        const factory = {name: "slack", create: () => ({name: "slack", send: async () => {}})};
        registry.register("notifiers", factory);
        expect(() => registry.register("notifiers", factory, "plugin x")).toThrow(/already provided by built-in/);
    });
});
