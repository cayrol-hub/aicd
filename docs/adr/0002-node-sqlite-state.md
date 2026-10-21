# 2. State on Node's built-in SQLite

Date: 2026-10-21 · Status: accepted

## Context

The design document planned `better-sqlite3`. It is a native module: it must be compiled or downloaded for the
runner's platform, which slows `npx` on every CI run and fails on some images.

## Decision

Use `node:sqlite` (built into Node.js ≥ 22.13, no flag). Minimum Node version: 22.13; recommended: 24.

## Consequences

- No native dependency, the CLI installs with plain `npx`.
- `node:sqlite` may print an experimental warning on some Node versions.
- The `StateStore` interface keeps the door open to Postgres (server mode) and S3-backed files.
