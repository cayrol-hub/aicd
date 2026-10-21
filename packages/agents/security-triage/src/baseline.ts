import {COLLECTIONS, type StateStore} from "@aicd-ci/plugin-sdk";
import type {SecurityAlert, Severity} from "./sarif.js";

/** What the default branch already has: alerts in it are not new on a merge request. */
export interface SecurityBaselineRecord {
    id: string;
    tool: string;
    ruleId: string;
    severity: Severity;
    file?: string;
    firstSeen: string;
    lastSeen: string;
}

/**
 * Records the alerts of the default branch. Alerts of the same tools that are gone are removed,
 * so that a fixed alert reintroduced later counts as new again. `tools` lists the scanners that
 * ran (default: the tools of `alerts`); records of other tools are kept.
 */
export async function recordBaseline(
    state: StateStore,
    alerts: SecurityAlert[],
    options: {now?: Date; tools?: string[]} = {}
): Promise<{recorded: number; removed: number}> {
    const now = (options.now ?? new Date()).toISOString();
    const tools = new Set(options.tools ?? alerts.map((alert) => alert.tool));
    const current = new Set(alerts.map((alert) => alert.id));
    let removed = 0;
    for (const record of await state.listRecords<SecurityBaselineRecord>(COLLECTIONS.securityBaseline)) {
        if (!current.has(record.id) && tools.has(record.value.tool)) {
            await state.deleteRecord(COLLECTIONS.securityBaseline, record.id);
            removed++;
        }
    }
    const seen = new Set<string>();
    for (const alert of alerts) {
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);
        const existing = await state.getRecord<SecurityBaselineRecord>(COLLECTIONS.securityBaseline, alert.id);
        const record: SecurityBaselineRecord = {
            id: alert.id,
            tool: alert.tool,
            ruleId: alert.ruleId,
            severity: alert.severity,
            ...(alert.file ? {file: alert.file} : {}),
            firstSeen: existing?.value.firstSeen ?? now,
            lastSeen: now
        };
        await state.putRecord(COLLECTIONS.securityBaseline, alert.id, record);
    }
    return {recorded: seen.size, removed};
}

/** Splits alerts into those absent from the baseline (new) and those already on the default branch. */
export async function splitNewAlerts(
    state: StateStore,
    alerts: SecurityAlert[]
): Promise<{newAlerts: SecurityAlert[]; existing: SecurityAlert[]}> {
    const newAlerts: SecurityAlert[] = [];
    const existing: SecurityAlert[] = [];
    for (const alert of alerts) {
        const known = await state.getRecord(COLLECTIONS.securityBaseline, alert.id);
        (known ? existing : newAlerts).push(alert);
    }
    return {newAlerts, existing};
}
