import type {DeploymentState, JobStatus} from "@aicd/plugin-sdk";

export type WebhookProvider = "github" | "gitlab";
export type AlertSource = "sentry" | "alertmanager" | "generic";
export type AlertSeverity = "info" | "warning" | "critical";

export interface PipelineCompletedEvent {
    type: "pipeline_completed";
    provider: WebhookProvider;
    repository: string;
    pipelineId: string;
    status: JobStatus;
    branch?: string;
    sha?: string;
    mergeRequestId?: string;
    url?: string;
    /** The code comes from a fork: no LLM call and no action. */
    fork: boolean;
}

export interface MergeRequestUpdatedEvent {
    type: "merge_request_updated";
    provider: WebhookProvider;
    repository: string;
    id: string;
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
    sha: string;
    url: string;
    /** The source branch lives in a fork: no LLM call and no action. */
    fork: boolean;
}

export interface DeploymentEvent {
    type: "deployment";
    provider: WebhookProvider;
    repository: string;
    id: string;
    environment: string;
    status: DeploymentState;
    sha?: string;
    url?: string;
    startedAt: string;
}

export interface TagPushedEvent {
    type: "tag_pushed";
    provider: WebhookProvider;
    repository: string;
    tag: string;
    sha: string;
}

export interface AlertEvent {
    type: "alert";
    source: AlertSource;
    id: string;
    status: "opened" | "resolved";
    title: string;
    environment?: string;
    severity: AlertSeverity;
    at: string;
    url?: string;
}

/** Everything the server receives, normalized: handlers never see provider payloads. */
export type AicdEvent =
    PipelineCompletedEvent | MergeRequestUpdatedEvent | DeploymentEvent | TagPushedEvent | AlertEvent;

export type AicdEventType = AicdEvent["type"];

/** One handler per event type; an event without a handler is stored and marked done. */
export type EventHandlers = {[K in AicdEventType]?: (event: Extract<AicdEvent, {type: K}>) => Promise<void>};

/** A payload that claims to be a supported format but is malformed (answered with 400). */
export class PayloadError extends Error {
    override readonly name = "PayloadError";
}
