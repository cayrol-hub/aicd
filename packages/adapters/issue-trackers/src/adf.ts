/** A node of the Atlassian Document Format (Jira Cloud rich text). */
export interface AdfNode {
    type: string;
    text?: string;
    version?: number;
    attrs?: Record<string, unknown>;
    marks?: {type: string; attrs?: Record<string, unknown>}[];
    content?: AdfNode[];
}

function isNode(value: unknown): value is AdfNode {
    return typeof value === "object" && value !== null && typeof (value as AdfNode).type === "string";
}

function children(node: AdfNode): AdfNode[] {
    return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function attr(node: AdfNode, name: string): string {
    const value = node.attrs?.[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function inlineText(nodes: AdfNode[]): string {
    return nodes.map(inline).join("");
}

function inline(node: AdfNode): string {
    switch (node.type) {
        case "text": {
            let text = node.text ?? "";
            for (const mark of node.marks ?? []) {
                if (mark.type === "strong") text = `**${text}**`;
                else if (mark.type === "code") text = `\`${text}\``;
            }
            return text;
        }
        case "hardBreak":
            return "\n";
        case "mention":
        case "emoji":
        case "status":
            return attr(node, "text") || attr(node, "shortName");
        case "inlineCard":
            return attr(node, "url");
        case "date": {
            const timestamp = Number(attr(node, "timestamp"));
            return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString().slice(0, 10) : "";
        }
        default:
            return inlineText(children(node));
    }
}

function indent(text: string, prefix: string): string {
    return text
        .split("\n")
        .map((line, index) => (index === 0 ? line : line === "" ? line : `${prefix}${line}`))
        .join("\n");
}

/** A block node as markdown-like lines; inside lists (`depth` > 0) blocks are separated by single newlines. */
function block(node: AdfNode, depth: number): string {
    switch (node.type) {
        case "paragraph":
            return inlineText(children(node));
        case "heading": {
            const level = Math.min(Math.max(Number(attr(node, "level")) || 1, 1), 6);
            return `${"#".repeat(level)} ${inlineText(children(node))}`;
        }
        case "bulletList":
            return children(node)
                .map((item) => `- ${indent(listItem(item), "  ")}`)
                .join("\n");
        case "orderedList": {
            const start = Number(attr(node, "order")) || 1;
            return children(node)
                .map((item, index) => `${start + index}. ${indent(listItem(item), "   ")}`)
                .join("\n");
        }
        case "taskList":
            return children(node)
                .map((item) =>
                    item.type === "taskItem"
                        ? `- [${attr(item, "state") === "DONE" ? "x" : " "}] ${inlineText(children(item))}`
                        : block(item, depth + 1)
                              .split("\n")
                              .map((line) => `  ${line}`)
                              .join("\n")
                )
                .join("\n");
        case "codeBlock":
            return `\`\`\`${attr(node, "language")}\n${inlineText(children(node))}\n\`\`\``;
        case "blockquote":
            return blocks(children(node), depth)
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n");
        case "rule":
            return "---";
        case "table":
            return children(node)
                .map(
                    (row) =>
                        `| ${children(row)
                            .map((cell) => blocks(children(cell), 0).replace(/\n+/g, " "))
                            .join(" | ")} |`
                )
                .join("\n");
        case "expand":
        case "nestedExpand": {
            const title = attr(node, "title");
            const body = blocks(children(node), depth);
            return title ? `**${title}**\n${body}` : body;
        }
        case "mediaSingle":
        case "mediaGroup":
        case "media":
            return "";
        default:
            return node.text !== undefined ? inline(node) : blocks(children(node), depth);
    }
}

/** A list item: its first paragraph on the marker line, nested blocks on the next lines. */
function listItem(item: AdfNode): string {
    return children(item)
        .map((child) => block(child, 1))
        .filter((text) => text !== "")
        .join("\n");
}

function blocks(nodes: AdfNode[], depth: number): string {
    return nodes
        .map((node) => block(node, depth))
        .filter((text) => text !== "")
        .join(depth > 0 ? "\n" : "\n\n");
}

/**
 * Plain text of an ADF document, markdown-flavoured so the structure survives: headings become `#`,
 * lists `-` / `1.`, task items `- [ ]` / `- [x]`, code blocks fences, bold text `**…**`.
 * Strings pass through; anything else gives "".
 */
export function adfToText(document: unknown): string {
    if (typeof document === "string") return document;
    if (!isNode(document)) return "";
    return (document.type === "doc" ? blocks(children(document), 0) : block(document, 0)).trim();
}

function textNodes(line: string): AdfNode[] {
    return line === "" ? [] : [{type: "text", text: line}];
}

function paragraph(lines: string[]): AdfNode {
    const content: AdfNode[] = [];
    lines.forEach((line, index) => {
        if (index > 0) content.push({type: "hardBreak"});
        content.push(...textNodes(line));
    });
    return {type: "paragraph", content};
}

/**
 * ADF document for a plain or markdown text: `#` headings, `-` / `*` and numbered lists, code fences and
 * paragraphs. Inline markdown is kept as text.
 */
export function textToAdf(text: string): AdfNode {
    const content: AdfNode[] = [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let paragraphLines: string[] = [];
    let list: {type: "bulletList" | "orderedList"; items: AdfNode[]} | undefined;

    const flushParagraph = () => {
        if (paragraphLines.length > 0) content.push(paragraph(paragraphLines));
        paragraphLines = [];
    };
    const flushList = () => {
        if (list) content.push({type: list.type, content: list.items});
        list = undefined;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        const fence = /^\s*```(\S*)/.exec(line);
        if (fence) {
            flushParagraph();
            flushList();
            const code: string[] = [];
            index++;
            while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) code.push(lines[index++] ?? "");
            content.push({
                type: "codeBlock",
                ...(fence[1] ? {attrs: {language: fence[1]}} : {}),
                content: textNodes(code.join("\n"))
            });
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flushParagraph();
            flushList();
            content.push({
                type: "heading",
                attrs: {level: heading[1]?.length ?? 1},
                content: textNodes((heading[2] ?? "").trim())
            });
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const item = bullet ?? numbered;
        if (item) {
            flushParagraph();
            const type = bullet ? "bulletList" : "orderedList";
            if (list?.type !== type) {
                flushList();
                list = {type, items: []};
            }
            list.items.push({type: "listItem", content: [paragraph([item[1] ?? ""])]});
            continue;
        }
        if (line.trim() === "") {
            flushParagraph();
            flushList();
            continue;
        }
        flushList();
        paragraphLines.push(line);
    }
    flushParagraph();
    flushList();
    return {type: "doc", version: 1, content};
}
