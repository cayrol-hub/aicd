import type {Language} from "@aicd-ci/plugin-sdk";
import type {Severity} from "./sarif.js";
import type {SecurityReport, SecurityVerdict, TriagedAlert} from "./security.js";

export const COMMENT_MARKER = "<!-- aicd:security -->";

const TEXT = {
    en: {
        title: "aicd · Security",
        intro: (n: number, existing: number) =>
            `${n} new security alert(s) in this merge request${existing > 0 ? ` (${existing} already on the default branch, not listed)` : ""}.`,
        noBaseline:
            "The default branch has never been scanned: every alert counts as new. Run the security agent on the default branch to record a baseline.",
        columns: ["Severity", "Rule", "Location", "Verdict"],
        severity: {critical: "critical", high: "high", medium: "medium", low: "low", note: "note"},
        verdict: {
            exploitable: "exploitable",
            not_exploitable: "not exploitable",
            needs_review: "needs review",
            likely_false_positive: "likely false positive"
        },
        source: {heuristic: "rules", llm: "analysis"},
        ignored: (pattern: string) => `file matches \`${pattern}\``,
        neverDismiss: "kept for review: this severity is never dismissed automatically",
        unverified: "analysis without verifiable quotes: needs a human review",
        evidence: "Evidence",
        fix: (branch: string) => `Fix proposed on branch \`${branch}\``,
        falsePositives: (n: number) => `${n} alert(s) in test, example, vendored or generated code`,
        footer: (runId: string) =>
            `Run \`${runId}\` · \`aicd explain ${runId}\` for details · aicd only comments, it never merges.`,
        statusFailure: (n: number, min: Severity) => `${n} new ${min}+ alert(s) to fix or review`,
        statusSuccess: (n: number) => (n > 0 ? `${n} new alert(s), none blocking` : "No new security alert")
    },
    fr: {
        title: "aicd · Sécurité",
        intro: (n: number, existing: number) =>
            `${n} nouvelle(s) alerte(s) de sécurité dans cette merge request${existing > 0 ? ` (${existing} déjà présente(s) sur la branche par défaut, non listée(s))` : ""}.`,
        noBaseline:
            "La branche par défaut n'a jamais été analysée : toutes les alertes comptent comme nouvelles. Lancez l'agent de sécurité sur la branche par défaut pour enregistrer une référence.",
        columns: ["Sévérité", "Règle", "Emplacement", "Verdict"],
        severity: {critical: "critique", high: "haute", medium: "moyenne", low: "basse", note: "info"},
        verdict: {
            exploitable: "exploitable",
            not_exploitable: "non exploitable",
            needs_review: "à vérifier",
            likely_false_positive: "faux positif probable"
        },
        source: {heuristic: "règles", llm: "analyse"},
        ignored: (pattern: string) => `le fichier correspond à \`${pattern}\``,
        neverDismiss: "gardée pour vérification : cette sévérité n'est jamais écartée automatiquement",
        unverified: "analyse sans citation vérifiable : une relecture humaine est nécessaire",
        evidence: "Preuves",
        fix: (branch: string) => `Correctif proposé sur la branche \`${branch}\``,
        falsePositives: (n: number) => `${n} alerte(s) dans du code de test, d'exemple, tiers ou généré`,
        footer: (runId: string) =>
            `Exécution \`${runId}\` · \`aicd explain ${runId}\` pour le détail · aicd commente seulement, il ne fusionne jamais.`,
        statusFailure: (n: number, min: Severity) =>
            `${n} nouvelle(s) alerte(s) ${TEXT.fr.severity[min]} ou plus à corriger ou vérifier`,
        statusSuccess: (n: number) =>
            n > 0 ? `${n} nouvelle(s) alerte(s), aucune bloquante` : "Aucune nouvelle alerte de sécurité"
    }
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function location(item: TriagedAlert): string {
    const {file, startLine} = item.alert;
    return file ? `\`${cell(file)}${startLine ? `:${startLine}` : ""}\`` : "—";
}

export function verdictLabel(verdict: SecurityVerdict, language: Language): string {
    return TEXT[language].verdict[verdict];
}

/** One-line description of the `aicd/security` commit status. */
export function statusDescription(report: SecurityReport, failOn: Severity, language: Language): string {
    const t = TEXT[language];
    return report.blocking.length > 0
        ? t.statusFailure(report.blocking.length, failOn)
        : t.statusSuccess(report.newCount);
}

/** Markdown comment posted (and updated) on the merge request: new alerts only. */
export function renderSecurityComment(report: SecurityReport, options: {language: Language; runId: string}): string {
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const fresh = report.alerts.filter((item) => item.isNew);
    const relevant = fresh.filter((item) => item.verdict !== "likely_false_positive");
    const dismissed = fresh.filter((item) => item.verdict === "likely_false_positive");

    const row = (item: TriagedAlert) =>
        `| ${t.severity[item.alert.severity]} | ${item.alert.helpUri ? `[\`${cell(item.alert.ruleId)}\`](${item.alert.helpUri})` : `\`${cell(item.alert.ruleId)}\``} | ${location(item)} | ${t.verdict[item.verdict]} (${t.source[item.source]}) |`;
    const header = [`| ${t.columns.join(" | ")} |`, `| ${t.columns.map(() => "---").join(" | ")} |`];

    const sections: string[] = [];
    if (relevant.length > 0) sections.push([...header, ...relevant.map(row)].join("\n"));

    for (const item of relevant) {
        const lines = [`#### \`${item.alert.ruleId}\` — ${location(item)}`, "", cell(item.alert.message)];
        if (item.explanation) lines.push("", item.explanation);
        if (item.downgraded === "never_dismiss") lines.push("", `_${t.neverDismiss}_`);
        if (item.downgraded === "unverified_evidence") lines.push("", `_${t.unverified}_`);
        if (item.ignoredBy) lines.push("", `_${t.ignored(item.ignoredBy)}_`);
        if (item.fix)
            lines.push(
                "",
                `**${t.fix(item.fix.branch)}**${item.fix.description ? `${colon} ${item.fix.description}` : ""}`
            );
        if (item.evidence.length > 0) {
            lines.push("", `<details><summary>${t.evidence}</summary>`, "");
            for (const evidence of item.evidence) {
                lines.push(
                    `- ${evidence.ref}${evidence.quote ? ` — \`${evidence.quote.replace(/`/g, "'").slice(0, 300)}\`` : ""}`
                );
            }
            lines.push("", "</details>");
        }
        sections.push(lines.join("\n"));
    }

    if (dismissed.length > 0) {
        sections.push(
            [
                `<details><summary>${t.falsePositives(dismissed.length)}</summary>`,
                "",
                ...header,
                ...dismissed.map(row),
                "",
                "</details>"
            ].join("\n")
        );
    }

    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        t.intro(fresh.length, report.existingCount),
        report.baselineMissing ? `> ${t.noBaseline}` : "",
        ...sections,
        `<sub>${t.footer(options.runId)}</sub>`
    ]
        .filter(Boolean)
        .join("\n\n");
}

const FIX_TEXT = {
    en: {
        intro: (severity: string, tool: string) => `Fix proposed by aicd for a ${severity} alert of ${tool}.`,
        rule: "Rule",
        location: "Location",
        alert: "Alert",
        verdict: "Verdict",
        analysis: "Analysis",
        change: "Change",
        review: "Generated by an LLM and checked only for applying cleanly: review it like any other change."
    },
    fr: {
        intro: (severity: string, tool: string) => `Correctif proposé par aicd pour une alerte ${severity} de ${tool}.`,
        rule: "Règle",
        location: "Emplacement",
        alert: "Alerte",
        verdict: "Verdict",
        analysis: "Analyse",
        change: "Modification",
        review: "Généré par un LLM et vérifié seulement sur son application propre : relisez-le comme toute autre modification."
    }
};

/** Description of a fix merge request: the alert, the analysis and the change. */
export function renderFixBody(item: TriagedAlert, language: Language): string {
    const t = FIX_TEXT[language];
    const colon = language === "fr" ? " :" : ":";
    const {alert} = item;
    const lines = [
        t.intro(TEXT[language].severity[alert.severity], alert.tool),
        "",
        `- ${t.rule}${colon} \`${alert.ruleId}\`${alert.helpUri ? ` (${alert.helpUri})` : ""}`,
        ...(alert.file ? [`- ${t.location}${colon} ${location(item)}`] : []),
        `- ${t.alert}${colon} ${cell(alert.message)}`,
        `- ${t.verdict}${colon} ${TEXT[language].verdict[item.verdict]}`
    ];
    if (item.explanation) lines.push("", `**${t.analysis}**${colon} ${item.explanation}`);
    if (item.fix?.description) lines.push("", `**${t.change}**${colon} ${item.fix.description}`);
    lines.push("", `_${t.review}_`);
    return lines.join("\n");
}
