import {createHash} from "node:crypto";

export type Severity = "critical" | "high" | "medium" | "low" | "note";

/** From the least to the most severe. */
export const SEVERITIES: readonly Severity[] = ["note", "low", "medium", "high", "critical"];

export function severityAtLeast(value: Severity, minimum: Severity): boolean {
    return SEVERITIES.indexOf(value) >= SEVERITIES.indexOf(minimum);
}

/** One scanner finding, whatever the tool. */
export interface SecurityAlert {
    /** Stable across runs and line shifts: same alert → same id. */
    id: string;
    tool: string;
    ruleId: string;
    severity: Severity;
    message: string;
    file?: string;
    startLine?: number;
    endLine?: number;
    helpUri?: string;
}

/** Thrown when a document is not SARIF at all (invalid JSON, no `runs`). */
export class SarifError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SarifError";
    }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `security-severity` is a CVSS-like score in a string ("8.8"). */
export function severityFromScore(score: number): Severity {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    if (score > 0) return "low";
    return "note";
}

/** SARIF level → severity. The SARIF default level is "warning". */
export function severityFromLevel(level: string | undefined): Severity {
    switch (level) {
        case "error":
            return "high";
        case "note":
            return "low";
        case "none":
            return "note";
        default:
            return "medium";
    }
}

function securitySeverity(...holders: unknown[]): number | undefined {
    for (const holder of holders) {
        if (!isObject(holder) || !isObject(holder.properties)) continue;
        const raw = holder.properties["security-severity"];
        const score = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
        if (Number.isFinite(score)) return score;
    }
    return undefined;
}

/** Removes what moves between runs (line and column numbers, whitespace) from a message or snippet. */
export function normalizeForId(text: string): string {
    return text.toLowerCase().replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim();
}

/** `file:///repo/src/a.ts` (scan root `file:///repo/`), `./src/a.ts` → `src/a.ts`. Relative URIs are kept relative. */
function normalizeUri(uri: string, bases: Map<string, string>): string {
    let path = uri;
    if (/^file:/i.test(path)) {
        path = path.replace(/^file:\/\//i, "");
        for (const root of bases.values()) {
            const prefix = root.replace(/^file:\/\//i, "").replace(/\/?$/, "/");
            if (prefix !== "/" && path.startsWith(prefix)) {
                path = path.slice(prefix.length);
                break;
            }
        }
    }
    try {
        path = decodeURIComponent(path);
    } catch {
        // Keep the raw path when it is not valid percent-encoding.
    }
    return path.replace(/^\.\//, "");
}

function hash(parts: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function formatMessage(text: string, args: unknown[]): string {
    return text.replace(/\{(\d+)\}/g, (match, index: string) => {
        const value = args[Number(index)];
        return value === undefined ? match : String(value);
    });
}

interface RuleInfo {
    id: string;
    rule?: Json;
}

function findRule(result: Json, rules: Json[], extensionRules: Json[]): RuleInfo {
    const ref = isObject(result.rule) ? result.rule : undefined;
    const index = asNumber(result.ruleIndex) ?? asNumber(ref?.index);
    const byIndex = index !== undefined ? rules[index] : undefined;
    const id = asString(result.ruleId) ?? asString(ref?.id) ?? asString(byIndex?.id) ?? "unknown";
    const byId = [...rules, ...extensionRules].find((rule) => rule.id === id);
    const rule = byIndex && (byIndex.id === id || id === "unknown") ? byIndex : (byId ?? byIndex);
    return rule ? {id, rule} : {id};
}

function messageOf(result: Json, rule: Json | undefined): string {
    const message = isObject(result.message) ? result.message : {};
    const args = asArray(message.arguments);
    const text = asString(message.text) ?? asString(message.markdown);
    if (text) return formatMessage(text, args);
    const messageId = asString(message.id);
    const strings = isObject(rule?.messageStrings) ? rule.messageStrings : {};
    const fromRule = messageId && isObject(strings[messageId]) ? asString(strings[messageId].text) : undefined;
    if (fromRule) return formatMessage(fromRule, args);
    const short = isObject(rule?.shortDescription) ? asString(rule.shortDescription.text) : undefined;
    return short ?? "";
}

function firstFingerprint(result: Json): [string, string] | undefined {
    for (const field of ["fingerprints", "partialFingerprints"] as const) {
        const prints = result[field];
        if (!isObject(prints)) continue;
        const key = Object.keys(prints)
            .sort()
            .find((name) => typeof prints[name] === "string" && prints[name] !== "");
        if (key) return [key, prints[key] as string];
    }
    return undefined;
}

function parseDocument(json: string | unknown): Json {
    let document: unknown = json;
    if (typeof json === "string") {
        try {
            document = JSON.parse(json);
        } catch (error) {
            throw new SarifError(`invalid JSON: ${(error as Error).message}`);
        }
    }
    if (!isObject(document) || !Array.isArray(document.runs)) throw new SarifError("not a SARIF document (no runs)");
    return document;
}

/** Names of the tools of a SARIF document, including runs without results. */
export function sarifTools(json: string | unknown): string[] {
    const document = parseDocument(json);
    const tools = document.runs as unknown[];
    return [...new Set(tools.filter(isObject).map(toolName))];
}

function toolName(run: Json): string {
    const tool = isObject(run.tool) ? run.tool : {};
    const driver = isObject(tool.driver) ? tool.driver : {};
    return asString(driver.name) ?? "unknown";
}

/**
 * Normalizes a SARIF 2.1.0 document (string or parsed) into alerts. Severity comes from the
 * `security-severity` score when present, else from the SARIF level. The id is the scanner's
 * fingerprint when it gives one, else a hash of tool, rule, file and normalized snippet or
 * message: it never depends on line numbers. `redact` is applied to messages and snippets.
 */
export function parseSarif(json: string | unknown, options: {redact?: (text: string) => string} = {}): SecurityAlert[] {
    const redact = options.redact ?? ((text: string) => text);
    const document = parseDocument(json);
    const alerts: SecurityAlert[] = [];
    for (const run of (document.runs as unknown[]).filter(isObject)) {
        const tool = toolName(run);
        const driver = isObject(run.tool) && isObject(run.tool.driver) ? run.tool.driver : {};
        const rules = asArray(driver.rules).filter(isObject);
        const extensionRules = asArray(isObject(run.tool) ? run.tool.extensions : undefined)
            .filter(isObject)
            .flatMap((extension) => asArray(extension.rules).filter(isObject));
        const bases = new Map<string, string>();
        if (isObject(run.originalUriBaseIds)) {
            for (const [name, value] of Object.entries(run.originalUriBaseIds)) {
                const uri = isObject(value) ? asString(value.uri) : undefined;
                if (uri) bases.set(name, uri);
            }
        }

        for (const result of asArray(run.results).filter(isObject)) {
            if (result.kind !== undefined && result.kind !== "fail") continue;
            if (asArray(result.suppressions).some((s) => isObject(s) && (s.status ?? "accepted") === "accepted"))
                continue;
            const {id: ruleId, rule} = findRule(result, rules, extensionRules);
            const configuration = isObject(rule?.defaultConfiguration) ? rule.defaultConfiguration : {};
            const level = asString(result.level) ?? asString(configuration.level);
            const score = securitySeverity(result, rule);
            const severity = score !== undefined ? severityFromScore(score) : severityFromLevel(level);
            const message = redact(messageOf(result, rule).trim());

            const location = asArray(result.locations).find(isObject);
            const physical = location && isObject(location.physicalLocation) ? location.physicalLocation : {};
            const artifact = isObject(physical.artifactLocation) ? physical.artifactLocation : {};
            const region = isObject(physical.region) ? physical.region : {};
            const uri = asString(artifact.uri);
            const file = uri ? normalizeUri(uri, bases) : undefined;
            const startLine = asNumber(region.startLine);
            const endLine = asNumber(region.endLine) ?? startLine;
            const snippet = isObject(region.snippet) ? asString(region.snippet.text) : undefined;
            const helpUri = asString(rule?.helpUri);

            const fingerprint = firstFingerprint(result);
            const id = fingerprint
                ? hash([tool, ruleId, ...fingerprint])
                : hash([tool, ruleId, file ?? "", normalizeForId(snippet ? redact(snippet) : message)]);

            alerts.push({
                id,
                tool,
                ruleId,
                severity,
                message,
                ...(file ? {file} : {}),
                ...(startLine !== undefined ? {startLine} : {}),
                ...(endLine !== undefined ? {endLine} : {}),
                ...(helpUri ? {helpUri} : {})
            });
        }
    }
    return alerts;
}
