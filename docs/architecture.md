# Architecture

aicd is a layer on top of an existing CI/CD, not a CI engine. Every feature follows one rule:
**agents propose, deterministic policies decide, the gateway acts, humans approve.**

```text
 events                 understanding                     decision                 action
 ───────────            ──────────────────────            ─────────────            ───────────────────
 pipeline step   ──►    adapters (CI, VCS, trackers,  ──►  policy engine  ──►       gateway ──► CI, trackers,
 webhooks               metrics) + redaction               (no LLM):                (typed)      deployers,
 alerts                 + state (history, graph)           autonomy, caps,                       notifiers
                        + agents (rules first,             forbidden actions
                          LLM optional, evidence
                          verified)                        audit log ◄──── every input, LLM call, decision, action
```

## Packages

| Layer    | Packages                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract | `@aicd/plugin-sdk` (the only stable API, plugin API version 1) and its conformance kit `@aicd/plugin-sdk/testing`                                                 |
| Core     | `@aicd/core` (configuration, policies, policy engine, gateway, budget, audit, LLM call helper, safe file edits, plugin loader)                                    |
| Helpers  | `@aicd/redaction`, `@aicd/parsers`, `@aicd/git`, `@aicd/metrics`                                                                                                  |
| Agents   | triage, flaky, test-selection, security-triage, pipeline-optimizer, intent-check, risk-score, release-notes, release-guardian, postmortem                         |
| Adapters | CI (GitHub, GitLab, local), LLM (Anthropic, OpenAI-compatible incl. Ollama/vLLM), state (SQLite, Postgres), issue trackers, metrics sources, deployers, notifiers |
| Surfaces | `@aicd/cli` (the `aicd` command), `@aicd/server` (webhooks, durable queue, HTTP API), `@aicd/mcp` (read-only MCP server), `@aicd/replay` (shadow mode)            |

## Two modes

**Pipeline mode** (default): aicd is a step of the pipeline. State is a SQLite file kept by the CI cache.
No infrastructure. **Server mode**: a long-running process receives webhooks (pipelines, merge requests,
deployments, tags, alerts) into a durable queue and runs the same agents; state in Postgres. Needed for what
happens outside a pipeline: watching deployments, correlating incidents, cross-repository metrics.

## An agent

1. Receives an `AgentRuntime` (context, state, optional LLM, budget, logger, redactor, language, `sendCode`).
2. Reads through `ReadonlyCI` only; may keep its own bookkeeping in state collections.
3. Decides with rules and statistics first. Calls the LLM only through `callLlm` (budget, forks, failures handled),
   with a zod schema, data framed in tags, and **keeps only claims whose quotes or ids are verified**.
4. Returns an `AgentResult`: a report and `ProposedAction`s. It never acts.

## Decision and action

`decide(action, autonomy)` maps each action to the minimum autonomy it needs (comment/notify: advise;
fix MR, issue, draft release: propose; labels, statuses, retries, quarantine, pause/rollback: act) and returns
apply / downgrade (becomes a suggestion in the comment) / observe / deny. Organisation policies cap autonomy per
agent and per environment and can forbid actions; `merge`, pushing to a protected branch and deleting a branch are
forbidden in code. `executeDecisions` runs applied actions; a failing action is logged, never fatal.

Decision records: [`docs/adr`](adr).
