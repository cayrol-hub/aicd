import {describe, expect, it} from "vitest";
import {
    globToRegExp,
    matchesGlob,
    normalizePath,
    parseCobertura,
    parseJaCoCo,
    parseLcov,
    shellQuote
} from "@aicd/agent-test-selection";

describe("normalizePath", () => {
    it("makes paths repository-relative and POSIX", () => {
        expect(normalizePath("./src//a/../b.ts")).toBe("src/b.ts");
        expect(normalizePath("/repo/src/b.ts", "/repo")).toBe("src/b.ts");
        expect(normalizePath("/repo/src/b.ts", "/repo/")).toBe("src/b.ts");
        expect(normalizePath("C:\\Work\\Repo\\src\\b.ts", "c:\\work\\repo")).toBe("src/b.ts");
        expect(normalizePath("src\\b.ts")).toBe("src/b.ts");
        expect(normalizePath("file:///repo/src/b.ts", "/repo")).toBe("src/b.ts");
        // Outside the root: kept, never silently re-rooted.
        expect(normalizePath("/other/src/b.ts", "/repo")).toBe("/other/src/b.ts");
        expect(normalizePath("/repository/b.ts", "/repo")).toBe("/repository/b.ts");
    });
});

describe("globs", () => {
    it("supports **, *, ? and braces; slash-less patterns match at any depth", () => {
        expect(matchesGlob("package.json", "package.json")).toBe(true);
        expect(matchesGlob("apps/web/package.json", "package.json")).toBe(true);
        expect(matchesGlob(".github/workflows/ci.yml", ".github/workflows/**")).toBe(true);
        expect(matchesGlob("src/a/b.test.tsx", "**/*.{test,spec}.{js,ts,tsx}")).toBe(true);
        expect(matchesGlob("src/a/b.ts", "**/*.{test,spec}.{js,ts,tsx}")).toBe(false);
        expect(matchesGlob("src/b.ts", "src/*.ts")).toBe(true);
        expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
        expect(matchesGlob("a/fixtures/x/y.json", "**/fixtures/**")).toBe(true);
        expect(matchesGlob("docker-compose.ci.yaml", "docker-compose*.{yml,yaml}")).toBe(true);
        expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    });

    it("quotes shell words only when needed", () => {
        expect(shellQuote("src/a.test.ts")).toBe("src/a.test.ts");
        expect(shellQuote("tests/it's here.py")).toBe(`'tests/it'\\''s here.py'`);
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
        expect(shellQuote("")).toBe("''");
    });
});

describe("parseLcov", () => {
    const lcov = [
        "TN:src/math.test.ts",
        "SF:/repo/src/math.ts",
        "FN:1,add",
        "FNDA:3,add",
        "DA:1,3",
        "DA:2,0",
        "LH:1",
        "LF:2",
        "end_of_record",
        "SF:/repo/src/unused.ts",
        "DA:1,0",
        "LH:0",
        "end_of_record",
        "TN:src/strings.test.ts",
        "SF:/repo/src/strings.ts",
        "BRDA:1,0,0,2",
        "end_of_record",
        "SF:/repo/src/math.ts",
        "DA:5,1",
        "end_of_record",
        "TN:",
        "SF:src/other.ts",
        "DA:1,4",
        "end_of_record",
        "garbage line",
        "DA:not,a,number"
    ].join("\n");

    it("maps each named test to the files it executed", () => {
        const report = parseLcov(lcov, {root: "/repo"});
        expect(Object.fromEntries(report.perTest)).toEqual({
            "src/math.test.ts": ["src/math.ts"],
            "src/strings.test.ts": ["src/math.ts", "src/strings.ts"]
        });
        expect(report.covered).toEqual(["src/math.ts", "src/other.ts", "src/strings.ts"]);
        expect(report.files).toEqual(["src/math.ts", "src/other.ts", "src/strings.ts", "src/unused.ts"]);
    });

    it("handles CRLF, a missing end_of_record and empty input", () => {
        const report = parseLcov("SF:a.py\r\nDA:1,1\r\n");
        expect(report.covered).toEqual(["a.py"]);
        expect(report.perTest.size).toBe(0);
        expect(parseLcov("")).toEqual({covered: [], files: [], perTest: new Map()});
    });
});

describe("parseCobertura", () => {
    const xml = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.5" version="7.4">
  <sources><source>/repo/src</source></sources>
  <packages>
    <package name="app">
      <classes>
        <class name="calc.py" filename="app/calc.py" line-rate="0.5">
          <lines><line number="1" hits="1"/><line number="2" hits="0"/></lines>
        </class>
        <class name="dead.py" filename="app/dead.py" line-rate="0">
          <lines><line number="1" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

    it("lists covered files, also joined with the source directories under root", () => {
        const report = parseCobertura(xml, {root: "/repo"});
        expect(report.covered).toEqual(["app/calc.py", "src/app/calc.py"]);
        expect(report.files).toContain("src/app/dead.py");
        expect(report.perTest.size).toBe(0);
    });

    it("rejects malformed or foreign documents", () => {
        expect(() => parseCobertura("<coverage><packages>")).toThrow(/invalid Cobertura/);
        expect(() => parseCobertura("<report/>")).toThrow(/no <coverage>/);
    });
});

describe("parseJaCoCo", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="app">
  <sessioninfo id="s" start="1" dump="2"/>
  <group name="module">
    <package name="com/acme/billing">
      <class name="com/acme/billing/Invoice" sourcefilename="Invoice.java"/>
      <sourcefile name="Invoice.java">
        <line nr="3" mi="0" ci="4" mb="0" cb="0"/>
        <counter type="INSTRUCTION" missed="2" covered="4"/>
        <counter type="LINE" missed="1" covered="1"/>
      </sourcefile>
      <sourcefile name="Unused.java">
        <counter type="LINE" missed="3" covered="0"/>
      </sourcefile>
    </package>
  </group>
  <package name="com/acme">
    <sourcefile name="App.kt"><counter type="LINE" missed="0" covered="2"/></sourcefile>
  </package>
</report>`;

    it("lists covered source files relative to the source roots", () => {
        expect(parseJaCoCo(xml).covered).toEqual(["com/acme/App.kt", "com/acme/billing/Invoice.java"]);
        const rooted = parseJaCoCo(xml, {sourceRoots: ["src/main/java"]});
        expect(rooted.covered).toEqual([
            "src/main/java/com/acme/App.kt",
            "src/main/java/com/acme/billing/Invoice.java"
        ]);
        expect(rooted.files).toContain("src/main/java/com/acme/billing/Unused.java");
    });

    it("rejects a document that is not a JaCoCo report", () => {
        expect(() => parseJaCoCo("<coverage/>")).toThrow(/no <report>/);
    });
});
