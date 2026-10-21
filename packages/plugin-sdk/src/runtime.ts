import type {LLMUsage} from "./llm.js";

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface Budget {
    readonly limitUsd: number;
    readonly spentUsd: number;
    canSpend(): boolean;
    record(usage: LLMUsage): void;
}
