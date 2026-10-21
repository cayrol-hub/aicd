import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}/src/index.ts`, import.meta.url));

// Tests run against the TypeScript sources, so no build is needed before `pnpm test`.
export default defineConfig({
    resolve: {
        alias: {
            "@aicd/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
            "@aicd/plugin-sdk/testing": fileURLToPath(
                new URL("./packages/plugin-sdk/src/testing/index.ts", import.meta.url)
            ),
            "@aicd/agent-pipeline-optimizer": src("agents/pipeline-optimizer"),
            "@aicd/adapter-metrics-sources": src("adapters/metrics-sources"),
            "@aicd/agent-release-guardian": src("agents/release-guardian"),
            "@aicd/adapter-issue-trackers": src("adapters/issue-trackers"),
            "@aicd/adapter-state-postgres": src("adapters/state-postgres"),
            "@aicd/agent-security-triage": src("agents/security-triage"),
            "@aicd/adapter-llm-anthropic": src("adapters/llm-anthropic"),
            "@aicd/adapter-state-sqlite": src("adapters/state-sqlite"),
            "@aicd/agent-test-selection": src("agents/test-selection"),
            "@aicd/agent-release-notes": src("agents/release-notes"),
            "@aicd/agent-intent-check": src("agents/intent-check"),
            "@aicd/adapter-llm-openai": src("adapters/llm-openai"),
            "@aicd/adapter-deployers": src("adapters/deployers"),
            "@aicd/adapter-notifiers": src("adapters/notifiers"),
            "@aicd/adapter-ci-github": src("adapters/ci-github"),
            "@aicd/adapter-ci-gitlab": src("adapters/ci-gitlab"),
            "@aicd/agent-risk-score": src("agents/risk-score"),
            "@aicd/agent-postmortem": src("agents/postmortem"),
            "@aicd/adapter-ci-local": src("adapters/ci-local"),
            "@aicd/agent-triage": src("agents/triage"),
            "@aicd/agent-flaky": src("agents/flaky"),
            "@aicd/plugin-sdk": src("plugin-sdk"),
            "@aicd/redaction": src("redaction"),
            "@aicd/parsers": src("parsers"),
            "@aicd/metrics": src("metrics"),
            "@aicd/server": src("server"),
            "@aicd/replay": src("replay"),
            "@aicd/core": src("core"),
            "@aicd/git": src("git"),
            "@aicd/mcp": src("mcp")
        }
    },
    test: {
        include: ["packages/**/test/**/*.test.ts"]
    }
});
