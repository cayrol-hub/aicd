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
        meaning: {
            low: "Small, contained change: a standard review is enough.",
            medium: "Review this change with care: several risk signals add up.",
            high: "Handle with care before merging: get the required approvals, run the full test suite and plan how to undo it."
        },
        scope: (files: number, lines: number) =>
            `${files} file${files > 1 ? "s" : ""}, ${lines} line${lines > 1 ? "s" : ""} changed.`,
        statusFails:
            "The `aicd/risk` check fails at high risk (`fail_on_high`): it turns green once the change is made safer, or stays as a record that the risk was accepted.",
        checklist: "What the reviewer should check",
        advice: {
            size: "Large change: review it commit by commit, and consider splitting it.",
            files: "Many files touched: check that every one belongs to this change.",
            sensitive_paths:
                "Sensitive code (authentication, payments, administration…): check access control and input validation, and ask its owners to review.",
            migrations:
                "Database migration: check that it works with the version currently running (deployments are not atomic) and that it can be rolled back.",
            destructive_sql:
                "Destructive SQL: back up the data first, and prefer two steps (stop using the table or column, deploy, then drop it). A `NOT NULL` without a default fails on existing rows.",
            fix_history:
                "These files were fixed often recently: regressions are likely here, make sure tests cover the change.",
            missing_tests: "Source code changed without tests: add or update the tests that cover this change.",
            dependencies: "Dependencies changed: read the changelogs of the new versions and check their licences.",
            ci_config: "CI or infrastructure changed: check permissions and secrets, and that every check still runs.",
            owners: "Several code owners are involved: get a review from each of them."
        } satisfies Record<SignalId, string>,
        noLockfile: "A manifest changed but no lockfile: installs are not reproducible until the lockfile is updated.",
        unscored: (n: number) => `Signals with no points (${n})`,
        scale: (medium: number, high: number) =>
            `The score adds up the points of each signal, capped at 100: medium from ${medium}, high from ${high}. Same changes, same score.`,
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
        meaning: {
            low: "Changement petit et circonscrit : une relecture normale suffit.",
            medium: "Relisez ce changement avec attention : plusieurs signaux de risque s'additionnent.",
            high: "À manier avec précaution avant la fusion : obtenez les approbations requises, lancez toute la suite de tests et prévoyez comment revenir en arrière."
        },
        scope: (files: number, lines: number) =>
            `${files} fichier${files > 1 ? "s" : ""}, ${lines} ligne${lines > 1 ? "s" : ""} modifiée${lines > 1 ? "s" : ""}.`,
        statusFails:
            "La vérification `aicd/risk` échoue en risque élevé (`fail_on_high`) : elle repasse au vert quand le changement est rendu plus sûr, ou reste comme trace que le risque a été accepté.",
        checklist: "Ce que le relecteur doit vérifier",
        advice: {
            size: "Gros changement : relisez-le commit par commit, et envisagez de le découper.",
            files: "Beaucoup de fichiers touchés : vérifiez que chacun a sa place dans ce changement.",
            sensitive_paths:
                "Code sensible (authentification, paiements, administration…) : vérifiez le contrôle d'accès et la validation des entrées, et demandez la relecture de ses responsables.",
            migrations:
                "Migration de base de données : vérifiez qu'elle fonctionne avec la version actuellement en service (un déploiement n'est pas atomique) et qu'elle peut être annulée.",
            destructive_sql:
                "SQL destructeur : sauvegardez d'abord les données, et préférez deux étapes (ne plus utiliser la table ou la colonne, déployer, puis la supprimer). Un `NOT NULL` sans valeur par défaut échoue sur les lignes existantes.",
            fix_history:
                "Ces fichiers ont souvent été corrigés récemment : les régressions y sont probables, vérifiez que des tests couvrent le changement.",
            missing_tests:
                "Code source modifié sans test : ajoutez ou mettez à jour les tests qui couvrent ce changement.",
            dependencies:
                "Dépendances modifiées : lisez le changelog des nouvelles versions et vérifiez leurs licences.",
            ci_config:
                "CI ou infrastructure modifiée : vérifiez les permissions et les secrets, et que toutes les vérifications tournent encore.",
            owners: "Plusieurs responsables de code sont concernés : obtenez la relecture de chacun."
        } satisfies Record<SignalId, string>,
        noLockfile:
            "Un manifeste a changé mais aucun lockfile : les installations ne sont pas reproductibles tant que le lockfile n'est pas mis à jour.",
        unscored: (n: number) => `Signaux sans point (${n})`,
        scale: (medium: number, high: number) =>
            `Le score additionne les points de chaque signal, plafonné à 100 : moyen à partir de ${medium}, élevé à partir de ${high}. Mêmes changements, même score.`,
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
export function renderRiskComment(
    report: RiskReport,
    options: {language: Language; runId: string; failOnHigh?: boolean}
): string {
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const scored = report.signals.filter((signal) => signal.points > 0);
    const unscored = report.signals.filter((signal) => signal.points === 0);
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

    const advice = scored.map((signal) => t.advice[signal.id]);
    const dependencies = scored.find((signal) => signal.id === "dependencies");
    if (dependencies && (dependencies.facts.manifests ?? 0) > 0 && !dependencies.facts.lockfiles)
        advice.push(t.noLockfile);
    const checklist =
        advice.length === 0 ? "" : [`**${t.checklist}**`, "", ...advice.map((item) => `- [ ] ${item}`)].join("\n");

    const method = [
        `<details><summary>${t.unscored(unscored.length)}</summary>`,
        "",
        ...(unscored.length > 0 ? [unscored.map((signal) => t.signals[signal.id]).join(", "), ""] : []),
        t.scale(report.thresholds.medium, report.thresholds.high),
        "",
        "</details>"
    ].join("\n");

    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        headline.join(" · "),
        `${t.meaning[report.level]} ${t.scope(report.files, report.linesChanged)}`,
        report.level === "high" && options.failOnHigh ? `> ${t.statusFails}` : "",
        table,
        checklist,
        evidence,
        method,
        `<sub>${t.footer(options.runId)}</sub>`
    ]
        .filter(Boolean)
        .join("\n\n");
}
