import type {Confidence, Evidence, FailureCategory, TestOutcome} from "@aicd-ci/plugin-sdk";

export type Language = "en" | "fr";

export interface Rule {
    /** Stable name, shown in the comment's reasoning and the audit log. */
    id: "network" | "resources" | "service" | "dependency" | "configuration";
    category: Exclude<FailureCategory, "regression" | "flaky_test" | "unknown">;
    pattern: RegExp;
    summary: Record<Language, string>;
    /** What to do, when it differs from the category's usual next steps. */
    hint?: Record<Language, string>;
}

/** Checked in order: the first match wins. Infrastructure first: it explains test failures it causes. */
export const RULES: Rule[] = [
    {
        id: "network",
        category: "infrastructure",
        pattern:
            /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|getaddrinfo|network is unreachable|TLS handshake timeout|could not resolve host|connection reset(?: by peer)?|connection timed out|read timed out)\b/i,
        summary: {en: "Network error during the job.", fr: "Erreur réseau pendant le job."}
    },
    {
        id: "resources",
        category: "infrastructure",
        pattern:
            /\b(No space left on device|out of memory|OOMKilled|JavaScript heap out of memory|exit code 137|signal: killed)\b|^\s*Killed\s*$/im,
        summary: {
            en: "The runner ran out of resources (disk or memory).",
            fr: "Le runner a manqué de ressources (disque ou mémoire)."
        },
        hint: {
            en: "A retry may fail the same way: give the job more memory or disk, or make it use less (parallelism, caches, artifacts, build output).",
            fr: "Une relance risque d'échouer de la même façon : donnez plus de mémoire ou de disque au job, ou réduisez ce qu'il consomme (parallélisme, caches, artefacts, sorties de build)."
        }
    },
    {
        id: "service",
        category: "infrastructure",
        pattern:
            /\b(429 Too Many Requests|toomanyrequests|rate limit exceeded|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|runner system failure|job execution timed out|execution took longer than|The operation was canceled|The runner has received a shutdown signal)\b/i,
        summary: {en: "External service or runner failure.", fr: "Panne d'un service externe ou du runner."},
        hint: {
            en: "Rate limits and outages are usually short: wait a few minutes before re-running the job.",
            fr: "Les limites de débit et les pannes sont en général courtes : attendez quelques minutes avant de relancer le job."
        }
    },
    {
        id: "dependency",
        category: "dependency",
        pattern:
            /\b(ERESOLVE|ETARGET|No matching version found|Could not resolve dependencies|ResolutionImpossible|No matching distribution found|Could not find artifact|unknown revision|npm ERR! 404|ERR_PNPM_(NO_MATCHING_VERSION|FETCH_404)|ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*(out of date|needs to be updated))\b/i,
        summary: {en: "Dependency resolution failed.", fr: "La résolution des dépendances a échoué."}
    },
    {
        id: "configuration",
        category: "configuration",
        pattern:
            /(command not found|is not recognized as an internal or external command|Cannot find module|ModuleNotFoundError|No such file or directory|permission denied|yaml: line \d+|invalid workflow file|Unknown option|missing required (env|environment) variable|exit code 127)/i,
        summary: {
            en: "Pipeline or environment configuration problem.",
            fr: "Problème de configuration du pipeline ou de l'environnement."
        }
    }
];

const TEST_FAILURE =
    /\b(\d+ (failing|failed)|tests? failed|AssertionError|AssertError|expected .+ (to|but)|FAIL\s|assert(Equal|That)?\b)/i;

export interface HeuristicResult {
    rule: Rule["id"];
    category: FailureCategory;
    summary: string;
    confidence: Confidence;
    evidence: Evidence[];
}

export function matchRules(
    errorLines: string[],
    excerpt: string,
    language: Language = "en"
): HeuristicResult | undefined {
    for (const rule of RULES) {
        const line =
            errorLines.find((candidate) => rule.pattern.test(candidate)) ??
            (rule.pattern.test(excerpt) ? excerpt.split("\n").find((l) => rule.pattern.test(l)) : undefined);
        if (line) {
            return {
                rule: rule.id,
                category: rule.category,
                summary: rule.summary[language],
                confidence: "medium",
                evidence: [{kind: "log", ref: "log", quote: line.replace(/^L\d+: /, "").trim()}]
            };
        }
    }
    return undefined;
}

/**
 * A test is flaky when it changed status on the same commit, or flipped at least `minFlips`
 * times in its recent history.
 */
export interface Flakiness {
    flaky: boolean;
    confidence: Confidence;
    /** English, for evidence and logs. */
    detail: string;
    /** Status changes in the history, skipped runs excluded. */
    flips: number;
    runs: number;
    /** Commit on which the test both passed and failed. */
    sameCommit?: string;
}

export function flakiness(history: TestOutcome[], minFlips: number): Flakiness {
    const runs = history.filter((outcome) => outcome.status !== "skipped");
    const byCommit = new Map<string, Set<string>>();
    for (const outcome of runs) {
        if (!outcome.commitSha) continue;
        const statuses = byCommit.get(outcome.commitSha) ?? new Set<string>();
        statuses.add(outcome.status);
        byCommit.set(outcome.commitSha, statuses);
    }
    let flips = 0;
    for (let index = 1; index < runs.length; index++) {
        if (runs[index]?.status !== runs[index - 1]?.status) flips++;
    }
    const counts = {flips, runs: runs.length};
    const sameCommit = [...byCommit.entries()].find(([, statuses]) => statuses.size > 1);
    if (sameCommit) {
        const sha = sameCommit[0].slice(0, 8);
        return {
            flaky: true,
            confidence: "high",
            detail: `passed and failed on the same commit ${sha}`,
            ...counts,
            sameCommit: sha
        };
    }
    const detail = `${flips} status changes in the last ${runs.length} runs`;
    if (flips >= minFlips) return {flaky: true, confidence: "medium", detail, ...counts};
    return {flaky: false, confidence: "low", detail, ...counts};
}

export function looksLikeTestFailure(excerpt: string): boolean {
    return TEST_FAILURE.test(excerpt);
}
