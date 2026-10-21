# aicd

**An AI layer you add to any CI/CD.** aicd diagnoses failed jobs, quarantines flaky tests, runs only the tests a
change needs, reviews merge requests against their ticket and their risk, triages security alerts, writes release
notes, watches deployments and rolls them back, and writes the post-mortem.

> Agents propose, deterministic policies decide, humans approve.

- **One step in your pipeline**, no server needed. GitHub Actions and GitLab CI built in, Docker for the rest.
- **Rules first, LLM second.** Works without any LLM. With one, every claim must quote the log, the diff or the code,
  or it is dropped.
- **Your LLM, your key**: Anthropic, OpenAI, or a local model through Ollama / vLLM. Secrets masked before anything
  leaves the runner.
- **Autonomy you control**, per agent and per environment, capped by organisation policies. aicd can never merge,
  push to a protected branch or delete a branch.
- **Everything audited**: `aicd explain` shows what a run saw, decided and did, and what the LLM cost.

## Quick start

```bash
npx @aicd-ci/cli init     # commented .aicd.yaml + the snippet for your CI
npx @aicd-ci/cli doctor   # checks the setup
```

```yaml
# GitHub Actions — after your tests
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
              llm-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

```yaml
# GitLab CI
include:
    - remote: https://raw.githubusercontent.com/cayrol-hub/aicd/v1/integrations/gitlab-component/templates/aicd.yml
```

Full pipelines: [GitHub](examples/github-workflow.yml), [GitLab](examples/gitlab-ci.yml). Step-by-step:
[getting started](docs/getting-started.md).

## What it does

| When                            | Command                                      | Agents                                                                                    |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Merge request opened or updated | `aicd review`                                | risk score, intent check against the ticket (Jira, GitHub Issues, Linear, Markdown specs) |
| Before the tests                | `aicd tests select`                          | test selection (per-test coverage, conventions, co-change; any doubt runs everything)     |
| After failing tests             | `aicd quarantine check`                      | gate: pass when every failure is a quarantined flaky test                                 |
| End of every pipeline           | `aicd analyze`                               | triage, flaky tests, security triage (SARIF), job timings                                 |
| Tag                             | `aicd release-notes`                         | release notes per audience, draft release                                                 |
| Deployment                      | `aicd deploy record`, `aicd guard`           | release guardian (Prometheus, Datadog, Sentry; Argo CD or webhook)                        |
| Incident                        | `aicd incident correlate`, `aicd postmortem` | suspect deployment and commits, blameless post-mortem                                     |
| Weekly                          | `aicd optimize`, `aicd dora`                 | pipeline optimizer, DORA metrics                                                          |
| Your coding agent               | `aicd mcp`                                   | read-only MCP server over the state                                                       |
| Outside pipelines               | `aicd serve`                                 | server mode: webhooks, durable queue, HTTP API                                            |

Details: [agents](docs/agents.md) · [server mode](docs/server.md) · [CLI reference](docs/reference/cli.md) ·
[configuration reference](docs/reference/configuration.md).

## Configuration

Layered: defaults → `.aicd.yaml` → `AICD_*` variables → `--set key=value`, capped by organisation policies
(`extends`). Validated by a JSON Schema (`schema/aicd.schema.json`).

```yaml
llm: {provider: anthropic, model: claude-opus-5-5, budget_per_run_usd: 0.3}
agents:
    triage: {autonomy: act}
    flaky: {autonomy: act, quarantine_after: 3}
    release_guardian:
        autonomy: {staging: act, production: propose}
comment: {language: fr}
```

## Security

Redaction before any LLM call, comment or audit entry; `send_code` (none / diff only / full) capped by policy;
no LLM call and no action on fork code; least-privilege tokens; signed releases with SBOM and provenance. Read the
[security model](docs/security.md); report vulnerabilities privately ([SECURITY.md](SECURITY.md)).

## Extending

Plugins add CI adapters, LLM providers, trackers, metrics sources, deployers, notifiers and state stores through
`@aicd-ci/plugin-sdk` (plugin API v1, frozen for 1.x) and are checked by its conformance kit:
[writing a plugin](docs/plugins.md).

## Development

Node.js ≥ 22.13 (24 recommended) and pnpm.

```bash
pnpm install
pnpm build      # tsc project references
pnpm test       # vitest on the sources
pnpm eval       # shadow mode on evals/fixtures, rules only
pnpm docs       # regenerate docs/reference and schema/
```

[Architecture](docs/architecture.md) · [contributing](CONTRIBUTING.md) · [decision records](docs/adr) ·
[changelog](CHANGELOG.md).

## License

[Apache 2.0](LICENSE)
