/** Most criteria kept per ticket. */
export const MAX_CRITERIA = 30;

const CRITERIA_HEADINGS =
    /^(acceptance criteria|acceptance criterion|acceptance tests?|acs?|criteres? d'acceptation|criteres? d'acceptance|definition of done|dod|definition de fini|expected (behaviou?rs?|results?)|comportements? attendus?|resultats? attendus?)$/;

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const CHECKLIST_ITEM = /^\s*(?:[-*+]|\d+[.)])?\s*\[[ xX]\]\s+(.*)$/;
const SCENARIO = /^\s*(?:scenario(?: outline| template)?|sc[ée]nario(?: outline)?|plan du sc[ée]nario|example)\s*:/i;
const STEP =
    /^\s*(?:[-*+]\s+)?(?:given|when|then|and|but|[ée]tant donn[ée]e?s?|soit|quand|lorsque|alors|et|mais)(?=[\s,:]|$)/i;
const FIRST_STEP = /^\s*(?:[-*+]\s+)?(?:given|[ée]tant donn[ée]e?s?|soit)(?=[\s,:]|$)/i;
const FENCE = /^\s*(```|~~~)/;
const MARKDOWN_HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;

/** Lower case, no accents, no markdown emphasis, no trailing colon: the form headings are compared in. */
function headingKey(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[’`]/g, "'")
        .replace(/[*_]/g, "")
        .replace(/\s*\(.*\)\s*$/, "")
        .replace(/[\s:.]+$/, "")
        .trim()
        .toLowerCase();
}

/** The text of a heading-like line, or undefined: markdown headings, bold-only lines, short "Title:" lines. */
function headingText(line: string): string | undefined {
    const markdown = MARKDOWN_HEADING.exec(line);
    if (markdown) return markdown[1] ?? "";
    const bold = BOLD_LINE.exec(line);
    if (bold) return bold[1] ?? "";
    const trimmed = line.trim();
    if (LIST_ITEM.test(line) || CHECKLIST_ITEM.test(line)) return undefined;
    if (trimmed.length <= 60 && trimmed.endsWith(":")) return trimmed;
    if (CRITERIA_HEADINGS.test(headingKey(trimmed))) return trimmed;
    return undefined;
}

function clean(text: string): string {
    return text
        .replace(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Acceptance criteria found in a ticket description: items under a criteria heading ("Acceptance criteria",
 * "Critères d'acceptation", "AC", "Definition of done", "Expected behaviour", "Comportement attendu"…, as a
 * markdown heading, a bold line or a "Title:" line), checklist items anywhere, and Gherkin scenarios anywhere
 * (the scenario line and its Given/When/Then steps kept together in one item). Deduplicated, at most 30.
 */
export function extractAcceptanceCriteria(text: string): string[] {
    const items: string[] = [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let inSection = false;
    let inFence = false;
    let paragraph: string[] = [];
    let scenario: string[] | undefined;
    let lastWasItem = false;

    const flushParagraph = () => {
        if (paragraph.length > 0) items.push(clean(paragraph.join(" ")));
        paragraph = [];
    };
    const flushScenario = () => {
        if (scenario && scenario.length > 0) items.push(clean(scenario.join(" ")));
        scenario = undefined;
    };

    for (const line of lines) {
        if (FENCE.test(line)) {
            flushParagraph();
            flushScenario();
            inFence = !inFence;
            lastWasItem = false;
            continue;
        }
        const trimmed = line.trim();

        // Gherkin, inside or outside fences and sections.
        if (SCENARIO.test(line)) {
            flushParagraph();
            flushScenario();
            scenario = [trimmed];
            lastWasItem = false;
            continue;
        }
        if (STEP.test(line) && (scenario || FIRST_STEP.test(line))) {
            flushParagraph();
            const step = (LIST_ITEM.exec(line)?.[1] ?? trimmed).trim();
            if (scenario) scenario.push(step);
            else scenario = [step];
            continue;
        }
        if (scenario && (trimmed === "" || trimmed.startsWith("|") || /^\s*examples?\s*:/i.test(line))) {
            // Blank lines and example tables do not end a scenario.
            continue;
        }
        flushScenario();
        if (inFence) continue;

        const checklist = CHECKLIST_ITEM.exec(line);
        if (checklist) {
            flushParagraph();
            items.push(clean(checklist[1] ?? ""));
            lastWasItem = true;
            continue;
        }

        const heading = headingText(line);
        if (heading !== undefined) {
            flushParagraph();
            inSection = CRITERIA_HEADINGS.test(headingKey(heading));
            lastWasItem = false;
            continue;
        }
        if (!inSection) {
            lastWasItem = false;
            continue;
        }

        const listItem = LIST_ITEM.exec(line);
        if (listItem) {
            flushParagraph();
            items.push(clean(listItem[1] ?? ""));
            lastWasItem = true;
        } else if (trimmed === "") {
            flushParagraph();
            lastWasItem = false;
        } else if (lastWasItem && /^\s{2,}/.test(line) && items.length > 0) {
            // Continuation of the previous list item.
            items[items.length - 1] = clean(`${items[items.length - 1]} ${trimmed}`);
        } else {
            paragraph.push(trimmed);
            lastWasItem = false;
        }
    }
    flushParagraph();
    flushScenario();

    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const key = item.toLowerCase();
        if (item.length < 2 || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= MAX_CRITERIA) break;
    }
    return result;
}
