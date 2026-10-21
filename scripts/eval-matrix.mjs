// Evaluates the triage agent on evals/fixtures with every LLM family available here, LLM alone
// (`--llm-only`) and with rules first, and writes evals/results/<date>.md. Run after `pnpm build`.
//   ANTHROPIC_API_KEY → claude-opus-5-5 and claude-sonnet-5-5
//   OPENAI_API_KEY    → AICD_EVAL_OPENAI_MODEL (required to include OpenAI)
//   Ollama on :11434  → AICD_EVAL_OLLAMA_MODEL (default llama3.1:8b)
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";

const cli = new URL("../packages/cli/dist/bin.js", import.meta.url).pathname;
const fixtures = new URL("../evals/fixtures", import.meta.url).pathname;

async function ollamaUp() {
    try {
        return (await fetch("http://localhost:11434/api/tags", {signal: AbortSignal.timeout(2000)})).ok;
    } catch {
        return false;
    }
}

const candidates = [
    {label: "rules only", set: ["llm.provider=none"]},
    ...(process.env.ANTHROPIC_API_KEY
        ? [
              {
                  label: "Anthropic claude-opus-5-5",
                  set: ["llm.provider=anthropic", "llm.model=claude-opus-5-5"],
                  llm: true
              },
              {
                  label: "Anthropic claude-sonnet-5-5",
                  set: ["llm.provider=anthropic", "llm.model=claude-sonnet-5-5"],
                  llm: true
              }
          ]
        : []),
    ...(process.env.OPENAI_API_KEY && process.env.AICD_EVAL_OPENAI_MODEL
        ? [
              {
                  label: `OpenAI ${process.env.AICD_EVAL_OPENAI_MODEL}`,
                  set: ["llm.provider=openai", `llm.model=${process.env.AICD_EVAL_OPENAI_MODEL}`],
                  llm: true
              }
          ]
        : []),
    ...((await ollamaUp())
        ? [
              {
                  label: `Ollama ${process.env.AICD_EVAL_OLLAMA_MODEL ?? "llama3.1:8b"} (local)`,
                  set: ["llm.provider=ollama", `llm.model=${process.env.AICD_EVAL_OLLAMA_MODEL ?? "llama3.1:8b"}`],
                  llm: true
              }
          ]
        : [])
];

const rows = [];
for (const candidate of candidates) {
    for (const llmOnly of candidate.llm ? [true, false] : [false]) {
        const args = [
            cli,
            "replay",
            "--fixtures",
            fixtures,
            "--json",
            "-q",
            "--set",
            "llm.budget_per_run_usd=5",
            ...candidate.set.flatMap((s) => ["--set", s])
        ];
        if (llmOnly) args.push("--llm-only");
        const result = JSON.parse(
            execFileSync("node", args, {encoding: "utf8", env: {...process.env, NODE_NO_WARNINGS: "1"}})
        );
        rows.push(
            `| ${candidate.label} | ${llmOnly ? "LLM alone" : "rules first"} | ${(result.accuracy * 100).toFixed(1)} % (${result.correct}/${result.total}) | ${result.llmCalls} | ${result.costUsd.toFixed(4)} |`
        );
        console.log(rows.at(-1));
    }
}

const date = new Date().toISOString().slice(0, 10);
mkdirSync(new URL("../evals/results/", import.meta.url), {recursive: true});
writeFileSync(
    new URL(`../evals/results/${date}.md`, import.meta.url),
    `# Triage evaluation — ${date}\n\n${candidates.length - 1} LLM configuration(s) available on the machine that ran it.\n\n| Model | Mode | Accuracy | LLM calls | Cost (USD) |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`
);
console.log(`evals/results/${date}.md written`);
