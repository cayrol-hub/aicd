import type {Language} from "@aicd-ci/plugin-sdk";
import {explainSignal, type RiskLevel, type RiskReport, type SignalId} from "./score.js";

export const COMMENT_MARKER = "<!-- aicd:risk -->";

const TEXT = {
    en: {
        title: "aicd · Risk score",
        risk: "Risk",
        levels: {low: "low", medium: "medium", high: "high"},
        signals: {
            size: "Size",
            files: "Files",
            sensitive_paths: "Sensitive paths",
            migrations: "Database migrations",
            destructive_sql: "Destructive SQL",
            fix_history: "Fix history",
            missing_tests: "No test changes",
            dependencies: "Dependencies",
            ci_config: "CI / infrastructure",
            owners: "Code owners"
        },
        signal: "Signal",
        points: "Points",
        explanation: "Explanation",
        evidence: "Evidence",
        fullSuite: "full test suite required",
        dataLoss: "high whatever the score: the migration destroys data, which a rollback cannot restore",
        approvals: (n: number) => `${n} approval${n > 1 ? "s" : ""} required`,
        noSignal: "No risk signal.",
        footer: (runId: string) =>
            `Run \`${runId}\` · deterministic score: same changes, same score · aicd only comments, it never merges.`
    },
    fr: {
        title: "aicd · Score de risque",
        risk: "Risque",
        levels: {low: "faible", medium: "moyen", high: "élevé"},
        signals: {
            size: "Taille",
            files: "Fichiers",
            sensitive_paths: "Chemins sensibles",
            migrations: "Migrations de base de données",
            destructive_sql: "SQL destructeur",
            fix_history: "Historique de corrections",
            missing_tests: "Aucun test modifié",
            dependencies: "Dépendances",
            ci_config: "CI / infrastructure",
            owners: "Propriétaires du code"
        },
        signal: "Signal",
        points: "Points",
        explanation: "Explication",
        evidence: "Preuves",
        fullSuite: "suite de tests complète requise",
        dataLoss: "élevé quel que soit le score : la migration détruit des données, qu'un rollback ne restaure pas",
        approvals: (n: number) => `${n} approbation${n > 1 ? "s" : ""} requise${n > 1 ? "s" : ""}`,
        noSignal: "Aucun signal de risque.",
        footer: (runId: string) =>
            `Exécution \`${runId}\` · score déterministe : mêmes changements, même score · aicd commente seulement, il ne fusionne jamais.`
    }
} satisfies Record<Language, unknown>;

export function levelLabel(level: RiskLevel, language: Language): string {
    return TEXT[language].levels[level];
}

export function signalLabel(id: SignalId, language: Language): string {
    return TEXT[language].signals[id];
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/** Markdown comment with the score, the level and the breakdown of every signal that scored. */
export function renderRiskComment(report: RiskReport, options: {language: Language; runId: string}): string {
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const scored = report.signals.filter((signal) => signal.points > 0);
    const headline = [`**${t.risk}${colon} ${t.levels[report.level]} (${report.score}/100)**`];
    const thresholdHigh = report.thresholds.high;
    if (report.level === "high" && report.score < thresholdHigh) headline.push(t.dataLoss);
    if (report.forceFullSuite) headline.push(t.fullSuite);
    headline.push(t.approvals(report.requiredApprovals));

    const table =
        scored.length === 0
            ? t.noSignal
            : [
                  `| ${t.signal} | ${t.points} | ${t.explanation} |`,
                  "| --- | ---: | --- |",
                  ...scored.map(
                      (signal) =>
                          `| ${t.signals[signal.id]} | ${signal.points}/${signal.maxPoints} | ${cell(explainSignal(signal, options.language))} |`
                  )
              ].join("\n");

    const withEvidence = scored.filter((signal) => signal.evidence.length > 0);
    const evidence =
        withEvidence.length === 0
            ? ""
            : [
                  `<details><summary>${t.evidence}</summary>`,
                  "",
                  ...withEvidence.flatMap((signal) => [
                      `**${t.signals[signal.id]}**`,
                      "",
                      ...signal.evidence.map(
                          (item) => `- ${code(item.ref)}${item.quote ? ` — ${code(item.quote.slice(0, 200))}` : ""}`
                      ),
                      ""
                  ]),
                  "</details>"
              ].join("\n");

    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        headline.join(" · "),
        table,
        evidence,
        `<sub>${t.footer(options.runId)}</sub>`
    ]
        .filter(Boolean)
        .join("\n\n");
}
