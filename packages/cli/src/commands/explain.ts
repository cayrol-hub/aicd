import type {AuditEntry} from "@aicd/plugin-sdk";
import {EXIT, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

function summarize(report: unknown): string {
    if (!report || typeof report !== "object") return "";
    const value = report as Record<string, unknown>;
    if (Array.isArray(value.findings)) {
        return (value.findings as Record<string, unknown>[])
            .map((f) =>
                [
                    f.jobName,
                    f.category ?? f.kind ?? f.code,
                    f.confidence ? `(${String(f.confidence)})` : undefined,
                    f.title
                ]
                    .filter(Boolean)
                    .join(" ")
            )
            .join("; ");
    }
    for (const key of ["level", "verdict", "full"]) if (key in value) return `${key} ${JSON.stringify(value[key])}`;
    return Object.keys(value).slice(0, 6).join(", ");
}

function describe(entry: AuditEntry): string {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    switch (entry.kind) {
        case "run":
            return `run on ${payload.provider} · llm ${payload.llm}${payload.configFile ? ` · ${payload.configFile}` : ""}`;
        case "finding":
            return `${entry.agent}: ${summarize(payload.report)} · ${payload.llmCalls ?? 0} LLM call(s)`;
        case "llm_call":
            return `${entry.agent}: LLM ${payload.model} ${payload.inputTokens} in / ${payload.outputTokens} out · ${Number(payload.costUsd).toFixed(4)} USD · ${payload.accepted ? "accepted" : "rejected"}${payload.detail ? ` (${payload.detail})` : ""}`;
        case "decision":
            return `${entry.agent}: ${payload.type} → ${payload.verdict} (${payload.reason})`;
        case "action":
            return `${entry.agent}: ${payload.type} ${payload.outcome}${payload.detail ? ` (${payload.detail})` : ""}`;
        default:
            return `${entry.agent}: ${entry.kind} ${JSON.stringify(payload)}`;
    }
}

/** `aicd explain [run-id]`: what a run saw, decided and did. Default: the last run. */
export async function explain(runId: string | undefined, options: GlobalOptions & {state?: string}): Promise<number> {
    const session = await Session.open({
        ...options,
        ci: "local",
        noLlm: true,
        readOnly: true,
        ...(options.state ? {statePath: options.state} : {})
    });
    try {
        const id = runId ?? (await session.state.listRuns(1))[0]?.runId;
        const entries = id ? await session.state.listAudit(id) : [];
        if (!id || entries.length === 0) {
            session.logger.error(id ? `unknown run ${id}` : "no run recorded yet");
            return EXIT.invalidConfig;
        }
        process.stdout.write(
            options.json
                ? `${JSON.stringify(entries, null, 2)}\n`
                : `${id}\n${entries.map((entry) => `  ${entry.at}  ${describe(entry)}`).join("\n")}\n`
        );
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
