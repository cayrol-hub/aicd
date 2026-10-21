import type {Language} from "@aicd/plugin-sdk";
import type {CoverageSource} from "./mapping.js";
import {shellQuote} from "./paths.js";
import type {Selection, SelectionDecision} from "./select.js";

export const COMMENT_MARKER = "<!-- aicd:tests -->";

const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

const list = (values: string[], max = 5) =>
    values.slice(0, max).map(code).join(", ") + (values.length > max ? ", …" : "");

const TEXT = {
    en: {
        full: "Full suite",
        sources: {
            per_test_coverage: "per-test coverage",
            convention: "naming convention",
            co_change: "git co-change"
        } satisfies Record<CoverageSource, string>,
        decision: {
            forced: () => "forced (high-risk change)",
            tag: (tag: string) => `tag pipeline ${code(tag)}`,
            default_branch: (branch: string) => `${code(branch)} is the default branch`,
            full_branch: (branch: string, pattern: string) => `branch ${code(branch)} matches ${code(pattern)}`,
            no_changes: () => "the list of changed files is empty or unknown",
            too_many_changes: (count: number, max: number) => `${count} files changed (limit ${max})`,
            force_full_file: (file: string, pattern: string) => `${code(file)} changed (matches ${code(pattern)})`,
            no_map: () => "no coverage map yet",
            undated_map: () => "the coverage map has no date",
            stale_map: (age: number, max: number) => `the coverage map is ${age} days old (limit ${max})`,
            no_tests: () => "no test file found",
            test_support_file: (file: string) => `${code(file)} is shared test code that no test is known to use`,
            covered_unmapped: (file: string) => `${code(file)} is executed by the suite but mapped to no test`,
            unmapped_source: (file: string) => `no test is mapped to ${code(file)}`,
            all_selected: () => "every test is affected"
        },
        changed_test: (test: string) => `${code(test)} selected: the test file changed`,
        snapshot: (test: string, file: string) => `${code(test)} selected: its snapshot ${code(file)} changed`,
        covers: (test: string, file: string, source: string) =>
            `${code(test)} selected: it covers ${code(file)} (${source})`,
        unmapped_tests: (tests: string[]) =>
            `${tests.length} test(s) selected because no coverage data links them to files: ${list(tests)}`,
        deleted_test: (test: string) => `${code(test)} not run: the test file was deleted`,
        ignored_file: (file: string, pattern: string) => `${code(file)} has no test impact (matches ${code(pattern)})`,
        ignored_unmapped: (file: string) => `${code(file)} is mapped to no test (unmappedSource: ignore)`,
        skipped: (count: number) => `${count} test(s) skipped: none is linked to the changed files`,
        nothing_affected: () => "No test is affected by the change",
        title: "aicd · Test selection",
        ran: (selected: number, total: number) => `**Ran ${selected} of ${total} test files**`,
        skippedCount: (count: number) => `${count} skipped`,
        fullRun: (total: number) => `**Full suite** (${total} test files)`,
        why: "Why",
        more: (count: number) => `… and ${count} more`,
        uncovered: "Changed files covered by no test",
        footer: "Skipped tests still run in full on the default branch."
    },
    fr: {
        full: "Suite complète",
        sources: {
            per_test_coverage: "couverture par test",
            convention: "convention de nommage",
            co_change: "co-modification git"
        } satisfies Record<CoverageSource, string>,
        decision: {
            forced: () => "forcée (changement à haut risque)",
            tag: (tag: string) => `pipeline de tag ${code(tag)}`,
            default_branch: (branch: string) => `${code(branch)} est la branche par défaut`,
            full_branch: (branch: string, pattern: string) =>
                `la branche ${code(branch)} correspond à ${code(pattern)}`,
            no_changes: () => "la liste des fichiers modifiés est vide ou inconnue",
            too_many_changes: (count: number, max: number) => `${count} fichiers modifiés (limite ${max})`,
            force_full_file: (file: string, pattern: string) => `${code(file)} modifié (motif ${code(pattern)})`,
            no_map: () => "pas encore de carte de couverture",
            undated_map: () => "la carte de couverture n'a pas de date",
            stale_map: (age: number, max: number) => `la carte de couverture date de ${age} jours (limite ${max})`,
            no_tests: () => "aucun fichier de test trouvé",
            test_support_file: (file: string) =>
                `${code(file)} est du code de test partagé qu'aucun test connu n'utilise`,
            covered_unmapped: (file: string) =>
                `${code(file)} est exécuté par la suite mais n'est associé à aucun test`,
            unmapped_source: (file: string) => `aucun test n'est associé à ${code(file)}`,
            all_selected: () => "tous les tests sont concernés"
        },
        changed_test: (test: string) => `${code(test)} sélectionné : le fichier de test a changé`,
        snapshot: (test: string, file: string) => `${code(test)} sélectionné : son snapshot ${code(file)} a changé`,
        covers: (test: string, file: string, source: string) =>
            `${code(test)} sélectionné : il couvre ${code(file)} (${source})`,
        unmapped_tests: (tests: string[]) =>
            `${tests.length} test(s) sélectionné(s) faute de données de couverture les reliant à des fichiers : ${list(tests)}`,
        deleted_test: (test: string) => `${code(test)} non exécuté : le fichier de test a été supprimé`,
        ignored_file: (file: string, pattern: string) =>
            `${code(file)} sans impact sur les tests (motif ${code(pattern)})`,
        ignored_unmapped: (file: string) => `${code(file)} n'est associé à aucun test (unmappedSource : ignore)`,
        skipped: (count: number) => `${count} test(s) non exécuté(s) : aucun n'est lié aux fichiers modifiés`,
        nothing_affected: () => "Aucun test n'est concerné par le changement",
        title: "aicd · Sélection des tests",
        ran: (selected: number, total: number) => `**${selected} fichiers de test exécutés sur ${total}**`,
        skippedCount: (count: number) => `${count} non exécutés`,
        fullRun: (total: number) => `**Suite complète** (${total} fichiers de test)`,
        why: "Pourquoi",
        more: (count: number) => `… et ${count} de plus`,
        uncovered: "Fichiers modifiés couverts par aucun test",
        footer: "Les tests non exécutés tournent quand même sur la branche par défaut (suite complète)."
    }
} satisfies Record<Language, unknown>;

/** One human-readable line for a selection decision. */
export function describeDecision(decision: SelectionDecision, language: Language): string {
    const t = TEXT[language];
    const colon = language === "fr" ? " :" : ":";
    const full = (text: string) => `${t.full}${colon} ${text}`;
    switch (decision.kind) {
        case "forced":
        case "no_changes":
        case "no_map":
        case "undated_map":
        case "no_tests":
        case "all_selected":
            return full(t.decision[decision.kind]());
        case "tag":
            return full(t.decision.tag(decision.tag));
        case "default_branch":
            return full(t.decision.default_branch(decision.branch));
        case "full_branch":
            return full(t.decision.full_branch(decision.branch, decision.pattern));
        case "too_many_changes":
            return full(t.decision.too_many_changes(decision.count, decision.max));
        case "force_full_file":
            return full(t.decision.force_full_file(decision.file, decision.pattern));
        case "stale_map":
            return full(t.decision.stale_map(decision.ageDays, decision.max));
        case "test_support_file":
        case "covered_unmapped":
        case "unmapped_source":
            return full(t.decision[decision.kind](decision.file));
        case "changed_test":
            return t.changed_test(decision.test);
        case "snapshot":
            return t.snapshot(decision.test, decision.file);
        case "covers":
            return t.covers(decision.test, decision.file, t.sources[decision.source]);
        case "unmapped_tests":
            return t.unmapped_tests(decision.tests);
        case "deleted_test":
            return t.deleted_test(decision.test);
        case "ignored_file":
            return t.ignored_file(decision.file, decision.pattern);
        case "ignored_unmapped":
            return t.ignored_unmapped(decision.file);
        case "skipped":
            return t.skipped(decision.count);
        case "nothing_affected":
            return t.nothing_affected();
    }
}

/**
 * Output for a pipeline script. `lines` (one test per line) and `args` (shell-quoted, space-separated) are empty
 * when the full suite must run, so that a runner called with no argument runs everything; `json` is the whole
 * selection without the structured decisions.
 */
export function formatSelection(selection: Selection, format: "lines" | "json" | "args"): string {
    if (format === "json") {
        const {full, reasons, selected, skipped, uncoveredChangedFiles} = selection;
        return JSON.stringify({full, reasons, selected, skipped, uncoveredChangedFiles}, null, 2);
    }
    if (selection.full) return "";
    return format === "args" ? selection.selected.map(shellQuote).join(" ") : selection.selected.join("\n");
}

/** Short markdown summary of a selection (without the comment marker). */
export function renderSelectionSummary(
    selection: Selection,
    options: {language: Language; maxReasons?: number}
): string {
    const t = TEXT[options.language];
    const colon = options.language === "fr" ? " :" : ":";
    const total = selection.selected.length + selection.skipped.length;
    const headline = selection.full
        ? t.fullRun(total)
        : `${t.ran(selection.selected.length, total)} · ${t.skippedCount(selection.skipped.length)}`;
    const max = options.maxReasons ?? 15;
    const reasons = selection.decisions.map((decision) => describeDecision(decision, options.language));
    const lines = [`### ${t.title}`, "", headline, "", `<details><summary>${t.why}</summary>`, ""];
    for (const reason of reasons.slice(0, max)) lines.push(`- ${reason}`);
    if (reasons.length > max) lines.push(`- ${t.more(reasons.length - max)}`);
    lines.push("", "</details>");
    if (selection.uncoveredChangedFiles.length > 0) {
        lines.push("", `**${t.uncovered}**${colon} ${list(selection.uncoveredChangedFiles, 10)}`);
    }
    if (!selection.full) lines.push("", `<sub>${t.footer}</sub>`);
    return lines.join("\n");
}
