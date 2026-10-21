import {describe, expect, it} from "vitest";
import {cleanLog, extractExcerpt, parseJUnit} from "@aicd/parsers";

describe("parseJUnit", () => {
    it("reads nested suites, failures, errors and skipped tests", () => {
        const results = parseJUnit(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase classname="app.Cart" name="adds an item" time="0.01"/>
      <testcase classname="app.Cart" name="removes an item"><failure message="expected 1 to be 0">stack</failure></testcase>
      <testcase classname="app.Cart" name="crashes"><error type="TypeError"/></testcase>
      <testcase classname="app.Cart" name="later"><skipped/></testcase>
    </testsuite>
  </testsuite>
</testsuites>`);
        expect(results.map((result) => [result.id, result.status])).toEqual([
            ["app.Cart::adds an item", "passed"],
            ["app.Cart::removes an item", "failed"],
            ["app.Cart::crashes", "failed"],
            ["app.Cart::later", "skipped"]
        ]);
        expect(results[1]).toMatchObject({message: "expected 1 to be 0", details: "stack"});
        expect(results[2]?.message).toBe("TypeError");
        expect(results[0]?.durationSeconds).toBe(0.01);
    });

    it("accepts a single testsuite root and falls back to the suite name", () => {
        const [result] = parseJUnit(`<testsuite name="test/a.test.ts"><testcase name="works"/></testsuite>`);
        expect(result?.id).toBe("test/a.test.ts::works");
    });
});

describe("logs", () => {
    it("removes ANSI codes, GitHub timestamps and GitLab section markers", () => {
        const lines = cleanLog(
            "2026-10-20T08:12:44.0034567Z \u001b[31mError\u001b[0m\nsection_start:1700000000:build\r$ npm ci"
        );
        expect(lines).toEqual(["Error", "$ npm ci"]);
    });

    it("keeps windows around error lines with their line numbers", () => {
        const log = Array.from({length: 100}, (_, i) => (i === 49 ? "Error: boom" : `line ${i + 1}`)).join("\n");
        const excerpt = extractExcerpt(log, {before: 2, after: 1});
        expect(excerpt.text).toBe("L48: line 48\nL49: line 49\nL50: Error: boom\nL51: line 51");
        expect(excerpt.errorLines).toEqual(["Error: boom"]);
        expect(excerpt.totalLines).toBe(100);
    });

    it("keeps the tail when no error line is found", () => {
        const log = Array.from({length: 10}, (_, i) => `step ${i + 1}`).join("\n");
        expect(extractExcerpt(log, {tailLines: 2}).text).toBe("L9: step 9\nL10: step 10");
    });

    it("caps the excerpt size", () => {
        const log = Array.from({length: 1000}, () => "error").join("\n");
        const excerpt = extractExcerpt(log, {maxLines: 50});
        expect(excerpt.text.split("\n")).toHaveLength(50);
        expect(excerpt.truncated).toBe(true);
    });
});
