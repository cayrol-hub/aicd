# Changelog

## 1.0.1

### Fixed

- JUnit reports written by Node's `node --test` reporter: test cases placed directly under `<testsuites>` were
  ignored, and tests were keyed by the generic classname `test`. They are now read, and keyed by their file path
  relative to the repository.
- Risk score: a migration that destroys data (DROP TABLE, DROP COLUMN, TRUNCATE…) is high risk on its own, whatever
  the score; the comment says why.
- Release: npm packages are published with their provenance attestation (`npm publish --provenance`).

## 1.0.0

First stable version. The plugin API (`@aicd-ci/plugin-sdk` 1.x, `PLUGIN_API_VERSION` 1) is frozen.

### Agents

- **Triage** (v0.1): fingerprints, rules, test history, verified LLM diagnosis, retries of flaky/infrastructure jobs.
- **Flaky tests** (v0.2): scores, quarantine and release, issues, `quarantine check` gate.
- **Test selection** (v0.3): lcov per-test coverage, Cobertura/JaCoCo, conventions, git co-change, safe fallbacks.
- **Security triage** (v0.3): SARIF 2.1.0, baseline on the default branch, verified verdicts, fix merge requests.
- **Pipeline optimizer** (v0.3): slow, uncached, serialized, duplicated, non-cancellable and retried jobs; verified YAML fixes.
- **Intent check** (v0.4): acceptance criteria from Jira, GitHub Issues, Linear, Markdown specs; verified coverage verdicts.
- **Risk score** (v0.4): deterministic, explainable score; labels, statuses, full test suite on high risk.
- **Release notes** (v0.4): conventional commits, per-audience rewrites citing real commits, draft releases.
- **Release guardian** (v0.5): metrics and new errors before/after a deployment; pause or rollback per environment.
- **Post-mortem** (v0.5): incident correlation, timeline, blameless document.

### Platform

- CLI with 22 commands, GitHub Actions and GitLab CI integrations, Docker image.
- Shadow mode (`replay`, `--llm-only`), evaluation matrix across LLM families, release gate.
- DORA metrics, read-only MCP server (stdio and HTTP).
- Server mode: signed webhooks, durable queue, HTTP API; SQLite or Postgres state.
- LLM providers: Anthropic (default `claude-opus-5-5`), OpenAI, OpenAI-compatible local servers (Ollama, vLLM).
- Policies: autonomy ceilings per agent and environment, forbidden actions, LLM and plugin allow-lists, `send_code` cap.
- Plugin loader and conformance kit; JSON Schema of the configuration; generated configuration and CLI references.
