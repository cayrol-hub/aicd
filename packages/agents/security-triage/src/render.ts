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
        whatIsNew:
            "An alert is new when the last scan of the default branch did not have it: only the alerts this change brings are listed.",
        statusFails: (n: number, min: string) =>
            `The \`aicd/security\` check fails: ${n} new alert${n > 1 ? "s" : ""} of severity ${min} or more must be fixed or reviewed (\`fail_on: ${min}\`).`,
        statusPasses: (min: string) =>
            `The \`aicd/security\` check passes: no new alert of severity ${min} or more needs action (\`fail_on: ${min}\`).`,
        rulesOnly:
            "Verdicts come from rules only: every alert needs a human review. With an LLM configured, aicd reads the code around each alert and says whether it is exploitable, quoting the code.",
        severityLabel: "Severity",
        verdictLabel: "Verdict",
        code: "Flagged code",
        todoLabel: "What to do",
        todo: {
            exploitable: "Fix it before merging: the analysis found a path from untrusted input to this code.",
            needs_review:
                "Check whether a user can control the data that reaches this code. If they can, fix it (validate, escape, or avoid the dangerous call); if they cannot, mark the alert as a false positive in the scanner with a justification.",
            not_exploitable:
                "The analysis found no way to exploit it: have a reviewer confirm, then mark it as a false positive in the scanner with that justification.",
            likely_false_positive: "Probably a false positive (test, example, vendored or generated code)."
        } satisfies Record<SecurityVerdict, string>,
        dismiss: (tool: string, rule: string) =>
            /semgrep/i.test(tool) ? ` For Semgrep: a \`// nosemgrep: ${rule}\` comment on the line.` : "",
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
        whatIsNew:
            "Une alerte est nouvelle quand la dernière analyse de la branche par défaut ne l'avait pas : seules les alertes apportées par ce changement sont listées.",
        statusFails: (n: number, min: string) =>
            `La vérification \`aicd/security\` échoue : ${n} nouvelle${n > 1 ? "s" : ""} alerte${n > 1 ? "s" : ""} de sévérité ${TEXT.fr.severity[min as Severity]} ou plus ${n > 1 ? "doivent" : "doit"} être corrigée${n > 1 ? "s" : ""} ou vérifiée${n > 1 ? "s" : ""} (\`fail_on: ${min}\`).`,
        statusPasses: (min: string) =>
            `La vérification \`aicd/security\` passe : aucune nouvelle alerte de sévérité ${TEXT.fr.severity[min as Severity]} ou plus ne demande d'action (\`fail_on: ${min}\`).`,
        rulesOnly:
            "Les verdicts viennent des règles seulement : chaque alerte demande une relecture humaine. Avec un LLM configuré, aicd lit le code autour de chaque alerte et dit si elle est exploitable, en citant le code.",
        severityLabel: "Sévérité",
        verdictLabel: "Verdict",
        code: "Code signalé",
        todoLabel: "Que faire",
        todo: {
            exploitable:
                "Corrigez-la avant la fusion : l'analyse a trouvé un chemin entre une entrée non fiable et ce code.",
            needs_review:
                "Vérifiez si un utilisateur peut contrôler les données qui arrivent à ce code. Si oui, corrigez (valider, échapper, ou éviter l'appel dangereux) ; sinon, marquez l'alerte comme faux positif dans le scanner avec une justification.",
            not_exploitable:
                "L'analyse n'a trouvé aucun moyen de l'exploiter : faites confirmer par un relecteur, puis marquez-la comme faux positif dans le scanner avec cette justification.",
            likely_false_positive: "Probablement un faux positif (code de test, d'exemple, tiers ou généré)."
        } satisfies Record<SecurityVerdict, string>,
        dismiss: (tool: string, rule: string) =>
            /semgrep/i.test(tool) ? ` Pour Semgrep : un commentaire \`// nosemgrep: ${rule}\` sur la ligne.` : "",
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
export function renderSecurityComment(
    report: SecurityReport,
    options: {language: Language; runId: string; failOn?: Severity; llm?: boolean}
): string {
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
        const lines = [
            `#### \`${item.alert.ruleId}\` — ${location(item)}`,
            "",
            `**${t.severityLabel}**${colon} ${t.severity[item.alert.severity]} · **${t.verdictLabel}**${colon} ${t.verdict[item.verdict]} (${t.source[item.source]})`,
            "",
            cell(item.alert.message)
        ];
        if (item.snippet) {
            const {startLine, text} = item.snippet;
            const width = String(startLine + text.split("\n").length - 1).length;
            const numbered = text
                .split("\n")
                .map((line, index) => `${String(startLine + index).padStart(width)} | ${line}`)
                .join("\n");
            const fence = numbered.includes("```") ? "~~~~" : "```";
            lines.push("", `${t.code}${colon}`, "", fence, numbered, fence);
        }
        if (item.explanation) lines.push("", item.explanation);
        if (item.downgraded === "never_dismiss") lines.push("", `_${t.neverDismiss}_`);
        if (item.downgraded === "unverified_evidence") lines.push("", `_${t.unverified}_`);
        if (item.ignoredBy) lines.push("", `_${t.ignored(item.ignoredBy)}_`);
        const dismiss = item.verdict === "exploitable" ? "" : t.dismiss(item.alert.tool, item.alert.ruleId);
        lines.push("", `**${t.todoLabel}**${colon} ${t.todo[item.verdict]}${dismiss}`);
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

    const status =
        options.failOn === undefined
            ? ""
            : report.blocking.length > 0
              ? `**${t.statusFails(report.blocking.length, options.failOn)}**`
              : t.statusPasses(options.failOn);
    const rulesOnly = options.llm === false || relevant.every((item) => item.source === "heuristic");

    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        `${t.intro(fresh.length, report.existingCount)} ${report.baselineMissing ? "" : t.whatIsNew}`.trim(),
        report.baselineMissing ? `> ${t.noBaseline}` : "",
        status,
        relevant.length > 0 && rulesOnly ? `_${t.rulesOnly}_` : "",
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
