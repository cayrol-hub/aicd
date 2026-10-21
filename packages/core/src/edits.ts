import type {FileChange} from "@aicd-ci/plugin-sdk";

/** A change an LLM may propose: replace one exact, unique snippet of a file. */
export interface TextEdit {
    path: string;
    search: string;
    replace: string;
}

export interface EditResult {
    changes: FileChange[];
    /** Edits refused, with the reason. Nothing is applied to a file with a refused edit. */
    rejected: {edit: TextEdit; reason: string}[];
}

/**
 * Applies search/replace edits. An edit is refused when its `search` text is missing or
 * appears more than once: an LLM never rewrites a file it has not quoted exactly.
 */
export async function applyEdits(
    edits: TextEdit[],
    read: (path: string) => Promise<string | undefined>
): Promise<EditResult> {
    const byPath = new Map<string, TextEdit[]>();
    for (const edit of edits) byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);

    const changes: FileChange[] = [];
    const rejected: EditResult["rejected"] = [];
    for (const [path, fileEdits] of byPath) {
        if (path.includes("..") || path.startsWith("/")) {
            fileEdits.forEach((edit) => rejected.push({edit, reason: "path outside the repository"}));
            continue;
        }
        const original = await read(path);
        if (original === undefined) {
            fileEdits.forEach((edit) => rejected.push({edit, reason: "file not found"}));
            continue;
        }
        let content = original;
        const failures: EditResult["rejected"] = [];
        for (const edit of fileEdits) {
            if (edit.search.length === 0) {
                failures.push({edit, reason: "empty search text"});
                continue;
            }
            const first = content.indexOf(edit.search);
            if (first === -1) {
                failures.push({edit, reason: "search text not found"});
            } else if (content.indexOf(edit.search, first + 1) !== -1) {
                failures.push({edit, reason: "search text is not unique"});
            } else {
                content = content.slice(0, first) + edit.replace + content.slice(first + edit.search.length);
            }
        }
        if (failures.length > 0) rejected.push(...failures);
        else if (content !== original) changes.push({path, content});
    }
    return {changes, rejected};
}

/** Safe branch name for a fix: `aicd/fix-<slug>-<suffix>`. */
export function fixBranchName(title: string, suffix: string): string {
    const slug = title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
    return `aicd/fix-${slug || "change"}-${suffix.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
}
