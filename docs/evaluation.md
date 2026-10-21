# Evaluation

An agent earns autonomy with numbers, not promises.

## Shadow mode

`aicd replay --fixtures evals/fixtures` runs the triage agent on labelled past failures and publishes nothing.
A case is a directory: `job.log`, optional `junit.xml`, `diff.patch`, `history.json` (past outcomes, most recent
first) and `expected.json` (`{"category": "...", "note": "..."}`). Build your own set from real failures of your
pipelines: it is the only number that tells you what aicd is worth on _your_ CI.

## Release gate

CI runs `aicd replay --min-accuracy 0.9` with rules only; a version is not released below it.

## Comparing LLMs

`node scripts/eval-matrix.mjs` evaluates every LLM family available on the machine (Anthropic with
`ANTHROPIC_API_KEY`, OpenAI with `OPENAI_API_KEY` + `AICD_EVAL_OPENAI_MODEL`, a local Ollama), each **LLM alone**
(`--llm-only`, rules skipped) and **rules first**, and writes `evals/results/<date>.md`. It spends real money on the
hosted providers; budget per configuration: 5 USD.

## Known limits

The bundled set (20 cases) was written by the maintainers together with the rules: 100 % on it says the rules do
what they were written for, not how they generalise. Contributions of anonymised real failures are the most useful
contribution to the project.
