import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {autonomyFor, ConfigError, configJsonSchema, envLayer, loadConfig, overridesLayer} from "@aicd/core";

function workspace(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "aicd-config-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
}

describe("loadConfig", () => {
    it("works without any file", async () => {
        const {config, file} = await loadConfig({cwd: workspace({}), env: {}});
        expect(file).toBeUndefined();
        expect(config.agents.triage.autonomy).toBe("advise");
        expect(config.llm.provider).toBe("anthropic");
        expect(config.privacy.send_code).toBe("diff_only");
    });

    it("layers file < env < --set", async () => {
        const cwd = workspace({
            ".aicd.yaml": "llm:\n  model: from-file\n  budget_per_run_usd: 1\ncomment:\n  language: fr\n"
        });
        const {config} = await loadConfig({
            cwd,
            env: {AICD_LLM_MODEL: "from-env", AICD_LLM_BUDGET_PER_RUN_USD: "2"},
            overrides: ["llm.budget_per_run_usd=3"]
        });
        expect(config.llm.model).toBe("from-env");
        expect(config.llm.budget_per_run_usd).toBe(3);
        expect(config.comment.language).toBe("fr");
    });

    it("rejects unknown keys and invalid values with the path at fault", async () => {
        const cwd = workspace({".aicd.yaml": "agents:\n  triage:\n    autonomy: yolo\nunknown_key: 1\n"});
        const error = await loadConfig({cwd, env: {}}).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues.join("\n")).toMatch(/agents\.triage\.autonomy/);
    });

    it("caps the configuration with the organisation policies", async () => {
        const cwd = workspace({
            ".aicd.yaml":
                "extends: ./policies.yaml\nagents:\n  triage:\n    autonomy: act\nprivacy:\n  send_code: full\n",
            "policies.yaml":
                "autonomy_max:\n  default: advise\nllm:\n  allowed_providers: [ollama]\n  max_budget_per_run_usd: 0.1\nprivacy:\n  send_code_max: none\n"
        });
        const {config, warnings} = await loadConfig({cwd, env: {}});
        expect(config.agents.triage.autonomy).toBe("advise");
        expect(config.llm.provider).toBe("none");
        expect(config.llm.budget_per_run_usd).toBe(0.1);
        expect(config.privacy.send_code).toBe("none");
        expect(warnings).toEqual(
            expect.arrayContaining([
                expect.stringContaining("agents.triage.autonomy lowered"),
                expect.stringContaining("agents.release_guardian.autonomy lowered"),
                expect.stringContaining("llm.provider anthropic is not allowed"),
                expect.stringContaining("privacy.send_code lowered")
            ])
        );
        expect(config.agents.release_guardian.autonomy).toEqual({
            default: "advise",
            staging: "advise",
            production: "advise"
        });
    });

    it("loads policies from an https URL", async () => {
        const cwd = workspace({".aicd.yaml": "extends: https://example.org/policies.yaml\n"});
        const fakeFetch = (async () => new Response("forbidden_actions: [retry_job]\n")) as unknown as typeof fetch;
        const {policies} = await loadConfig({cwd, env: {}, fetch: fakeFetch});
        expect(policies.forbidden_actions).toEqual(["retry_job"]);
    });
});

describe("autonomy per environment", () => {
    it("caps each environment with the policy of the same environment", async () => {
        const cwd = workspace({
            ".aicd.yaml":
                "extends: ./p.yaml\nagents:\n  release_guardian:\n    autonomy: {default: act, production: act}\n",
            "p.yaml": "autonomy_max:\n  release_guardian: {default: act, production: propose}\n"
        });
        const {config} = await loadConfig({cwd, env: {}});
        expect(config.agents.release_guardian.autonomy).toEqual({default: "act", production: "propose"});
        expect(autonomyFor(config.agents.release_guardian.autonomy, "staging")).toBe("act");
        expect(autonomyFor(config.agents.release_guardian.autonomy, "production")).toBe("propose");
    });

    it("refuses plugins the organisation does not allow", async () => {
        const cwd = workspace({
            ".aicd.yaml": "extends: ./p.yaml\nplugins: [aicd-plugin-a, aicd-plugin-b]\n",
            "p.yaml": "plugins:\n  allowed: [aicd-plugin-a]\n"
        });
        const {config, warnings} = await loadConfig({cwd, env: {}});
        expect(config.plugins).toEqual(["aicd-plugin-a"]);
        expect(warnings).toEqual(["plugins not allowed by policy, not loaded: aicd-plugin-b"]);
    });
});

describe("layers", () => {
    it("maps AICD_* variables to typed keys", () => {
        expect(
            envLayer({
                AICD_AGENTS_TRIAGE_AUTONOMY: "act",
                AICD_AGENTS_TRIAGE_RETRY_FLAKY: "false",
                AICD_PRIVACY_REDACT: "secrets, emails",
                AICD_UNRELATED: "x"
            })
        ).toEqual({agents: {triage: {autonomy: "act", retry_flaky: false}}, privacy: {redact: ["secrets", "emails"]}});
    });

    it("rejects a non-numeric value for a numeric key", () => {
        expect(() => envLayer({AICD_LLM_BUDGET_PER_RUN_USD: "cheap"})).toThrow(ConfigError);
    });

    it("rejects unknown --set keys", () => {
        expect(() => overridesLayer(["agents.triage.nope=1"])).toThrow(/unknown key/);
        expect(() => overridesLayer(["novalue"])).toThrow(/key=value/);
    });

    it("exports a JSON Schema for editors", () => {
        const schema = configJsonSchema() as {properties: Record<string, unknown>};
        expect(Object.keys(schema.properties)).toContain("agents");
    });
});

describe("keys reachable from env and --set", () => {
    it("include optional keys and per-environment autonomy", () => {
        expect(envLayer({AICD_LLM_BASE_URL: "http://localhost:11434/v1", AICD_AUDIT_JSONL: "a.jsonl"})).toEqual({
            llm: {base_url: "http://localhost:11434/v1"},
            audit: {jsonl: "a.jsonl"}
        });
        expect(
            overridesLayer([
                "agents.release_guardian.autonomy=act",
                "agents.release_guardian.autonomy.production=propose"
            ])
        ).toEqual({agents: {release_guardian: {autonomy: {default: "act", production: "propose"}}}});
        expect(overridesLayer(["agents.risk_score.weights.size=5"])).toEqual({
            agents: {risk_score: {weights: {size: 5}}}
        });
    });
});
