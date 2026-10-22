# Changelog

## 1.0.2

### Changed

- Clearer, fuller comments, so that a reader gets the whole picture without opening the logs:
    - **Triage**: the pipeline, commit and job links; each failing test with its assertion message and location; what
      the diagnosis means and the next steps for its category; how aicd reached it (known failures, rules, test history,
      LLM, and why the LLM was not used).
    - **Risk score**: what the level means, a checklist for the reviewer built from the signals that scored, why the
      `aicd/risk` check fails, the signals with no points and how the score is computed.
    - **Intent check**: without an LLM verdict, the acceptance criteria become a checklist for the reviewer, with how
      to enable the automatic check; how to link a ticket.
    - **Security**: the flagged code (redacted) for each new alert, what to do for its verdict, how to dismiss a false
      positive, why the `aicd/security` check fails or passes.
    - **Flaky tests**: what flaky and quarantined mean, and what to do.
    - Suggested actions an agent may not run say why (the agent's autonomy, the autonomy each action needs) and come
      before the footer.

### Fixed

- Security: a default branch scanned without any alert was reported as "never scanned". Each scan of the default
  branch is now recorded, with or without alerts.
- Triage: a probable regression quotes the failing tests' assertion messages as evidence, instead of the first error
  line of the log.
- Release: npm packages are published under the `next` tag, and `latest` moves only once the registry serves all of
  them. During the 1.0.1 release, `npx @aicd-ci/cli@1` failed for a few minutes because the CLI was installable before
  one of its dependencies.

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
