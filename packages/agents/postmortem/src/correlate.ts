import {callLlm} from "@aicd-ci/core";
import {
    COLLECTIONS,
    type AgentResult,
    type AgentRuntime,
    type DeploymentRecord,
    type IncidentRecord,
    type ProposedAction
} from "@aicd-ci/plugin-sdk";
import {buildCorrelationPrompt, CORRELATION_SYSTEM_PROMPT, LlmRankingSchema, verifyRanking} from "./llm.js";
import {correlationText, renderCorrelationIssue} from "./render.js";

export const AGENT_NAME = "postmortem";

export interface CorrelateInput {
    incident: IncidentRecord;
    /** Hours before `openedAt` searched for a deployment. Default: 24. */
    lookback_hours?: number;
}

export interface SuspectCommit {
    sha: string;
    subject?: string;
    authoredAt: string;
    /** Only for commits the LLM ranked with a verified quote. */
    reason?: string;
    source: "rules" | "llm";
}

export interface SuspectDeployment {
    id: string;
    environment: string;
    service?: string;
    version?: string;
    commitSha?: string;
    startedAt: string;
    status: DeploymentRecord["status"];
    url?: string;
    rollbackOf?: string;
}

export interface CorrelationReport {
    incidentId: string;
    lookbackHours: number;
    /** Deployments of the environment that started in the lookback window, before the incident. */
    candidates: number;
    deployment?: SuspectDeployment;
    /** Most suspect first. */
    suspects: SuspectCommit[];
    source: "rules" | "llm";
}

/** Commits most recent first; on equal dates the later one in the (oldest-first) list comes first. */
export function rankCommitsByRecency(commits: NonNullable<DeploymentRecord["commits"]>): SuspectCommit[] {
    return commits
        .map((commit, index) => ({commit, index, at: Date.parse(commit.authoredAt)}))
        .sort(
            (a, b) =>
                (Number.isNaN(b.at) ? -Infinity : b.at) - (Number.isNaN(a.at) ? -Infinity : a.at) || b.index - a.index
        )
        .map(({commit}) => ({
            sha: commit.sha,
            ...(commit.subject !== undefined ? {subject: commit.subject} : {}),
            authoredAt: commit.authoredAt,
            source: "rules" as const
        }));
}

/**
 * Finds the deployment suspected of an incident: the last one of the same environment that started before the
 * incident opened, within the lookback window. Its commits are ranked most recent first; the LLM may re-rank them
 * with reasons that quote commit subjects (unverifiable items dropped). Updates the incident record and proposes an
 * issue (when none is linked) and a notification.
 */
export async function correlateIncident(
    runtime: AgentRuntime,
    input: CorrelateInput
): Promise<AgentResult<CorrelationReport>> {
    const incident: IncidentRecord = {
        ...input.incident,
        title: runtime.redact(input.incident.title),
        timeline: input.incident.timeline ?? []
    };
    const opened = Date.parse(incident.openedAt);
    if (Number.isNaN(opened)) throw new Error(`postmortem: incident ${incident.id} has an invalid openedAt`);
    const lookbackHours = input.lookback_hours ?? 24;
    const from = opened - lookbackHours * 3_600_000;

    const candidates = (await runtime.state.listRecords<DeploymentRecord>(COLLECTIONS.deployments))
        .map((record) => record.value)
        .filter((deployment) => {
            const started = Date.parse(deployment.startedAt);
            return (
                (!incident.environment || deployment.environment === incident.environment) &&
                !Number.isNaN(started) &&
                started < opened &&
                started >= from
            );
        })
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const found = candidates[0];

    const commits = (found?.commits ?? []).map((commit) => ({
        ...commit,
        ...(commit.subject !== undefined ? {subject: runtime.redact(commit.subject)} : {})
    }));
    let suspects = rankCommitsByRecency(commits);
    let source: CorrelationReport["source"] = "rules";
    let llmCalls = 0;
    let costUsd = 0;

    if (found && suspects.length > 0) {
        const response = await callLlm(runtime, AGENT_NAME, {
            system: CORRELATION_SYSTEM_PROMPT,
            prompt: buildCorrelationPrompt({
                incident: [
                    `title: ${incident.title}`,
                    ...(incident.severity ? [`severity: ${incident.severity}`] : []),
                    `opened: ${incident.openedAt}`
                ].join("\n"),
                timeline: incident.timeline
                    .map((entry) => `${entry.at} ${entry.kind}: ${runtime.redact(entry.text)}`)
                    .join("\n"),
                deployment: [
                    `id: ${found.id}`,
                    `environment: ${found.environment}`,
                    ...(found.service ? [`service: ${found.service}`] : []),
                    ...(found.version ? [`version: ${found.version}`] : []),
                    `started: ${found.startedAt}`
                ].join("\n"),
                commits: suspects
                    .slice(0, 50)
                    .map((commit) => `${commit.sha} ${commit.authoredAt} ${commit.subject ?? ""}`.trim())
                    .join("\n"),
                language: runtime.language
            }),
            schema: LlmRankingSchema
        });
        if (response) {
            llmCalls++;
            costUsd += response.usage.costUsd;
            const verified = verifyRanking(response.output, commits);
            if (verified.rejected > 0) {
                runtime.logger.warn(`${AGENT_NAME}: ${verified.rejected} unverifiable commit ranking(s) dropped`);
            }
            if (verified.accepted.length > 0) {
                const ranked = verified.accepted.map(({sha, reason}) => ({
                    ...(suspects.find((s) => s.sha === sha) as SuspectCommit),
                    reason,
                    source: "llm" as const
                }));
                suspects = [...ranked, ...suspects.filter((s) => !ranked.some((r) => r.sha === s.sha))];
                source = "llm";
            }
        }
    }

    const report: CorrelationReport = {
        incidentId: incident.id,
        lookbackHours,
        candidates: candidates.length,
        ...(found
            ? {
                  deployment: {
                      id: found.id,
                      environment: found.environment,
                      ...(found.service ? {service: found.service} : {}),
                      ...(found.version ? {version: found.version} : {}),
                      ...(found.commitSha ? {commitSha: found.commitSha} : {}),
                      startedAt: found.startedAt,
                      status: found.status,
                      ...(found.url ? {url: found.url} : {}),
                      ...(found.rollbackOf ? {rollbackOf: found.rollbackOf} : {})
                  }
              }
            : {}),
        suspects,
        source
    };

    // Re-running the correlation replaces its previous timeline entry instead of piling them up.
    const updated: IncidentRecord = {
        ...input.incident,
        ...(found ? {deploymentId: found.id} : {}),
        suspectCommits: suspects.map((suspect) => suspect.sha),
        timeline: [
            ...(input.incident.timeline ?? []).filter((entry) => entry.kind !== "correlation"),
            {at: runtime.now().toISOString(), kind: "correlation", text: correlationText(report, runtime.language)}
        ]
    };
    await runtime.state.putRecord<IncidentRecord>(COLLECTIONS.incidents, incident.id, updated);

    const actions: ProposedAction[] = [];
    if (!incident.issueKey) {
        actions.push({
            type: "create_issue",
            reason: `incident ${incident.id} has no linked issue`,
            issue: {
                title: `Incident${runtime.language === "fr" ? " :" : ":"} ${incident.title}`,
                body: renderCorrelationIssue(incident, report, runtime.language),
                labels: ["incident", ...(incident.severity ? [incident.severity] : [])]
            }
        });
    }
    actions.push({
        type: "notify",
        reason: `correlation of incident ${incident.id}`,
        notification: {
            title: `Incident${runtime.language === "fr" ? " :" : ":"} ${incident.title}`,
            text: correlationText(report, runtime.language),
            severity: incident.severity ?? "warning",
            ...(incident.url ? {url: incident.url} : {}),
            fields: {
                ...(incident.environment ? {environment: incident.environment} : {}),
                ...(found ? {deployment: found.id} : {}),
                ...(suspects[0] ? {suspect: suspects[0].sha.slice(0, 12)} : {})
            }
        }
    });

    return {agent: AGENT_NAME, actions, report, llmCalls, costUsd};
}
