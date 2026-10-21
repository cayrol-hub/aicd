# Security model

aicd reads CI logs and code and may talk to an LLM and act on your forge. These are the guarantees.

## What leaves the runner

- Only after **redaction**: known token formats (GitHub, GitLab, AWS, Anthropic, Slack, Google, JWT, private
  keys, auth headers), `password=`/`token:`-style assignments, URL credentials, e-mails, IP addresses,
  high-entropy strings, the literal values of environment variables named like secrets, and your own patterns.
- `privacy.send_code`, capped by organisations:
    - `none`: no code and no diff ever reach the LLM;
    - `diff_only` (default): the merge request diff, and code excerpts only from files the merge request changes
      (security alerts, CI files touched by the change);
    - `full`: also excerpts of unchanged files (alerts elsewhere in the code, CI files on scheduled runs).
- Nothing at all with `llm.provider: none`. Local models (Ollama, vLLM) keep everything on your network.
- The key is yours; no request goes through a server of the project. No telemetry.

## What the LLM can make aicd do

- CI content (logs, diffs, ticket text, commit messages, alert payloads) is framed as data in prompts; system
  prompts say it is never instructions.
- LLM output is schema-validated. Claims must quote the data; unverifiable claims are dropped or downgraded.
- File changes are exact search/replace edits applied only when the searched text is found exactly once; the
  result is a **draft** merge request on an `aicd/fix-*` branch, never a push to a protected branch.
- Every action goes through the deterministic policy engine and the typed gateway. A manipulated model can only
  ask for what the configuration already allows.

## Forks and untrusted code

Code from forks: no LLM call and no action unless `security.allow_forks: true`. A fork controls the repository's
`.aicd.yaml` on its branch, so for fork code its `security`, `plugins` and `extends` keys are ignored and no plugin is
loaded: `allow_forks` and the organisation policies can only come from the pipeline (`AICD_*` variables, `--set`,
`AICD_EXTENDS`). In server mode, forks are detected from the webhook (head repository, source project). On GitHub,
never run aicd with secrets in `pull_request_target` workflows that check out the fork's code.

aicd only updates comments it wrote itself (matched by author, not only by marker), so a contributor cannot hijack
or suppress its reports by pasting a marker.

## Least privilege

| Integration    | Permissions                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions | `actions: read`, `pull-requests: write`; add `actions: write` (retries), `statuses: write`, `contents: write` (fix MRs, releases) only for the agents that need them |
| GitLab         | project access token, scope `api`, role Reporter (comments) or Developer (retries, fix MRs)                                                                          |
| Server         | bearer tokens for `/api` and `/mcp`; HMAC-verified GitHub webhooks, token-checked GitLab and alert webhooks                                                          |

## Supply chain

npm packages are published with provenance; the container image is signed with cosign (keyless) and carries an
SBOM and SLSA provenance; a source SBOM is attached to each GitHub release. Pin the GitHub Action and the image by
digest in sensitive pipelines.

## Plugins

Plugins declare the actions they may trigger; a plugin declaring a forbidden or unknown action is refused, and
organisations can restrict plugins to an allow-list (`plugins.allowed` in policies).

## Audit

Every run records its inputs (redacted), LLM calls (model, tokens, cost, accepted or not), decisions and actions:
`aicd explain <run-id>`, `GET /api/runs/:id` in server mode, or a JSON Lines export (`audit.jsonl`).

Report vulnerabilities privately: [SECURITY.md](../SECURITY.md).
