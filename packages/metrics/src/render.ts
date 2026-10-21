import type {Language} from "@aicd-ci/plugin-sdk";
import type {DoraLevel, DoraReport} from "./dora.js";

const TEXT = {
    en: {
        title: (environment: string) => `DORA metrics · ${environment}`,
        period: "Period",
        days: "days",
        metric: "Metric",
        value: "Value",
        level: "Level",
        frequency: "Deployment frequency",
        leadTime: "Lead time for changes",
        failureRate: "Change failure rate",
        restore: "Time to restore",
        perDay: "/ day",
        perWeek: "/ week",
        deployments: (count: number, successful: number) => `${count} deployment(s), ${successful} successful`,
        commits: (count: number) => `${count} commit(s)`,
        median: "median",
        failed: (failed: number, total: number) => `${failed} of ${total} deployment(s)`,
        failures: (failures: number, restored: number, open: number) =>
            `${failures} failure(s), ${restored} restored, ${open} still open`,
        none: "no data",
        levels: {elite: "Elite", high: "High", medium: "Medium", low: "Low"},
        hours: "h",
        daysShort: "d",
        footer: "Levels: DORA 2023 State of DevOps thresholds."
    },
    fr: {
        title: (environment: string) => `Métriques DORA · ${environment}`,
        period: "Période",
        days: "jours",
        metric: "Métrique",
        value: "Valeur",
        level: "Niveau",
        frequency: "Fréquence de déploiement",
        leadTime: "Délai de mise en production",
        failureRate: "Taux d'échec des changements",
        restore: "Temps de rétablissement",
        perDay: "/ jour",
        perWeek: "/ semaine",
        deployments: (count: number, successful: number) => `${count} déploiement(s), ${successful} réussi(s)`,
        commits: (count: number) => `${count} commit(s)`,
        median: "médiane",
        failed: (failed: number, total: number) => `${failed} déploiement(s) sur ${total}`,
        failures: (failures: number, restored: number, open: number) =>
            `${failures} défaillance(s), ${restored} rétablie(s), ${open} encore ouverte(s)`,
        none: "aucune donnée",
        levels: {elite: "Élite", high: "Élevé", medium: "Moyen", low: "Faible"},
        hours: "h",
        daysShort: "j",
        footer: "Niveaux : seuils du rapport DORA 2023 State of DevOps."
    }
} satisfies Record<Language, unknown>;

/** Localized label of a DORA level. */
export function levelLabel(level: DoraLevel | null, language: Language): string {
    return level ? TEXT[language].levels[level] : "—";
}

/** DORA report as a Markdown table (en/fr) or as JSON. */
export function renderDora(report: DoraReport, options: {language: Language; format: "markdown" | "json"}): string {
    if (options.format === "json") return JSON.stringify(report, null, 2);
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const number = new Intl.NumberFormat(options.language === "fr" ? "fr-FR" : "en-US", {maximumFractionDigits: 2});
    const duration = (hours: number | null) => {
        if (hours === null) return t.none;
        return hours >= 48 ? `${number.format(hours / 24)} ${t.daysShort}` : `${number.format(hours)} ${t.hours}`;
    };
    const percent = (rate: number | null) =>
        rate === null ? t.none : `${number.format(rate * 100)}${options.language === "fr" ? " %" : "%"}`;

    const {deploymentFrequency: frequency, leadTime, changeFailureRate: cfr, timeToRestore: restore} = report;
    const rows = [
        [
            t.frequency,
            frequency.count === 0
                ? t.none
                : `${number.format(frequency.perDay)} ${t.perDay} · ${number.format(frequency.perWeek)} ${t.perWeek} (${t.deployments(frequency.count, frequency.successful)})`,
            levelLabel(frequency.level, options.language)
        ],
        [
            t.leadTime,
            leadTime.medianHours === null
                ? t.none
                : `${t.median} ${duration(leadTime.medianHours)} · p90 ${duration(leadTime.p90Hours)} (${t.commits(leadTime.commits)})`,
            levelLabel(leadTime.level, options.language)
        ],
        [
            t.failureRate,
            cfr.rate === null ? t.none : `${percent(cfr.rate)} (${t.failed(cfr.failed, cfr.deployments)})`,
            levelLabel(cfr.level, options.language)
        ],
        [
            t.restore,
            restore.medianHours === null && restore.failures === 0
                ? t.none
                : `${t.median} ${duration(restore.medianHours)} (${t.failures(restore.failures, restore.restored, restore.open)})`,
            levelLabel(restore.level, options.language)
        ]
    ];
    return [
        `### ${t.title(report.environment)}`,
        `${t.period}${colon} ${report.start.slice(0, 10)} → ${report.end.slice(0, 10)} (${number.format(report.days)} ${t.days})`,
        [
            `| ${t.metric} | ${t.value} | ${t.level} |`,
            "| --- | --- | --- |",
            ...rows.map((row) => `| ${row.join(" | ")} |`)
        ].join("\n"),
        `<sub>${t.footer}</sub>`
    ].join("\n\n");
}
