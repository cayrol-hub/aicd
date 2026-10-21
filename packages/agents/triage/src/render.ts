import type {Confidence, FailureCategory, Finding} from "@aicd/plugin-sdk";

export const COMMENT_MARKER = "<!-- aicd:triage -->";

type Language = "en" | "fr";

const TEXT = {
    en: {
        title: "aicd · Triage",
        categories: {
            regression: "Probable regression",
            flaky_test: "Flaky test",
            infrastructure: "Infrastructure problem",
            configuration: "Configuration problem",
            dependency: "Dependency problem",
            unknown: "Undetermined cause"
        },
        confidence: {low: "low", medium: "medium", high: "high"},
        confidenceLabel: "confidence",
        cause: "Probable cause",
        fix: "Suggested fix",
        evidence: "Evidence",
        tests: "Failing tests",
        suggestions: "Suggested actions (not run: autonomy too low)",
        source: {heuristic: "rules", cache: "known failure", llm: "analysis"},
        footer: (runId: string) =>
            `Run \`${runId}\` · \`aicd explain ${runId}\` for details · aicd only comments, it never merges.`
    },
    fr: {
        title: "aicd · Triage",
        categories: {
            regression: "Régression probable",
            flaky_test: "Test instable",
            infrastructure: "Problème d'infrastructure",
            configuration: "Problème de configuration",
            dependency: "Problème de dépendances",
            unknown: "Cause indéterminée"
        },
        confidence: {low: "faible", medium: "moyenne", high: "haute"},
        confidenceLabel: "confiance",
        cause: "Cause probable",
        fix: "Correctif suggéré",
        evidence: "Preuves",
        tests: "Tests en échec",
        suggestions: "Actions suggérées (non exécutées : autonomie insuffisante)",
        source: {heuristic: "règles", cache: "échec déjà connu", llm: "analyse"},
        footer: (runId: string) =>
            `Exécution \`${runId}\` · \`aicd explain ${runId}\` pour le détail · aicd commente seulement, il ne fusionne jamais.`
    }
} satisfies Record<Language, unknown>;

export function categoryLabel(category: FailureCategory, language: Language): string {
    return TEXT[language].categories[category];
}

export function confidenceLabel(confidence: Confidence, language: Language): string {
    return TEXT[language].confidence[confidence];
}

/** Markdown comment posted (and updated) on the merge request. */
export function renderTriageComment(
    findings: Finding[],
    options: {runId: string; language: Language; suggestions?: string[]}
): string {
    const t = TEXT[options.language];
    // French typography puts a space before the colon.
    const colon = options.language === "fr" ? " :" : ":";
    const sections = findings.map((finding) => {
        const lines = [
            `#### ${finding.jobName ? `\`${finding.jobName}\` — ` : ""}${t.categories[finding.category]} (${t.confidenceLabel}${colon} ${t.confidence[finding.confidence]}, ${t.source[finding.source]})`,
            "",
            finding.summary
        ];
        if (finding.cause) lines.push("", `**${t.cause}**${colon} ${finding.cause}`);
        if (finding.suggestedFix) lines.push("", `**${t.fix}**${colon} ${finding.suggestedFix}`);
        if (finding.failingTests.length > 0) {
            lines.push(
                "",
                `**${t.tests}**${colon} ${finding.failingTests
                    .slice(0, 10)
                    .map((id) => `\`${id}\``)
                    .join(", ")}`
            );
        }
        if (finding.evidence.length > 0) {
            lines.push("", `<details><summary>${t.evidence}</summary>`, "");
            for (const item of finding.evidence) {
                lines.push(`- ${item.ref}${item.quote ? ` — \`${item.quote.replace(/`/g, "'").slice(0, 300)}\`` : ""}`);
            }
            lines.push("", "</details>");
        }
        return lines.join("\n");
    });

    const suggestions = options.suggestions ?? [];
    const suggestionBlock =
        suggestions.length > 0 ? [`**${t.suggestions}**`, ...suggestions.map((s) => `- ${s}`)].join("\n") : "";

    return [COMMENT_MARKER, `### ${t.title}`, ...sections, suggestionBlock, `<sub>${t.footer(options.runId)}</sub>`]
        .filter(Boolean)
        .join("\n\n");
}
