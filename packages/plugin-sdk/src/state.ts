import type {Confidence, FailureCategory} from "./findings.js";
import type {DeploymentRef, DeploymentState} from "./deploy.js";
import type {JobStatus} from "./ci.js";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestOutcome {
    testId: string;
    status: TestStatus;
    runId: string;
    branch?: string;
    commitSha?: string;
    at: string;
}

export interface StoredDiagnosis {
    fingerprint: string;
    category: FailureCategory;
    summary: string;
    cause?: string;
    confidence: Confidence;
    hits: number;
    updatedAt: string;
}

export type AuditKind = "run" | "llm_call" | "finding" | "decision" | "action" | "warning" | "event";

export interface AuditEntry {
    runId: string;
    at: string;
    agent: string;
    kind: AuditKind;
    payload: unknown;
}

export interface StoredRecord<T = unknown> {
    collection: string;
    id: string;
    value: T;
    updatedAt: string;
}

/**
 * Durable state. Every method is async so that remote stores (Postgres) fit the same contract.
 * Agent data that has no dedicated method lives in named collections of JSON records.
 */
export interface StateStore {
    getDiagnosis(fingerprint: string): Promise<StoredDiagnosis | undefined>;
    saveDiagnosis(diagnosis: Omit<StoredDiagnosis, "hits" | "updatedAt">): Promise<void>;
    recordTestOutcomes(outcomes: TestOutcome[]): Promise<void>;
    /** Most recent first. */
    getTestHistory(testId: string, limit: number): Promise<TestOutcome[]>;
    /** Ids of every test seen since `since` (ISO date). */
    listTestIds(since?: string): Promise<string[]>;
    appendAudit(entry: AuditEntry): Promise<void>;
    listAudit(runId: string): Promise<AuditEntry[]>;
    /** Most recent first. */
    listRuns(limit: number): Promise<{runId: string; at: string}[]>;
    putRecord<T>(collection: string, id: string, value: T): Promise<void>;
    getRecord<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined>;
    /** Most recently updated first. */
    listRecords<T>(collection: string, options?: {limit?: number; since?: string}): Promise<StoredRecord<T>[]>;
    deleteRecord(collection: string, id: string): Promise<void>;
    close(): Promise<void>;
}

/** Collection names shared by agents, so that one agent can read what another wrote. */
export const COLLECTIONS = {
    quarantine: "quarantine",
    deployments: "deployments",
    incidents: "incidents",
    coverageMap: "coverage_map",
    jobRuns: "job_runs",
    securityBaseline: "security_baseline",
    testSelections: "test_selections",
    events: "events"
} as const;

export interface QuarantineRecord {
    testId: string;
    since: string;
    reason: string;
    /** Share of status changes in the window, 0 to 1. */
    flakyScore: number;
    issueKey?: string;
}

export interface DeploymentRecord extends DeploymentRef {
    status: DeploymentState;
    finishedAt?: string;
    /** Commits shipped by this deployment (since the previous one), oldest first. */
    commits?: {sha: string; authoredAt: string; subject?: string}[];
    /** Set when this deployment rolls back another one. */
    rollbackOf?: string;
    source: string;
}

export interface IncidentRecord {
    id: string;
    title: string;
    environment?: string;
    severity?: "info" | "warning" | "critical";
    openedAt: string;
    resolvedAt?: string;
    url?: string;
    /** Deployment suspected to have caused the incident. */
    deploymentId?: string;
    suspectCommits?: string[];
    issueKey?: string;
    source: string;
    timeline: {at: string; kind: string; text: string}[];
}

export interface JobRunRecord {
    pipelineId: string;
    jobId: string;
    name: string;
    stage?: string;
    status: JobStatus;
    durationSeconds?: number;
    queuedSeconds?: number;
    branch?: string;
    at: string;
}

export interface CoverageMapRecord {
    /** Test file or test id. */
    test: string;
    /** Source files this test exercises. */
    files: string[];
    source: "per_test_coverage" | "convention" | "co_change";
    commitSha?: string;
    /** When the map was built (ISO date); a stale map makes test selection run everything. */
    generatedAt?: string;
}

export interface TestSelectionRecord {
    runId: string;
    commitSha?: string;
    baseSha?: string;
    full: boolean;
    selected: string[];
    skipped: string[];
    reasons: string[];
    at: string;
}
