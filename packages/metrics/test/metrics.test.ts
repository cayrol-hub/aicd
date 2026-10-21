import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {
    computeDora,
    deploymentCommits,
    percentile,
    previousDeployment,
    recordDeployment,
    recordIncident,
    renderDora,
    type DoraReport
} from "@aicd/metrics";
import {COLLECTIONS, type DeploymentRecord, type IncidentRecord} from "@aicd/plugin-sdk";

const WINDOW = {start: "2026-10-01T00:00:00Z", end: "2026-10-15T00:00:00Z"};

function deployment(id: string, overrides: Partial<DeploymentRecord>): DeploymentRecord {
    return {
        id,
        environment: "production",
        startedAt: "2026-10-01T00:00:00Z",
        status: "success",
        source: "test",
        ...overrides
    };
}

function incident(id: string, overrides: Partial<IncidentRecord>): IncidentRecord {
    return {id, title: id, openedAt: "2026-10-01T00:00:00Z", source: "test", timeline: [], ...overrides};
}

function commit(sha: string, authoredAt: string) {
    return {sha, authoredAt, subject: `commit ${sha}`};
}

/** Throws when any number of the report is NaN or infinite. */
function assertFinite(value: unknown, path = "report"): void {
    if (typeof value === "number") expect(Number.isFinite(value), path).toBe(true);
    else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) assertFinite(child, `${path}.${key}`);
    }
}

async function scenario(): Promise<SqliteStateStore> {
    const state = new SqliteStateStore(":memory:");
    const deployments: DeploymentRecord[] = [
        // Before the window: ships c0 and c1.
        deployment("d0", {
            startedAt: "2026-09-28T10:00:00Z",
            commits: [commit("c0", "2026-09-27T10:00:00Z"), commit("c1", "2026-09-27T12:00:00Z")]
        }),
        // c1 is redeployed: it must not count again.
        deployment("d1", {
            startedAt: "2026-10-02T10:00:00Z",
            finishedAt: "2026-10-02T11:00:00Z",
            commits: [
                commit("c1", "2026-09-27T12:00:00Z"),
                commit("c2", "2026-10-02T09:00:00Z"),
                commit("c3", "2026-10-01T11:00:00Z")
            ]
        }),
        deployment("d2", {
            startedAt: "2026-10-05T10:00:00Z",
            finishedAt: "2026-10-05T10:30:00Z",
            status: "failed",
            commits: [commit("c4", "2026-10-05T08:00:00Z")]
        }),
        deployment("d3", {
            startedAt: "2026-10-05T12:00:00Z",
            finishedAt: "2026-10-05T12:30:00Z",
            commits: [commit("c4", "2026-10-05T08:00:00Z")]
        }),
        // Caused an incident.
        deployment("d4", {
            startedAt: "2026-10-08T09:00:00Z",
            finishedAt: "2026-10-08T09:30:00Z",
            commits: [commit("c5", "2026-10-07T09:30:00Z")]
        }),
        // Rolled back by d6.
        deployment("d5", {
            startedAt: "2026-10-10T09:00:00Z",
            finishedAt: "2026-10-10T09:20:00Z",
            commits: [commit("c6", "2026-10-10T08:20:00Z")]
        }),
        deployment("d6", {startedAt: "2026-10-10T10:00:00Z", finishedAt: "2026-10-10T10:20:00Z", rollbackOf: "d5"}),
        deployment("d7", {startedAt: "2026-10-12T10:00:00Z", status: "in_progress"}),
        deployment("d8", {startedAt: "2026-10-16T10:00:00Z", commits: [commit("c9", "2026-10-11T10:00:00Z")]}),
        deployment("s1", {environment: "staging", startedAt: "2026-10-03T10:00:00Z", status: "failed"})
    ];
    for (const record of deployments) await recordDeployment(state, record);
    await recordIncident(
        state,
        incident("inc1", {
            deploymentId: "d4",
            openedAt: "2026-10-08T10:00:00Z",
            resolvedAt: "2026-10-08T13:00:00Z"
        })
    );
    await recordIncident(state, incident("inc2", {openedAt: "2026-10-13T10:00:00Z"}));
    await recordIncident(
        state,
        incident("inc3", {environment: "staging", openedAt: "2026-10-03T10:00:00Z", resolvedAt: "2026-10-09T10:00:00Z"})
    );
    return state;
}

describe("percentile", () => {
    it("interpolates between ranks and handles empty lists", () => {
        expect(percentile([], 50)).toBeNull();
        expect(percentile([5], 90)).toBe(5);
        expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
        expect(percentile([1, 2, 4.5, 24, 24], 90)).toBe(24);
    });
});

describe("computeDora", () => {
    it("computes the four metrics with fixed dates", async () => {
        const state = await scenario();
        const report = await computeDora(state, WINDOW);
        expect(report).toEqual({
            environment: "production",
            start: "2026-10-01T00:00:00.000Z",
            end: "2026-10-15T00:00:00.000Z",
            days: 14,
            deploymentFrequency: {count: 6, successful: 5, perDay: 0.4286, perWeek: 3, level: "high"},
            leadTime: {commits: 5, medianHours: 4.5, p90Hours: 24, level: "elite"},
            changeFailureRate: {
                deployments: 6,
                failed: 3,
                rate: 0.5,
                level: "low",
                failedDeploymentIds: ["d2", "d4", "d5"]
            },
            timeToRestore: {failures: 4, restored: 3, open: 1, medianHours: 2, level: "high"}
        } satisfies DoraReport);
    });

    it("filters by environment", async () => {
        const state = await scenario();
        const report = await computeDora(state, {...WINDOW, environment: "staging"});
        expect(report.deploymentFrequency).toMatchObject({count: 1, successful: 0});
        expect(report.changeFailureRate).toMatchObject({failed: 1, rate: 1, failedDeploymentIds: ["s1"]});
        expect(report.leadTime.medianHours).toBeNull();
        // inc3 (staging, 6 days) and inc2 (no environment, still open); s1 is never restored.
        expect(report.timeToRestore).toEqual({failures: 3, restored: 1, open: 2, medianHours: 144, level: "medium"});
    });

    it("gives nulls and no NaN on empty data", async () => {
        const report = await computeDora(new SqliteStateStore(":memory:"), WINDOW);
        assertFinite(report);
        expect(report.deploymentFrequency).toEqual({count: 0, successful: 0, perDay: 0, perWeek: 0, level: null});
        expect(report.leadTime).toEqual({commits: 0, medianHours: null, p90Hours: null, level: null});
        expect(report.changeFailureRate.rate).toBeNull();
        expect(report.timeToRestore).toEqual({failures: 0, restored: 0, open: 0, medianHours: null, level: null});
    });

    it("skips malformed records instead of producing NaN", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord(COLLECTIONS.deployments, "bad", {
            id: "bad",
            environment: "production",
            startedAt: "nope"
        });
        await state.putRecord(COLLECTIONS.deployments, "null", null);
        await recordDeployment(
            state,
            deployment("ok", {startedAt: "2026-10-02T00:00:00Z", commits: [commit("x", "not a date")]})
        );
        await state.putRecord(COLLECTIONS.incidents, "bad", {id: "bad", openedAt: "?"});
        const report = await computeDora(state, WINDOW);
        assertFinite(report);
        expect(report.deploymentFrequency.count).toBe(1);
        expect(report.leadTime.commits).toBe(0);
    });

    it("applies the DORA 2023 thresholds", async () => {
        const state = new SqliteStateStore(":memory:");
        // 14 deployments in 14 days, lead time 1 h, restore 30 min, 0 failure.
        for (let day = 1; day <= 14; day++) {
            const date = `2026-10-${String(day).padStart(2, "0")}`;
            await recordDeployment(
                state,
                deployment(`d${day}`, {
                    startedAt: `${date}T10:00:00Z`,
                    commits: [commit(`c${day}`, `${date}T09:00:00Z`)]
                })
            );
        }
        await recordIncident(
            state,
            incident("i", {openedAt: "2026-10-03T00:00:00Z", resolvedAt: "2026-10-03T00:30:00Z"})
        );
        const report = await computeDora(state, WINDOW);
        expect(report.deploymentFrequency.level).toBe("elite");
        expect(report.leadTime.level).toBe("elite");
        expect(report.changeFailureRate).toMatchObject({rate: 0, level: "elite"});
        expect(report.timeToRestore).toMatchObject({medianHours: 0.5, level: "elite"});
    });

    it("rejects an invalid window", async () => {
        const state = new SqliteStateStore(":memory:");
        await expect(computeDora(state, {start: WINDOW.end, end: WINDOW.start})).rejects.toThrow(RangeError);
        await expect(computeDora(state, {start: "x", end: WINDOW.end})).rejects.toThrow(RangeError);
    });
});

describe("records", () => {
    it("upserts deployments without erasing known fields", async () => {
        const state = new SqliteStateStore(":memory:");
        await recordDeployment(
            state,
            deployment("d", {status: "in_progress", commits: [commit("a", "2026-10-01T00:00:00Z")]})
        );
        const stored = await recordDeployment(
            state,
            deployment("d", {status: "success", finishedAt: "2026-10-01T01:00:00Z", commits: undefined})
        );
        expect(stored).toMatchObject({status: "success", finishedAt: "2026-10-01T01:00:00Z"});
        expect(stored.commits).toHaveLength(1);
        expect((await state.getRecord(COLLECTIONS.deployments, "d"))?.value).toEqual(stored);
        await expect(recordDeployment(state, deployment("", {}))).rejects.toThrow();
        await expect(recordDeployment(state, deployment("x", {startedAt: "nope"}))).rejects.toThrow();
    });

    it("merges incident timelines", async () => {
        const state = new SqliteStateStore(":memory:");
        await recordIncident(
            state,
            incident("i", {
                timeline: [
                    {at: "2026-10-01T02:00:00Z", kind: "note", text: "b"},
                    {at: "2026-10-01T01:00:00Z", kind: "alert", text: "a"}
                ]
            })
        );
        const merged = await recordIncident(
            state,
            incident("i", {
                resolvedAt: "2026-10-01T05:00:00Z",
                timeline: [
                    {at: "2026-10-01T01:00:00Z", kind: "alert", text: "a"},
                    {at: "2026-10-01T04:00:00Z", kind: "resolved", text: "c"}
                ]
            })
        );
        expect(merged.resolvedAt).toBe("2026-10-01T05:00:00Z");
        expect(merged.timeline.map((entry) => entry.text)).toEqual(["a", "b", "c"]);
    });

    it("finds the previous successful deployment of an environment", async () => {
        const state = await scenario();
        expect((await previousDeployment(state, "production", "2026-10-05T11:00:00Z"))?.id).toBe("d1");
        expect((await previousDeployment(state, "production", "2026-10-05T13:00:00Z"))?.id).toBe("d3");
        expect(await previousDeployment(state, "production", "2026-09-01T00:00:00Z")).toBeUndefined();
        expect(await previousDeployment(state, "staging", "2026-12-01T00:00:00Z")).toBeUndefined();
        expect(await previousDeployment(state, "production", "garbage")).toBeUndefined();
    });
});

describe("deploymentCommits", () => {
    const dir = mkdtempSync(join(tmpdir(), "aicd-metrics-"));
    afterAll(() => rmSync(dir, {recursive: true, force: true}));
    const git = (args: string[], date?: string) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
            cwd: dir,
            env: {...process.env, ...(date ? {GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date} : {})}
        })
            .toString()
            .trim();
    git(["init", "-q"]);
    const shas = ["one", "two", "three"].map((name, index) => {
        writeFileSync(join(dir, `${name}.txt`), name);
        git(["add", "."]);
        git(["commit", "-q", "-m", name], `2026-10-0${index + 1}T10:00:00Z`);
        return git(["rev-parse", "HEAD"]);
    });

    it("lists the shipped commits oldest first", async () => {
        const commits = await deploymentCommits({fromSha: shas[0], toSha: shas[2]!, cwd: dir});
        expect(commits.map((entry) => entry.subject)).toEqual(["two", "three"]);
        expect(commits[0]).toEqual({sha: shas[1], authoredAt: "2026-10-02T10:00:00Z", subject: "two"});
    });

    it("lists every reachable commit without a previous deployment, capped", async () => {
        expect((await deploymentCommits({toSha: shas[2]!, cwd: dir})).map((entry) => entry.subject)).toEqual([
            "one",
            "two",
            "three"
        ]);
        expect((await deploymentCommits({toSha: shas[2]!, cwd: dir, maxCount: 2})).map((e) => e.subject)).toEqual([
            "two",
            "three"
        ]);
    });

    it("returns nothing for an unknown sha", async () => {
        expect(await deploymentCommits({toSha: "0".repeat(40), cwd: dir})).toEqual([]);
    });
});

describe("renderDora", () => {
    it("renders Markdown in English and French, and JSON", async () => {
        const report = await computeDora(await scenario(), WINDOW);
        const en = renderDora(report, {language: "en", format: "markdown"});
        expect(en).toContain("### DORA metrics · production");
        expect(en).toContain("| Deployment frequency | 0.43 / day · 3 / week (6 deployment(s), 5 successful) | High |");
        expect(en).toContain("| Change failure rate | 50% (3 of 6 deployment(s)) | Low |");
        expect(en).toContain("median 4.5 h · p90 24 h (5 commit(s))");
        const fr = renderDora(report, {language: "fr", format: "markdown"});
        expect(fr).toContain("### Métriques DORA · production");
        expect(fr).toContain("Période : 2026-10-01 → 2026-10-15 (14 jours)");
        expect(fr).toContain("médiane 4,5 h");
        expect(fr).toContain("50 % (3 déploiement(s) sur 6)");
        expect(fr).toContain("| Temps de rétablissement | médiane 2 h");
        expect(JSON.parse(renderDora(report, {language: "en", format: "json"}))).toEqual(report);
    });

    it("renders empty reports without NaN", async () => {
        const report = await computeDora(new SqliteStateStore(":memory:"), WINDOW);
        const en = renderDora(report, {language: "en", format: "markdown"});
        expect(en).not.toContain("NaN");
        expect(en).toContain("| Lead time for changes | no data | — |");
        expect(renderDora(report, {language: "fr", format: "markdown"})).toContain("aucune donnée");
    });
});
