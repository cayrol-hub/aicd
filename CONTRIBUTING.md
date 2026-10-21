# Contributing to aicd

Thank you for helping. Issues labelled `good first issue` are a good start — adapters especially.

## Setup

```bash
nvm use            # Node 24, see .nvmrc
pnpm install
pnpm build && pnpm test
```

## Rules

- **Every change keeps `pnpm build`, `pnpm test`, `pnpm format:check` and `pnpm eval` green**, and `pnpm docs`
  leaves no diff (configuration schema, references and the plugin API report are generated).
- A change to an agent comes with replay fixtures (`evals/fixtures/<case>/`) that show the improvement.
- Only `@aicd-ci/plugin-sdk` is a public contract (plugin API v1, frozen for 1.x). Additive changes show up in
  `packages/plugin-sdk/api-report.d.ts`; breaking ones need a major version and an ADR in `docs/adr/`.
- New agents follow the contract in `docs/architecture.md`: rules first, `callLlm` only, verified evidence,
  proposals only, one comment per agent, en/fr texts.
- No action that cannot be undone (merge, push to a protected branch, branch deletion) will ever be accepted.
- Anything sent to an LLM goes through the redactor first. Tests cover it.
- Logs go to stderr; stdout is reserved for command output (`--json`, local comments).

## Commits

Sign off your commits ([DCO](https://developercertificate.org/)): `git commit -s`.
Conventional commit messages are appreciated: `feat(triage): …`, `fix(gitlab): …`.

## Writing an adapter or plugin

Implement an interface of `@aicd-ci/plugin-sdk` (`CIProviderFactory`, `LLMProvider`, `StateStore`) and publish it as
`aicd-plugin-<name>`. Look at `packages/adapters/ci-gitlab` for a complete example with tests using a fake `fetch`.
