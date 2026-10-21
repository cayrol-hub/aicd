import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {
    AuditEntry,
    Confidence,
    FailureCategory,
    StateStore,
    StoredDiagnosis,
    StoredRecord,
    TestOutcome,
    TestStatus
} from "@aicd/plugin-sdk";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diagnoses (
    fingerprint TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    summary TEXT NOT NULL,
    cause TEXT,
    confidence TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS test_outcomes_test ON test_outcomes (test_id, id DESC);
CREATE INDEX IF NOT EXISTS test_outcomes_at ON test_outcomes (at);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    at TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_run ON audit (run_id, id);
CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_recent ON records (collection, seq DESC);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2');
`;

/** Rows kept per test: enough for flaky detection, small enough for a CI cache. */
const MAX_OUTCOMES_PER_TEST = 200;

type Row = Record<string, string | number | null>;

/**
 * State on a single SQLite file, kept between runs by the CI cache (`.aicd/state.db`).
 * Uses Node's built-in `node:sqlite`: no native module to build on the runner.
 */
export class SqliteStateStore implements StateStore {
    readonly #db: DatabaseSync;
    #seq = 0;

    constructor(readonly path: string = ":memory:") {
        if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
        this.#db = new DatabaseSync(path);
        this.#db.exec("PRAGMA journal_mode = WAL;");
        this.#db.exec(SCHEMA);
        const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM records").get() as Row;
        this.#seq = Number(row.seq);
    }

    async getDiagnosis(fingerprint: string): Promise<StoredDiagnosis | undefined> {
        const row = this.#db.prepare("SELECT * FROM diagnoses WHERE fingerprint = ?").get(fingerprint) as
            Row | undefined;
        if (!row) return undefined;
        return {
            fingerprint: String(row.fingerprint),
            category: row.category as FailureCategory,
            summary: String(row.summary),
            ...(row.cause ? {cause: String(row.cause)} : {}),
            confidence: row.confidence as Confidence,
            hits: Number(row.hits),
            updatedAt: String(row.updated_at)
        };
    }

    async saveDiagnosis(diagnosis: Omit<StoredDiagnosis, "hits" | "updatedAt">): Promise<void> {
        this.#db
            .prepare(
                `INSERT INTO diagnoses (fingerprint, category, summary, cause, confidence, hits, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, ?)
                 ON CONFLICT (fingerprint) DO UPDATE SET
                    category = excluded.category, summary = excluded.summary, cause = excluded.cause,
                    confidence = excluded.confidence, hits = hits + 1, updated_at = excluded.updated_at`
            )
            .run(
                diagnosis.fingerprint,
                diagnosis.category,
                diagnosis.summary,
                diagnosis.cause ?? null,
                diagnosis.confidence,
                new Date().toISOString()
            );
    }

    async recordTestOutcomes(outcomes: TestOutcome[]): Promise<void> {
        if (outcomes.length === 0) return;
        const insert = this.#db.prepare(
            "INSERT INTO test_outcomes (test_id, status, run_id, branch, commit_sha, at) VALUES (?, ?, ?, ?, ?, ?)"
        );
        const prune = this.#db.prepare(
            `DELETE FROM test_outcomes WHERE test_id = ? AND id NOT IN
             (SELECT id FROM test_outcomes WHERE test_id = ? ORDER BY id DESC LIMIT ${MAX_OUTCOMES_PER_TEST})`
        );
        this.#transaction(() => {
            for (const outcome of outcomes) {
                insert.run(
                    outcome.testId,
                    outcome.status,
                    outcome.runId,
                    outcome.branch ?? null,
                    outcome.commitSha ?? null,
                    outcome.at
                );
            }
            for (const testId of new Set(outcomes.map((outcome) => outcome.testId))) prune.run(testId, testId);
        });
    }

    async getTestHistory(testId: string, limit: number): Promise<TestOutcome[]> {
        const rows = this.#db
            .prepare("SELECT * FROM test_outcomes WHERE test_id = ? ORDER BY id DESC LIMIT ?")
            .all(testId, limit) as Row[];
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
        const rows = (
            since
                ? this.#db
                      .prepare("SELECT DISTINCT test_id FROM test_outcomes WHERE at >= ? ORDER BY test_id")
                      .all(since)
                : this.#db.prepare("SELECT DISTINCT test_id FROM test_outcomes ORDER BY test_id").all()
        ) as Row[];
        return rows.map((row) => String(row.test_id));
    }

    async appendAudit(entry: AuditEntry): Promise<void> {
        this.#db
            .prepare("INSERT INTO audit (run_id, at, agent, kind, payload) VALUES (?, ?, ?, ?, ?)")
            .run(entry.runId, entry.at, entry.agent, entry.kind, JSON.stringify(entry.payload ?? null));
    }

    async listAudit(runId: string): Promise<AuditEntry[]> {
        const rows = this.#db.prepare("SELECT * FROM audit WHERE run_id = ? ORDER BY id").all(runId) as Row[];
        return rows.map((row) => ({
            runId: String(row.run_id),
            at: String(row.at),
            agent: String(row.agent),
            kind: row.kind as AuditEntry["kind"],
            payload: JSON.parse(String(row.payload)) as unknown
        }));
    }

    async listRuns(limit: number): Promise<{runId: string; at: string}[]> {
        const rows = this.#db
            .prepare("SELECT run_id, MIN(at) AS at FROM audit GROUP BY run_id ORDER BY MIN(id) DESC LIMIT ?")
            .all(limit) as Row[];
        return rows.map((row) => ({runId: String(row.run_id), at: String(row.at)}));
    }

    async putRecord<T>(collection: string, id: string, value: T): Promise<void> {
        this.#db
            .prepare(
                `INSERT INTO records (collection, id, value, updated_at, seq) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (collection, id) DO UPDATE SET
                    value = excluded.value, updated_at = excluded.updated_at, seq = excluded.seq`
            )
            .run(collection, id, JSON.stringify(value), new Date().toISOString(), ++this.#seq);
    }

    async getRecord<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
        const row = this.#db.prepare("SELECT * FROM records WHERE collection = ? AND id = ?").get(collection, id) as
            Row | undefined;
        return row ? toRecord<T>(row) : undefined;
    }

    async listRecords<T>(
        collection: string,
        options: {limit?: number; since?: string} = {}
    ): Promise<StoredRecord<T>[]> {
        const limit = options.limit ?? 10_000;
        const rows = (
            options.since
                ? this.#db
                      .prepare(
                          "SELECT * FROM records WHERE collection = ? AND updated_at >= ? ORDER BY seq DESC LIMIT ?"
                      )
                      .all(collection, options.since, limit)
                : this.#db
                      .prepare("SELECT * FROM records WHERE collection = ? ORDER BY seq DESC LIMIT ?")
                      .all(collection, limit)
        ) as Row[];
        return rows.map((row) => toRecord<T>(row));
    }

    async deleteRecord(collection: string, id: string): Promise<void> {
        this.#db.prepare("DELETE FROM records WHERE collection = ? AND id = ?").run(collection, id);
    }

    async close(): Promise<void> {
        this.#db.close();
    }

    #transaction(body: () => void): void {
        this.#db.exec("BEGIN");
        try {
            body();
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
}

function toRecord<T>(row: Row): StoredRecord<T> {
    return {
        collection: String(row.collection),
        id: String(row.id),
        value: JSON.parse(String(row.value)) as T,
        updatedAt: String(row.updated_at)
    };
}
