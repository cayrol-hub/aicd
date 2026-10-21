# Agents

Every agent follows the same contract: rules and history first, the LLM only to refine, every LLM claim checked
against the data, and **proposals only** — the policy engine decides with the autonomy you configured.

| Agent              | Command                            | Uses the LLM for                                                                                       | Proposes (minimum autonomy)                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Triage             | `analyze`                          | Diagnosis when no rule, known failure or history explains it; quotes verified against the log and diff | comment (advise), retry of flaky/infra jobs (act), fix MR (propose)                    |
| Flaky tests        | `analyze`                          | —                                                                                                      | quarantine / release (act), one issue per quarantined test (propose), comment (advise) |
| Test selection     | `tests select`                     | —                                                                                                      | comment when tests are skipped (advise); the selection itself is output                |
| Security triage    | `analyze` (SARIF)                  | Exploitability verdict quoting the code; critical alerts never dismissed by the LLM                    | comment (advise), status (act), fix MR (propose)                                       |
| Pipeline optimizer | `optimize`                         | YAML edits, accepted only if they apply, parse and remove the finding                                  | issue / fix MR (propose), comment (advise)                                             |
| Intent check       | `review`                           | Criterion by criterion verdict quoting the diff; unrequested changes                                   | comment (advise), status (act)                                                         |
| Risk score         | `review`                           | — (deterministic, explainable)                                                                         | label and status (act), comment (advise)                                               |
| Release notes      | `release-notes`                    | Audience rewrites citing existing commits only                                                         | draft release (propose), published with act                                            |
| Release guardian   | `guard`                            | Explanation and suspect commit (must be a shipped commit)                                              | pause / rollback (act, per environment), notification (advise)                         |
| Post-mortem        | `incident correlate`, `postmortem` | Ranking of suspect commits, narrative citing timeline entries                                          | issue, post-mortem MR (propose), notification (advise)                                 |

## Rules worth knowing

- **Triage** order: known fingerprint → rules (network, resources, registry, dependencies, configuration) →
  test history (flaky) → LLM → deterministic fallback. Confident diagnoses are reused next time without the LLM.
- **Flaky tests**: flaky when the test passed and failed on the same commit, or flipped repeatedly. Quarantined
  tests still run; `quarantine check` lets the pipeline pass only when every failure is quarantined.
- **Test selection**: any doubt runs everything — default or release branch, tag, lockfile/CI/build config change,
  stale or missing map, unmapped source file, too many files, high risk (from `review`).
- **Security**: the default branch records a baseline; merge requests only report new alerts.
- **Risk**: size, sensitive paths, migrations and destructive SQL, fix history of the files, missing tests,
  dependency and CI changes, CODEOWNERS teams touched. Same input, same score.
- **Release guardian**: no data is never "healthy"; one degradation pauses, two or one severe roll back.

Detailed options: [configuration reference](reference/configuration.md).
