# Server mode

Pipeline mode covers what happens inside pipelines. Server mode adds what happens outside them: deployments
reported by the forge, alerts from monitoring, cross-repository history. It runs the same agents.

```bash
AICD_DATABASE_URL=postgres://… AICD_API_TOKENS=<token> \
AICD_GITHUB_WEBHOOK_SECRET=… AICD_GITHUB_TOKEN=… \
aicd serve --set state.backend=postgres
```

| Endpoint                                                    | Purpose                                                 | Auth                                      |
| ----------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `POST /webhooks/github`                                     | workflow runs, pull requests, deployment statuses, tags | `X-Hub-Signature-256` (HMAC)              |
| `POST /webhooks/gitlab`                                     | pipeline, merge request, deployment and tag hooks       | `X-Gitlab-Token`                          |
| `POST /webhooks/alerts/{sentry,alertmanager,generic}`       | incidents                                               | bearer / `X-Aicd-Token`; Sentry signature |
| `GET /api/runs`, `/api/runs/:id`                            | runs and their audit log                                | bearer                                    |
| `GET /api/quarantine`, `/api/deployments`, `/api/incidents` | state                                                   | bearer                                    |
| `GET /api/metrics/dora?environment=&days=`                  | DORA metrics                                            | bearer                                    |
| `POST /mcp`                                                 | read-only MCP (streamable HTTP)                         | bearer                                    |
| `GET /healthz`, `/readyz`                                   | probes                                                  | none                                      |

| Event                          | Flow                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| Failed pipeline                | triage (`analyze` on the forge's logs)                       |
| Merge request opened / updated | `review` (risk, intent)                                      |
| Successful deployment          | record + release guardian (waits for the observation window) |
| Alert opened / resolved        | incident record + correlation / post-mortem                  |

Events go into a durable queue on the state store (deduplicated by delivery id, retried with backoff, resumed after
a restart). Delivery is at-least-once: every flow is idempotent (comments are updated in place, records upserted).
Forge credentials come from the server's environment (`AICD_GITHUB_TOKEN`, `AICD_GITLAB_TOKEN`), never from payloads.

## Limits

- The server has no checkout of the repositories it serves: on failed pipelines it triages from the forge's job
  logs only (JUnit, SARIF and coverage are read by `aicd analyze` in the pipeline). Risk scores use the diff only.
- One state per repository: test history, quarantine and coverage map are not keyed by repository. Serve several
  repositories with one server per repository (or one Postgres schema each).
- The release guardian runs beside the queue so it does not hold a worker during its observation window; a guard
  interrupted by a restart is not resumed (re-run `aicd guard --deployment <id>`). A deployment is guarded once.
- Alerts carry no repository: post-mortems are written to the server's workspace and proposed through the issue
  tracker, not as a merge request.
