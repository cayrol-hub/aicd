# Getting started

aicd runs as steps of your existing pipeline. Nothing to host. Without an LLM key it works with rules only.

## 1. Configure

```bash
npx @aicd-ci/cli init      # writes a commented .aicd.yaml and prints the snippet for your CI
npx @aicd-ci/cli doctor    # checks configuration, CI detection, state, LLM and integrations
```

Every agent starts at a cautious autonomy (`advise`: it comments, it does not act). Raise it per agent when you
trust it: `observe` < `advise` < `propose` (draft fixes, issues, releases) < `act` (labels, statuses, retries,
quarantine, rollbacks).

## 2. Add the steps

| When                                      | Command                                | What it does                                               |
| ----------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Start of a merge request pipeline         | `aicd review`                          | Risk score, intent check against the ticket                |
| Before the tests                          | `aicd tests select --format args`      | Only the tests the change needs (empty = all)              |
| After the tests, on failure               | `aicd quarantine check`                | Pass when every failing test is a known flaky test         |
| End of every pipeline                     | `aicd analyze`                         | Triage failures, flaky tests, security alerts, job timings |
| Default branch, after a run with coverage | `aicd tests map`                       | Refresh the test → source map                              |
| Tag pipeline                              | `aicd release-notes`                   | Notes and a draft release                                  |
| Deploy job                                | `aicd deploy record` then `aicd guard` | DORA data; pause or roll back a degrading deployment       |
| Weekly schedule                           | `aicd optimize`, `aicd dora`           | CI cost and speed findings, delivery metrics               |

Complete pipelines: [examples/github-workflow.yml](../examples/github-workflow.yml),
[examples/gitlab-ci.yml](../examples/gitlab-ci.yml). Every key: [examples/aicd.full.yaml](../examples/aicd.full.yaml).

### GitHub Actions

```yaml
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

The action sets up Node 24 for the rest of the job: run it after your own steps, or in a job of its own. Its
`stdout` output carries the command's output (e.g. `tests select --format args`).

### GitLab CI

```yaml
include:
    - remote: https://raw.githubusercontent.com/cayrol-hub/aicd/v1/integrations/gitlab-component/templates/aicd.yml
```

Masked CI/CD variables: `AICD_GITLAB_TOKEN` (project access token, scope `api`) and `ANTHROPIC_API_KEY`.

### Anything else

```bash
docker run --rm -e AICD_LLM_API_KEY -v "$PWD:/repo" ghcr.io/cayrol-hub/aicd analyze --ci local --log job.log --junit "**/junit.xml"
```

## 3. Choose the LLM

```yaml
llm: {provider: anthropic, model: claude-opus-5-5} # default
llm: {provider: openai, model: <model>, api_key_env: OPENAI_API_KEY}
llm: {provider: ollama, model: llama3.1:8b} # local, nothing leaves your network
llm: {provider: none} # rules only
```

## 4. Check what it did

`aicd explain` shows the last run: inputs, LLM calls and their cost, decisions, actions. Before raising
autonomy, run `aicd replay --fixtures <dir>` on labelled past failures (see [evaluation](evaluation.md)).
