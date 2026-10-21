import {XMLParser} from "fast-xml-parser";

export type TestCaseStatus = "passed" | "failed" | "skipped";

export interface TestCaseResult {
    /** Stable id: `classname::name` (or `file::name` when there is no classname). */
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

function toResult(testcase: XmlNode, suite: XmlNode): TestCaseResult {
    const name = attr(testcase, "name") ?? "(unnamed)";
    const classname = attr(testcase, "classname") ?? attr(suite, "name");
    const file = attr(testcase, "file") ?? attr(suite, "file");
    const problems = [...asArray(testcase.failure as XmlNode[]), ...asArray(testcase.error as XmlNode[])];
    const skipped = asArray(testcase.skipped as XmlNode[]).length > 0;
    const first = problems[0];
    const time = attr(testcase, "time");
    return {
        id: `${classname ?? file ?? "unknown"}::${name}`,
        name,
        ...(classname ? {classname} : {}),
        ...(file ? {file} : {}),
        status: problems.length > 0 ? "failed" : skipped ? "skipped" : "passed",
        ...(first ? {message: attr(first, "message") ?? attr(first, "type"), details: text(first)?.trim()} : {}),
        ...(time !== undefined && !Number.isNaN(Number(time)) ? {durationSeconds: Number(time)} : {})
    };
}

/** Parses a JUnit XML report (testsuites or testsuite root, nested suites supported). */
export function parseJUnit(xml: string): TestCaseResult[] {
    const document = parser.parse(xml) as XmlNode;
    const root = (document.testsuites as XmlNode | undefined) ?? document;
    return collectSuites(root).flatMap((suite) =>
        asArray(suite.testcase as XmlNode[]).map((testcase) => toResult(testcase, suite))
    );
}
