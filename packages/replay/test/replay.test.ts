import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vitest";
import {formatReport, loadCases, replayCases} from "@aicd-ci/replay";

const fixtures = fileURLToPath(new URL("../../../evals/fixtures", import.meta.url));
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

describe("replay on the evaluation fixtures (rules only)", () => {
    it("classifies every labelled case", async () => {
        const report = await replayCases(loadCases(fixtures), {
            budgetUsd: 0,
            logger,
            redact: (text) => text,
            triage: {
                useLlm: false,
                sendCode: "none",
                language: "en",
                retryFlaky: false,
                flakyWindow: 20,
                flakyMinFlips: 2
            }
        });
        expect(report.total).toBeGreaterThanOrEqual(6);
        expect(report.cases.filter((result) => !result.correct)).toEqual([]);
        expect(formatReport(report)).toContain("accuracy 100.0%");
    });
});
