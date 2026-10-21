import {describe, expect, it, vi} from "vitest";
import {
    DatadogSource,
    metricsSourceFactories,
    PrometheusSource,
    SentrySource,
    sumPointWise
} from "@aicd/adapter-metrics-sources";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const window = {start: new Date("2026-10-21T10:00:00Z"), end: new Date("2026-10-21T10:15:00Z")};
const query = {name: "errors", query: "sum(rate(http_5xx[1m]))", bad: "up" as const};

function fakeFetch(responses: (Response | ((url: URL) => Response))[]) {
    const calls: {url: URL; init: RequestInit | undefined}[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({url, init});
        const next = responses.shift();
        if (!next) throw new Error("unexpected call");
        return typeof next === "function" ? next(url) : next;
    });
    return {fetch: fn as unknown as typeof fetch, calls};
}

const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}, ...init});

describe("sumPointWise", () => {
    it("adds series by timestamp and skips NaN", () => {
        expect(
            sumPointWise([
                [
                    [2000, 1],
                    [1000, 2]
                ],
                [
                    [1000, 3],
                    [2000, Number.NaN]
                ]
            ])
        ).toEqual([
            {at: new Date(1000).toISOString(), value: 5},
            {at: new Date(2000).toISOString(), value: 1}
        ]);
    });
});

describe("PrometheusSource", () => {
    it("queries query_range and sums the series point-wise", async () => {
        const {fetch, calls} = fakeFetch([
            json({
                status: "success",
                data: {
                    resultType: "matrix",
                    result: [
                        {
                            metric: {pod: "a"},
                            values: [
                                [1792576800, "1"],
                                [1792576860, "2"]
                            ]
                        },
                        {metric: {pod: "b"}, values: [[1792576800, "0.5"]]}
                    ]
                }
            })
        ]);
        const source = new PrometheusSource({
            url: "https://prom.example/",
            bearerToken: "secret",
            headers: {"X-Scope-OrgID": "acme"},
            fetch
        });
        const samples = await source.queryRange(query, window, 60);
        expect(samples).toEqual([
            {at: new Date(1792576800_000).toISOString(), value: 1.5},
            {at: new Date(1792576860_000).toISOString(), value: 2}
        ]);
        const call = calls[0]!;
        expect(call.url.pathname).toBe("/api/v1/query_range");
        expect(call.url.searchParams.get("query")).toBe(query.query);
        expect(call.url.searchParams.get("start")).toBe(String(window.start.getTime() / 1000));
        expect(call.url.searchParams.get("step")).toBe("60s");
        expect(call.init?.headers).toMatchObject({Authorization: "Bearer secret", "X-Scope-OrgID": "acme"});
    });

    it("reports API errors without leaking the token", async () => {
        const {fetch} = fakeFetch([
            new Response("bad query", {status: 400}),
            json({status: "error", error: "parse error"}),
            json({status: "success", data: {resultType: "vector", result: []}})
        ]);
        const source = new PrometheusSource({url: "https://prom.example", bearerToken: "secret", fetch});
        await expect(source.queryRange(query, window, 60)).rejects.toThrow(/HTTP 400 \(bad query\)/);
        await expect(source.queryRange(query, window, 60)).rejects.toThrow(/parse error/);
        await expect(source.queryRange(query, window, 60)).rejects.toThrow(/expected a matrix/);
    });
});

describe("DatadogSource", () => {
    it("queries /api/v1/query on the configured site with both keys", async () => {
        const {fetch, calls} = fakeFetch([
            json({
                status: "ok",
                series: [
                    {
                        pointlist: [
                            [1792576800000, 3],
                            [1792576860000, null]
                        ]
                    }
                ]
            })
        ]);
        const source = new DatadogSource({site: "datadoghq.eu", apiKey: "k", appKey: "a", fetch});
        expect(await source.queryRange(query, window, 60)).toEqual([
            {at: new Date(1792576800000).toISOString(), value: 3}
        ]);
        expect(calls[0]!.url.host).toBe("api.datadoghq.eu");
        expect(calls[0]!.url.searchParams.get("from")).toBe(String(window.start.getTime() / 1000));
        expect(calls[0]!.init?.headers).toMatchObject({"DD-API-KEY": "k", "DD-APPLICATION-KEY": "a"});
    });

    it("throws on an error status", async () => {
        const {fetch} = fakeFetch([json({status: "error", error: "invalid query"})]);
        await expect(
            new DatadogSource({apiKey: "k", appKey: "a", fetch}).queryRange(query, window, 60)
        ).rejects.toThrow(/invalid query/);
    });
});

describe("SentrySource", () => {
    it("lists new issues in the window, follows pagination and filters on firstSeen", async () => {
        const {fetch, calls} = fakeFetch([
            json(
                [
                    {
                        id: "1",
                        title: "TypeError: x is undefined",
                        firstSeen: "2026-10-21T10:05:00Z",
                        count: "12",
                        level: "error",
                        permalink: "https://sentry.io/i/1"
                    },
                    {id: "2", title: "Old", firstSeen: "2026-10-20T10:05:00Z", count: "1"}
                ],
                {headers: {link: '<https://sentry.io/next>; rel="next"; results="true"; cursor="c1"'}}
            ),
            json([{id: "3", title: "RangeError", firstSeen: "2026-10-21T10:06:00Z", count: 2}], {
                headers: {link: '<https://sentry.io/next>; rel="next"; results="false"; cursor="c2"'}
            })
        ]);
        const source = new SentrySource({organization: "acme", project: "api", token: "t", fetch});
        const groups = await source.newErrors(window, {environment: "production", release: "api@1.2.3"});
        expect(groups.map((group) => group.id)).toEqual(["1", "3"]);
        expect(groups[0]).toMatchObject({count: 12, level: "error", url: "https://sentry.io/i/1"});
        expect(calls[0]!.url.pathname).toBe("/api/0/projects/acme/api/issues/");
        expect(calls[0]!.url.searchParams.get("query")).toBe(
            "firstSeen:>=2026-10-21T10:00:00.000Z firstSeen:<=2026-10-21T10:15:00.000Z environment:production release:api@1.2.3"
        );
        expect(calls[1]!.url.searchParams.get("cursor")).toBe("c1");
        expect(calls[0]!.init?.headers).toMatchObject({Authorization: "Bearer t"});
    });

    it("does not support queryRange", async () => {
        const source = new SentrySource({organization: "acme", project: "api", token: "t", fetch: vi.fn()});
        await expect(source.queryRange(query, window, 60)).rejects.toThrow(/not supported/);
    });

    it("surfaces HTTP errors", async () => {
        const {fetch} = fakeFetch([new Response("forbidden", {status: 403})]);
        const source = new SentrySource({organization: "acme", project: "api", token: "t", fetch});
        await expect(source.newErrors(window)).rejects.toThrow(/HTTP 403/);
    });
});

describe("metricsSourceFactories", () => {
    const factory = (name: string) => metricsSourceFactories.find((f) => f.name === name)!;

    it("reads secrets from the environment variables named in the configuration", async () => {
        const {fetch, calls} = fakeFetch([json({status: "success", data: {resultType: "matrix", result: []}})]);
        const source = factory("prometheus").create(
            {url: "https://prom.example", bearer_token_env: "PROM_TOKEN"},
            {env: {PROM_TOKEN: "from-env"}, fetch, logger}
        );
        expect(await source.queryRange(query, window, 30)).toEqual([]);
        expect(calls[0]!.init?.headers).toMatchObject({Authorization: "Bearer from-env"});
    });

    it("refuses missing configuration and missing secrets", () => {
        const context = {env: {}, fetch: vi.fn() as unknown as typeof fetch, logger};
        expect(() => factory("prometheus").create({}, context)).toThrow(/url/);
        expect(() => factory("datadog").create({}, context)).toThrow(/DD_API_KEY/);
        expect(() => factory("sentry").create({organization: "a", project: "b"}, context)).toThrow(/SENTRY_AUTH_TOKEN/);
        expect(
            factory("sentry").create({organization: "a", project: "b"}, {...context, env: {SENTRY_AUTH_TOKEN: "x"}})
                .name
        ).toBe("sentry");
    });
});
