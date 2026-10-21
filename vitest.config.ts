import {fileURLToPath} from "node:url";
import {defineConfig} from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}/src/index.ts`, import.meta.url));

// Tests run against the TypeScript sources, so no build is needed before `pnpm test`.
export default defineConfig({
    resolve: {
        alias: {
            "@aicd-ci/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
            "@aicd-ci/plugin-sdk/testing": fileURLToPath(
                new URL("./packages/plugin-sdk/src/testing/index.ts", import.meta.url)
            ),
            "@aicd-ci/agent-pipeline-optimizer": src("agents/pipeline-optimizer"),
            "@aicd-ci/adapter-metrics-sources": src("adapters/metrics-sources"),
            "@aicd-ci/agent-release-guardian": src("agents/release-guardian"),
            "@aicd-ci/adapter-issue-trackers": src("adapters/issue-trackers"),
            "@aicd-ci/adapter-state-postgres": src("adapters/state-postgres"),
            "@aicd-ci/agent-security-triage": src("agents/security-triage"),
            "@aicd-ci/adapter-llm-anthropic": src("adapters/llm-anthropic"),
            "@aicd-ci/adapter-state-sqlite": src("adapters/state-sqlite"),
            "@aicd-ci/agent-test-selection": src("agents/test-selection"),
            "@aicd-ci/agent-release-notes": src("agents/release-notes"),
            "@aicd-ci/agent-intent-check": src("agents/intent-check"),
            "@aicd-ci/adapter-llm-openai": src("adapters/llm-openai"),
            "@aicd-ci/adapter-deployers": src("adapters/deployers"),
            "@aicd-ci/adapter-notifiers": src("adapters/notifiers"),
            "@aicd-ci/adapter-ci-github": src("adapters/ci-github"),
            "@aicd-ci/adapter-ci-gitlab": src("adapters/ci-gitlab"),
            "@aicd-ci/agent-risk-score": src("agents/risk-score"),
            "@aicd-ci/agent-postmortem": src("agents/postmortem"),
            "@aicd-ci/adapter-ci-local": src("adapters/ci-local"),
            "@aicd-ci/agent-triage": src("agents/triage"),
            "@aicd-ci/agent-flaky": src("agents/flaky"),
            "@aicd-ci/plugin-sdk": src("plugin-sdk"),
            "@aicd-ci/redaction": src("redaction"),
            "@aicd-ci/parsers": src("parsers"),
            "@aicd-ci/metrics": src("metrics"),
            "@aicd-ci/server": src("server"),
            "@aicd-ci/replay": src("replay"),
            "@aicd-ci/core": src("core"),
            "@aicd-ci/git": src("git"),
            "@aicd-ci/mcp": src("mcp")
        }
    },
    test: {
        include: ["packages/**/test/**/*.test.ts"]
    }
});
