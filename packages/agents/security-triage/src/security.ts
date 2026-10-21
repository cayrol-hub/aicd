import {z} from "zod";
import {applyEdits, callLlm, fixBranchName, type TextEdit} from "@aicd/core";
import {COLLECTIONS} from "@aicd/plugin-sdk";
import type {
    AgentResult,
    AgentRuntime,
    Confidence,
    Evidence,
    FileChange,
    ProposedAction,
    ReadonlyCI
} from "@aicd/plugin-sdk";
import {recordBaseline, splitNewAlerts} from "./baseline.js";
import {DEFAULT_IGNORE_PATHS, dedupeAlerts, matchIgnorePath} from "./heuristics.js";
import {
    buildPrompt,
    LlmSecurityVerdictSchema,
    numberedSnippet,
    SYSTEM_PROMPT,
    toTextEdits,
    verifySecurityEvidence
} from "./llm.js";
import {COMMENT_MARKER, renderFixBody, renderSecurityComment, statusDescription} from "./render.js";
import {parseSarif, sarifTools, SEVERITIES, severityAtLeast, type SecurityAlert, type Severity} from "./sarif.js";

export const AGENT_NAME = "security";
export const STATUS_CONTEXT = "aicd/security";

const severity = z.enum(SEVERITIES as [Severity, ...Severity[]]);

/** `agents.security` section of `.aicd.yaml`. */
export const SecurityTriageOptionsSchema = z
    .object({
        ignore_paths: z.array(z.string()).default([...DEFAULT_IGNORE_PATHS]),
        max_alerts: z.number().int().nonnegative().default(10),
        never_dismiss: z.array(severity).default(["critical"]),
        fail_on: severity.default("high"),
        fix_proposal: z.boolean().default(false),
        context_lines: z.number().int().nonnegative().default(20)
    })
    .strict();

export type SecurityTriageOptions = z.output<typeof SecurityTriageOptionsSchema>;

export type SecurityVerdict = "exploitable" | "not_exploitable" | "needs_review" | "likely_false_positive";

export interface TriagedAlert {
    alert: SecurityAlert;
    /** Absent from the default branch baseline. */
    isNew: boolean;
    verdict: SecurityVerdict;
    confidence: Confidence;
    source: "heuristic" | "llm";
    explanation?: string;
    evidence: Evidence[];
    /** Ignore pattern that matched the alert's file. */
    ignoredBy?: string;
    /** Set when the LLM verdict was changed by a safeguard (invented quote, never-dismiss severity). */
    downgraded?: "unverified_evidence" | "never_dismiss";
    fix?: {description: string; branch: string; files: string[]};
}

export interface SecurityReport {
    defaultBranch: boolean;
    /** True when the default branch has never been scanned: every alert counts as new. */
    baselineMissing: boolean;
    alerts: TriagedAlert[];
    newCount: number;
    existingCount: number;
    /** Ids of new alerts that fail the status. */
    blocking: string[];
    status?: "success" | "failure";
    /** Documents that could not be parsed. */
    errors: string[];
}

export interface SecurityTriageInput {
    ci: ReadonlyCI;
    /** Raw SARIF documents (one per scanner output file). */
    sarifDocuments: string[];
    /**
     * Files the merge request changes. With `sendCode: diff_only`, only alerts in these files may be shown to the
     * LLM (their code is already part of the diff); `full` lifts the restriction.
     */
    changedFiles?: string[];
    options?: Partial<SecurityTriageOptions>;
}

const VERDICT_ORDER: SecurityVerdict[] = ["exploitable", "needs_review", "not_exploitable", "likely_false_positive"];

function byPriority(a: TriagedAlert, b: TriagedAlert): number {
    return (
        Number(b.isNew) - Number(a.isNew) ||
        SEVERITIES.indexOf(b.alert.severity) - SEVERITIES.indexOf(a.alert.severity) ||
        VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict)
    );
}

/** Rules only: ignored paths are likely false positives, unless the severity may never be dismissed. */
function triageByRules(alert: SecurityAlert, isNew: boolean, options: SecurityTriageOptions): TriagedAlert {
    const ignoredBy = matchIgnorePath(alert.file, options.ignore_paths);
    if (ignoredBy && !options.never_dismiss.includes(alert.severity)) {
        return {
            alert,
            isNew,
            verdict: "likely_false_positive",
            confidence: "low",
            source: "heuristic",
            evidence: [],
            ignoredBy
        };
    }
    return {
        alert,
        isNew,
        verdict: "needs_review",
        confidence: "low",
        source: "heuristic",
        evidence: [],
        ...(ignoredBy ? {ignoredBy} : {})
    };
}

/**
 * Triages SARIF alerts. On the default branch it records the baseline and proposes nothing. On a
 * merge request, alerts absent from the baseline are new: the LLM (optional, `max_alerts` at most,
 * never with `sendCode: none`, only for changed files with `diff_only`) refines their verdict from a redacted
 * snippet, every quote is
 * verified, and a `never_dismiss` severity never ends as not exploitable. Proposes a comment (new
 * alerts only), a commit status and, with `fix_proposal`, fix merge requests whose edits apply.
 */
export async function runSecurityTriage(
    runtime: AgentRuntime,
    input: SecurityTriageInput
): Promise<AgentResult<SecurityReport>> {
    const options = SecurityTriageOptionsSchema.parse(input.options ?? {});
    const {context, logger, state} = runtime;
    const errors: string[] = [];
    const parsed: SecurityAlert[] = [];
    const tools = new Set<string>();
    input.sarifDocuments.forEach((document, index) => {
        try {
            parsed.push(...parseSarif(document, {redact: runtime.redact}));
            sarifTools(document).forEach((tool) => tools.add(tool));
        } catch (error) {
            const message = `SARIF document ${index + 1}: ${(error as Error).message}`;
            errors.push(message);
            logger.warn(`${AGENT_NAME}: ${message}`);
        }
    });
    const alerts = dedupeAlerts(parsed);
    const isDefaultBranch =
        !context.mergeRequest && !context.tag && !!context.branch && context.branch === context.defaultBranch;

    if (isDefaultBranch) {
        // A run with an unparsable document must not erase the baseline of the tools it lists.
        if (errors.length === 0 || alerts.length > 0) {
            const {recorded, removed} = await recordBaseline(state, alerts, {now: runtime.now(), tools: [...tools]});
            logger.info(`${AGENT_NAME}: baseline updated (${recorded} alerts, ${removed} removed)`);
        }
        const triaged = alerts.map((alert) => triageByRules(alert, false, options)).sort(byPriority);
        return {
            agent: AGENT_NAME,
            actions: [],
            report: {
                defaultBranch: true,
                baselineMissing: false,
                alerts: triaged,
                newCount: 0,
                existingCount: triaged.length,
                blocking: [],
                errors
            },
            llmCalls: 0,
            costUsd: 0
        };
    }

    const baselineMissing = (await state.listRecords(COLLECTIONS.securityBaseline, {limit: 1})).length === 0;
    const {newAlerts, existing} = await splitNewAlerts(state, alerts);
    const triaged = [
        ...newAlerts.map((alert) => triageByRules(alert, true, options)),
        ...existing.map((alert) => triageByRules(alert, false, options))
    ];

    let llmCalls = 0;
    let costUsd = 0;
    const fixes: {item: TriagedAlert; changes: FileChange[]}[] = [];
    if (context.mergeRequest && runtime.sendCode !== "none" && runtime.llm && options.max_alerts > 0) {
        const changed = new Set(input.changedFiles ?? []);
        const mayShow = (file: string) => runtime.sendCode === "full" || changed.has(file);
        const candidates = triaged
            .filter(
                (item) =>
                    item.isNew &&
                    item.verdict !== "likely_false_positive" &&
                    item.alert.file &&
                    mayShow(item.alert.file)
            )
            .sort(byPriority)
            .slice(0, options.max_alerts);
        const files = new Map<string, Promise<string | undefined>>();
        const read = (path: string) => {
            if (!files.has(path))
                files.set(
                    path,
                    input.ci.readFile(path).catch(() => undefined)
                );
            return files.get(path) as Promise<string | undefined>;
        };
        for (const item of candidates) {
            const outcome = await refineWithLlm(runtime, item, read, options);
            if (!outcome) continue;
            llmCalls++;
            costUsd += outcome.costUsd;
            if (outcome.changes) fixes.push({item, changes: outcome.changes});
        }
    }

    const newOnes = triaged.filter((item) => item.isNew);
    const blocking = newOnes.filter(
        (item) =>
            severityAtLeast(item.alert.severity, options.fail_on) &&
            (item.verdict === "exploitable" || item.verdict === "needs_review")
    );
    const report: SecurityReport = {
        defaultBranch: false,
        baselineMissing,
        alerts: triaged.sort(byPriority),
        newCount: newOnes.length,
        existingCount: triaged.length - newOnes.length,
        blocking: blocking.map((item) => item.alert.id),
        errors
    };

    const actions: ProposedAction[] = [];
    if (context.mergeRequest) {
        report.status = blocking.length > 0 ? "failure" : "success";
        if (newOnes.length > 0) {
            actions.push({
                type: "comment",
                marker: COMMENT_MARKER,
                body: renderSecurityComment(report, {language: runtime.language, runId: runtime.runId}),
                reason: `${newOnes.length} new security alert(s)`
            });
        }
        actions.push({
            type: "set_status",
            status: {
                state: report.status,
                context: STATUS_CONTEXT,
                description: statusDescription(report, options.fail_on, runtime.language),
                ...(context.pipelineUrl ? {url: context.pipelineUrl} : {})
            },
            reason:
                blocking.length > 0
                    ? `${blocking.length} new alert(s) of severity ${options.fail_on} or more are exploitable or need review`
                    : "no new blocking security alert"
        });
        for (const {item, changes} of fixes) {
            if (!item.fix) continue;
            actions.push({
                type: "open_fix_mr",
                fix: {
                    title: `fix(security): ${item.alert.ruleId} in ${item.alert.file ?? "code"}`,
                    body: renderFixBody(item, runtime.language),
                    branch: item.fix.branch,
                    changes
                },
                reason: `proposed fix for ${item.verdict} alert ${item.alert.ruleId}`
            });
        }
    }
    return {agent: AGENT_NAME, actions, report, llmCalls, costUsd};
}

async function refineWithLlm(
    runtime: AgentRuntime,
    item: TriagedAlert,
    read: (path: string) => Promise<string | undefined>,
    options: SecurityTriageOptions
): Promise<{costUsd: number; changes?: FileChange[]} | undefined> {
    const {alert} = item;
    const raw = alert.file ? await read(alert.file) : undefined;
    if (raw === undefined || alert.startLine === undefined) return undefined;
    const content = runtime.redact(raw);
    const snippet = numberedSnippet(
        content,
        alert.startLine - options.context_lines,
        (alert.endLine ?? alert.startLine) + options.context_lines
    );
    if (snippet.trim() === "") return undefined;

    const response = await callLlm(runtime, AGENT_NAME, {
        system: SYSTEM_PROMPT,
        prompt: buildPrompt({alert, snippet, language: runtime.language, askFix: options.fix_proposal}),
        schema: LlmSecurityVerdictSchema
    });
    if (!response) return undefined;
    const output = response.output;
    const verified = verifySecurityEvidence(output, snippet, alert.file);

    item.source = "llm";
    item.explanation = output.explanation;
    item.evidence = verified.evidence;
    if (!verified.allValid) {
        runtime.logger.warn(
            `${AGENT_NAME}: ${alert.ruleId} verdict downgraded (${verified.rejected} unverified quote(s))`
        );
        item.verdict = "needs_review";
        item.confidence = "low";
        item.downgraded = "unverified_evidence";
    } else if (output.verdict === "not_exploitable" && options.never_dismiss.includes(alert.severity)) {
        item.verdict = "needs_review";
        item.confidence = "medium";
        item.downgraded = "never_dismiss";
    } else {
        item.verdict = output.verdict;
        item.confidence = output.verdict === "needs_review" ? "low" : "medium";
    }

    const edits: TextEdit[] = toTextEdits(output);
    if (
        !options.fix_proposal ||
        !verified.allValid ||
        item.verdict === "not_exploitable" ||
        edits.length === 0 ||
        edits.some((edit) => edit.path !== alert.file)
    ) {
        return {costUsd: response.usage.costUsd};
    }
    const applied = await applyEdits(edits, read);
    if (applied.rejected.length > 0 || applied.changes.length === 0) {
        runtime.logger.warn(
            `${AGENT_NAME}: fix for ${alert.ruleId} rejected (${applied.rejected.map((r) => r.reason).join(", ") || "no change"})`
        );
        return {costUsd: response.usage.costUsd};
    }
    item.fix = {
        description: output.fix_description,
        branch: fixBranchName(`security ${alert.ruleId}`, alert.id),
        files: applied.changes.map((change) => change.path)
    };
    return {costUsd: response.usage.costUsd, changes: applied.changes};
}
