import {computeDora, listDeployments, listIncidents} from "@aicd-ci/metrics";
import {COLLECTIONS, type QuarantineRecord, type StateStore, type StoredDiagnosis} from "@aicd-ci/plugin-sdk";
import {invalidParams, isRecord} from "./jsonrpc.js";
import type {McpTool} from "./server.js";

const DAY = 86_400_000;
const READ_ONLY = {readOnlyHint: true, idempotentHint: true, openWorldHint: false} as const;
const DEPLOYMENT_STATES = ["in_progress", "success", "failed", "paused", "rolled_back", "unknown"] as const;

const limit = (fallback: number, maximum: number) => ({
    type: "integer" as const,
    minimum: 1,
    maximum,
    default: fallback,
    description: `Maximum number of items (1 to ${maximum}, default ${fallback}).`
});
const id = (description: string) => ({type: "string" as const, minLength: 1, maxLength: 500, description});

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function number(value: unknown, fallback: number): number {
    return typeof value === "number" ? value : fallback;
}

/** The built-in read-only tools over the aicd state. */
export function builtinTools(state: StateStore, now: () => Date): McpTool[] {
    async function runOrLatest(runId: string | undefined): Promise<string> {
        const resolved = runId ?? (await state.listRuns(1))[0]?.runId;
        if (!resolved) throw new Error("no run recorded yet");
        return resolved;
    }

    return [
        {
            name: "list_runs",
            title: "List aicd runs",
            description: "Most recent aicd executions (run id and date), most recent first.",
            inputSchema: {type: "object", properties: {limit: limit(20, 100)}, additionalProperties: false},
            annotations: READ_ONLY,
            async handler(args) {
                return {runs: await state.listRuns(number(args.limit, 20))};
            }
        },
        {
            name: "explain_run",
            title: "Explain a run",
            description:
                "Audit log of one aicd run: what it saw (findings), the LLM calls, the policy decisions and the actions. Defaults to the last run.",
            inputSchema: {
                type: "object",
                properties: {runId: id("Run id, as listed by list_runs. Default: the last run.")},
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const runId = await runOrLatest(optionalString(args.runId));
                const entries = await state.listAudit(runId);
                if (entries.length === 0) throw new Error(`unknown run: ${runId}`);
                return {runId, entries};
            }
        },
        {
            name: "explain_failure",
            title: "Explain a CI failure",
            description:
                "Stored diagnosis of a failure fingerprint, or the triage findings of a run with the stored diagnoses of their fingerprints. Give fingerprint, runId or both.",
            inputSchema: {
                type: "object",
                properties: {
                    fingerprint: id("Failure fingerprint (from a triage finding)."),
                    runId: id("Run id whose findings to return.")
                },
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const fingerprint = optionalString(args.fingerprint);
                const runId = optionalString(args.runId);
                if (!fingerprint && !runId) throw invalidParams("give fingerprint or runId");
                const result: Record<string, unknown> = {};
                if (fingerprint) {
                    const diagnosis = await state.getDiagnosis(fingerprint);
                    if (!diagnosis && !runId) throw new Error(`no diagnosis stored for fingerprint ${fingerprint}`);
                    result.fingerprint = fingerprint;
                    result.diagnosis = diagnosis ?? null;
                }
                if (runId) {
                    const entries = await state.listAudit(runId);
                    if (entries.length === 0) throw new Error(`unknown run: ${runId}`);
                    const findings = entries.filter((entry) => entry.kind === "finding").map((entry) => entry.payload);
                    const diagnoses: StoredDiagnosis[] = [];
                    const seen = new Set<string>();
                    for (const finding of findings) {
                        const key = isRecord(finding) ? optionalString(finding.fingerprint) : undefined;
                        if (!key || seen.has(key)) continue;
                        seen.add(key);
                        const diagnosis = await state.getDiagnosis(key);
                        if (diagnosis) diagnoses.push(diagnosis);
                    }
                    Object.assign(result, {runId, findings, diagnoses});
                }
                return result;
            }
        },
        {
            name: "list_flaky_tests",
            title: "List flaky tests",
            description: "Tests in quarantine (flaky score 0 to 1, reason, issue), most recently updated first.",
            inputSchema: {type: "object", properties: {limit: limit(50, 500)}, additionalProperties: false},
            annotations: READ_ONLY,
            async handler(args) {
                const records = await state.listRecords<QuarantineRecord>(COLLECTIONS.quarantine, {
                    limit: number(args.limit, 50)
                });
                return {tests: records.map((record) => record.value)};
            }
        },
        {
            name: "get_test_history",
            title: "Get a test's history",
            description: "Recent outcomes of one test (passed, failed, skipped), most recent first, with totals.",
            inputSchema: {
                type: "object",
                properties: {testId: id("Test id, e.g. 'src/pricing.test.ts > caps'."), limit: limit(50, 500)},
                required: ["testId"],
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const testId = String(args.testId);
                const outcomes = await state.getTestHistory(testId, number(args.limit, 50));
                const totals = {passed: 0, failed: 0, skipped: 0};
                for (const outcome of outcomes) totals[outcome.status]++;
                return {testId, totals, outcomes};
            }
        },
        {
            name: "list_deployments",
            title: "List deployments",
            description:
                "Recorded deployments, most recent first. Commits are summarized by their count unless includeCommits is true.",
            inputSchema: {
                type: "object",
                properties: {
                    environment: id("Only this environment, e.g. 'production'."),
                    status: {type: "string", enum: DEPLOYMENT_STATES, description: "Only this status."},
                    includeCommits: {type: "boolean", default: false, description: "Return the shipped commits."},
                    limit: limit(20, 200)
                },
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const status = optionalString(args.status);
                const deployments = (await listDeployments(state, optionalString(args.environment)))
                    .filter((deployment) => status === undefined || deployment.status === status)
                    .reverse()
                    .slice(0, number(args.limit, 20))
                    .map(({commits, ...deployment}) => ({
                        ...deployment,
                        commitCount: commits?.length ?? 0,
                        ...(args.includeCommits === true ? {commits: commits ?? []} : {})
                    }));
                return {deployments};
            }
        },
        {
            name: "list_incidents",
            title: "List incidents",
            description: "Recorded incidents with their timeline, most recently opened first.",
            inputSchema: {
                type: "object",
                properties: {
                    environment: id("Only this environment."),
                    open: {type: "boolean", description: "true: only unresolved incidents; false: only resolved ones."},
                    limit: limit(20, 200)
                },
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const environment = optionalString(args.environment);
                const open = typeof args.open === "boolean" ? args.open : undefined;
                const incidents = (await listIncidents(state))
                    .filter((incident) => environment === undefined || incident.environment === environment)
                    .filter((incident) => open === undefined || (incident.resolvedAt === undefined) === open)
                    .reverse()
                    .slice(0, number(args.limit, 20));
                return {incidents};
            }
        },
        {
            name: "get_dora_metrics",
            title: "Get DORA metrics",
            description:
                "DORA metrics of an environment over the last days: deployment frequency, lead time for changes, change failure rate and time to restore, each with its DORA 2023 level.",
            inputSchema: {
                type: "object",
                properties: {
                    environment: {...id("Environment, default 'production'."), default: "production"},
                    days: {
                        type: "integer",
                        minimum: 1,
                        maximum: 365,
                        default: 30,
                        description: "Window length in days, ending now (1 to 365, default 30)."
                    }
                },
                additionalProperties: false
            },
            annotations: READ_ONLY,
            async handler(args) {
                const end = now();
                const start = new Date(end.getTime() - number(args.days, 30) * DAY);
                return computeDora(state, {environment: optionalString(args.environment) ?? "production", start, end});
            }
        }
    ];
}
