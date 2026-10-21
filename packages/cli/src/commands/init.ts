import {existsSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {glob} from "tinyglobby";
import type {Logger} from "@aicd/plugin-sdk";

const CONFIG_TEMPLATE = (
    junit: string[]
) => `# yaml-language-server: $schema=https://raw.githubusercontent.com/cayrol-hub/aicd/main/schema/aicd.schema.json
# aicd configuration. Every key is optional; the values below are the defaults unless noted.
# Override any key with AICD_<PATH> (e.g. AICD_AGENTS_TRIAGE_AUTONOMY=act) or --set path=value.
# Full reference: https://github.com/cayrol-hub/aicd/blob/main/docs/reference/configuration.md

# extends: ./policies.yaml          # organisation ceilings (file or https URL)

llm:
  provider: anthropic               # anthropic | openai | ollama | none (rules only)
  model: claude-opus-5-5
  budget_per_run_usd: 0.3

# Autonomy: observe (log) < advise (comment) < propose (draft MR, issue) < act (labels, retries, rollbacks…)
agents:
  triage: {autonomy: advise}        # failed jobs: cause, evidence, retry of flaky/infra failures (act)
  flaky: {autonomy: advise}         # flaky test scores and quarantine (act)
  security_triage: {autonomy: advise}
  intent_check: {autonomy: advise}  # diff vs ticket acceptance criteria
  risk_score: {autonomy: advise}    # labels and status need act
  pipeline_optimizer: {autonomy: propose}
  release_notes: {autonomy: propose}

inputs:
  junit:${junit.map((pattern) => `\n    - "${pattern}"`).join("")}

privacy:
  send_code: diff_only              # none | diff_only | full

comment:
  language: en                      # en | fr
`;

const SNIPPETS: Record<string, string> = {
    github: `# .github/workflows/<your workflow>.yml — after your test jobs (full example: examples/github-workflow.yml)
  aicd:
    needs: [test]
    if: always()
    runs-on: ubuntu-latest
    permissions: {actions: read, contents: read, pull-requests: write}
    steps:
      - uses: actions/checkout@v4
      - uses: cayrol-hub/aicd/integrations/github-action@v1
        with:
          command: analyze
          llm-api-key: \${{ secrets.ANTHROPIC_API_KEY }}`,
    gitlab: `# .gitlab-ci.yml (full example: examples/gitlab-ci.yml)
include:
  - remote: https://raw.githubusercontent.com/cayrol-hub/aicd/v1/integrations/gitlab-component/templates/aicd.yml
# Add masked CI/CD variables AICD_GITLAB_TOKEN (project access token, scope api) and ANTHROPIC_API_KEY.`,
    other: `# Any other CI: at the end of the pipeline
docker run --rm -e AICD_LLM_API_KEY -v "$PWD:/repo" ghcr.io/cayrol-hub/aicd analyze --ci local --log path/to/job.log`
};

export function detectCi(cwd: string): "github" | "gitlab" | "other" {
    if (existsSync(resolve(cwd, ".gitlab-ci.yml"))) return "gitlab";
    if (existsSync(resolve(cwd, ".github/workflows"))) return "github";
    return "other";
}

/** `aicd init`: writes a commented .aicd.yaml and prints the snippet to add to the pipeline. */
export async function init(options: {force?: boolean}, logger: Logger, cwd: string = process.cwd()): Promise<number> {
    const ci = detectCi(cwd);
    const found = await glob(["**/junit*.xml", "**/TEST-*.xml", "**/test-results/**/*.xml"], {
        cwd,
        ignore: ["**/node_modules/**", "**/.git/**"]
    });
    const junit =
        found.length > 0
            ? [...new Set(found.map((file) => file.replace(/[^/]+$/, "*.xml")))].slice(0, 5)
            : ["**/junit*.xml", "**/TEST-*.xml"];

    const target = resolve(cwd, ".aicd.yaml");
    if (existsSync(target) && !options.force) {
        logger.warn(".aicd.yaml already exists (use --force to overwrite)");
    } else {
        writeFileSync(target, CONFIG_TEMPLATE(junit));
        logger.info(`wrote ${target}`);
    }
    logger.info(
        `detected CI: ${ci}${found.length > 0 ? ` · JUnit reports: ${junit.join(", ")}` : " · no JUnit report found yet"}`
    );
    logger.info("next: `aicd doctor` checks the setup; `aicd replay` scores the agents on your past failures");
    process.stdout.write(`\n${SNIPPETS[ci]}\n`);
    return 0;
}
