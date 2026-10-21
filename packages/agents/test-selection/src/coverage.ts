import {posix} from "node:path";
import {XMLParser, XMLValidator} from "fast-xml-parser";
import {normalizePath} from "./paths.js";

/** What a coverage report says. Paths are repository-relative when `root` is given. */
export interface CoverageReport {
    /** Every file with at least one executed line. */
    covered: string[];
    /** Every file the report lists, covered or not. */
    files: string[];
    /** Test name → files it executed. Only lcov reports with `TN:` names carry it. */
    perTest: Map<string, string[]>;
}

export interface CoverageParseOptions {
    /** Repository root: absolute paths under it are made relative. */
    root?: string;
}

const toNumber = (value: unknown): number => {
    const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
    return Number.isFinite(number) ? number : 0;
};

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function report(covered: Set<string>, files: Set<string>, perTest = new Map<string, Set<string>>()): CoverageReport {
    return {
        covered: [...covered].sort(),
        files: [...files].sort(),
        perTest: new Map([...perTest].map(([test, set]) => [test, [...set].sort()]))
    };
}

/**
 * Parses an lcov tracefile. Records following a `TN:<name>` line belong to that test, which gives the per-test
 * map (when the tool writes one tracefile section per test); records without a name only count as aggregate
 * coverage. A file is covered when a line, function or branch was hit.
 */
export function parseLcov(text: string, options: CoverageParseOptions = {}): CoverageReport {
    const covered = new Set<string>();
    const files = new Set<string>();
    const perTest = new Map<string, Set<string>>();
    let test = "";
    let file: string | undefined;
    let hit = false;
    const finish = () => {
        if (file === undefined || file === "") return;
        files.add(file);
        if (hit) {
            covered.add(file);
            if (test) {
                const set = perTest.get(test) ?? new Set<string>();
                set.add(file);
                perTest.set(test, set);
            }
        }
        file = undefined;
        hit = false;
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "end_of_record") {
            finish();
            continue;
        }
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon);
        const value = line.slice(colon + 1);
        if (key === "TN") {
            finish();
            test = value.trim();
        } else if (key === "SF") {
            finish();
            file = normalizePath(value, options.root);
        } else if (file !== undefined) {
            const parts = value.split(",");
            if (key === "DA" && toNumber(parts[1]) > 0) hit = true;
            else if (key === "FNDA" && toNumber(parts[0]) > 0) hit = true;
            else if (key === "BRDA" && toNumber(parts[3]) > 0) hit = true;
            else if ((key === "LH" || key === "FNH" || key === "BRH") && toNumber(value) > 0) hit = true;
        }
    }
    finish();
    return report(covered, files, perTest);
}

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["source", "package", "class", "line", "group", "sourcefile", "counter"].includes(name)
});

type XmlNode = Record<string, unknown>;

function parseXml(xml: string, root: string, format: string): XmlNode {
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw new Error(`invalid ${format} report: ${valid.err.msg} (line ${valid.err.line})`);
    const document = xmlParser.parse(xml) as XmlNode;
    const node = document[root];
    if (!node || typeof node !== "object") throw new Error(`invalid ${format} report: no <${root}> element`);
    return node as XmlNode;
}

/**
 * Parses a Cobertura XML report (coverage.py, gcovr, istanbul's cobertura reporter…) into aggregate coverage.
 * Class file names are relative to the `<source>` directories: each combination under `root` is listed too.
 */
export function parseCobertura(xml: string, options: CoverageParseOptions = {}): CoverageReport {
    const coverage = parseXml(xml, "coverage", "Cobertura");
    const sources = asArray((coverage.sources as XmlNode | undefined)?.source as unknown)
        .map((source) => (typeof source === "string" ? source : String((source as XmlNode)?.["#text"] ?? "")))
        .map((source) => source.trim())
        .filter(Boolean);
    const covered = new Set<string>();
    const files = new Set<string>();
    for (const pkg of asArray((coverage.packages as XmlNode | undefined)?.package as XmlNode[] | undefined)) {
        for (const cls of asArray((pkg.classes as XmlNode | undefined)?.class as XmlNode[] | undefined)) {
            const filename = String(cls["@_filename"] ?? "").trim();
            if (!filename) continue;
            const candidates = new Set<string>([normalizePath(filename, options.root)]);
            if (options.root) {
                for (const source of sources) {
                    const joined = normalizePath(posix.join(source.replace(/\\/g, "/"), filename), options.root);
                    if (!joined.startsWith("/") && !/^[A-Za-z]:\//.test(joined)) candidates.add(joined);
                }
            }
            const lines = asArray((cls.lines as XmlNode | undefined)?.line as XmlNode[] | undefined);
            const hit = toNumber(cls["@_line-rate"]) > 0 || lines.some((line) => toNumber(line["@_hits"]) > 0);
            for (const candidate of candidates) {
                files.add(candidate);
                if (hit) covered.add(candidate);
            }
        }
    }
    return report(covered, files);
}

/**
 * Parses a JaCoCo XML report into aggregate coverage. Paths are `package/SourceFile.java`, relative to a source
 * root: give `sourceRoots` (e.g. `["src/main/java"]`) to get repository paths; selection also matches them as
 * path suffixes.
 */
export function parseJaCoCo(
    xml: string,
    options: CoverageParseOptions & {sourceRoots?: string[]} = {}
): CoverageReport {
    const root = parseXml(xml, "report", "JaCoCo");
    const covered = new Set<string>();
    const files = new Set<string>();
    const visit = (node: XmlNode) => {
        for (const group of asArray(node.group as XmlNode[] | undefined)) visit(group);
        for (const pkg of asArray(node.package as XmlNode[] | undefined)) {
            const name = String(pkg["@_name"] ?? "").replace(/\\/g, "/");
            for (const sourcefile of asArray(pkg.sourcefile as XmlNode[] | undefined)) {
                const file = String(sourcefile["@_name"] ?? "").trim();
                if (!file) continue;
                const relativePath = normalizePath(name ? `${name}/${file}` : file);
                const roots = options.sourceRoots?.length ? options.sourceRoots : [""];
                const hit = asArray(sourcefile.counter as XmlNode[] | undefined).some(
                    (counter) =>
                        (counter["@_type"] === "LINE" || counter["@_type"] === "INSTRUCTION") &&
                        toNumber(counter["@_covered"]) > 0
                );
                for (const sourceRoot of roots) {
                    const path = normalizePath(
                        sourceRoot ? `${sourceRoot}/${relativePath}` : relativePath,
                        options.root
                    );
                    files.add(path);
                    if (hit) covered.add(path);
                }
            }
        }
    };
    visit(root);
    return report(covered, files);
}
