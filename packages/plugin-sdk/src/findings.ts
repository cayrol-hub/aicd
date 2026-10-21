import type {ProposedAction} from "./actions.js";

export type FailureCategory =
    "regression" | "flaky_test" | "infrastructure" | "configuration" | "dependency" | "unknown";

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
    "regression",
    "flaky_test",
    "infrastructure",
    "configuration",
    "dependency",
    "unknown"
];

export type Confidence = "low" | "medium" | "high";

export const CONFIDENCE_LEVELS: readonly Confidence[] = ["low", "medium", "high"];

export function confidenceAtLeast(value: Confidence, minimum: Confidence): boolean {
    return CONFIDENCE_LEVELS.indexOf(value) >= CONFIDENCE_LEVELS.indexOf(minimum);
}

export interface Evidence {
    kind: "log" | "diff" | "test" | "history" | "code" | "metric" | "ticket" | "commit";
    /** Where to look: "log L123", "src/app.ts:42", a test id, a metric name… */
    ref: string;
    /** Verbatim text from the referenced source. */
    quote?: string;
}

export interface Finding {
    agent: string;
    jobId?: string;
    jobName?: string;
    fingerprint?: string;
    category: FailureCategory;
    summary: string;
    cause?: string;
    suggestedFix?: string;
    confidence: Confidence;
    evidence: Evidence[];
    /** heuristic = rules only, cache = known fingerprint, llm = model analysis that passed verification. */
    source: "heuristic" | "cache" | "llm";
    failingTests: string[];
    actions: ProposedAction[];
}

/** What every agent returns: actions for the policy engine, plus what it wants in the audit log. */
export interface AgentResult<T = unknown> {
    agent: string;
    actions: ProposedAction[];
    /** Agent-specific report, written to the audit log and to `--json`. */
    report: T;
    llmCalls: number;
    costUsd: number;
}
