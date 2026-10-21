import {describe, expect, it, vi} from "vitest";
import {decide, executeDecisions, RunBudget} from "@aicd-ci/core";
import type {CIProvider, ProposedAction} from "@aicd-ci/plugin-sdk";

const retry: ProposedAction = {type: "retry_job", jobId: "42", reason: "flaky"};
const comment: ProposedAction = {type: "comment", reason: "report", body: "hello"};

describe("decide", () => {
    it("applies an action the autonomy allows", () => {
        expect(decide(retry, "act").verdict).toBe("apply");
        expect(decide(comment, "advise").verdict).toBe("apply");
    });

    it("downgrades an action above the autonomy to a suggestion", () => {
        expect(decide(retry, "advise").verdict).toBe("downgrade");
        expect(decide(retry, "propose").verdict).toBe("downgrade");
    });

    it("only logs in observe mode", () => {
        expect(decide(comment, "observe").verdict).toBe("observe");
    });

    it("denies forbidden actions whatever the autonomy", () => {
        expect(decide({type: "merge", reason: "x"} as unknown as ProposedAction, "act").verdict).toBe("deny");
        expect(decide(retry, "act", {forbidden: ["retry_job"]}).verdict).toBe("deny");
    });
});

describe("executeDecisions", () => {
    const fakeCi = (): CIProvider => ({
        name: "fake",
        getContext: vi.fn(),
        listFailedJobs: vi.fn(),
        listJobs: vi.fn(),
        listRecentPipelines: vi.fn(),
        getJobLog: vi.fn(),
        getDiff: vi.fn(),
        readFile: vi.fn(),
        setStatus: vi.fn(async () => {}),
        openFixMergeRequest: vi.fn(async () => ({id: "1"})),
        createRelease: vi.fn(async () => ({})),
        upsertComment: vi.fn(async () => {}),
        retryJob: vi.fn(async () => {
            throw new Error("HTTP 403");
        }),
        addLabels: vi.fn(async () => {})
    });
    const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

    it("runs applied decisions only and survives a failing action", async () => {
        const ci = fakeCi();
        const outcomes: string[] = [];
        await executeDecisions([decide(retry, "act"), decide(comment, "advise"), decide(retry, "advise")], {
            ci,
            logger,
            commentMarker: "<!-- m -->",
            onAction: (decision, outcome) => outcomes.push(`${decision.action.type}:${outcome}`)
        });
        expect(ci.upsertComment).toHaveBeenCalledWith("<!-- m -->", "hello");
        expect(ci.retryJob).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual(["retry_job:failed", "comment:done"]);
    });

    it("executes nothing in dry run", async () => {
        const ci = fakeCi();
        await executeDecisions([decide(comment, "advise")], {ci, logger, commentMarker: "m", dryRun: true});
        expect(ci.upsertComment).not.toHaveBeenCalled();
    });
});

describe("RunBudget", () => {
    it("stops allowing calls once the limit is reached", () => {
        const budget = new RunBudget(0.01);
        expect(budget.canSpend()).toBe(true);
        budget.record({model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.02});
        expect(budget.canSpend()).toBe(false);
        expect(budget.spentUsd).toBe(0.02);
    });
});
