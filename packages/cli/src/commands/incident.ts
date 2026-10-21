import {writeFileSync} from "node:fs";
import {buildPostmortem, correlateIncident, type PostmortemReport} from "@aicd-ci/agent-postmortem";
import {recordIncident} from "@aicd-ci/metrics";
import {COLLECTIONS, type AuditEntry, type IncidentRecord, type StateStore} from "@aicd-ci/plugin-sdk";
import {EXIT, type GlobalOptions} from "../shared.js";
import {conclude, report} from "../outcome.js";
import {Session} from "../session.js";

export interface IncidentRecordOptions extends GlobalOptions {
    id: string;
    title?: string;
    env?: string;
    severity?: "info" | "warning" | "critical";
    openedAt?: string;
    resolvedAt?: string;
    url?: string;
    source?: string;
}

export async function recordIncidentFrom(
    state: StateStore,
    input: Omit<IncidentRecordOptions, keyof GlobalOptions>
): Promise<IncidentRecord> {
    const existing = (await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, input.id))?.value;
    const openedAt = input.openedAt ?? existing?.openedAt ?? new Date().toISOString();
    const timeline = [
        ...(existing ? [] : [{at: openedAt, kind: "alert_opened", text: input.title ?? input.id}]),
        ...(input.resolvedAt ? [{at: input.resolvedAt, kind: "resolved", text: "incident resolved"}] : [])
    ];
    return recordIncident(state, {
        id: input.id,
        title: input.title ?? existing?.title ?? input.id,
        openedAt,
        source: input.source ?? existing?.source ?? "cli",
        timeline,
        ...((input.env ?? existing?.environment) ? {environment: input.env ?? existing?.environment} : {}),
        ...((input.severity ?? existing?.severity) ? {severity: input.severity ?? existing?.severity} : {}),
        ...(input.resolvedAt ? {resolvedAt: input.resolvedAt} : {}),
        ...((input.url ?? existing?.url) ? {url: input.url ?? existing?.url} : {})
    } as IncidentRecord);
}

/** `aicd incident record`. */
export async function incidentRecord(options: IncidentRecordOptions): Promise<number> {
    const session = await Session.open({...options, noLlm: true});
    try {
        const record = await recordIncidentFrom(session.state, options);
        session.logger.info(`incident ${record.id} recorded${record.resolvedAt ? " (resolved)" : ""}`);
        if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        return EXIT.ok;
    } finally {
        await session.close();
    }
}

/** Links an incident to the deployment and commits that probably caused it. */
export async function correlate(
    session: Session,
    incidentId: string,
    options: {dryRun?: boolean; json?: boolean} = {}
): Promise<number> {
    const incident = (await session.state.getRecord<IncidentRecord>(COLLECTIONS.incidents, incidentId))?.value;
    if (!incident) {
        session.logger.error(`unknown incident ${incidentId}`);
        return EXIT.invalidConfig;
    }
    if (!session.config.agents.postmortem.enabled) return EXIT.ok;
    const result = await correlateIncident(session.runtime("postmortem"), {
        incident,
        lookback_hours: session.config.agents.postmortem.lookback_hours
    });
    const runs = [{agent: "postmortem" as const, result}];
    const conclusion = await conclude(session, runs, {dryRun: options.dryRun ?? false});
    // Remember the issue, so that a second correlation (re-sent alert, re-run) does not open another one.
    const issue = conclusion.outcomes.find((outcome) => outcome.type === "create_issue" && outcome.outcome === "done");
    if (issue?.detail) {
        const current = (await session.state.getRecord<IncidentRecord>(COLLECTIONS.incidents, incidentId))?.value;
        if (current)
            await session.state.putRecord(COLLECTIONS.incidents, incidentId, {...current, issueKey: issue.detail});
    }
    report(session, runs, conclusion, options.json);
    return EXIT.ok;
}

/** Audit entries of recent runs: the pauses and rollbacks the post-mortem timeline is built from. */
async function recentActions(state: StateStore): Promise<AuditEntry[]> {
    const runs = await state.listRuns(200);
    const entries = await Promise.all(runs.map((run) => state.listAudit(run.runId)));
    return entries.flat().filter((entry) => entry.kind === "action");
}

/** Writes the blameless post-mortem of a resolved incident and proposes it as a merge request. */
export async function postmortem(
    session: Session,
    incidentId: string,
    options: {dryRun?: boolean; json?: boolean; output?: string} = {}
): Promise<number> {
    const result = await buildPostmortem(session.runtime("postmortem"), {
        incidentId,
        audit: await recentActions(session.state)
    });
    const document = (result.report as PostmortemReport & {markdown?: string}).markdown;
    if (options.output && document) writeFileSync(options.output, document);
    const runs = [{agent: "postmortem" as const, result}];
    report(session, runs, await conclude(session, runs, {dryRun: options.dryRun ?? false}), options.json);
    return EXIT.ok;
}

export async function incidentCorrelateCommand(id: string, options: GlobalOptions & {ci?: string}): Promise<number> {
    const session = await Session.open(options);
    try {
        return await correlate(session, id, options);
    } finally {
        await session.close();
    }
}

export async function postmortemCommand(
    id: string,
    options: GlobalOptions & {ci?: string; output?: string}
): Promise<number> {
    const session = await Session.open(options);
    try {
        return await postmortem(session, id, options);
    } finally {
        await session.close();
    }
}
