import {readFile} from "node:fs/promises";
import {basename, isAbsolute, relative, resolve} from "node:path";
import type {IssueTracker, Ticket} from "@aicd/plugin-sdk";
import {extractAcceptanceCriteria} from "./criteria.js";
import {unique} from "./http.js";

export interface MarkdownSpecTrackerOptions {
    /** Repository root. */
    cwd: string;
    /** Directories holding the specs, relative to `cwd`. */
    roots?: string[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Specs written as markdown files in the repository. Keys are spec paths mentioned in a text
 * (`docs/specs/login.md`) or `spec:login`; only files under the configured roots are ever read.
 */
export class MarkdownSpecTracker implements IssueTracker {
    readonly name = "markdown";
    readonly #cwd: string;
    readonly #roots: string[];

    constructor(options: MarkdownSpecTrackerOptions) {
        this.#cwd = resolve(options.cwd);
        this.#roots = (options.roots ?? ["docs/specs", "specs"]).map((root) => root.replace(/^\.\/|\/+$/g, ""));
    }

    extractKeys(text: string): string[] {
        const keys: string[] = [];
        for (const root of this.#roots) {
            const pattern = new RegExp(`(?<![\\w/.-])(?:\\./)?(${escape(root)}/[\\w./-]+?\\.md)(?![\\w/-])`, "g");
            for (const match of text.matchAll(pattern)) if (match[1]) keys.push(match[1]);
        }
        for (const match of text.matchAll(/(?<![\w-])spec:([\w][\w./-]*)/g)) {
            const name = (match[1] ?? "").replace(/[./]+$/, "");
            if (name) keys.push(`spec:${name}`);
        }
        return unique(keys);
    }

    /** Absolute path of a key when it lies inside one of the roots. */
    #candidates(key: string): string[] {
        const paths = key.startsWith("spec:")
            ? this.#roots.flatMap((root) => {
                  const name = key.slice(5);
                  return name.endsWith(".md")
                      ? [`${root}/${name}`]
                      : [`${root}/${name}.md`, `${root}/${name}/README.md`];
              })
            : [key];
        return paths
            .map((path) => resolve(this.#cwd, path))
            .filter((path) =>
                this.#roots.some((root) => {
                    const inside = relative(resolve(this.#cwd, root), path);
                    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
                })
            );
    }

    async getTicket(key: string): Promise<Ticket | undefined> {
        for (const path of this.#candidates(key)) {
            let content: string;
            try {
                content = await readFile(path, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw error;
            }
            const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? basename(path, ".md");
            return {
                key,
                title,
                description: content,
                url: relative(this.#cwd, path),
                labels: [],
                acceptanceCriteria: extractAcceptanceCriteria(content)
            };
        }
        return undefined;
    }

    async createIssue(): Promise<{key: string; url?: string}> {
        throw new Error("markdown: creating issues is not supported");
    }
}
