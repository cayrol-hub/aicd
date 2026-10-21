import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    classify,
    compareWindows,
    GUARD_RESULTS_COLLECTION,
    guardDeployment,
    renderGuardReport,
    resolveSha,
    windowStats,
    type GuardInput,
    type GuardReport,
    type LlmGuard
} from "@aicd-ci/agent-release-guardian";
import {RunBudget} from "@aicd-ci/core";
import {
    COLLECTIONS,
    type AgentRuntime,
    type DeploymentRecord,
    type ErrorGroup,
    type LLMProvider,
    type MetricQuery,
    type MetricsSource,
    type TimeWindow
} from "@aicd-ci/plugin-sdk";

const STARTED = "2026-10-21T10:00:00.000Z";
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_guard",
        context: {provider: "test", repository: "acme/shop", isFork: false},
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text.replace(/secret-\w+/g, "[REDACTED]"),
        language: "en",
        sendCode: "diff_only",
        now: () => new Date("2026-10-21T10:05:00Z"),
        ...overrides
    };
}

/** Constant values per metric, before and after the deployment. */
function fakeSource(values: Record<string, {before: number[]; after: number[]}>, errors: ErrorGroup[] = []) {
    const calls: {query: string; window: TimeWindow}[] = [];
    const source: MetricsSource & {calls: typeof calls} = {
        name: "fake",
        calls,
        async queryRange(query: MetricQuery, window: TimeWindow) {
            calls.push({query: query.name, window});
            const entry = values[query.name];
            if (!entry) throw new Error(`no such metric ${query.name}`);
            const list = window.end.getTime() <= Date.parse(STARTED) ? entry.before : entry.after;
            return list.map((value, index) => ({
                at: new Date(window.start.getTime() + index * 60_000).toISOString(),
                value
            }));
        },
        async newErrors() {
            return errors;
        }
    };
    return source;
}

const errorRate: MetricQuery = {name: "http_5xx_rate", query: "sum(rate(http_5xx[1m]))", bad: "up"};
const latency: MetricQuery = {name: "p95_latency_ms", query: "histogram_quantile(...)", bad: "up"};
const throughput: MetricQuery = {name: "orders_per_minute", query: "sum(rate(orders[1m]))", bad: "down"};

const deployment = {
    id: "dep-42",
    environment: "production",
    service: "shop",
    version: "1.4.0",
    commitSha: "c3c3c3c3c3c3c3c3",
    startedAt: STARTED,
    url: "https://deploy.example/dep-42"
};

function input(source: MetricsSource, overrides: Partial<GuardInput> = {}): GuardInput & {waited: number[]} {
    const waited: number[] = [];
    return {
        deployment,
        metrics: [{source: "prom", query: errorRate}],
        sources: {prom: source},
        wait: async (ms) => {
            waited.push(ms);
        },
        waited,
        ...overrides
    };
}

function fakeLlm(output: LlmGuard | Error): LLMProvider & {calls: number; prompts: string[]} {
    const provider = {
        name: "fake",
        model: "fake-model",
        calls: 0,
        prompts: [] as string[],
        async generateStructured(request: {prompt: string}) {
            provider.calls++;
            provider.prompts.push(request.prompt);
            if (output instanceof Error) throw output;
            return {
                output: output as never,
                usage: {model: "fake-model", inputTokens: 100, outputTokens: 20, costUsd: 0.002}
            };
        }
    };
    return provider as LLMProvider & {calls: number; prompts: string[]};
}

const flat = (value: number, n = 10) => Array.from({length: n}, () => value);

describe("statistics", () => {
    it("computes mean and nearest-rank p95, ignoring non-finite values", () => {
        const stats = windowStats([
            ...Array.from({length: 20}, (_, i) => ({at: "", value: i + 1})),
            {at: "", value: NaN}
        ]);
        expect(stats).toEqual({count: 20, mean: 10.5, p95: 19});
        expect(windowStats([])).toBeUndefined();
    });

    it("needs both thresholds and flags severe changes", () => {
        const thresholds = {relative_increase: 0.5, absolute_min: 0, severe_factor: 2};
        const base = {count: 10, mean: 1, p95: 1};
        expect(classify(compareWindows(base, {count: 10, mean: 1.4, p95: 1.4}, "up"), thresholds).status).toBe("ok");
        expect(classify(compareWindows(base, {count: 10, mean: 1.6, p95: 1.6}, "up"), thresholds).status).toBe(
            "degraded"
        );
        expect(classify(compareWindows(base, {count: 10, mean: 2.5, p95: 2.5}, "up"), thresholds).status).toBe(
            "severe"
        );
        expect(
            classify(compareWindows(base, {count: 10, mean: 1.6, p95: 1.6}, "up"), {...thresholds, absolute_min: 1})
                .status
        ).toBe("ok");
        expect(classify(compareWindows(base, {count: 10, mean: 0.4, p95: 0.4}, "down"), thresholds).status).toBe(
            "degraded"
        );
        const fromZero = classify(
            compareWindows({count: 1, mean: 0, p95: 0}, {count: 1, mean: 2, p95: 2}, "up"),
            thresholds
        );
        expect(fromZero).toMatchObject({status: "severe", decisive: {relative: null}});
    });
});

describe("guardDeployment", () => {
    it("waits for the observation window and lets a healthy deployment continue", async () => {
        const source = fakeSource({http_5xx_rate: {before: flat(1), after: flat(1.1)}});
        const rt = runtime({
            context: {provider: "test", repository: "acme/shop", isFork: false, mergeRequest: {id: "7"}}
        });
        const guard = input(source);
        const result = await guardDeployment(rt, guard);
        expect(guard.waited).toEqual([10 * 60_000]);
        expect(result.report).toMatchObject({verdict: "continue", health: "healthy", degradations: 0, source: "rules"});
        expect(result.actions).toEqual([]);
        expect(source.calls.map((call) => [call.window.start.toISOString(), call.window.end.toISOString()])).toEqual([
            ["2026-10-21T09:00:00.000Z", STARTED],
            [STARTED, "2026-10-21T10:15:00.000Z"]
        ]);
        const stored = await rt.state.getRecord<GuardReport>(GUARD_RESULTS_COLLECTION, "dep-42");
        expect(stored?.value.verdict).toBe("continue");
        const record = await rt.state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, "dep-42");
        expect(record?.value).toMatchObject({id: "dep-42", status: "in_progress", source: "release-guardian"});
    });

    it("does not wait when the window has already elapsed", async () => {
        const guard = input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(1)}}));
        await guardDeployment(runtime({now: () => new Date("2026-10-21T11:00:00Z")}), guard);
        expect(guard.waited).toEqual([]);
    });

    it("pauses on one non-severe degradation and notifies a warning", async () => {
        const source = fakeSource({http_5xx_rate: {before: flat(1), after: flat(1.6)}});
        const rt = runtime({
            context: {provider: "test", repository: "acme/shop", isFork: false, mergeRequest: {id: "7"}}
        });
        const result = await guardDeployment(rt, input(source));
        expect(result.report).toMatchObject({verdict: "pause", health: "degraded", severe: false});
        expect(result.actions.map((action) => action.type)).toEqual(["pause_deployment", "notify", "comment"]);
        const notify = result.actions.find((action) => action.type === "notify");
        expect(notify).toMatchObject({notification: {severity: "warning", url: deployment.url}});
        expect(notify?.type === "notify" && notify.notification.text).toContain(
            "| `http_5xx_rate` | 1 / 1 | 1.6 / 1.6 | +60% (mean) | degraded |"
        );
        const comment = result.actions.find((action) => action.type === "comment");
        expect(comment).toMatchObject({marker: "<!-- aicd:release-guardian -->"});
    });

    it("rolls back on a severe degradation or on two degradations", async () => {
        const severe = await guardDeployment(
            runtime(),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(3)}}))
        );
        expect(severe.report).toMatchObject({verdict: "rollback", severe: true, degradations: 1});
        expect(severe.actions[0]).toMatchObject({type: "rollback_deployment", deployment: {id: "dep-42"}});
        expect(severe.actions[1]).toMatchObject({type: "notify", notification: {severity: "critical"}});

        const two = await guardDeployment(
            runtime(),
            input(
                fakeSource({
                    http_5xx_rate: {before: flat(1), after: flat(1.6)},
                    orders_per_minute: {before: flat(100), after: flat(40)}
                }),
                {
                    metrics: [
                        {source: "prom", query: errorRate},
                        {source: "prom", query: throughput}
                    ]
                }
            )
        );
        expect(two.report).toMatchObject({verdict: "rollback", severe: false, degradations: 2});
    });

    it("applies absolute minimums globally, per metric name and per metric entry", async () => {
        const source = fakeSource({
            http_5xx_rate: {before: flat(1), after: flat(1.6)},
            p95_latency_ms: {before: flat(100), after: flat(180)}
        });
        const result = await guardDeployment(
            runtime(),
            input(source, {
                metrics: [
                    {source: "prom", query: errorRate, absolute_min: 1},
                    {source: "prom", query: latency}
                ],
                options: {absolute_min: {p95_latency_ms: 100}}
            })
        );
        expect(result.report.metrics.map((m) => [m.status, m.absoluteMin])).toEqual([
            ["ok", 1],
            ["ok", 100]
        ]);
        expect(result.report.verdict).toBe("continue");
    });

    it("never calls no data healthy", async () => {
        const rt = runtime({
            context: {provider: "test", repository: "acme/shop", isFork: false, mergeRequest: {id: "7"}}
        });
        const empty = await guardDeployment(rt, input(fakeSource({http_5xx_rate: {before: [], after: flat(1)}})));
        expect(empty.report).toMatchObject({verdict: "continue", health: "no_data"});
        expect(empty.report.reasons).toContain("no data: the deployment could not be judged");
        expect(empty.actions.map((a) => a.type)).toEqual(["comment"]);
        const body = empty.actions[0]?.type === "comment" ? empty.actions[0].body : "";
        expect(body).toContain("No data does not mean healthy");

        const none = await guardDeployment(runtime(), input(fakeSource({}), {metrics: []}));
        expect(none.report.health).toBe("no_data");
    });

    it("reports a partial view when a source fails or is unknown", async () => {
        const result = await guardDeployment(
            runtime(),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(1)}}), {
                metrics: [
                    {source: "prom", query: errorRate},
                    {source: "prom", query: latency},
                    {source: "datadog", query: throughput}
                ]
            })
        );
        expect(result.report.health).toBe("partial");
        expect(result.report.metrics.map((m) => m.status)).toEqual(["ok", "error", "error"]);
        expect(result.report.metrics[2]?.error).toMatch(/unknown metrics source "datadog"/);
    });

    it("counts new error groups first seen after the deployment", async () => {
        const group = (id: string, firstSeen: string): ErrorGroup => ({
            id,
            title: `TypeError ${id} secret-abc`,
            firstSeen,
            count: 5
        });
        const source = fakeSource({http_5xx_rate: {before: flat(1), after: flat(1)}}, [
            group("1", "2026-10-21T10:01:00Z"),
            group("2", "2026-10-21T10:02:00Z"),
            group("3", "2026-10-21T10:03:00Z"),
            group("old", "2026-10-21T09:30:00Z")
        ]);
        const result = await guardDeployment(runtime(), input(source, {errorSource: "prom"}));
        expect(result.report.newErrors).toMatchObject({status: "degraded", threshold: 3});
        expect(result.report.newErrors.groups.map((g) => g.id)).toEqual(["1", "2", "3"]);
        expect(result.report.newErrors.groups[0]?.title).toBe("TypeError 1 [REDACTED]");
        expect(result.report.verdict).toBe("pause");
    });

    it("keeps the LLM explanation and suspect commit only when verified", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord<DeploymentRecord>(COLLECTIONS.deployments, "dep-42", {
            ...deployment,
            status: "success",
            source: "gitlab",
            commits: [
                {sha: "a1a1a1a1a1a1a1a1", authoredAt: "2026-10-21T08:00:00Z", subject: "docs: readme"},
                {sha: "b2b2b2b2b2b2b2b2", authoredAt: "2026-10-21T09:00:00Z", subject: "feat: retry payments"}
            ]
        });
        const llm = fakeLlm({
            explanation: "Errors tripled right after the deployment.",
            evidence: ["http_5xx_rate [severe]"],
            suspect_commit: "b2b2b2b",
            suspect_reason: '"feat: retry payments" touches the failing path.'
        });
        const result = await guardDeployment(
            runtime({state, llm}),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(3)}}))
        );
        expect(llm.calls).toBe(1);
        expect(llm.prompts[0]).toContain(
            "<commits>\na1a1a1a1a1a1a1a1 docs: readme\nb2b2b2b2b2b2b2b2 feat: retry payments"
        );
        expect(result.report).toMatchObject({
            source: "llm",
            explanation: "Errors tripled right after the deployment.",
            suspectCommit: {sha: "b2b2b2b2b2b2b2b2", subject: "feat: retry payments"}
        });
        expect(result).toMatchObject({llmCalls: 1, costUsd: 0.002});
        // The existing record is kept, not overwritten.
        const record = await state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, "dep-42");
        expect(record?.value).toMatchObject({status: "success", source: "gitlab"});
        expect(record?.value.commits).toHaveLength(2);
    });

    it("drops unverifiable LLM claims and never calls the LLM for a healthy deployment or a fork", async () => {
        const llm = fakeLlm({
            explanation: "The database is overloaded.",
            evidence: ["database CPU at 99%"],
            suspect_commit: "deadbeefdeadbeef",
            suspect_reason: "invented"
        });
        const rejected = await guardDeployment(
            runtime({llm}),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(3)}}), {
                commits: [{sha: "a1a1a1a1a1a1a1a1", authoredAt: "2026-10-21T08:00:00Z", subject: "docs: readme"}]
            })
        );
        expect(rejected.report.source).toBe("rules");
        expect(rejected.report.explanation).toBeUndefined();
        expect(rejected.report.suspectCommit).toBeUndefined();
        expect(rejected.report.verdict).toBe("rollback");

        const quiet = fakeLlm(new Error("should not be called"));
        await guardDeployment(
            runtime({llm: quiet}),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(1)}}))
        );
        await guardDeployment(
            runtime({llm: quiet, context: {provider: "test", repository: "acme/shop", isFork: true}}),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(3)}}))
        );
        expect(quiet.calls).toBe(0);
    });

    it("falls back to rules when the LLM fails", async () => {
        const result = await guardDeployment(
            runtime({llm: fakeLlm(new Error("timeout"))}),
            input(fakeSource({http_5xx_rate: {before: flat(1), after: flat(3)}}))
        );
        expect(result.report).toMatchObject({verdict: "rollback", source: "rules"});
        expect(result.llmCalls).toBe(0);
    });

    it("refuses an invalid start date", async () => {
        await expect(
            guardDeployment(runtime(), input(fakeSource({}), {deployment: {...deployment, startedAt: "yesterday"}}))
        ).rejects.toThrow(/invalid startedAt/);
    });
});

describe("resolveSha", () => {
    it("accepts full SHAs and unique prefixes of 7 characters or more", () => {
        const commits = [{sha: "abcdef1234"}, {sha: "abcdef9999"}];
        expect(resolveSha("abcdef1234", commits)).toBe("abcdef1234");
        expect(resolveSha("abcdef1", commits)).toBe("abcdef1234");
        expect(resolveSha("abcdef", commits)).toBeUndefined();
        expect(resolveSha("abcdef12", [{sha: "abcdef1234"}, {sha: "abcdef1299"}])).toBeUndefined();
    });
});

describe("renderGuardReport", () => {
    async function report(): Promise<GuardReport> {
        const source = fakeSource({http_5xx_rate: {before: flat(0.5), after: flat(1.25)}}, [
            {
                id: "9",
                title: "TypeError: cart is `undefined`",
                firstSeen: "2026-10-21T10:02:00Z",
                count: 4,
                url: "https://sentry.io/9"
            }
        ]);
        const result = await guardDeployment(
            runtime(),
            input(source, {errorSource: "prom", options: {new_errors_threshold: 1}})
        );
        return {
            ...result.report,
            suspectCommit: {sha: "b2b2b2b2b2b2b2b2", subject: "feat: retry payments", reason: "touches checkout"}
        };
    }

    it("renders in English", async () => {
        const text = renderGuardReport(await report(), {language: "en", runId: "run_1"});
        expect(text).toContain("<!-- aicd:release-guardian -->");
        expect(text).toContain("**Verdict: Roll back** — `shop` 1.4.0 in `production` (deployment `dep-42`)");
        expect(text).toContain("| `http_5xx_rate` | 0.5 / 0.5 | 1.25 / 1.25 | +150% (mean) | severe |");
        expect(text).toContain("- [TypeError: cart is 'undefined'](https://sentry.io/9) (4 events)");
        expect(text).toContain("**Most suspect commit**: `b2b2b2b2b2b2` feat: retry payments — touches checkout");
        expect(text).toContain(
            "Baseline 2026-10-21 09:00–10:00 UTC, observed 2026-10-21 10:00–10:15 UTC · Run `run_1`"
        );
    });

    it("renders in French with French typography", async () => {
        const text = renderGuardReport(await report(), {language: "fr"});
        expect(text).toContain(
            "**Verdict : Revenir en arrière** — `shop` 1.4.0 en `production` (déploiement `dep-42`)"
        );
        expect(text).toContain("| Métrique | Avant (moyenne / p95) | Après (moyenne / p95) | Dégradation | État |");
        expect(text).toContain("+150 % (mean) | sévère |");
        expect(text).toContain(
            "**Nouvelles erreurs** : 1 nouveau(x) groupe(s) d'erreurs depuis le déploiement (seuil 1)"
        );
        expect(text).toContain("**Commit le plus suspect** :");
    });
});
