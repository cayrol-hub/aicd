export interface DiffLine {
    /** Line number in the new file (added lines) or the old file (removed lines). */
    line: number;
    text: string;
}

export interface DiffFile {
    /** Path after the change (the old path for a deleted file). */
    path: string;
    /** Path before a rename. */
    oldPath?: string;
    status: "added" | "deleted" | "modified" | "renamed";
    binary: boolean;
    additions: number;
    deletions: number;
    added: DiffLine[];
    removed: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(path: string): string {
    const trimmed = path.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
    return trimmed
        .slice(1, -1)
        .replace(/\\(["\\])/g, "$1")
        .replace(/\\t/g, "\t")
        .replace(/\\n/g, "\n");
}

function stripPrefix(path: string): string | undefined {
    const clean = unquote(path).replace(/\t.*$/, "");
    if (clean === "/dev/null") return undefined;
    return clean.replace(/^[ab]\//, "");
}

/** `diff --git a/x b/x`: splits where both halves are equal, else at the last " b/". */
function gitHeaderPaths(rest: string): {from: string; to: string} {
    const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
    if (quoted && (rest.includes('"') || !rest.slice(2).includes(" b/"))) {
        return {from: stripPrefix(quoted[1] as string) ?? "", to: stripPrefix(quoted[2] as string) ?? ""};
    }
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
        const path = rest.slice(2, half);
        return {from: path, to: path};
    }
    const split = rest.lastIndexOf(" b/");
    return {from: rest.slice(2, split), to: rest.slice(split + 3)};
}

/**
 * Parses a unified diff (git or plain `---`/`+++`) into files with their added and removed lines.
 * Hunk line counts are followed exactly, so content lines starting with `---` or `+++` are not
 * mistaken for headers. Malformed input yields what could be read, never an exception.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
    const files: DiffFile[] = [];
    let current: DiffFile | undefined;
    let oldLeft = 0;
    let newLeft = 0;
    let oldLine = 0;
    let newLine = 0;
    /** True between a `diff --git` line and the first hunk: `---`/`+++` belong to that file. */
    let headerOpen = false;

    const start = (path: string): DiffFile => {
        current = {path, status: "modified", binary: false, additions: 0, deletions: 0, added: [], removed: []};
        files.push(current);
        oldLeft = newLeft = 0;
        return current;
    };

    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (current && (oldLeft > 0 || newLeft > 0)) {
            const marker = line[0];
            if (marker === "+") {
                current.added.push({line: newLine++, text: line.slice(1)});
                current.additions++;
                newLeft--;
                continue;
            }
            if (marker === "-") {
                current.removed.push({line: oldLine++, text: line.slice(1)});
                current.deletions++;
                oldLeft--;
                continue;
            }
            if (marker === " " || line === "") {
                oldLine++;
                newLine++;
                oldLeft--;
                newLeft--;
                continue;
            }
            if (marker === "\\") continue;
            // Truncated hunk: fall through and read the line as a header.
            oldLeft = newLeft = 0;
        }

        if (line.startsWith("diff --git ")) {
            const {from, to} = gitHeaderPaths(line.slice("diff --git ".length));
            const file = start(to);
            headerOpen = true;
            if (from !== to) {
                file.oldPath = from;
                file.status = "renamed";
            }
            continue;
        }
        if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
            const from = stripPrefix(line.slice(4));
            const to = stripPrefix((lines[i + 1] as string).slice(4));
            const file = current && headerOpen ? current : start(to ?? from ?? "");
            headerOpen = false;
            if (to === undefined && from !== undefined) {
                file.status = "deleted";
                file.path = from;
            } else if (from === undefined && to !== undefined) {
                file.status = "added";
                file.path = to;
            } else if (from !== undefined && to !== undefined) {
                file.path = to;
                if (from !== to) {
                    file.oldPath = from;
                    file.status = "renamed";
                }
            }
            i++;
            continue;
        }
        if (!current) continue;
        const hunk = line.match(HUNK);
        if (hunk) {
            headerOpen = false;
            oldLine = Number(hunk[1]);
            oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
            newLine = Number(hunk[3]);
            newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
        } else if (line.startsWith("new file mode")) current.status = "added";
        else if (line.startsWith("deleted file mode")) current.status = "deleted";
        else if (line.startsWith("rename from ")) {
            current.oldPath = unquote(line.slice("rename from ".length));
            current.status = "renamed";
        } else if (line.startsWith("rename to ")) current.path = unquote(line.slice("rename to ".length));
        else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) current.binary = true;
    }
    return files.filter((file) => file.path.length > 0);
}
