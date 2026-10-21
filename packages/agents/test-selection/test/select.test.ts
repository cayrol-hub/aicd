import {describe, expect, it} from "vitest";
import {
    describeDecision,
    formatSelection,
    renderSelectionSummary,
    selectTests,
    type CoverageMap,
    type CoverageMapEntry,
    type SelectInput,
    type SelectionOptions
} from "@aicd-ci/agent-test-selection";

const NOW = new Date("2026-10-21T12:00:00Z");

function entry(test: string, via: Record<string, CoverageMapEntry["source"]>): CoverageMapEntry {
    const files = Object.keys(via);
    const source = Object.values(via).includes("per_test_coverage")
        ? "per_test_coverage"
        : Object.values(via).includes("convention")
          ? "convention"
          : "co_change";
    return {test, files, source, via};
}

const TESTS = [
    "src/calc.test.ts",
    "src/format.test.ts",
    "test/integration.test.ts",
    "web/__tests__/x.ts",
    "tests/test_api.py"
];

function map(generatedAt = "2026-10-20T00:00:00Z"): CoverageMap {
    return {
        generatedAt,
        entries: new Map(
            [
                entry("src/calc.test.ts", {
                    "src/calc.ts": "per_test_coverage",
                    "tests/helpers/db.ts": "per_test_coverage"
                }),
                entry("src/format.test.ts", {"src/format.ts": "convention", "tests/helpers/fake.ts": "co_change"}),
                entry("test/integration.test.ts", {"src/calc.ts": "co_change", "src/format.ts": "co_change"}),
                entry("web/__tests__/x.ts", {"src/x.ts": "convention"}),
                entry("tests/test_api.py", {"api/views.py": "convention"})
            ].map((e) => [e.test, e])
        )
    };
}

function select(
    changedFiles: SelectInput["changedFiles"],
    options: SelectionOptions = {},
    overrides: Partial<SelectInput> = {}
) {
    return selectTests({changedFiles, tests: TESTS, map: map(), options: {now: () => NOW, ...options}, ...overrides});
}

describe("selectTests — partial selection", () => {
    it("selects the tests mapped to a changed file, with a reason each", () => {
        const selection = select(["src/format.ts"]);
        expect(selection.full).toBe(false);
        expect(selection.selected).toEqual(["src/format.test.ts", "test/integration.test.ts"]);
        expect(selection.skipped).toEqual(["src/calc.test.ts", "tests/test_api.py", "web/__tests__/x.ts"]);
        expect(selection.reasons).toEqual([
            "`src/format.test.ts` selected: it covers `src/format.ts` (naming convention)",
            "`test/integration.test.ts` selected: it covers `src/format.ts` (git co-change)",
            "3 test(s) skipped: none is linked to the changed files"
        ]);
        expect(selection.uncoveredChangedFiles).toEqual([]);
    });

    it("always selects changed tests, even ones the map does not know", () => {
        const selection = select(["src/calc.test.ts", "src/brand-new.test.ts"]);
        expect(selection.selected).toEqual(["src/brand-new.test.ts", "src/calc.test.ts"]);
        expect(selection.decisions).toContainEqual({kind: "changed_test", test: "src/brand-new.test.ts"});
    });

    it("never selects a deleted test, and selects the tests of a deleted or renamed source file", () => {
        const selection = select(
            [
                {path: "src/old.test.ts", status: "deleted"},
                {path: "api/handlers.py", status: "renamed", previousPath: "api/views.py"},
                {path: "src/format.ts", status: "modified"}
            ],
            {unmappedSource: "ignore"}
        );
        expect(selection.full).toBe(false);
        expect(selection.selected).toEqual(["src/format.test.ts", "test/integration.test.ts", "tests/test_api.py"]);
        expect(selection.decisions).toContainEqual({kind: "deleted_test", test: "src/old.test.ts"});
        // The new path of the rename is mapped to nothing yet.
        expect(selection.uncoveredChangedFiles).toEqual(["api/handlers.py"]);
    });

    it("keeps a path deleted and re-added as existing", () => {
        const selection = select([{path: "src/calc.test.ts", status: "deleted"}, "src/calc.test.ts"]);
        expect(selection.selected).toContain("src/calc.test.ts");
    });

    it("selects a test whose snapshot changed", () => {
        const tests = [...TESTS, "src/a.test.ts"];
        const selection = select(["src/__snapshots__/a.test.ts.snap"], {}, {tests});
        expect(selection.full).toBe(false);
        expect(selection.selected).toContain("src/a.test.ts");
    });

    it("ignores documentation outside test directories", () => {
        const selection = select(["README.md", "docs/guide/intro.md"]);
        expect(selection.full).toBe(false);
        expect(selection.selected).toEqual([]);
        expect(selection.reasons[0]).toBe("`README.md` has no test impact (matches `*.md`)");
        expect(selection.decisions).toContainEqual({kind: "nothing_affected"});
    });

    it("runs tests the map knows nothing about, unless told otherwise", () => {
        const tests = [...TESTS, "src/orphan.test.ts"];
        const run = select(["src/format.ts"], {}, {tests});
        expect(run.selected).toContain("src/orphan.test.ts");
        expect(run.decisions).toContainEqual({kind: "unmapped_tests", tests: ["src/orphan.test.ts"]});
        const skip = select(["src/format.ts"], {unmappedTests: "skip"}, {tests});
        expect(skip.skipped).toContain("src/orphan.test.ts");
    });

    it("trusts only per-test coverage for shared test code", () => {
        const covered = select(["tests/helpers/db.ts"]);
        expect(covered.full).toBe(false);
        expect(covered.selected).toEqual(["src/calc.test.ts"]);
        const coChangeOnly = select(["tests/helpers/fake.ts"]);
        expect(coChangeOnly.full).toBe(true);
        expect(coChangeOnly.decisions).toEqual([{kind: "test_support_file", file: "tests/helpers/fake.ts"}]);
    });

    it("treats a JVM helper under src/test as shared test code", () => {
        const selection = select(
            ["src/test/java/com/x/TestUtils.java"],
            {},
            {tests: [...TESTS, "src/test/java/com/x/FooTest.java"]}
        );
        expect(selection.full).toBe(true);
        expect(selection.decisions[0]).toMatchObject({kind: "test_support_file"});
    });

    it("ignores an unmapped source file only when asked, and lists it as uncovered", () => {
        const selection = select(["src/format.ts", "src/new-module.ts"], {unmappedSource: "ignore"});
        expect(selection.full).toBe(false);
        expect(selection.uncoveredChangedFiles).toEqual(["src/new-module.ts"]);
        expect(selection.reasons).toContain("`src/new-module.ts` is mapped to no test (unmappedSource: ignore)");
    });
});

describe("selectTests — every doubt runs the full suite", () => {
    const fullCases: [string, SelectInput["changedFiles"], SelectionOptions, Partial<SelectInput>, string][] = [
        ["forced by the risk agent", ["src/format.ts"], {forceFull: true}, {}, "forced"],
        ["tag pipeline", ["src/format.ts"], {tag: "v1.2.0"}, {}, "tag"],
        ["default branch", ["src/format.ts"], {branch: "trunk", defaultBranch: "trunk"}, {}, "default_branch"],
        ["main", ["src/format.ts"], {branch: "main"}, {}, "full_branch"],
        ["release branch", ["src/format.ts"], {branch: "release/2.1"}, {}, "full_branch"],
        [
            "custom branch pattern",
            ["src/format.ts"],
            {branch: "hotfix/x", fullSuiteOn: ["hotfix/*"]},
            {},
            "full_branch"
        ],
        ["no changed files", [], {}, {}, "no_changes"],
        ["too many changed files", Array.from({length: 51}, () => "src/format.ts"), {}, {}, "too_many_changes"],
        ["lockfile", ["pnpm-lock.yaml"], {}, {}, "force_full_file"],
        ["nested package manifest", ["packages/web/package.json"], {}, {}, "force_full_file"],
        ["CI config", [".github/workflows/ci.yml"], {}, {}, "force_full_file"],
        ["GitLab CI", [".gitlab-ci.yml"], {}, {}, "force_full_file"],
        ["build config", ["tsconfig.base.json"], {}, {}, "force_full_file"],
        ["Dockerfile", ["Dockerfile"], {}, {}, "force_full_file"],
        ["test config", ["vitest.config.ts"], {}, {}, "force_full_file"],
        ["pytest conftest", ["tests/conftest.py"], {}, {}, "force_full_file"],
        ["fixtures", ["src/fixtures/user.json"], {}, {}, "force_full_file"],
        ["go module", ["go.sum"], {}, {}, "force_full_file"],
        ["custom force pattern", ["schema/db.sql"], {forceFullPatterns: ["schema/**"]}, {}, "force_full_file"],
        ["no map", ["src/format.ts"], {}, {map: undefined}, "no_map"],
        ["empty map", ["src/format.ts"], {}, {map: {entries: new Map(), generatedAt: NOW.toISOString()}}, "no_map"],
        ["undated map", ["src/format.ts"], {}, {map: {entries: map().entries}}, "undated_map"],
        ["stale map", ["src/format.ts"], {}, {map: map("2026-10-01T00:00:00Z")}, "stale_map"],
        ["no tests", ["src/format.ts"], {}, {tests: []}, "no_tests"],
        ["unmapped source", ["src/new-module.ts"], {}, {}, "unmapped_source"],
        ["test support file", ["tests/data/sample.txt"], {}, {}, "test_support_file"],
        ["snapshot of an unknown test", ["src/__snapshots__/gone.test.ts.snap"], {}, {}, "test_support_file"],
        [
            "file executed by the suite but unmapped",
            ["lib/legacy.ts"],
            {unmappedSource: "ignore", coveredFiles: ["lib/legacy.ts"]},
            {},
            "covered_unmapped"
        ],
        [
            "JaCoCo suffix coverage",
            ["svc/src/main/java/com/acme/Billing.java"],
            {unmappedSource: "ignore", coveredFiles: ["com/acme/Billing.java"]},
            {},
            "covered_unmapped"
        ]
    ];

    for (const [name, changedFiles, options, overrides, kind] of fullCases) {
        it(name, () => {
            const selection = select(changedFiles, options, overrides);
            expect(selection.full).toBe(true);
            expect(selection.skipped).toEqual([]);
            expect(selection.selected).toEqual([...(overrides.tests ?? TESTS)].sort());
            expect(selection.decisions.map((decision) => decision.kind)).toContain(kind);
            expect(selection.reasons.length).toBe(selection.decisions.length);
            expect(selection.reasons.every((reason) => reason.startsWith("Full suite: "))).toBe(true);
        });
    }

    it("does not run the full suite on a feature branch or for a fresh map", () => {
        const selection = select(["src/format.ts"], {
            branch: "feature/main-menu",
            defaultBranch: "main",
            mapMaxAgeDays: 30
        });
        expect(selection.full).toBe(false);
    });

    it("reports every reason at once", () => {
        const selection = select(["package.json", "src/new-module.ts"], {forceFull: true, branch: "main"});
        expect(selection.decisions.map((decision) => decision.kind)).toEqual([
            "forced",
            "full_branch",
            "force_full_file",
            "unmapped_source"
        ]);
    });

    it("turns a selection of every test into a full run", () => {
        const selection = select(["src/calc.ts", "src/format.ts", "src/x.ts", "api/views.py"]);
        expect(selection.full).toBe(true);
        expect(selection.decisions.at(-1)).toEqual({kind: "all_selected"});
    });
});

describe("rendering", () => {
    const partial = select(["src/format.ts", "src/new.ts"], {unmappedSource: "ignore"});
    const full = select(["package.json"]);

    it("localises reasons", () => {
        expect(select(["package.json"], {language: "fr"}).reasons).toEqual([
            "Suite complète : `package.json` modifié (motif `package.json`)"
        ]);
        expect(describeDecision({kind: "stale_map", ageDays: 20, max: 14}, "fr")).toBe(
            "Suite complète : la carte de couverture date de 20 jours (limite 14)"
        );
        expect(describeDecision({kind: "covers", test: "a", file: "b", source: "co_change"}, "fr")).toBe(
            "`a` sélectionné : il couvre `b` (co-modification git)"
        );
    });

    it("formats for pipelines: empty output means the full suite", () => {
        expect(formatSelection(partial, "lines")).toBe("src/format.test.ts\ntest/integration.test.ts");
        expect(formatSelection(partial, "args")).toBe("src/format.test.ts test/integration.test.ts");
        expect(formatSelection(full, "lines")).toBe("");
        expect(formatSelection(full, "args")).toBe("");
        const json = JSON.parse(formatSelection(partial, "json"));
        expect(json).toMatchObject({full: false, selected: ["src/format.test.ts", "test/integration.test.ts"]});
        expect(json.uncoveredChangedFiles).toEqual(["src/new.ts"]);
        expect(json.decisions).toBeUndefined();
    });

    it("quotes unsafe test names in args", () => {
        const selection = selectTests({
            changedFiles: ["tests/it's $(odd).test.ts"],
            tests: ["tests/it's $(odd).test.ts", "a.test.ts"],
            map: {...map(), entries: new Map([["a.test.ts", entry("a.test.ts", {"a.ts": "convention"})]])},
            options: {now: () => NOW}
        });
        expect(formatSelection(selection, "args")).toBe(`'tests/it'\\''s $(odd).test.ts'`);
    });

    it("renders a short summary in English and French", () => {
        const en = renderSelectionSummary(partial, {language: "en"});
        expect(en).toContain("### aicd · Test selection");
        expect(en).toContain("**Ran 2 of 5 test files** · 3 skipped");
        expect(en).toContain("**Changed files covered by no test**: `src/new.ts`");
        const fr = renderSelectionSummary(partial, {language: "fr"});
        expect(fr).toContain("### aicd · Sélection des tests");
        expect(fr).toContain("**2 fichiers de test exécutés sur 5** · 3 non exécutés");
        expect(fr).toContain("**Fichiers modifiés couverts par aucun test** : `src/new.ts`");
        expect(fr).toContain("`src/format.test.ts` sélectionné : il couvre `src/format.ts` (convention de nommage)");
        expect(renderSelectionSummary(full, {language: "en"})).toContain("**Full suite** (5 test files)");
    });

    it("truncates long reason lists", () => {
        const many = select(
            Array.from({length: 30}, (_, i) => `src/t${i}.test.ts`),
            {},
            {}
        );
        const text = renderSelectionSummary(many, {language: "en", maxReasons: 5});
        expect(text).toMatch(/… and \d+ more/);
    });
});
