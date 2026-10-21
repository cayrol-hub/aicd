import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";

describe("SqliteStateStore", () => {
    it("persists diagnoses, history, audit and records across reopenings", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "aicd-state-")), "nested", "state.db");
        const first = new SqliteStateStore(path);
        await first.saveDiagnosis({
            fingerprint: "fp",
            category: "infrastructure",
            summary: "net",
            confidence: "medium"
        });
        await first.saveDiagnosis({
            fingerprint: "fp",
            category: "infrastructure",
            summary: "net",
            confidence: "medium"
        });
        await first.recordTestOutcomes([
            {testId: "t", status: "passed", runId: "r1", at: "2026-10-01T00:00:00Z"},
            {testId: "t", status: "failed", runId: "r2", commitSha: "c", at: "2026-10-02T00:00:00Z"}
        ]);
        await first.appendAudit({
            runId: "r2",
            at: "2026-10-02T00:00:00Z",
            agent: "triage",
            kind: "run",
            payload: {a: 1}
        });
        await first.putRecord("quarantine", "t", {testId: "t"});
        await first.putRecord("quarantine", "u", {testId: "u"});
        await first.close();

        const second = new SqliteStateStore(path);
        expect(await second.getDiagnosis("fp")).toMatchObject({category: "infrastructure", hits: 2});
        expect((await second.getTestHistory("t", 10)).map((o) => o.status)).toEqual(["failed", "passed"]);
        expect(await second.listTestIds()).toEqual(["t"]);
        expect((await second.listAudit("r2"))[0]?.payload).toEqual({a: 1});
        expect(await second.listRuns(5)).toEqual([{runId: "r2", at: "2026-10-02T00:00:00Z"}]);
        expect((await second.listRecords("quarantine")).map((r) => r.id)).toEqual(["u", "t"]);
        await second.putRecord("quarantine", "t", {testId: "t", updated: true});
        expect((await second.getRecord("quarantine", "t"))?.value).toEqual({testId: "t", updated: true});
        expect((await second.listRecords("quarantine", {limit: 1})).map((r) => r.id)).toEqual(["t"]);
        await second.deleteRecord("quarantine", "u");
        expect(await second.getRecord("quarantine", "u")).toBeUndefined();
        await second.close();
    });

    it("returns undefined for an unknown fingerprint", async () => {
        expect(await new SqliteStateStore().getDiagnosis("nope")).toBeUndefined();
    });
});
