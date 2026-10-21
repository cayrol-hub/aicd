import {callLlm, fixBranchName} from "@aicd-ci/core";
import {
    COLLECTIONS,
    type AgentResult,
    type AgentRuntime,
    type AuditEntry,
    type DeploymentRecord,
    type IncidentRecord,
    type ProposedAction
} from "@aicd-ci/plugin-sdk";
import {AGENT_NAME} from "./correlate.js";
import {buildNarrativePrompt, LlmNarrativeSchema, NARRATIVE_SYSTEM_PROMPT, verifyNarrative, type Claim} from "./llm.js";
import {deterministicNarrative, renderPostmortem, timelineText} from "./render.js";

/** Written by the release guardian, keyed by deployment id (read only here). */
export const GUARD_RESULTS_COLLECTION = "guard_results";

export type TimelineKind =
    | "deployment_started"
    | "deployment_finished"
    | "guard_verdict"
    | "alert_opened"
    | "pause"
    | "rollback"
    | "resolved"
    | "issue_linked"
    | "note";

export interface TimelineEntry {
    /** E1, E2… in chronological order: what narrative claims cite. */
    id: string;
    at: string;
    kind: TimelineKind;
    /** Original kind of an incident timeline entry (`kind` is then "note"). */
    sourceKind?: string;
    /** Facts for the renderer; `text` for free-form entries. */
    data: Record<string, string>;
}

export interface Durations {
    /** Alert opened − deployment started. */
    detectMinutes?: number;
    /** First rollback − alert opened; 0 when the rollback came first (see `mitigatedBeforeAlert`). */
    mitigateMinutes?: number;
    mitigatedBeforeAlert?: boolean;
    /** Resolved − alert opened. */
    resolveMinutes?: number;
}

export interface PostmortemReport {
    incidentId: string;
    title: string;
    environment?: string;
    severity?: IncidentRecord["severity"];
    openedAt: string;
    resolvedAt?: string;
    deploymentId?: string;
    issueKey?: string;
    suspectCommits: {sha: string; subject?: string}[];
    timeline: TimelineEntry[];
    durations: Durations;
    /** Verified LLM claims, or the deterministic narrative. */
    claims: Claim[];
    source: "rules" | "llm";
    /** `docs/postmortems/<YYYY-MM-DD>-<slug>.md` */
    path: string;
    markdown: string;
}

export interface BuildPostmortemInput {
    incidentId: string;
    /** Audit entries of the runs that acted on the incident (pause / rollback actions, with outcome "done"). */
    audit?: AuditEntry[];
}

const KIND_ORDER: TimelineKind[] = [
    "deployment_started",
    "deployment_finished",
    "guard_verdict",
    "alert_opened",
    "pause",
    "rollback",
    "note",
    "issue_linked",
    "resolved"
];

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

export function slugify(text: string): string {
    return (
        text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50)
            .replace(/-$/, "") || "incident"
    );
}

interface DraftEntry {
    at: string;
    kind: TimelineKind;
    sourceKind?: string;
    data: Record<string, string>;
}

function actionFromAudit(entry: AuditEntry): "pause" | "rollback" | undefined {
    if (entry.kind !== "action" || typeof entry.payload !== "object" || entry.payload === null) return undefined;
    const payload = entry.payload as {type?: unknown; outcome?: unknown};
    if (payload.outcome !== undefined && payload.outcome !== "done") return undefined;
    if (payload.type === "rollback_deployment") return "rollback";
    if (payload.type === "pause_deployment") return "pause";
    return undefined;
}

/** Chronological timeline of the incident from the state (deployments, guard results, incident) and the audit. */
export async function buildTimeline(
    runtime: AgentRuntime,
    incident: IncidentRecord,
    audit: AuditEntry[] = []
): Promise<{timeline: TimelineEntry[]; deployment?: DeploymentRecord}> {
    const drafts: DraftEntry[] = [];
    const deployment = incident.deploymentId
        ? (await runtime.state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, incident.deploymentId))?.value
        : undefined;

    if (deployment) {
        const facts = {
            id: deployment.id,
            environment: deployment.environment,
            ...(deployment.service ? {service: deployment.service} : {}),
            ...(deployment.version ? {version: deployment.version} : {})
        };
        drafts.push({at: deployment.startedAt, kind: "deployment_started", data: facts});
        if (deployment.finishedAt) {
            drafts.push({
                at: deployment.finishedAt,
                kind: "deployment_finished",
                data: {...facts, status: deployment.status}
            });
        }
        const guard = await runtime.state.getRecord<{verdict?: string; health?: string; evaluatedAt?: string}>(
            GUARD_RESULTS_COLLECTION,
            deployment.id
        );
        if (guard?.value.verdict && guard.value.evaluatedAt) {
            drafts.push({
                at: guard.value.evaluatedAt,
                kind: "guard_verdict",
                data: {verdict: guard.value.verdict, health: guard.value.health ?? ""}
            });
        }
        const rollbacks = (await runtime.state.listRecords<DeploymentRecord>(COLLECTIONS.deployments))
            .map((record) => record.value)
            .filter((record) => record.rollbackOf === deployment.id);
        for (const rollback of rollbacks) {
            drafts.push({
                at: rollback.startedAt,
                kind: "rollback",
                data: {id: rollback.id, ...(rollback.version ? {version: rollback.version} : {})}
            });
        }
    }

    drafts.push({at: incident.openedAt, kind: "alert_opened", data: {title: runtime.redact(incident.title)}});

    const hasRollbackRecord = drafts.some((draft) => draft.kind === "rollback");
    for (const entry of audit) {
        const action = actionFromAudit(entry);
        // A rollback deployment record already says when the rollback happened.
        if (!action || (action === "rollback" && hasRollbackRecord)) continue;
        drafts.push({at: entry.at, kind: action, data: {agent: entry.agent}});
    }

    for (const entry of incident.timeline ?? []) {
        if (Number.isNaN(Date.parse(entry.at))) continue;
        drafts.push({at: entry.at, kind: "note", sourceKind: entry.kind, data: {text: runtime.redact(entry.text)}});
    }

    if (incident.issueKey) {
        // The issue is proposed at correlation time; without a correlation entry, it is dated with the alert.
        const correlation = (incident.timeline ?? []).find((entry) => entry.kind === "correlation");
        drafts.push({at: correlation?.at ?? incident.openedAt, kind: "issue_linked", data: {key: incident.issueKey}});
    }
    if (incident.resolvedAt) drafts.push({at: incident.resolvedAt, kind: "resolved", data: {}});

    const timeline = drafts
        .filter((draft) => !Number.isNaN(Date.parse(draft.at)))
        .map((draft, index) => ({draft, index}))
        .sort(
            (a, b) =>
                Date.parse(a.draft.at) - Date.parse(b.draft.at) ||
                KIND_ORDER.indexOf(a.draft.kind) - KIND_ORDER.indexOf(b.draft.kind) ||
                a.index - b.index
        )
        .map(({draft}, index) => ({
            id: `E${index + 1}`,
            at: new Date(draft.at).toISOString(),
            kind: draft.kind,
            ...(draft.sourceKind ? {sourceKind: draft.sourceKind} : {}),
            data: draft.data
        }));
    return {timeline, ...(deployment ? {deployment} : {})};
}

/** Time to detect, to mitigate and to resolve, in minutes, from the timeline. */
export function computeDurations(timeline: TimelineEntry[]): Durations {
    const first = (kind: TimelineKind) => timeline.find((entry) => entry.kind === kind)?.at;
    const started = first("deployment_started");
    const alert = first("alert_opened");
    const rollback = first("rollback");
    const resolved = first("resolved");
    const durations: Durations = {};
    if (started && alert) durations.detectMinutes = minutesBetween(started, alert);
    if (alert && rollback) {
        const minutes = minutesBetween(alert, rollback);
        durations.mitigateMinutes = Math.max(0, minutes);
        if (minutes < 0) durations.mitigatedBeforeAlert = true;
    }
    if (alert && resolved) durations.resolveMinutes = minutesBetween(alert, resolved);
    return durations;
}

/**
 * Builds a blameless post-mortem of an incident: sorted timeline, durations, a narrative (LLM claims that cite
 * timeline entries, unknown citations dropped; otherwise a deterministic draft), rendered as markdown and proposed
 * as `docs/postmortems/<YYYY-MM-DD>-<slug>.md` in a merge request.
 */
export async function buildPostmortem(
    runtime: AgentRuntime,
    input: BuildPostmortemInput
): Promise<AgentResult<PostmortemReport>> {
    const stored = await runtime.state.getRecord<IncidentRecord>(COLLECTIONS.incidents, input.incidentId);
    if (!stored) throw new Error(`postmortem: incident ${input.incidentId} not found in the state`);
    const incident = stored.value;
    const {timeline, deployment} = await buildTimeline(runtime, incident, input.audit);
    const durations = computeDurations(timeline);

    const subjects = new Map((deployment?.commits ?? []).map((commit) => [commit.sha, commit.subject]));
    const suspectCommits = (incident.suspectCommits ?? []).map((sha) => {
        const subject = subjects.get(sha);
        return {sha, ...(subject !== undefined ? {subject: runtime.redact(subject)} : {})};
    });

    const base = {
        incidentId: incident.id,
        title: runtime.redact(incident.title),
        ...(incident.environment ? {environment: incident.environment} : {}),
        ...(incident.severity ? {severity: incident.severity} : {}),
        openedAt: incident.openedAt,
        ...(incident.resolvedAt ? {resolvedAt: incident.resolvedAt} : {}),
        ...(incident.deploymentId ? {deploymentId: incident.deploymentId} : {}),
        ...(incident.issueKey ? {issueKey: incident.issueKey} : {}),
        suspectCommits,
        timeline,
        durations,
        path: `docs/postmortems/${incident.openedAt.slice(0, 10)}-${slugify(incident.title)}.md`
    };

    let claims: Claim[] = [];
    let llmCalls = 0;
    let costUsd = 0;
    const response = await callLlm(runtime, AGENT_NAME, {
        system: NARRATIVE_SYSTEM_PROMPT,
        prompt: buildNarrativePrompt({
            incident: [
                `title: ${base.title}`,
                ...(base.severity ? [`severity: ${base.severity}`] : []),
                ...(base.environment ? [`environment: ${base.environment}`] : [])
            ].join("\n"),
            timeline: timeline.map((entry) => `${entry.id} ${entry.at} ${timelineText(entry, "en")}`).join("\n"),
            commits: suspectCommits.map((commit) => `${commit.sha} ${commit.subject ?? ""}`.trim()).join("\n"),
            language: runtime.language
        }),
        schema: LlmNarrativeSchema
    });
    if (response) {
        llmCalls++;
        costUsd += response.usage.costUsd;
        const verified = verifyNarrative(response.output, new Set(timeline.map((entry) => entry.id)));
        claims = verified.claims;
        if (verified.rejected > 0) {
            runtime.logger.warn(
                `${AGENT_NAME}: ${verified.rejected} post-mortem claim(s) without valid citation dropped`
            );
        }
    }
    const source: PostmortemReport["source"] = claims.length > 0 ? "llm" : "rules";
    if (claims.length === 0) claims = deterministicNarrative({...base, claims: [], source}, runtime.language);

    const withoutMarkdown = {...base, claims, source};
    const markdown = renderPostmortem(withoutMarkdown, {language: runtime.language, runId: runtime.runId});
    const report: PostmortemReport = {...withoutMarkdown, markdown};

    const title =
        runtime.language === "fr" ? `docs : post-mortem « ${base.title} »` : `docs: post-mortem "${base.title}"`;
    const actions: ProposedAction[] = [
        {
            type: "open_fix_mr",
            reason: `post-mortem of incident ${incident.id}`,
            fix: {
                title,
                body:
                    runtime.language === "fr"
                        ? `Brouillon de post-mortem sans reproche pour l'incident \`${incident.id}\`, généré par aicd. À relire et compléter avant fusion.`
                        : `Blameless post-mortem draft for incident \`${incident.id}\`, generated by aicd. Review and complete it before merging.`,
                branch: fixBranchName(`postmortem ${base.title}`, incident.id),
                ...(runtime.context.defaultBranch ? {baseBranch: runtime.context.defaultBranch} : {}),
                changes: [{path: base.path, content: markdown}]
            }
        }
    ];
    return {agent: AGENT_NAME, actions, report, llmCalls, costUsd};
}
