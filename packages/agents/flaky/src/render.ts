import type {Language} from "@aicd-ci/plugin-sdk";
import type {FlakyReport} from "./agent.js";
import type {TestScore} from "./score.js";

export const COMMENT_MARKER = "<!-- aicd:flaky -->";

const TEXT = {
    en: {
        title: "aicd · Flaky tests",
        intro: "A test is flaky when it passes and fails without any code change. aicd scores each test from its recent history: status changes, failures, and above all a pass and a failure on the same commit.",
        quarantineMeaning: (releaseAfter: number) =>
            `A quarantined test keeps running and its failures are still reported, but they no longer block pipelines. It comes out of quarantine after ${releaseAfter} consecutive passes.`,
        stepsLabel: "What to do",
        steps: [
            "Look for what makes the test non-deterministic: timing and timeouts, test order, shared state, network calls, random data, time zones.",
            "Fix the test or the code under it; the issue opened for each quarantined test is the place to track it.",
            "Failing tests outside quarantine still block: treat them as real failures."
        ],
        failedQuarantined: "Quarantined tests that failed in this run (known flaky)",
        failedOther: "Other failing tests (not quarantined)",
        newlyFlaky: "Newly detected flaky tests",
        toQuarantine: "Proposed for quarantine",
        toRelease: "Proposed for release from quarantine",
        quarantined: (n: number) => `${n} test(s) in quarantine.`,
        header: "| Test | Score | Status changes | Runs | Confidence |",
        confidence: {low: "low", medium: "medium", high: "high"},
        passes: (n: number) => `${n} consecutive passes`,
        sameCommit: (shas: string) => `passed and failed on the same commit ${shas}`,
        evidence: (s: TestScore) => `${s.flips} status changes in ${s.runs} runs, ${s.failures} failures`,
        issueTitle: (id: string) => `Flaky test: ${id}`,
        issueBody: (s: TestScore, runId: string, releaseAfter: number) => [
            `The test \`${s.testId}\` is flaky: score ${s.score.toFixed(2)} (${s.flips} status changes in ${s.runs} runs, ${s.failures} failures, ${s.intermittentFailures} intermittent).`,
            s.sameCommitShas.length > 0
                ? `It passed and failed on the same commit: ${s.sameCommitShas.map((sha) => `\`${sha.slice(0, 8)}\``).join(", ")}.`
                : "",
            `History (oldest to newest, P = passed, F = failed): \`${s.history}\``,
            `aicd quarantined it in run \`${runId}\`: its failures no longer block the pipeline. It is released after ${releaseAfter} consecutive passes.`
        ],
        footer: (runId: string) =>
            `Run \`${runId}\` · \`aicd explain ${runId}\` for details · a quarantined test keeps running, its failures are reported, not blocking.`
    },
    fr: {
        title: "aicd · Tests instables",
        intro: "Un test est instable quand il réussit et échoue sans changement de code. aicd note chaque test d'après son historique récent : changements de statut, échecs, et surtout un succès et un échec sur le même commit.",
        quarantineMeaning: (releaseAfter: number) =>
            `Un test en quarantaine continue de s'exécuter et ses échecs restent signalés, mais ils ne bloquent plus les pipelines. Il sort de quarantaine après ${releaseAfter} succès consécutifs.`,
        stepsLabel: "Que faire",
        steps: [
            "Cherchez ce qui rend le test non déterministe : délais et timeouts, ordre des tests, état partagé, appels réseau, données aléatoires, fuseaux horaires.",
            "Corrigez le test ou le code qu'il teste ; l'issue ouverte pour chaque test en quarantaine sert à suivre ce travail.",
            "Les tests en échec hors quarantaine bloquent toujours : traitez-les comme de vrais échecs."
        ],
        failedQuarantined: "Tests en quarantaine en échec dans cette exécution (instabilité connue)",
        failedOther: "Autres tests en échec (hors quarantaine)",
        newlyFlaky: "Nouveaux tests instables détectés",
        toQuarantine: "Mise en quarantaine proposée",
        toRelease: "Sortie de quarantaine proposée",
        quarantined: (n: number) => `${n} test(s) en quarantaine.`,
        header: "| Test | Score | Changements de statut | Exécutions | Confiance |",
        confidence: {low: "faible", medium: "moyenne", high: "haute"},
        passes: (n: number) => `${n} succès consécutifs`,
        sameCommit: (shas: string) => `réussi et échoué sur le même commit ${shas}`,
        evidence: (s: TestScore) => `${s.flips} changements de statut en ${s.runs} exécutions, ${s.failures} échecs`,
        issueTitle: (id: string) => `Test instable : ${id}`,
        issueBody: (s: TestScore, runId: string, releaseAfter: number) => [
            `Le test \`${s.testId}\` est instable : score ${s.score.toFixed(2)} (${s.flips} changements de statut en ${s.runs} exécutions, ${s.failures} échecs, dont ${s.intermittentFailures} intermittents).`,
            s.sameCommitShas.length > 0
                ? `Il a réussi et échoué sur le même commit : ${s.sameCommitShas.map((sha) => `\`${sha.slice(0, 8)}\``).join(", ")}.`
                : "",
            `Historique (du plus ancien au plus récent, P = réussi, F = échoué) : \`${s.history}\``,
            `aicd l'a mis en quarantaine lors de l'exécution \`${runId}\` : ses échecs ne bloquent plus le pipeline. Il en sort après ${releaseAfter} succès consécutifs.`
        ],
        footer: (runId: string) =>
            `Exécution \`${runId}\` · \`aicd explain ${runId}\` pour le détail · un test en quarantaine continue de s'exécuter, ses échecs sont signalés sans bloquer.`
    }
} satisfies Record<Language, unknown>;

const code = (id: string) => `\`${id.replace(/`/g, "'")}\``;
const shortShas = (shas: string[]) => shas.map((sha) => sha.slice(0, 8)).join(", ");

/** One line of evidence for a score, in English: used in action reasons and the audit log. */
export function describeScore(score: TestScore): string {
    const evidence = `flaky score ${score.score.toFixed(2)} (${score.flips} status changes in ${score.runs} runs)`;
    return score.sameCommitShas.length > 0
        ? `${evidence}, passed and failed on the same commit ${shortShas(score.sameCommitShas)}`
        : evidence;
}

function list(title: string, items: string[], colon: string): string {
    if (items.length === 0) return "";
    const shown = items.slice(0, 20);
    const more = items.length > shown.length ? [`- … +${items.length - shown.length}`] : [];
    return [`**${title}**${colon}`, ...shown.map((item) => `- ${item}`), ...more].join("\n");
}

/** Markdown comment posted (and updated) on the merge request. */
export function renderFlakyComment(
    report: FlakyReport,
    options: {runId: string; language: Language; releaseAfter?: number}
): string {
    const t = TEXT[options.language];
    // French typography puts a space before the colon.
    const colon = options.language === "fr" ? " :" : ":";
    const evidence = (score: TestScore) =>
        score.sameCommitShas.length > 0
            ? `${t.evidence(score)}, ${t.sameCommit(shortShas(score.sameCommitShas))}`
            : t.evidence(score);

    const newly =
        report.newlyFlaky.length > 0
            ? [
                  `**${t.newlyFlaky}**${colon}`,
                  "",
                  t.header,
                  "| --- | --- | --- | --- | --- |",
                  ...report.newlyFlaky
                      .slice(0, 20)
                      .map(
                          (s) =>
                              `| ${code(s.testId)} | ${s.score.toFixed(2)} | ${s.flips} | ${s.runs} | ${t.confidence[s.confidence]} |`
                      )
              ].join("\n")
            : "";

    const quarantining = report.toQuarantine.length > 0 || report.failing.quarantined.length > 0;
    return [
        COMMENT_MARKER,
        `### ${t.title}`,
        t.intro,
        list(t.failedQuarantined, report.failing.quarantined.map(code), colon),
        report.failing.quarantined.length > 0
            ? list(t.failedOther, report.failing.notQuarantined.map(code), colon)
            : "",
        newly,
        list(
            t.toQuarantine,
            report.toQuarantine.map((entry) => `${code(entry.testId)} — ${evidence(entry.score)}`),
            colon
        ),
        list(
            t.toRelease,
            report.toRelease.map((entry) => `${code(entry.testId)} — ${t.passes(entry.consecutivePasses)}`),
            colon
        ),
        report.quarantined.length > 0 ? t.quarantined(report.quarantined.length) : "",
        quarantining && options.releaseAfter !== undefined ? t.quarantineMeaning(options.releaseAfter) : "",
        report.newlyFlaky.length > 0 || quarantining
            ? [`**${t.stepsLabel}**`, "", ...t.steps.map((step, index) => `${index + 1}. ${step}`)].join("\n")
            : "",
        `<sub>${t.footer(options.runId)}</sub>`
    ]
        .filter(Boolean)
        .join("\n\n");
}

/** Issue proposed for a newly quarantined test, with its history as evidence. */
export function renderIssue(
    score: TestScore,
    options: {runId: string; language: Language; releaseAfter: number}
): {title: string; body: string} {
    const t = TEXT[options.language];
    return {
        title: t.issueTitle(score.testId),
        body: t.issueBody(score, options.runId, options.releaseAfter).filter(Boolean).join("\n\n")
    };
}
