import {XMLParser} from "fast-xml-parser";

export type TestCaseStatus = "passed" | "failed" | "skipped";

export interface TestCaseResult {
    /**
     * Stable id: `classname::name`, or `file::name` when the classname says nothing (absent, or `test` as written by
     * Node's `node --test` reporter), with the file relative to `root`.
     */
    id: string;
    name: string;
    classname?: string;
    file?: string;
    status: TestCaseStatus;
    message?: string;
    details?: string;
    durationSeconds?: number;
}

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name)
});

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function text(node: unknown): string | undefined {
    if (typeof node === "string") return node;
    if (node && typeof node === "object" && "#text" in node) return String((node as XmlNode)["#text"]);
    return undefined;
}

function attr(node: XmlNode, name: string): string | undefined {
    const value = node[`@_${name}`];
    return value === undefined ? undefined : String(value);
}

function collectSuites(node: XmlNode): XmlNode[] {
    const suites = asArray(node.testsuite as XmlNode | XmlNode[] | undefined);
    return suites.flatMap((suite) => [suite, ...collectSuites(suite)]);
}

export interface JUnitOptions {
    /** Repository root: absolute file paths below it become relative (stable ids across machines). */
    root?: string;
}

function relativeFile(file: string | undefined, root: string | undefined): string | undefined {
    if (!file) return undefined;
    const path = file.replace(/^file:\/\//, "");
    const base = root?.replace(/\/+$/, "");
    return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function toResult(testcase: XmlNode, suite: XmlNode, options: JUnitOptions): TestCaseResult {
    const name = attr(testcase, "name") ?? "(unnamed)";
    const classname = attr(testcase, "classname") ?? attr(suite, "name");
    const file = relativeFile(attr(testcase, "file") ?? attr(suite, "file"), options.root);
    const owner = classname && classname !== "test" ? classname : (file ?? classname ?? "unknown");
    const problems = [...asArray(testcase.failure as XmlNode[]), ...asArray(testcase.error as XmlNode[])];
    const skipped = asArray(testcase.skipped as XmlNode[]).length > 0;
    const first = problems[0];
    const time = attr(testcase, "time");
    return {
        id: `${owner}::${name}`,
        name,
        ...(classname ? {classname} : {}),
        ...(file ? {file} : {}),
        status: problems.length > 0 ? "failed" : skipped ? "skipped" : "passed",
        ...(first ? {message: attr(first, "message") ?? attr(first, "type"), details: text(first)?.trim()} : {}),
        ...(time !== undefined && !Number.isNaN(Number(time)) ? {durationSeconds: Number(time)} : {})
    };
}

/**
 * Parses a JUnit XML report: testsuites or testsuite root, nested suites, and test cases placed directly under the
 * root (Node's `node --test` reporter does that).
 */
export function parseJUnit(xml: string, options: JUnitOptions = {}): TestCaseResult[] {
    const document = parser.parse(xml) as XmlNode;
    const root = (document.testsuites as XmlNode | undefined) ?? document;
    return [root, ...collectSuites(root)].flatMap((suite) =>
        asArray(suite.testcase as XmlNode[]).map((testcase) => toResult(testcase, suite, options))
    );
}
