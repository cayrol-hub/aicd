# 4. Plugin API version 1 is frozen

Date: 2026-10-21 · Status: accepted

## Decision

`@aicd/plugin-sdk` 1.x is the only stable contract: actions, CI/LLM/state/tracker/metrics/deployer/notifier
interfaces, agent runtime and results, record types, plugin manifest (`apiVersion: 1`). Its declarations are
tracked in `packages/plugin-sdk/api-report.d.ts`; CI fails on any unreviewed change. Additive changes go in minor
versions; anything that breaks a plugin needs a new major version, a new `PLUGIN_API_VERSION` and an ADR.
Everything else (core, agents, CLI internals) may change in minor versions.

## Consequences

Plugins are refused at load time when their `apiVersion` differs. The conformance kit
(`@aicd/plugin-sdk/testing`) is part of the contract.
