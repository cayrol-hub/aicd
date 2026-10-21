import {describe, expect, it} from "vitest";
import {githubProvider} from "@aicd-ci/adapter-ci-github";
import {gitlabProvider} from "@aicd-ci/adapter-ci-gitlab";
import {localProvider} from "@aicd-ci/adapter-ci-local";
import {definePlugin, PLUGIN_API_VERSION, type PluginManifest} from "@aicd-ci/plugin-sdk";
import {checkCIProvider, checkPluginManifest, checkStateStore} from "@aicd-ci/plugin-sdk/testing";

describe("conformance kit", () => {
    it("accepts the built-in CI adapters", async () => {
        for (const factory of [githubProvider, gitlabProvider, localProvider]) {
            expect(await checkCIProvider(factory.create({env: {}}))).toEqual([]);
        }
        expect(await checkCIProvider(localProvider.create({env: {}}), {probeContext: true})).toEqual([]);
    });

    it("reports a broken state store with the failing checks", async () => {
        const broken = {
            getDiagnosis: async () => undefined,
            close: async () => {}
        } as never;
        const failures = await checkStateStore(() => broken);
        expect(failures.length).toBeGreaterThan(3);
        expect(failures[0]?.check).toBe("diagnoses: save twice increments hits");
    });

    it("validates plugin manifests", () => {
        const good = definePlugin({
            name: "aicd-plugin-example",
            version: "1.0.0",
            apiVersion: PLUGIN_API_VERSION,
            provides: {notifiers: [{name: "pager", create: () => ({name: "pager", send: async () => {}})}]},
            actions: ["notify"]
        });
        expect(checkPluginManifest(good)).toEqual([]);

        const bad = {
            name: "Bad Name",
            version: "",
            apiVersion: 2,
            provides: {notifiers: [{name: "x", create: () => ({})}, {name: "x"}]},
            actions: ["merge", "teleport"]
        } as unknown as PluginManifest;
        expect(checkPluginManifest(bad).map((failure) => failure.check)).toEqual([
            "name",
            "version",
            "apiVersion",
            "notifiers",
            "notifiers",
            "actions",
            "actions"
        ]);
    });
});
