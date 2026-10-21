import pg from "pg";
import type {
    AuditEntry,
    Confidence,
    FailureCategory,
    Logger,
    StateStore,
    StoredDiagnosis,
    StoredRecord,
    TestOutcome,
    TestStatus
} from "@aicd-ci/plugin-sdk";
import {MIGRATION_LOCK_KEY, SCHEMA_STATEMENTS, SCHEMA_VERSION} from "./schema.js";

/** Rows kept per test, as in the SQLite store. */
const MAX_OUTCOMES_PER_TEST = 200;
/** Rows per multi-row INSERT: 6 parameters each, far below Postgres' 65 535 parameter limit. */
const INSERT_CHUNK = 1000;
const DEFAULT_RECORD_LIMIT = 10_000;

type Row = Record<string, unknown>;

/** What the store needs from a `pg` client: `pg.Pool` and `pg.PoolClient` fit, and so do test fakes. */
export interface PgQueryable {
    query(text: string, values?: unknown[]): Promise<{rows: Row[]}>;
}

export interface PgPoolClient extends PgQueryable {
    release(error?: Error | boolean): void;
}

export interface PgPool extends PgQueryable {
    connect(): Promise<PgPoolClient>;
    end(): Promise<void>;
}

export type PostgresStateStoreOptions = ({connectionString: string; max?: number} | {pool: PgPool}) & {
    /** Reports errors of idle connections of a pool the store created (they would crash the process otherwise). */
    logger?: Logger;
    now?: () => Date;
};

/**
 * State on Postgres, for the server mode where several workers share one store.
 * Call `migrate()` once before use (or use `PostgresStateStore.connect`). Every query is parameterized.
 */
export class PostgresStateStore implements StateStore {
    readonly #pool: PgPool;
    readonly #ownsPool: boolean;
    readonly #now: () => Date;

    constructor(options: PostgresStateStoreOptions) {
        this.#now = options.now ?? (() => new Date());
        if ("pool" in options) {
            this.#pool = options.pool;
            this.#ownsPool = false;
        } else {
            const pool = new pg.Pool({connectionString: options.connectionString, max: options.max ?? 10});
            pool.on("error", (error) => options.logger?.warn(`postgres: idle connection error: ${error.message}`));
            this.#pool = pool;
            this.#ownsPool = true;
        }
    }

    /** Creates the store and runs `migrate()`. */
    static async connect(options: PostgresStateStoreOptions): Promise<PostgresStateStore> {
        const store = new PostgresStateStore(options);
        try {
            await store.migrate();
        } catch (error) {
            await store.close();
            throw error;
        }
        return store;
    }

    /**
     * Creates the tables and indexes if missing and records the schema version. Idempotent and safe when
     * several replicas start together (advisory lock). Refuses a database migrated by a newer aicd.
     */
    async migrate(): Promise<void> {
        await this.#transaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
            for (const statement of SCHEMA_STATEMENTS) await client.query(statement);
            const {rows} = await client.query("SELECT value FROM aicd_meta WHERE key = $1", ["schema_version"]);
            const current = Number(rows[0]?.value ?? 0);
            if (current > SCHEMA_VERSION) {
                throw new Error(`database schema version ${current} is newer than this aicd (${SCHEMA_VERSION})`);
            }
            await client.query(
                `INSERT INTO aicd_meta (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                ["schema_version", String(SCHEMA_VERSION)]
            );
        });
    }

    async getDiagnosis(fingerprint: string): Promise<StoredDiagnosis | undefined> {
        const {rows} = await this.#pool.query("SELECT * FROM aicd_diagnoses WHERE fingerprint = $1", [fingerprint]);
        const row = rows[0];
        if (!row) return undefined;
        return {
            fingerprint: String(row.fingerprint),
            category: row.category as FailureCategory,
            summary: String(row.summary),
            ...(row.cause ? {cause: String(row.cause)} : {}),
            confidence: row.confidence as Confidence,
            hits: Number(row.hits),
            updatedAt: toIso(row.updated_at)
        };
    }

    async saveDiagnosis(diagnosis: Omit<StoredDiagnosis, "hits" | "updatedAt">): Promise<void> {
        await this.#pool.query(
            `INSERT INTO aicd_diagnoses (fingerprint, category, summary, cause, confidence, hits, updated_at)
             VALUES ($1, $2, $3, $4, $5, 1, $6)
             ON CONFLICT (fingerprint) DO UPDATE SET
                category = EXCLUDED.category, summary = EXCLUDED.summary, cause = EXCLUDED.cause,
                confidence = EXCLUDED.confidence, hits = aicd_diagnoses.hits + 1, updated_at = EXCLUDED.updated_at`,
            [
                diagnosis.fingerprint,
                diagnosis.category,
                diagnosis.summary,
                diagnosis.cause ?? null,
                diagnosis.confidence,
                this.#now().toISOString()
            ]
        );
    }

    /** Inserts the outcomes and prunes each test to its 200 most recent rows, in one transaction. */
    async recordTestOutcomes(outcomes: TestOutcome[]): Promise<void> {
        if (outcomes.length === 0) return;
        await this.#transaction(async (client) => {
            for (let start = 0; start < outcomes.length; start += INSERT_CHUNK) {
                const chunk = outcomes.slice(start, start + INSERT_CHUNK);
                const values: unknown[] = [];
                const tuples = chunk.map((outcome, index) => {
                    values.push(
                        outcome.testId,
                        outcome.status,
                        outcome.runId,
                        outcome.branch ?? null,
                        outcome.commitSha ?? null,
                        outcome.at
                    );
                    const base = index * 6;
                    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
                });
                await client.query(
                    `INSERT INTO aicd_test_outcomes (test_id, status, run_id, branch, commit_sha, at) VALUES ${tuples.join(", ")}`,
                    values
                );
            }
            await client.query(
                `DELETE FROM aicd_test_outcomes WHERE id IN (
                    SELECT id FROM (
                        SELECT id, row_number() OVER (PARTITION BY test_id ORDER BY id DESC) AS rank
                        FROM aicd_test_outcomes WHERE test_id = ANY($1::text[])
                    ) ranked WHERE rank > $2
                )`,
                [[...new Set(outcomes.map((outcome) => outcome.testId))], MAX_OUTCOMES_PER_TEST]
            );
        });
    }

    async getTestHistory(testId: string, limit: number): Promise<TestOutcome[]> {
        const {rows} = await this.#pool.query(
            "SELECT * FROM aicd_test_outcomes WHERE test_id = $1 ORDER BY id DESC LIMIT $2",
            [testId, limit]
        );
        return rows.map((row) => ({
            testId: String(row.test_id),
            status: row.status as TestStatus,
            runId: String(row.run_id),
            ...(row.branch ? {branch: String(row.branch)} : {}),
            ...(row.commit_sha ? {commitSha: String(row.commit_sha)} : {}),
            at: String(row.at)
        }));
    }

    async listTestIds(since?: string): Promise<string[]> {
        const {rows} = since
            ? await this.#pool.query(
                  "SELECT DISTINCT test_id FROM aicd_test_outcomes WHERE at >= $1 ORDER BY test_id",
                  [since]
              )
            : await this.#pool.query("SELECT DISTINCT test_id FROM aicd_test_outcomes ORDER BY test_id");
        return rows.map((row) => String(row.test_id));
    }

    async appendAudit(entry: AuditEntry): Promise<void> {
        await this.#pool.query(
            "INSERT INTO aicd_audit (run_id, at, agent, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
            [entry.runId, entry.at, entry.agent, entry.kind, toJsonb(entry.payload)]
        );
    }

    async listAudit(runId: string): Promise<AuditEntry[]> {
        const {rows} = await this.#pool.query("SELECT * FROM aicd_audit WHERE run_id = $1 ORDER BY id", [runId]);
        return rows.map((row) => ({
            runId: String(row.run_id),
            at: String(row.at),
            agent: String(row.agent),
            kind: row.kind as AuditEntry["kind"],
            payload: row.payload as unknown
        }));
    }

    async listRuns(limit: number): Promise<{runId: string; at: string}[]> {
        const {rows} = await this.#pool.query(
            "SELECT run_id, MIN(at) AS at FROM aicd_audit GROUP BY run_id ORDER BY MIN(id) DESC LIMIT $1",
            [limit]
        );
        return rows.map((row) => ({runId: String(row.run_id), at: String(row.at)}));
    }

    /** Upserts the record and moves it to the top of `listRecords` (new sequence value). */
    async putRecord<T>(collection: string, id: string, value: T): Promise<void> {
        await this.#pool.query(
            `INSERT INTO aicd_records (collection, id, value, updated_at) VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (collection, id) DO UPDATE SET
                value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, seq = DEFAULT`,
            [collection, id, toJsonb(value), this.#now().toISOString()]
        );
    }

    async getRecord<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
        const {rows} = await this.#pool.query("SELECT * FROM aicd_records WHERE collection = $1 AND id = $2", [
            collection,
            id
        ]);
        return rows[0] ? toRecord<T>(rows[0]) : undefined;
    }

    async listRecords<T>(
        collection: string,
        options: {limit?: number; since?: string} = {}
    ): Promise<StoredRecord<T>[]> {
        const limit = options.limit ?? DEFAULT_RECORD_LIMIT;
        const {rows} = options.since
            ? await this.#pool.query(
                  `SELECT * FROM aicd_records WHERE collection = $1 AND updated_at >= $2::timestamptz
                   ORDER BY seq DESC LIMIT $3`,
                  [collection, options.since, limit]
              )
            : await this.#pool.query("SELECT * FROM aicd_records WHERE collection = $1 ORDER BY seq DESC LIMIT $2", [
                  collection,
                  limit
              ]);
        return rows.map((row) => toRecord<T>(row));
    }

    async deleteRecord(collection: string, id: string): Promise<void> {
        await this.#pool.query("DELETE FROM aicd_records WHERE collection = $1 AND id = $2", [collection, id]);
    }

    /** Ends the pool only when the store created it; a pool passed in belongs to the caller. */
    async close(): Promise<void> {
        if (this.#ownsPool) await this.#pool.end();
    }

    async #transaction(body: (client: PgQueryable) => Promise<void>): Promise<void> {
        const client = await this.#pool.connect();
        try {
            await client.query("BEGIN");
            await body(client);
            await client.query("COMMIT");
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch {
                // The connection is broken: it is discarded below instead of going back to the pool.
                client.release(true);
                throw error;
            }
            client.release();
            throw error;
        }
        client.release();
    }
}

function toRecord<T>(row: Row): StoredRecord<T> {
    return {
        collection: String(row.collection),
        id: String(row.id),
        value: row.value as T,
        updatedAt: toIso(row.updated_at)
    };
}

/** `pg` returns TIMESTAMPTZ as a `Date`, unless a custom type parser returns Postgres' text (`2026-10-21 10:00:00+00`). */
function toIso(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    const text = String(value);
    const date = new Date(text.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

/**
 * JSON text for a JSONB parameter (`pg` would turn a JS array into a Postgres array). JSONB rejects the NUL
 * character, which CI logs can contain: it becomes U+FFFD. Object keys come back in JSONB order, not insertion order.
 */
export function toJsonb(value: unknown): string {
    return JSON.stringify(value ?? null).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1\\ufffd");
}
