# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
(Security → Report a vulnerability) on this repository. You will get an answer within 7 days.

Of particular interest:

- a secret or personal data that reaches the LLM, a comment, an issue, a notification or the audit log unmasked;
- a way for CI content (log, diff, commit message, ticket, alert payload) to make aicd take an action its policies
  forbid, or to push to a protected branch;
- a way to run aicd with secrets or an LLM on code from a fork;
- a way to get the server to act on an unauthenticated or forged webhook.

## What aicd sends to the LLM

Only after redaction, and only what the agent needs:

| Agent              | Data                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Triage             | excerpt of each failed job log (around the error lines, 300 lines at most), failing tests and their history, the merge request diff (`send_code` ≠ none) |
| Security triage    | the alert and ±20 lines of the flagged file (`send_code` ≠ none)                                                                                         |
| Pipeline optimizer | findings and the CI configuration files                                                                                                                  |
| Intent check       | ticket title, description and criteria, the merge request diff (`send_code` ≠ none)                                                                      |
| Release notes      | commit subjects and bodies, merge request titles                                                                                                         |
| Release guardian   | metric summaries, new error titles, shipped commit subjects                                                                                              |
| Post-mortem        | the incident timeline and suspect commit subjects                                                                                                        |

Nothing is sent with `llm.provider: none`; nothing leaves your network with a local model. The key is yours;
nothing goes through a server of the project. Full model: [docs/security.md](docs/security.md).
