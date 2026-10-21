# 3. Server mode on node:http with a queue on the state store

Date: 2026-10-21 · Status: accepted

## Context

Server mode needs webhooks, a small authenticated API and a durable queue. A web framework and Redis would add
dependencies and infrastructure for a handful of routes and modest volumes.

## Decision

- `node:http` with a small router, body limit, JSON-only, constant-time token checks, HMAC verification.
- The queue is a collection of the state store (SQLite or Postgres): dedupe by delivery id, retries with backoff,
  resume on restart, at-least-once delivery. Handlers must be idempotent.

## Consequences

One process, one database. Horizontal scaling (several workers on one queue) needs row locking in the Postgres
store; until then run one instance per database.
