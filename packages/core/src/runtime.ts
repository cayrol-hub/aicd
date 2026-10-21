import {appendFileSync, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import type {AuditEntry, AuditKind, Budget, LLMUsage, Logger, StateStore} from "@aicd-ci/plugin-sdk";

export class RunBudget implements Budget {
    #spent = 0;

    constructor(readonly limitUsd: number) {}

    get spentUsd(): number {
        return this.#spent;
    }

    canSpend(): boolean {
        return this.#spent < this.limitUsd;
    }

    record(usage: LLMUsage): void {
        this.#spent += usage.costUsd;
    }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Logs go to stderr so stdout stays clean for `--json` and local comments. */
export function createLogger(
    level: LogLevel = "info",
    write: (line: string) => void = (line) => process.stderr.write(line)
): Logger {
    const threshold = LEVELS.indexOf(level);
    const log = (at: LogLevel) => (message: string) => {
        if (LEVELS.indexOf(at) >= threshold) write(`[aicd] ${at === "info" ? "" : `${at}: `}${message}\n`);
    };
    return {debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error")};
}

export function newRunId(now: Date = new Date()): string {
    return `run_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function redactDeep(value: unknown, redact: (text: string) => string): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDeep(child, redact)]));
    }
    return value;
}

/**
 * Writes every audit entry to the state store and, optionally, to a JSON Lines file. Each string of the payload
 * is redacted on its own (never the serialized JSON, which a mask could break). Recording never throws: a failed
 * write is reported through `onError` and the run goes on. Call `flush()` before exiting.
 */
export class Auditor {
    #pending: Promise<void>[] = [];

    constructor(
        private readonly state: StateStore,
        readonly runId: string,
        private readonly jsonlPath?: string,
        private readonly redact: (text: string) => string = (text) => text,
        private readonly onError: (error: Error) => void = () => {}
    ) {
        if (jsonlPath) mkdirSync(dirname(jsonlPath), {recursive: true});
    }

    record(agent: string, kind: AuditKind, payload: unknown): void {
        let safe: unknown;
        try {
            safe = redactDeep(JSON.parse(JSON.stringify(payload ?? null)) as unknown, this.redact);
        } catch (error) {
            safe = {unserializable: (error as Error).message};
        }
        const entry: AuditEntry = {runId: this.runId, at: new Date().toISOString(), agent, kind, payload: safe};
        this.#pending.push(this.state.appendAudit(entry).catch((error: Error) => this.onError(error)));
        if (this.jsonlPath) {
            try {
                appendFileSync(this.jsonlPath, `${JSON.stringify(entry)}\n`);
            } catch (error) {
                this.onError(error as Error);
            }
        }
    }

    async flush(): Promise<void> {
        const pending = this.#pending;
        this.#pending = [];
        await Promise.all(pending);
    }
}
