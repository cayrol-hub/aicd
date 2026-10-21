import type {Language} from "@aicd-ci/plugin-sdk";
import type {CriterionStatus, IntentAnalysis, IntentReport} from "./intent.js";

export const COMMENT_MARKER = "<!-- aicd:intent -->";
export const STATUS_CONTEXT = "aicd/intent";

const TEXT = {
    en: {
        title: "aicd · Intent check",
        noTicket:
            "**No ticket linked.** Mention the ticket key (e.g. `ENG-123`), its link or its spec file in the title, description or branch name, so the change can be checked against its acceptance criteria.",
        tickets: "Tickets",
        criterion: "Criterion",
        status: "Status",
        evidence: "Evidence",
        statuses: {covered: "Covered", not_covered: "Not covered", unclear: "Unclear", unchecked: "Not checked"},
        noCriteria: (key: string) => `${key} has no acceptance criteria.`,
        summary: (covered: number, total: number, notCovered: number, unclear: number) =>
            `**${covered}/${total} criteria covered**${notCovered ? `, ${notCovered} not covered` : ""}${unclear ? `, ${unclear} unclear` : ""}.`,
        notChecked: {
            no_ticket: "",
            no_diff: "Criteria were not checked against the code: no diff was available.",
            send_code_none:
                "Criteria were not checked against the code: sending code to the LLM is disabled (`send_code: none`).",
            unavailable: "Criteria were not checked against the code: no LLM analysis is available for this pipeline.",
            failed: "Criteria were not checked against the code: the analysis failed."
        } satisfies Record<Exclude<IntentAnalysis, "llm">, string>,
        truncated: 'The diff was too long and was truncated: "not covered" verdicts were lowered to "unclear".',
        unrequested: "Changes no ticket asks for",
        testsChanged: (n: number) => `**Tests:** ${n} test file(s) changed.`,
        noTests: "**Tests:** no test file changed.",
        changedFiles: (n: number) => `Changed files (${n})`,
        more: (n: number) => `… and ${n} more`,
        footer: (runId: string) =>
            `Run \`${runId}\` · \`aicd explain ${runId}\` for details · verdicts are hints, the reviewer decides.`,
        commitStatus: {
            all: (covered: number, total: number) => `${covered}/${total} criteria covered`,
            gaps: (n: number) => `${n} not covered`
        }
    },
    fr: {
        title: "aicd · Conformité au ticket",
        noTicket:
            "**Aucun ticket lié.** Mentionnez la clé du ticket (par ex. `ENG-123`), son lien ou son fichier de spécification dans le titre, la description ou le nom de branche, pour que le changement soit comparé à ses critères d'acceptation.",
        tickets: "Tickets",
        criterion: "Critère",
        status: "Statut",
        evidence: "Preuves",
        statuses: {covered: "Couvert", not_covered: "Non couvert", unclear: "Incertain", unchecked: "Non vérifié"},
        noCriteria: (key: string) => `${key} n'a pas de critères d'acceptation.`,
        summary: (covered: number, total: number, notCovered: number, unclear: number) =>
            `**${covered}/${total} critère(s) couvert(s)**${notCovered ? `, ${notCovered} non couvert(s)` : ""}${unclear ? `, ${unclear} incertain(s)` : ""}.`,
        notChecked: {
            no_ticket: "",
            no_diff: "Les critères n'ont pas été vérifiés dans le code : aucun diff disponible.",
            send_code_none:
                "Les critères n'ont pas été vérifiés dans le code : l'envoi de code au LLM est désactivé (`send_code: none`).",
            unavailable:
                "Les critères n'ont pas été vérifiés dans le code : aucune analyse LLM n'est disponible pour ce pipeline.",
            failed: "Les critères n'ont pas été vérifiés dans le code : l'analyse a échoué."
        } satisfies Record<Exclude<IntentAnalysis, "llm">, string>,
        truncated:
            "Le diff était trop long et a été tronqué : les verdicts « non couvert » ont été ramenés à « incertain ».",
        unrequested: "Changements qu'aucun ticket ne demande",
        testsChanged: (n: number) => `**Tests :** ${n} fichier(s) de test modifié(s).`,
        noTests: "**Tests :** aucun fichier de test modifié.",
        changedFiles: (n: number) => `Fichiers modifiés (${n})`,
        more: (n: number) => `… et ${n} de plus`,
        footer: (runId: string) =>
            `Exécution \`${runId}\` · \`aicd explain ${runId}\` pour le détail · les verdicts sont indicatifs, le relecteur décide.`,
        commitStatus: {
            all: (covered: number, total: number) => `${covered}/${total} critère(s) couvert(s)`,
            gaps: (n: number) => `${n} non couvert(s)`
        }
    }
} satisfies Record<Language, unknown>;

export function statusLabel(status: CriterionStatus, language: Language): string {
    return TEXT[language].statuses[status];
}

/** Table cell: no line breaks, pipes escaped. */
const cell = (text: string) =>
    text
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
/** Free text from tickets or the LLM: no raw HTML (a hidden comment could fake the marker). */
const plain = (text: string) => text.replace(/</g, "&lt;").replace(/\s+/g, " ").trim();
const code = (text: string, max = 200) => {
    const squashed = text.replace(/\s+/g, " ").trim();
    return `\`${(squashed.length > max ? `${squashed.slice(0, max)}…` : squashed).replace(/`/g, "'")}\``;
};

function counts(report: IntentReport) {
    const assessed = report.criteria.filter((criterion) => criterion.status !== "unchecked");
    return {
        total: assessed.length,
        covered: assessed.filter((criterion) => criterion.status === "covered").length,
        notCovered: assessed.filter((criterion) => criterion.status === "not_covered").length,
        unclear: assessed.filter((criterion) => criterion.status === "unclear").length
    };
}

/** Short description of the `aicd/intent` commit status. */
export function statusDescription(report: IntentReport, language: Language): string {
    const t = TEXT[language].commitStatus;
    const {total, covered, notCovered} = counts(report);
    return `${t.all(covered, total)}${notCovered ? `, ${t.gaps(notCovered)}` : ""}`;
}

/** Markdown comment posted (and updated) on the merge request. */
export function renderIntentComment(report: IntentReport, options: {language: Language; runId: string}): string {
    const t = TEXT[options.language];
    const sections: string[] = [COMMENT_MARKER, `### ${t.title}`];

    if (report.tickets.length === 0) sections.push(`> ${t.noTicket}`);
    else {
        const colon = options.language === "fr" ? " :" : ":";
        const tickets = report.tickets.map((ticket) => {
            const name = ticket.url ? `[${ticket.key}](${ticket.url})` : `\`${ticket.key}\``;
            return `${name} ${plain(ticket.title)}${ticket.status ? ` (${plain(ticket.status)})` : ""}`;
        });
        sections.push(`**${t.tickets}${colon}** ${tickets.join(" · ")}`);
    }

    if (report.verdict) {
        const {total, covered, notCovered, unclear} = counts(report);
        sections.push(t.summary(covered, total, notCovered, unclear));
    }

    if (report.criteria.length > 0) {
        const rows = report.criteria.map((criterion, index) => {
            const evidence = [
                criterion.explanation ? cell(plain(criterion.explanation)) : "",
                ...criterion.evidence.map(
                    (item) => `\`${cell(item.ref)}\`${item.quote ? ` ${cell(code(item.quote))}` : ""}`
                )
            ]
                .filter(Boolean)
                .join("<br>");
            return `| ${index + 1} | ${cell(plain(criterion.text))} <sub>${cell(criterion.ticket)}</sub> | ${t.statuses[criterion.status]} | ${evidence} |`;
        });
        sections.push(
            [`| # | ${t.criterion} | ${t.status} | ${t.evidence} |`, "|---|---|---|---|", ...rows].join("\n")
        );
    }

    const notes: string[] = [];
    for (const finding of report.findings) {
        if (finding.code === "no_criteria" && finding.ticket) notes.push(t.noCriteria(finding.ticket));
    }
    if (report.analysis !== "llm" && report.analysis !== "no_ticket" && report.criteria.length > 0) {
        notes.push(t.notChecked[report.analysis]);
    }
    if (report.diffTruncated) notes.push(t.truncated);
    if (notes.length > 0) sections.push(notes.map((note) => `_${note}_`).join("\n\n"));

    if (report.unrequestedChanges.length > 0) {
        sections.push(
            [
                `**${t.unrequested}**`,
                ...report.unrequestedChanges.map(
                    (change) => `- \`${change.file}\` — ${plain(change.reason)} ${code(change.quote)}`
                )
            ].join("\n")
        );
    }

    sections.push(report.testsChanged ? t.testsChanged(report.testFiles.length) : t.noTests);

    if (report.changedFiles.length > 0) {
        const shown = report.changedFiles.slice(0, 50).map((file) => `- \`${file}\``);
        if (report.changedFiles.length > 50) shown.push(`- ${t.more(report.changedFiles.length - 50)}`);
        sections.push(
            [
                `<details><summary>${t.changedFiles(report.changedFiles.length)}</summary>`,
                "",
                ...shown,
                "",
                "</details>"
            ].join("\n")
        );
    }

    sections.push(`<sub>${t.footer(options.runId)}</sub>`);
    return sections.join("\n\n");
}
