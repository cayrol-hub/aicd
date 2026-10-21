/** Version written to `aicd_meta` by `migrate()`. Bump it with every schema change and add the upgrade step. */
export const SCHEMA_VERSION = 1;

/** Arbitrary key for `pg_advisory_xact_lock`, so that replicas starting together migrate one at a time. */
export const MIGRATION_LOCK_KEY = 4_217_001;

/** Idempotent DDL: every statement can run again on an up-to-date database. */
export const SCHEMA_STATEMENTS: readonly string[] = [
    "CREATE TABLE IF NOT EXISTS aicd_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE IF NOT EXISTS aicd_diagnoses (
        fingerprint TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        cause TEXT,
        confidence TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS aicd_test_outcomes (
        id BIGSERIAL PRIMARY KEY,
        test_id TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT NOT NULL,
        branch TEXT,
        commit_sha TEXT,
        at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS aicd_test_outcomes_test ON aicd_test_outcomes (test_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS aicd_test_outcomes_at ON aicd_test_outcomes (at)",
    `CREATE TABLE IF NOT EXISTS aicd_audit (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS aicd_audit_run ON aicd_audit (run_id, id)",
    `CREATE TABLE IF NOT EXISTS aicd_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        seq BIGSERIAL NOT NULL,
        PRIMARY KEY (collection, id)
    )`,
    "CREATE INDEX IF NOT EXISTS aicd_records_recent ON aicd_records (collection, seq DESC)",
    "CREATE INDEX IF NOT EXISTS aicd_records_updated ON aicd_records (collection, updated_at)"
];
