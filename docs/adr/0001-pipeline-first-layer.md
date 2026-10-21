# 1. A layer on top of existing CIs, pipeline mode first

Date: 2026-10-21 · Status: accepted

## Context

Teams already run GitHub Actions, GitLab CI, Jenkins… Replacing their CI engine brings nothing AI-related and
blocks adoption. Requiring a server before the first useful comment also blocks adoption.

## Decision

- aicd is a CLI that runs as one step of the existing pipeline. CI-specific code lives in thin adapters.
- State (known failures, test history, audit) is a SQLite file kept by the CI cache. A server mode comes later
  (v0.5) for what needs events outside a pipeline.
- Inputs are standard formats only (JUnit XML, raw logs, unified diffs; coverage and SARIF later).
- Agents propose; a deterministic policy engine decides; a typed gateway acts.

## Consequences

- History is bounded by the cache lifetime in pipeline mode.
- Each CI needs an adapter; GitHub and GitLab are official, others go through the local adapter and Docker.
