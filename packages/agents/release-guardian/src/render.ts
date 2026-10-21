import type {Language} from "@aicd/plugin-sdk";
import type {GuardReport, Health, MetricResult, Verdict} from "./guard.js";
import type {Comparison} from "./stats.js";

export const COMMENT_MARKER = "<!-- aicd:release-guardian -->";

const TEXT = {
    en: {
        title: "aicd · Release guardian",
        verdictLabel: "Verdict",
        verdict: {continue: "Continue", pause: "Pause", rollback: "Roll back"},
        health: {
            healthy: "No degradation detected on the metrics observed.",
            degraded: "Degradation detected after the deployment.",
            no_data: "No data: the guard could not judge this deployment. No data does not mean healthy.",
            partial: "No degradation on the data available, but some sources returned nothing: partial view."
        },
        deployment: (what: string, env: string, id: string) => `${what} in \`${env}\` (deployment \`${id}\`)`,
        headers: ["Metric", "Before (mean / p95)", "After (mean / p95)", "Degradation", "Status"],
        status: {ok: "OK", degraded: "degraded", severe: "severe", no_data: "no data", error: "error"},
        fromZero: "from 0",
        newErrors: "New errors",
        newErrorsLine: (n: number, threshold: number) =>
            `${n} new error group(s) since the deployment (threshold ${threshold})`,
        errorsUnavailable: "New errors could not be read",
        events: "events",
        explanation: "Explanation",
        suspect: "Most suspect commit",
        footer: (baseline: string, observe: string, runId?: string) =>
            `Baseline ${baseline}, observed ${observe}${runId ? ` · Run \`${runId}\`` : ""} · aicd proposes, the policy decides.`
    },
    fr: {
        title: "aicd · Gardien de déploiement",
        verdictLabel: "Verdict",
        verdict: {continue: "Continuer", pause: "Mettre en pause", rollback: "Revenir en arrière"},
        health: {
            healthy: "Aucune dégradation détectée sur les métriques observées.",
            degraded: "Dégradation détectée après le déploiement.",
            no_data:
                "Aucune donnée : le gardien n'a pas pu juger ce déploiement. L'absence de données ne veut pas dire que tout va bien.",
            partial:
                "Aucune dégradation sur les données disponibles, mais certaines sources n'ont rien renvoyé : vue partielle."
        },
        deployment: (what: string, env: string, id: string) => `${what} en \`${env}\` (déploiement \`${id}\`)`,
        headers: ["Métrique", "Avant (moyenne / p95)", "Après (moyenne / p95)", "Dégradation", "État"],
        status: {ok: "OK", degraded: "dégradée", severe: "sévère", no_data: "aucune donnée", error: "erreur"},
        fromZero: "depuis 0",
        newErrors: "Nouvelles erreurs",
        newErrorsLine: (n: number, threshold: number) =>
            `${n} nouveau(x) groupe(s) d'erreurs depuis le déploiement (seuil ${threshold})`,
        errorsUnavailable: "Les nouvelles erreurs n'ont pas pu être lues",
        events: "événements",
        explanation: "Explication",
        suspect: "Commit le plus suspect",
        footer: (baseline: string, observe: string, runId?: string) =>
            `Référence ${baseline}, observation ${observe}${runId ? ` · Exécution \`${runId}\`` : ""} · aicd propose, la politique décide.`
    }
} satisfies Record<Language, unknown>;

/** Short numbers for humans: integers as is, otherwise 4 significant digits. */
export function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
}

function formatChange(change: Comparison | undefined, language: Language): string {
    if (!change) return "—";
    if (change.relative === null) return TEXT[language].fromZero;
    const percent = Math.round(change.relative * 100);
    const sign = percent > 0 ? "+" : "";
    return `${sign}${percent}${language === "fr" ? " %" : "%"} (${change.statistic})`;
}

const pair = (stats: MetricResult["baseline"]) =>
    stats ? `${formatNumber(stats.mean)} / ${formatNumber(stats.p95)}` : "—";

export function verdictLabel(verdict: Verdict, language: Language): string {
    return TEXT[language].verdict[verdict];
}

export function healthLabel(health: Health, language: Language): string {
    return TEXT[language].health[health];
}

/** One line per metric, in English, for the LLM prompt (quotes are verified against these lines). */
export function metricsLines(report: GuardReport): string[] {
    return report.metrics.map((metric) => {
        const parts = [`${metric.name} [${metric.status}]`];
        if (metric.baseline)
            parts.push(`before mean=${formatNumber(metric.baseline.mean)} p95=${formatNumber(metric.baseline.p95)}`);
        if (metric.observed)
            parts.push(`after mean=${formatNumber(metric.observed.mean)} p95=${formatNumber(metric.observed.p95)}`);
        if (metric.change) parts.push(`degradation ${formatChange(metric.change, "en")}`);
        return parts.join("; ");
    });
}

/** Markdown table of the metrics, also used as the notification text. */
export function renderMetricsTable(report: GuardReport, language: Language): string {
    const t = TEXT[language];
    const escape = (text: string) => text.replace(/\|/g, "\\|");
    const lines = [`| ${t.headers.join(" | ")} |`, `|${t.headers.map(() => " --- ").join("|")}|`];
    for (const metric of report.metrics) {
        lines.push(
            `| \`${escape(metric.name)}\` | ${pair(metric.baseline)} | ${pair(metric.observed)} | ${formatChange(metric.change, language)} | ${t.status[metric.status]} |`
        );
    }
    if (report.newErrors.status !== "not_configured") {
        const status = report.newErrors.status === "error" ? t.status.error : t.status[report.newErrors.status];
        lines.push(
            `| ${t.newErrors} | — | ${report.newErrors.status === "error" ? "—" : report.newErrors.groups.length} | ≥ ${report.newErrors.threshold} | ${status} |`
        );
    }
    return lines.join("\n");
}

const hhmm = (iso: string) => `${iso.slice(11, 16)}`;
const range = (window: {start: string; end: string}) =>
    `${window.start.slice(0, 10)} ${hhmm(window.start)}–${hhmm(window.end)} UTC`;

/** Markdown report posted on the merge request (one comment, updated in place) and printed by the CLI. */
export function renderGuardReport(report: GuardReport, options: {language: Language; runId?: string}): string {
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const {deployment} = report;
    const what = `\`${deployment.service ?? deployment.id}\`${deployment.version ? ` ${deployment.version}` : ""}`;
    const sections = [
        COMMENT_MARKER,
        `### ${t.title}`,
        `**${t.verdictLabel}${colon} ${t.verdict[report.verdict]}** — ${t.deployment(what, deployment.environment, deployment.id)}`,
        t.health[report.health]
    ];
    if (report.metrics.length > 0 || report.newErrors.status !== "not_configured") {
        sections.push(renderMetricsTable(report, options.language));
    }
    if (report.newErrors.status === "error") {
        sections.push(`**${t.errorsUnavailable}**${colon} ${report.newErrors.error ?? ""}`);
    } else if (report.newErrors.groups.length > 0) {
        const groups = report.newErrors.groups.slice(0, 10).map((group) => {
            const title = group.title.replace(/`/g, "'").slice(0, 200);
            return `- ${group.url ? `[${title}](${group.url})` : title} (${group.count} ${t.events})`;
        });
        sections.push(
            [
                `**${t.newErrors}**${colon} ${t.newErrorsLine(report.newErrors.groups.length, report.newErrors.threshold)}`,
                ...groups
            ].join("\n")
        );
    }
    if (report.explanation) sections.push(`**${t.explanation}**${colon} ${report.explanation}`);
    if (report.suspectCommit) {
        const {sha, subject, reason} = report.suspectCommit;
        sections.push(
            `**${t.suspect}**${colon} \`${sha.slice(0, 12)}\`${subject ? ` ${subject}` : ""}${reason ? ` — ${reason}` : ""}`
        );
    }
    sections.push(
        `<sub>${t.footer(range(report.windows.baseline), range(report.windows.observe), options.runId)}</sub>`
    );
    return sections.join("\n\n");
}
