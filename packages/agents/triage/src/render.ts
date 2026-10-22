import type {Confidence, FailureCategory, Finding, PipelineContext} from "@aicd-ci/plugin-sdk";
import type {Rule} from "./heuristics.js";
import type {FailingTest, LlmStatus, TriageFinding, TriageTrail} from "./triage.js";

export const COMMENT_MARKER = "<!-- aicd:triage -->";

type Language = "en" | "fr";

const TEXT = {
    en: {
        title: "aicd · Triage",
        headline: (jobs: number) => `**The pipeline failed: ${jobs} job${jobs > 1 ? "s" : ""} diagnosed**`,
        commit: (sha: string, branch?: string) => `commit \`${sha}\`${branch ? ` on \`${branch}\`` : ""}`,
        pipeline: "pipeline",
        categories: {
            regression: "Probable regression",
            flaky_test: "Flaky test",
            infrastructure: "Infrastructure problem",
            configuration: "Configuration problem",
            dependency: "Dependency problem",
            unknown: "Undetermined cause"
        },
        confidence: {low: "low", medium: "medium", high: "high"},
        confidenceHelp: {
            low: "a lead to check, not a certainty",
            medium: "a known pattern matched",
            high: "strong evidence"
        },
        confidenceLabel: "Confidence",
        diagnosisLabel: "Diagnosis",
        jobLabel: "Job",
        cause: "Probable cause",
        fix: "Suggested fix",
        evidence: "Evidence",
        tests: (n: number) => `Failing tests (${n})`,
        more: (n: number) => `… and ${n} more`,
        meaningLabel: "What it means",
        nextSteps: "Next steps",
        suggestions: "Suggested actions",
        meaning: {
            regression:
                "The failing tests have no history of instability and no environment problem was found: the tested behaviour most likely changed, in this change or on the branch it targets.",
            flaky_test:
                "These tests have passed and failed without any code change: this failure is probably not caused by this change.",
            infrastructure:
                "The job failed because of its environment (network, runner, external service), not because of the code under test.",
            configuration:
                "The pipeline or its environment is not set up the way the code expects: a variable, file, command, option or permission is missing or wrong. A re-run will fail the same way.",
            dependency:
                "A dependency could not be installed (a version that does not exist, an unreachable registry or an outdated lockfile), so the code itself was not tested.",
            unknown: "No rule, history or analysis explains this failure yet."
        } satisfies Record<FailureCategory, string>,
        steps: {
            regression: [
                "Read the assertion messages above, then run the failing tests locally.",
                "If the new behaviour is intended, update the tests in this change; otherwise fix the code.",
                "If you suspect an unreliable test, re-run the job: a test that passes and fails on the same commit is detected as flaky."
            ],
            flaky_test: [
                "Re-run the failed job: it will most likely pass.",
                "Find what makes the test non-deterministic (timing, test order, shared state, network, random data) and fix it.",
                "Until then, the flaky test agent can quarantine it so that it stops blocking pipelines."
            ],
            infrastructure: [
                "Re-run the job: this kind of failure is usually transient.",
                "If it happens again, check the host or service quoted in the evidence; tests should not depend on the network (use a mock or a local service)."
            ],
            configuration: [
                "Read the quoted line: it names what is missing or wrong.",
                "Add it where it belongs (CI variables or secrets, the workflow file, the runner image), or make the code work without it.",
                "If this change introduced the requirement, document it (README, `.env.example`)."
            ],
            dependency: [
                "Check that the version quoted in the evidence exists (`npm view <package> versions`, `pip index versions <package>`…).",
                "Fix the version in the manifest and update the lockfile in the same commit.",
                "If the registry could not be reached, re-run the job."
            ],
            unknown: [
                "Open the job log from the link above.",
                "With an LLM configured, aicd analyses the failures no rule explains, and keeps a diagnosis only if it quotes the log."
            ]
        } satisfies Record<FailureCategory, string[]>,
        source: {heuristic: "rules", cache: "known failure", llm: "LLM analysis"},
        reasoning: "How aicd reached this diagnosis",
        trail: {
            known: (hits: number) =>
                hits > 0
                    ? `Known failures: seen ${hits} time${hits > 1 ? "s" : ""} before, its diagnosis is reused.`
                    : "Known failures: first time this error is seen.",
            rule: (rule: Rule["id"] | null) =>
                rule
                    ? `Rules: the \`${rule}\` rule matches the log.`
                    : "Rules (network, runner resources, external services, dependencies, configuration): no match.",
            history: (testId: string, flips: number, runs: number, sameCommit: string | undefined, flaky: boolean) =>
                runs <= 1 && !sameCommit
                    ? `Test history of \`${testId}\`: no earlier run recorded, too early to tell whether it is flaky.`
                    : `Test history of \`${testId}\`: ${
                          sameCommit
                              ? `passed and failed on the same commit \`${sameCommit}\``
                              : `${flips} status change${flips === 1 ? "" : "s"} in the last ${runs} run${runs === 1 ? "" : "s"}`
                      } — ${flaky ? "flaky" : "not flaky"}.`,
            noHistory: "Test history: no test report for this job.",
            llm: {
                used: "LLM analysis: done, every quote it relies on was found in the log or the diff.",
                not_needed: "",
                not_configured:
                    "LLM analysis: none, no LLM is configured (rules only). Add an API key (`llm-api-key` input or `AICD_LLM_API_KEY`) to analyse the failures no rule explains.",
                fork: "LLM analysis: skipped, the code comes from a fork.",
                budget: "LLM analysis: skipped, the run's LLM budget is spent (`llm.budget_per_run_usd`).",
                rejected: "LLM analysis: discarded, it quoted nothing that could be found in the log or the diff.",
                failed: "LLM analysis: the call failed, the rules decided."
            } satisfies Record<LlmStatus, string>
        },
        footer: (runId: string) =>
            `Run \`${runId}\` · \`aicd explain ${runId}\` for details · aicd only comments, it never merges.`
    },
    fr: {
        title: "aicd · Triage",
        headline: (jobs: number) =>
            `**Le pipeline a échoué : ${jobs} job${jobs > 1 ? "s" : ""} diagnostiqué${jobs > 1 ? "s" : ""}**`,
        commit: (sha: string, branch?: string) => `commit \`${sha}\`${branch ? ` sur \`${branch}\`` : ""}`,
        pipeline: "pipeline",
        categories: {
            regression: "Régression probable",
            flaky_test: "Test instable",
            infrastructure: "Problème d'infrastructure",
            configuration: "Problème de configuration",
            dependency: "Problème de dépendances",
            unknown: "Cause indéterminée"
        },
        confidence: {low: "faible", medium: "moyenne", high: "haute"},
        confidenceHelp: {
            low: "une piste à vérifier, pas une certitude",
            medium: "un motif connu correspond",
            high: "preuves solides"
        },
        confidenceLabel: "Confiance",
        diagnosisLabel: "Diagnostic",
        jobLabel: "Job",
        cause: "Cause probable",
        fix: "Correctif suggéré",
        evidence: "Preuves",
        tests: (n: number) => `Tests en échec (${n})`,
        more: (n: number) => `… et ${n} de plus`,
        meaningLabel: "Ce que ça veut dire",
        nextSteps: "Que faire",
        suggestions: "Actions suggérées",
        meaning: {
            regression:
                "Les tests en échec n'ont pas d'historique d'instabilité et aucun problème d'environnement n'a été trouvé : le comportement testé a très probablement changé, dans ce changement ou sur la branche qu'il cible.",
            flaky_test:
                "Ces tests ont déjà réussi et échoué sans changement de code : cet échec ne vient probablement pas de ce changement.",
            infrastructure:
                "Le job a échoué à cause de son environnement (réseau, runner, service externe), pas du code testé.",
            configuration:
                "Le pipeline ou son environnement n'est pas configuré comme le code l'attend : une variable, un fichier, une commande, une option ou une permission manque ou est incorrecte. Une relance échouera de la même façon.",
            dependency:
                "Une dépendance n'a pas pu être installée (version inexistante, registre injoignable ou lockfile pas à jour) : le code lui-même n'a pas été testé.",
            unknown: "Aucune règle, aucun historique ni aucune analyse n'explique encore cet échec."
        } satisfies Record<FailureCategory, string>,
        steps: {
            regression: [
                "Lisez les messages d'assertion ci-dessus, puis lancez les tests en échec en local.",
                "Si le nouveau comportement est voulu, mettez à jour les tests dans ce changement ; sinon corrigez le code.",
                "Si vous soupçonnez un test peu fiable, relancez le job : un test qui réussit et échoue sur le même commit est détecté comme instable."
            ],
            flaky_test: [
                "Relancez le job en échec : il passera très probablement.",
                "Trouvez ce qui rend le test non déterministe (timing, ordre des tests, état partagé, réseau, données aléatoires) et corrigez-le.",
                "En attendant, l'agent des tests instables peut le mettre en quarantaine pour qu'il ne bloque plus les pipelines."
            ],
            infrastructure: [
                "Relancez le job : ce type d'échec est en général passager.",
                "S'il se reproduit, vérifiez l'hôte ou le service cité dans les preuves ; les tests ne devraient pas dépendre du réseau (utilisez un mock ou un service local)."
            ],
            configuration: [
                "Lisez la ligne citée : elle nomme ce qui manque ou est incorrect.",
                "Ajoutez-le là où il doit être (variables ou secrets de la CI, fichier de workflow, image du runner), ou faites fonctionner le code sans.",
                "Si ce changement a introduit ce besoin, documentez-le (README, `.env.example`)."
            ],
            dependency: [
                "Vérifiez que la version citée dans les preuves existe (`npm view <paquet> versions`, `pip index versions <paquet>`…).",
                "Corrigez la version dans le manifeste et mettez à jour le lockfile dans le même commit.",
                "Si le registre était injoignable, relancez le job."
            ],
            unknown: [
                "Ouvrez le journal du job depuis le lien ci-dessus.",
                "Avec un LLM configuré, aicd analyse les échecs qu'aucune règle n'explique, et ne garde un diagnostic que s'il cite le journal."
            ]
        } satisfies Record<FailureCategory, string[]>,
        source: {heuristic: "règles", cache: "échec déjà connu", llm: "analyse LLM"},
        reasoning: "Comment aicd a établi ce diagnostic",
        trail: {
            known: (hits: number) =>
                hits > 0
                    ? `Échecs connus : déjà vu ${hits} fois, son diagnostic est réutilisé.`
                    : "Échecs connus : première fois que cette erreur est vue.",
            rule: (rule: Rule["id"] | null) =>
                rule
                    ? `Règles : la règle \`${rule}\` correspond au journal.`
                    : "Règles (réseau, ressources du runner, services externes, dépendances, configuration) : aucune ne correspond.",
            history: (testId: string, flips: number, runs: number, sameCommit: string | undefined, flaky: boolean) =>
                runs <= 1 && !sameCommit
                    ? `Historique de \`${testId}\` : aucune exécution antérieure enregistrée, trop tôt pour dire s'il est instable.`
                    : `Historique de \`${testId}\` : ${
                          sameCommit
                              ? `réussi et échoué sur le même commit \`${sameCommit}\``
                              : `${flips} changement${flips > 1 ? "s" : ""} de statut sur les ${runs} dernière${runs > 1 ? "s" : ""} exécution${runs > 1 ? "s" : ""}`
                      } — ${flaky ? "instable" : "stable"}.`,
            noHistory: "Historique des tests : aucun rapport de tests pour ce job.",
            llm: {
                used: "Analyse LLM : faite, chaque citation sur laquelle elle s'appuie a été retrouvée dans le journal ou le diff.",
                not_needed: "",
                not_configured:
                    "Analyse LLM : aucune, aucun LLM n'est configuré (règles seulement). Ajoutez une clé d'API (entrée `llm-api-key` ou `AICD_LLM_API_KEY`) pour analyser les échecs qu'aucune règle n'explique.",
                fork: "Analyse LLM : ignorée, le code vient d'un fork.",
                budget: "Analyse LLM : ignorée, le budget LLM de l'exécution est épuisé (`llm.budget_per_run_usd`).",
                rejected: "Analyse LLM : écartée, elle ne citait rien qui se retrouve dans le journal ou le diff.",
                failed: "Analyse LLM : l'appel a échoué, les règles ont décidé."
            } satisfies Record<LlmStatus, string>
        },
        footer: (runId: string) =>
            `Exécution \`${runId}\` · \`aicd explain ${runId}\` pour le détail · aicd commente seulement, il ne fusionne jamais.`
    }
} satisfies Record<Language, unknown>;

type Text = (typeof TEXT)[Language];

export function categoryLabel(category: FailureCategory, language: Language): string {
    return TEXT[language].categories[category];
}

export function confidenceLabel(confidence: Confidence, language: Language): string {
    return TEXT[language].confidence[confidence];
}

/** Inline code: a backtick would end it early, a line break would break the list. */
const code = (text: string, max = 300) => {
    const squashed = text.replace(/\s+/g, " ").trim();
    return `\`${(squashed.length > max ? `${squashed.slice(0, max)}…` : squashed).replace(/`/g, "'")}\``;
};

function reasoning(trail: TriageTrail, t: Text): string[] {
    const lines = [t.trail.known(trail.knownHits)];
    if (trail.rule !== undefined) lines.push(t.trail.rule(trail.rule));
    if (trail.rule === null) {
        if (!trail.history || trail.history.length === 0) lines.push(t.trail.noHistory);
        else
            for (const item of trail.history.slice(0, 10))
                lines.push(t.trail.history(item.testId, item.flips, item.runs, item.sameCommit, item.flaky));
    }
    if (t.trail.llm[trail.llm]) lines.push(t.trail.llm[trail.llm]);
    return lines;
}

function renderFinding(finding: Finding | TriageFinding, t: Text, colon: string): string {
    const extra: Partial<TriageFinding> = finding;
    const job = finding.jobName
        ? extra.jobUrl
            ? `[${finding.jobName}](${extra.jobUrl})`
            : `\`${finding.jobName}\``
        : "";
    const lines = [
        `#### ${finding.jobName ? `\`${finding.jobName}\` — ` : ""}${t.categories[finding.category]}`,
        "",
        finding.summary,
        "",
        [
            `**${t.confidenceLabel}**${colon} ${t.confidence[finding.confidence]} (${t.confidenceHelp[finding.confidence]})`,
            `**${t.diagnosisLabel}**${colon} ${t.source[finding.source]}`,
            job ? `**${t.jobLabel}**${colon} ${job}` : ""
        ]
            .filter(Boolean)
            .join(" · ")
    ];
    if (finding.cause) lines.push("", `**${t.cause}**${colon} ${finding.cause}`);
    if (finding.suggestedFix) lines.push("", `**${t.fix}**${colon} ${finding.suggestedFix}`);

    const tests: FailingTest[] = extra.tests ?? finding.failingTests.map((id) => ({id, name: id}));
    if (tests.length > 0) {
        lines.push("", `**${t.tests(tests.length)}**`, "");
        for (const test of tests.slice(0, 10)) {
            const location = test.location ? ` — ${code(test.location)}` : "";
            lines.push(`- ${code(test.id)}${location}`);
            if (test.message) lines.push(`  > ${code(test.message)}`);
        }
        if (tests.length > 10) lines.push(`- ${t.more(tests.length - 10)}`);
    }

    lines.push("", `**${t.meaningLabel}**${colon} ${t.meaning[finding.category]}`);
    const steps = [...t.steps[finding.category]];
    // A rule's own advice replaces the generic "re-run" step of infrastructure problems.
    if (extra.hint) steps.splice(0, finding.category === "infrastructure" ? 1 : 0, extra.hint);
    lines.push("", `**${t.nextSteps}**`, "", ...steps.map((step, index) => `${index + 1}. ${step}`));

    if (extra.trail) {
        lines.push(
            "",
            `<details><summary>${t.reasoning}</summary>`,
            "",
            ...reasoning(extra.trail, t).map((line) => `- ${line}`),
            "",
            "</details>"
        );
    }
    if (finding.evidence.length > 0) {
        lines.push("", `<details><summary>${t.evidence}</summary>`, "");
        for (const item of finding.evidence) lines.push(`- ${item.ref}${item.quote ? ` — ${code(item.quote)}` : ""}`);
        lines.push("", "</details>");
    }
    return lines.join("\n");
}

/** Markdown comment posted (and updated) on the merge request. */
export function renderTriageComment(
    findings: (Finding | TriageFinding)[],
    options: {runId: string; language: Language; suggestions?: string[]; context?: PipelineContext}
): string {
    const t = TEXT[options.language];
    // French typography puts a space before the colon.
    const colon = options.language === "fr" ? " :" : ":";
    const context = options.context;
    const where = [
        context?.commitSha ? t.commit(context.commitSha.slice(0, 7), context.branch) : "",
        context?.pipelineUrl ? `[${t.pipeline}](${context.pipelineUrl})` : ""
    ].filter(Boolean);
    const headline = `${t.headline(findings.length)}${where.length > 0 ? ` · ${where.join(" · ")}` : ""}`;

    const suggestions = options.suggestions ?? [];
    const suggestionBlock =
        suggestions.length > 0 ? [`**${t.suggestions}**`, ...suggestions.map((s) => `- ${s}`)].join("\n") : "";

    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        headline,
        ...findings.map((finding) => renderFinding(finding, t, colon)),
        suggestionBlock,
        `<sub>${t.footer(options.runId)}</sub>`
    ]
        .filter(Boolean)
        .join("\n\n");
}
