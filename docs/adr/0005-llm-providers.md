# 5. LLM providers: official SDK for Anthropic, plain HTTP for OpenAI-compatible servers

Date: 2026-10-21 · Status: accepted

## Decision

- Anthropic through `@anthropic-ai/sdk` (structured outputs with zod, server-side fallbacks on safety declines,
  prompt caching of the system prompt, cost from usage).
- OpenAI and every OpenAI-compatible server (Ollama, vLLM, LM Studio…) through `POST /chat/completions` with a
  strict JSON schema, without SDK: one small adapter covers hosted and local models.
- Default model `claude-opus-5-5`; the design document's open question on the default stays open until the
  evaluation matrix has run on real failures.

## Consequences

Local models keep all data on the network. Providers aicd has no price for report a cost of 0 unless `llm.prices`
is set, and their budget is then not enforced.
