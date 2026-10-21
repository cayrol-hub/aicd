import {describe, expect, it} from "vitest";
import pg from "pg";
import {
    PostgresStateStore,
    SCHEMA_VERSION,
    toJsonb,
    type PgPool,
    type PgPoolClient
} from "@aicd/adapter-state-postgres";
import {checkStateStore} from "@aicd/plugin-sdk/testing";

interface Call {
    text: string;
    values: unknown[] | undefined;
    on: "pool" | "client";
}

/** Fake `pg.Pool`: records every query and answers with canned rows chosen by a matcher. */
class FakePool implements PgPool {
    readonly calls: Call[] = [];
    released: (Error | boolean | undefined)[] = [];
    ended = false;

    constructor(private readonly answer: (text: string, values?: unknown[]) => Record<string, unknown>[] = () => []) {}

    async query(text: string, values?: unknown[]) {
        return this.#run(text, values, "pool");
    }

    async connect(): Promise<PgPoolClient> {
        return {
            query: async (text: string, values?: unknown[]) => this.#run(text, values, "client"),
            release: (error?: Error | boolean) => {
                this.released.push(error);
            }
        };
    }

    async end(): Promise<void> {
        this.ended = true;
    }

    sql(): string[] {
        return this.calls.map((call) => call.text.replace(/\s+/g, " ").trim());
    }

    #run(text: string, values: unknown[] | undefined, on: Call["on"]) {
        this.calls.push({text, values, on});
        return Promise.resolve({rows: this.answer(text, values)});
    }
}

const NOW = new Date("2026-10-21T10:00:00.000Z");

describe("PostgresStateStore with a fake pool", () => {
    it("migrates idempotently inside a locked transaction and records the schema version", async () => {
        const pool = new FakePool();
        const store = new PostgresStateStore({pool});
        await store.migrate();
        const sql = pool.sql();
        expect(sql[0]).toBe("BEGIN");
        expect(sql[1]).toBe("SELECT pg_advisory_xact_lock($1)");
        expect(sql.at(-1)).toBe("COMMIT");
        expect(pool.calls.every((call) => call.on === "client")).toBe(true);
        const ddl = sql.filter((text) => text.startsWith("CREATE"));
        expect(ddl.length).toBeGreaterThan(5);
        expect(ddl.every((text) => text.includes("IF NOT EXISTS"))).toBe(true);
        expect(sql.some((text) => text.includes("payload JSONB"))).toBe(true);
        expect(sql.some((text) => text.includes("value JSONB"))).toBe(true);
        expect(sql.some((text) => text.includes("seq BIGSERIAL"))).toBe(true);
        const upsert = pool.calls.find((call) => call.text.includes("INSERT INTO aicd_meta"));
        expect(upsert?.values).toEqual(["schema_version", String(SCHEMA_VERSION)]);
        expect(pool.released).toEqual([undefined]);
    });

    it("refuses a database migrated by a newer version and rolls back", async () => {
        const pool = new FakePool((text) => (text.startsWith("SELECT value FROM aicd_meta") ? [{value: "99"}] : []));
        await expect(new PostgresStateStore({pool}).migrate()).rejects.toThrow(/newer than this aicd/);
        expect(pool.sql().at(-1)).toBe("ROLLBACK");
        expect(pool.sql()).not.toContain("COMMIT");
        expect(pool.released).toEqual([undefined]);
    });

    it("upserts diagnoses with parameters and maps rows back", async () => {
        const pool = new FakePool((text) =>
            text.startsWith("SELECT * FROM aicd_diagnoses")
                ? [
                      {
                          fingerprint: "fp",
                          category: "infrastructure",
                          summary: "net",
                          cause: null,
                          confidence: "medium",
                          hits: 2,
                          updated_at: NOW
                      }
                  ]
                : []
        );
        const store = new PostgresStateStore({pool, now: () => NOW});
        await store.saveDiagnosis({
            fingerprint: "fp",
            category: "infrastructure",
            summary: "net",
            confidence: "medium"
        });
        const insert = pool.calls[0];
        expect(insert?.text).toContain("hits = aicd_diagnoses.hits + 1");
        expect(insert?.values).toEqual(["fp", "infrastructure", "net", null, "medium", NOW.toISOString()]);
        expect(await store.getDiagnosis("fp")).toEqual({
            fingerprint: "fp",
            category: "infrastructure",
            summary: "net",
            confidence: "medium",
            hits: 2,
            updatedAt: NOW.toISOString()
        });
        expect(pool.calls[1]?.values).toEqual(["fp"]);
        expect(await new PostgresStateStore({pool: new FakePool()}).getDiagnosis("missing")).toBeUndefined();
    });

    it("records test outcomes in one transaction and prunes to 200 per test", async () => {
        const pool = new FakePool();
        const store = new PostgresStateStore({pool});
        await store.recordTestOutcomes([
            {testId: "t", status: "passed", runId: "r1", at: "2026-10-01T00:00:00Z"},
            {testId: "t", status: "failed", runId: "r2", commitSha: "c", branch: "main", at: "2026-10-02T00:00:00Z"},
            {testId: "u", status: "skipped", runId: "r2", at: "2026-10-02T00:00:00Z"}
        ]);
        const sql = pool.sql();
        expect(sql[0]).toBe("BEGIN");
        expect(sql.at(-1)).toBe("COMMIT");
        expect(sql[1]).toContain("VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12), ($13,");
        expect(pool.calls[1]?.values).toEqual([
            ...["t", "passed", "r1", null, null, "2026-10-01T00:00:00Z"],
            ...["t", "failed", "r2", "main", "c", "2026-10-02T00:00:00Z"],
            ...["u", "skipped", "r2", null, null, "2026-10-02T00:00:00Z"]
        ]);
        expect(sql[2]).toContain("row_number() OVER (PARTITION BY test_id ORDER BY id DESC)");
        expect(pool.calls[2]?.values).toEqual([["t", "u"], 200]);
        expect(pool.calls.every((call) => call.on === "client")).toBe(true);
        expect(pool.released).toEqual([undefined]);
    });

    it("splits large batches into several inserts and skips empty ones", async () => {
        const pool = new FakePool();
        const store = new PostgresStateStore({pool});
        await store.recordTestOutcomes([]);
        expect(pool.calls).toEqual([]);
        const outcomes = Array.from({length: 2500}, (_, index) => ({
            testId: `t${index % 3}`,
            status: "passed" as const,
            runId: "r",
            at: "2026-10-01T00:00:00Z"
        }));
        await store.recordTestOutcomes(outcomes);
        const inserts = pool.calls.filter((call) => call.text.startsWith("INSERT INTO aicd_test_outcomes"));
        expect(inserts.map((call) => call.values?.length)).toEqual([6000, 6000, 3000]);
    });

    it("rolls back and releases the client when a statement fails", async () => {
        const pool = new FakePool();
        const failing: PgPool = {
            query: pool.query.bind(pool),
            end: pool.end.bind(pool),
            connect: async () => {
                const client = await pool.connect();
                return {
                    release: client.release,
                    query: async (text: string, values?: unknown[]) => {
                        if (text.startsWith("INSERT")) throw new Error("disk full");
                        return client.query(text, values);
                    }
                };
            }
        };
        const store = new PostgresStateStore({pool: failing});
        await expect(
            store.recordTestOutcomes([{testId: "t", status: "passed", runId: "r", at: "2026-10-01T00:00:00Z"}])
        ).rejects.toThrow("disk full");
        expect(pool.sql()).toEqual(["BEGIN", "ROLLBACK"]);
        expect(pool.released).toEqual([undefined]);
    });

    it("discards the connection when the rollback itself fails", async () => {
        const pool = new FakePool();
        const broken: PgPool = {
            query: pool.query.bind(pool),
            end: pool.end.bind(pool),
            connect: async () => {
                const client = await pool.connect();
                return {
                    release: client.release,
                    query: async (text: string) => {
                        if (text !== "BEGIN") throw new Error("connection reset");
                        return {rows: []};
                    }
                };
            }
        };
        await expect(new PostgresStateStore({pool: broken}).migrate()).rejects.toThrow("connection reset");
        expect(pool.released).toEqual([true]);
    });

    it("maps test history and test ids", async () => {
        const pool = new FakePool((text) =>
            text.startsWith("SELECT * FROM aicd_test_outcomes")
                ? [
                      {
                          test_id: "t",
                          status: "failed",
                          run_id: "r2",
                          branch: null,
                          commit_sha: "c",
                          at: "2026-10-02T00:00:00Z"
                      }
                  ]
                : [{test_id: "t"}, {test_id: "u"}]
        );
        const store = new PostgresStateStore({pool});
        expect(await store.getTestHistory("t", 5)).toEqual([
            {testId: "t", status: "failed", runId: "r2", commitSha: "c", at: "2026-10-02T00:00:00Z"}
        ]);
        expect(pool.calls[0]?.values).toEqual(["t", 5]);
        expect(await store.listTestIds()).toEqual(["t", "u"]);
        expect(pool.calls[1]?.values).toBeUndefined();
        await store.listTestIds("2026-10-01T00:00:00Z");
        expect(pool.calls[2]?.text).toContain("WHERE at >= $1");
        expect(pool.calls[2]?.values).toEqual(["2026-10-01T00:00:00Z"]);
    });

    it("stores audit payloads as JSONB and lists runs most recent first", async () => {
        const pool = new FakePool((text) =>
            text.startsWith("SELECT run_id")
                ? [{run_id: "b", at: "2026-10-02T00:00:00Z"}]
                : [{run_id: "a", at: "2026-10-01T00:00:00Z", agent: "triage", kind: "run", payload: {n: 1}}]
        );
        const store = new PostgresStateStore({pool});
        await store.appendAudit({
            runId: "a",
            at: "2026-10-01T00:00:00Z",
            agent: "triage",
            kind: "run",
            payload: [1, 2]
        });
        expect(pool.calls[0]?.text).toContain("$5::jsonb");
        expect(pool.calls[0]?.values).toEqual(["a", "2026-10-01T00:00:00Z", "triage", "run", "[1,2]"]);
        await store.appendAudit({runId: "a", at: "x", agent: "triage", kind: "run", payload: undefined});
        expect(pool.calls[1]?.values?.[4]).toBe("null");
        expect(await store.listAudit("a")).toEqual([
            {runId: "a", at: "2026-10-01T00:00:00Z", agent: "triage", kind: "run", payload: {n: 1}}
        ]);
        expect(await store.listRuns(3)).toEqual([{runId: "b", at: "2026-10-02T00:00:00Z"}]);
        expect(pool.calls.at(-1)?.text).toContain("ORDER BY MIN(id) DESC LIMIT $1");
        expect(pool.calls.at(-1)?.values).toEqual([3]);
    });

    it("upserts records with a fresh sequence value and lists them by sequence", async () => {
        const pool = new FakePool((text) =>
            text.startsWith("SELECT * FROM aicd_records")
                ? [{collection: "c", id: "1", value: {v: 3}, updated_at: "2026-10-21T10:00:00+00"}]
                : []
        );
        const store = new PostgresStateStore({pool, now: () => NOW});
        await store.putRecord("c", "1", {v: 3});
        expect(pool.calls[0]?.text).toContain("seq = DEFAULT");
        expect(pool.calls[0]?.values).toEqual(["c", "1", '{"v":3}', NOW.toISOString()]);
        expect(await store.getRecord("c", "1")).toEqual({
            collection: "c",
            id: "1",
            value: {v: 3},
            updatedAt: NOW.toISOString()
        });
        await store.listRecords("c");
        expect(pool.calls.at(-1)?.text).toContain("ORDER BY seq DESC LIMIT $2");
        expect(pool.calls.at(-1)?.values).toEqual(["c", 10_000]);
        await store.listRecords("c", {limit: 1, since: "2026-10-01T00:00:00Z"});
        expect(pool.calls.at(-1)?.text).toContain("updated_at >= $2::timestamptz");
        expect(pool.calls.at(-1)?.values).toEqual(["c", "2026-10-01T00:00:00Z", 1]);
        await store.deleteRecord("c", "1");
        expect(pool.calls.at(-1)?.values).toEqual(["c", "1"]);
    });

    it("never interpolates values into SQL", async () => {
        const pool = new FakePool();
        const store = new PostgresStateStore({pool});
        const evil = "x'; DROP TABLE aicd_records; --";
        await store.putRecord(evil, evil, evil);
        await store.getRecord(evil, evil);
        await store.listRecords(evil, {since: evil});
        await store.deleteRecord(evil, evil);
        await store.getDiagnosis(evil);
        await store.getTestHistory(evil, 1);
        await store.listAudit(evil);
        expect(pool.calls.every((call) => !call.text.includes("DROP TABLE"))).toBe(true);
    });

    it("ends only a pool it created", async () => {
        const pool = new FakePool();
        await new PostgresStateStore({pool}).close();
        expect(pool.ended).toBe(false);
        const owned = new PostgresStateStore({connectionString: "postgres://aicd@127.0.0.1:1/none"});
        await owned.close();
    });

    it("turns NUL characters into U+FFFD for JSONB but keeps escaped backslashes", () => {
        expect(toJsonb({log: "a\u0000b"})).toBe('{"log":"a\\ufffdb"}');
        expect(JSON.parse(toJsonb({log: "\\u0000"}))).toEqual({log: "\\u0000"});
        expect(JSON.parse(toJsonb(["\\\u0000"]))).toEqual(["\\�"]);
        expect(toJsonb(undefined)).toBe("null");
    });
});

const databaseUrl = process.env.AICD_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresStateStore on a real database", () => {
    /** One fresh schema per store, so that each conformance check starts empty. */
    const createStore = async (): Promise<PostgresStateStore> => {
        const schema = `aicd_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const admin = new pg.Client({connectionString: databaseUrl});
        await admin.connect();
        await admin.query(`CREATE SCHEMA ${schema}`);
        await admin.end();
        const pool = new pg.Pool({connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3});
        const store = await PostgresStateStore.connect({pool});
        return Object.assign(store, {
            close: async () => {
                await pool.query(`DROP SCHEMA ${schema} CASCADE`);
                await pool.end();
            }
        });
    };

    it("passes the state store conformance kit", async () => {
        expect(await checkStateStore(createStore)).toEqual([]);
    });

    it("migrates twice, prunes history and round-trips JSON", async () => {
        const store = await createStore();
        try {
            await store.migrate();
            await store.recordTestOutcomes(
                Array.from({length: 205}, (_, index) => ({
                    testId: "t",
                    status: index % 2 ? ("failed" as const) : ("passed" as const),
                    runId: `r${index}`,
                    at: "2026-10-01T00:00:00Z"
                }))
            );
            const history = await store.getTestHistory("t", 1000);
            expect(history).toHaveLength(200);
            expect(history[0]?.runId).toBe("r204");
            await store.appendAudit({
                runId: "a",
                at: "2026-10-01T00:00:00Z",
                agent: "x",
                kind: "event",
                payload: ["a\u0000"]
            });
            expect((await store.listAudit("a"))[0]?.payload).toEqual(["a�"]);
            await store.putRecord("c", "1", {nested: {list: [1, "two", null]}});
            await store.putRecord("c", "2", 7);
            await store.putRecord("c", "1", {nested: {list: []}});
            expect((await store.listRecords("c")).map((record) => record.id)).toEqual(["1", "2"]);
            expect((await store.getRecord("c", "2"))?.value).toBe(7);
            expect(await store.listRecords("c", {since: "2999-01-01T00:00:00Z"})).toEqual([]);
        } finally {
            await store.close();
        }
    });
});
