import {createHash} from "node:crypto";
import {PayloadError, type AlertEvent, type AlertSeverity, type AlertSource} from "./events.js";
import {at, defined, isoDate, obj, str, text} from "./json.js";

export const ALERT_SOURCES: readonly AlertSource[] = ["sentry", "alertmanager", "generic"];

/** Maps the severity words of Sentry levels, Prometheus labels and generic payloads. Unknown words are warnings. */
export function alertSeverity(value: string | undefined): AlertSeverity {
    switch (value?.toLowerCase()) {
        case "fatal":
        case "critical":
        case "page":
        case "error":
        case "high":
            return "critical";
        case "info":
        case "debug":
        case "low":
        case "none":
            return "info";
        default:
            return "warning";
    }
}

function sentryTag(event: unknown, key: string): string | undefined {
    const tags = at(event, "tags");
    if (!Array.isArray(tags)) return undefined;
    for (const tag of tags) {
        if (Array.isArray(tag) && tag[0] === key) return text(tag[1]);
        if (str(tag, "key") === key) return str(tag, "value");
    }
    return undefined;
}

/**
 * Normalizes a Sentry integration webhook: `issue` (created/unresolved → opened, resolved → resolved),
 * `event_alert` (triggered → opened) and `metric_alert` (critical/warning → opened, resolved → resolved).
 * The resource is recognized from the payload, so the `Sentry-Hook-Resource` header is optional.
 */
export function normalizeSentry(payload: unknown, now: Date = new Date()): AlertEvent[] {
    const action = str(payload, "action");
    const issue = obj(at(payload, "data", "issue"));
    const event = obj(at(payload, "data", "event"));
    const metric = obj(at(payload, "data", "metric_alert"));
    if (issue) {
        const id = str(issue, "id");
        const status =
            action === "created" || action === "unresolved" ? "opened" : action === "resolved" ? "resolved" : undefined;
        if (!id || !status) return [];
        return [
            {
                type: "alert",
                source: "sentry",
                id,
                status,
                title: str(issue, "title") ?? str(issue, "culprit") ?? "Sentry issue",
                severity: alertSeverity(str(issue, "level")),
                at: (status === "opened" ? isoDate(str(issue, "firstSeen")) : undefined) ?? now.toISOString(),
                ...defined({url: str(issue, "web_url") ?? str(issue, "permalink")})
            }
        ];
    }
    if (event) {
        const id = str(event, "issue_id") ?? str(event, "event_id");
        if (action !== "triggered" || !id) return [];
        return [
            {
                type: "alert",
                source: "sentry",
                id,
                status: "opened",
                title: str(event, "title") ?? str(payload, "data", "triggered_rule") ?? "Sentry alert",
                severity: alertSeverity(str(event, "level")),
                at: isoDate(str(event, "datetime")) ?? now.toISOString(),
                ...defined({
                    environment: str(event, "environment") ?? sentryTag(event, "environment"),
                    url: str(event, "web_url") ?? str(event, "issue_url")
                })
            }
        ];
    }
    if (metric) {
        const id = str(metric, "id");
        const status =
            action === "critical" || action === "warning" ? "opened" : action === "resolved" ? "resolved" : undefined;
        if (!id || !status) return [];
        return [
            {
                type: "alert",
                source: "sentry",
                id,
                status,
                title:
                    str(payload, "data", "description_title") ??
                    str(metric, "alert_rule", "name") ??
                    "Sentry metric alert",
                severity: action === "critical" ? "critical" : "warning",
                at:
                    isoDate(status === "opened" ? str(metric, "date_detected") : str(metric, "date_closed")) ??
                    now.toISOString(),
                ...defined({
                    environment: str(metric, "alert_rule", "environment"),
                    url: str(payload, "data", "web_url")
                })
            }
        ];
    }
    return [];
}

/**
 * Normalizes a Prometheus Alertmanager webhook (version 4): one event per alert, firing → opened,
 * resolved → resolved. The id is the alert fingerprint, so that opening and resolution match.
 */
export function normalizeAlertmanager(payload: unknown, now: Date = new Date()): AlertEvent[] {
    const alerts = at(payload, "alerts");
    if (!Array.isArray(alerts)) throw new PayloadError("alertmanager payload has no alerts array");
    const events: AlertEvent[] = [];
    for (const alert of alerts) {
        const labels = obj(at(alert, "labels")) ?? {};
        const status = str(alert, "status");
        if (status !== "firing" && status !== "resolved") continue;
        const id =
            str(alert, "fingerprint") ??
            createHash("sha256")
                .update(JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))))
                .digest("hex")
                .slice(0, 16);
        events.push({
            type: "alert",
            source: "alertmanager",
            id,
            status: status === "firing" ? "opened" : "resolved",
            title: str(alert, "annotations", "summary") ?? str(labels, "alertname") ?? "Prometheus alert",
            severity: alertSeverity(str(labels, "severity")),
            at: isoDate(str(alert, status === "firing" ? "startsAt" : "endsAt")) ?? now.toISOString(),
            ...defined({
                environment: str(labels, "environment") ?? str(labels, "env"),
                url: str(alert, "generatorURL") ?? str(payload, "externalURL")
            })
        });
    }
    return events;
}

const OPENED = new Set(["opened", "open", "firing", "triggered"]);
const RESOLVED = new Set(["resolved", "closed", "ok"]);
const SEVERITIES = new Set<string>(["info", "warning", "critical"]);

/**
 * Normalizes aicd's generic alert format `{id, status, title, environment?, severity?, at?, url?}`.
 * `status` is `opened` or `resolved` (aliases: open, firing, triggered / closed, ok). Throws `PayloadError` when invalid.
 */
export function normalizeGenericAlert(payload: unknown, now: Date = new Date()): AlertEvent[] {
    const body = obj(payload);
    if (!body) throw new PayloadError("alert must be a JSON object");
    const id = str(body, "id");
    const title = str(body, "title");
    const status = str(body, "status")?.toLowerCase() ?? "";
    if (!id) throw new PayloadError("alert id is required");
    if (!title) throw new PayloadError("alert title is required");
    if (!OPENED.has(status) && !RESOLVED.has(status)) throw new PayloadError("alert status must be opened or resolved");
    const severity = str(body, "severity")?.toLowerCase();
    if (severity !== undefined && !SEVERITIES.has(severity)) {
        throw new PayloadError("alert severity must be info, warning or critical");
    }
    const when = body.at === undefined ? now.toISOString() : isoDate(body.at);
    if (!when) throw new PayloadError("alert at must be an ISO 8601 date");
    return [
        {
            type: "alert",
            source: "generic",
            id,
            status: OPENED.has(status) ? "opened" : "resolved",
            title,
            severity: (severity as AlertSeverity | undefined) ?? "warning",
            at: when,
            ...defined({environment: str(body, "environment"), url: str(body, "url")})
        }
    ];
}

/** Dispatches to the normalizer of `source`. */
export function normalizeAlert(source: AlertSource, payload: unknown, now: Date = new Date()): AlertEvent[] {
    switch (source) {
        case "sentry":
            return normalizeSentry(payload, now);
        case "alertmanager":
            return normalizeAlertmanager(payload, now);
        case "generic":
            return normalizeGenericAlert(payload, now);
    }
}
