import {quoteIsIn} from "@aicd/core";

/** The part of a unified diff that concerns one file. */
export interface DiffSection {
    path: string;
    text: string;
}

/** Splits a unified (git) diff by file; the path is the new path ("b/…"), or the old one for deletions. */
export function splitDiff(diff: string): DiffSection[] {
    const sections: DiffSection[] = [];
    let current: {path: string; lines: string[]; git: boolean; sawTarget: boolean} | undefined;
    const push = () => {
        if (current) sections.push({path: current.path, text: current.lines.join("\n")});
    };
    const lines = diff.split("\n");
    lines.forEach((line, index) => {
        const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (header) {
            push();
            current = {path: header[2] ?? header[1] ?? "", lines: [line], git: true, sawTarget: false};
            return;
        }
        // Plain unified diffs (no "diff --git" line): a "---" line followed by "+++" starts a file.
        const source = /^--- (?:a\/)?(.+?)(?:\t.*)?$/.exec(line);
        if (source && lines[index + 1]?.startsWith("+++ ") && !(current?.git && !current.sawTarget)) {
            push();
            current = {path: source[1] ?? "", lines: [], git: false, sawTarget: false};
        }
        const target = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
        if (target && current && !current.sawTarget) {
            current.sawTarget = true;
            if (target[1] !== "/dev/null") current.path = target[1] ?? current.path;
        }
        current ??= {path: "", lines: [], git: false, sawTarget: false};
        current.lines.push(line);
    });
    push();
    return sections.filter((section) => section.text.trim() !== "");
}

/** Diff lines without their "+", "-" or " " prefix, so quotes spanning several lines can match. */
export function stripDiffPrefixes(text: string): string {
    return text
        .split("\n")
        .filter((line) => !/^(?:diff --git|index |--- |\+\+\+ |@@ )/.test(line))
        .map((line) => line.replace(/^[+\- ]/, ""))
        .join("\n");
}

const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * The file a quote really comes from: the claimed file when the quote is in its part of the diff, else the
 * first file whose part contains it. Undefined when the quote is nowhere in the diff.
 */
export function locateQuote(quote: string, claimedFile: string, sections: DiffSection[]): string | undefined {
    const matches = (section: DiffSection) => quoteIsIn(quote, section.text, stripDiffPrefixes(section.text));
    const claimed = sections.find((section) => samePath(section.path, claimedFile.trim()));
    if (claimed && matches(claimed)) return claimed.path;
    return sections.find(matches)?.path;
}

const TEST_FILE = [
    /(^|\/)(tests?|__tests__|spec|e2e|cypress|integration-tests?)\//i,
    /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/i,
    /_test\.(go|py|rb|exs?)$/i,
    /(^|\/)test_[^/]+\.py$/i,
    /_spec\.rb$/i,
    /(Tests?|IT|Spec)\.(java|kt|scala|cs|swift|php)$/
];

/** True for test sources (not for spec documents such as docs/specs/*.md). */
export function isTestFile(path: string): boolean {
    if (/\.(md|mdx|txt|rst|adoc)$/i.test(path)) return false;
    return TEST_FILE.some((pattern) => pattern.test(path));
}
