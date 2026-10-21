/**
 * Conformance kit for plugin authors: `@aicd-ci/plugin-sdk/testing`.
 * Framework-agnostic: each check returns a list of failures (empty = conformant), so it fits
 * Vitest, Jest, Mocha or node:test with one assertion.
 */
import {ACTION_TYPES, FORBIDDEN_ACTIONS} from "../actions.js";
import type {CIProvider} from "../ci.js";
import type {LLMProvider} from "../llm.js";
import {PLUGIN_API_VERSION, type PluginManifest} from "../plugin.js";
import type {StateStore} from "../state.js";

export interface ConformanceFailure {
    check: string;
    message: string;
}

type Check = [name: string, run: () => Promise<void> | void];

async function runChecks(checks: Check[]): Promise<ConformanceFailure[]> {
    const failures: ConformanceFailure[] = [];
    for (const [check, run] of checks) {
        try {
            await run();
        } catch (error) {
            failures.push({check, message: error instanceof Error ? error.message : String(error)});
        }
    }
    return failures;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function equalJson(actual: unknown, expected: unknown, message: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

/**
 * Checks a `StateStore` against the contract. `create` must return an empty store each time
 * (use a fresh database or schema per call).
 */
export async function checkStateStore(create: () => Promise<StateStore> | StateStore): Promise<ConformanceFailure[]> {
    const withStore = (body: (store: StateStore) => Promise<void>) => async () => {
        const store = await create();
        try {
            await body(store);
        } finally {
            await store.close();
        }
    };
    return runChecks([
        [
            "diagnoses: unknown fingerprint is undefined",
            withStore(async (store) =>
                assert((await store.getDiagnosis("missing")) === undefined, "expected undefined")
            )
        ],
        [
            "diagnoses: save twice increments hits",
            withStore(async (store) => {
                const diagnosis = {
                    fingerprint: "fp",
                    category: "infrastructure",
                    summary: "s",
                    confidence: "medium"
                } as const;
                await store.saveDiagnosis(diagnosis);
                await store.saveDiagnosis({...diagnosis, summary: "updated"});
                const saved = await store.getDiagnosis("fp");
                assert(saved?.hits === 2, `hits should be 2, got ${saved?.hits}`);
                assert(saved.summary === "updated", "summary should be updated");
                assert(!Number.isNaN(Date.parse(saved.updatedAt)), "updatedAt should be an ISO date");
            })
        ],
        [
            "test history: most recent first, limited",
            withStore(async (store) => {
                await store.recordTestOutcomes([
                    {testId: "t", status: "passed", runId: "r1", at: "2026-01-01T00:00:00Z"},
                    {testId: "t", status: "failed", runId: "r2", commitSha: "c", at: "2026-01-02T00:00:00Z"},
                    {testId: "u", status: "skipped", runId: "r2", at: "2026-01-02T00:00:00Z"}
                ]);
                const history = await store.getTestHistory("t", 1);
                equalJson(
                    history.map((outcome) => [outcome.runId, outcome.status, outcome.commitSha]),
                    [["r2", "failed", "c"]],
                    "history"
                );
                equalJson((await store.listTestIds()).sort(), ["t", "u"], "listTestIds");
                equalJson(await store.listTestIds("2030-01-01T00:00:00Z"), [], "listTestIds since");
            })
        ],
        [
            "audit: entries in order, runs most recent first",
            withStore(async (store) => {
                await store.appendAudit({
                    runId: "a",
                    at: "2026-01-01T00:00:00Z",
                    agent: "x",
                    kind: "run",
                    payload: {n: 1}
                });
                await store.appendAudit({
                    runId: "a",
                    at: "2026-01-01T00:00:01Z",
                    agent: "x",
                    kind: "finding",
                    payload: {n: 2}
                });
                await store.appendAudit({
                    runId: "b",
                    at: "2026-01-02T00:00:00Z",
                    agent: "x",
                    kind: "run",
                    payload: null
                });
                equalJson(
                    (await store.listAudit("a")).map((entry) => entry.payload),
                    [{n: 1}, {n: 2}],
                    "audit payloads"
                );
                equalJson(
                    (await store.listRuns(10)).map((run) => run.runId),
                    ["b", "a"],
                    "runs"
                );
                equalJson(await store.listAudit("missing"), [], "unknown run");
            })
        ],
        [
            "records: upsert, get, list by recency, limit, delete",
            withStore(async (store) => {
                await store.putRecord("c", "1", {v: 1});
                await store.putRecord("c", "2", {v: 2});
                await store.putRecord("other", "1", {v: "x"});
                await store.putRecord("c", "1", {v: 3});
                equalJson((await store.getRecord("c", "1"))?.value, {v: 3}, "upserted value");
                equalJson(
                    (await store.listRecords("c")).map((record) => record.id),
                    ["1", "2"],
                    "recency order"
                );
                equalJson(
                    (await store.listRecords("c", {limit: 1})).map((record) => record.id),
                    ["1"],
                    "limit"
                );
                await store.deleteRecord("c", "1");
                assert((await store.getRecord("c", "1")) === undefined, "deleted record should be gone");
                equalJson(
                    (await store.listRecords("other")).map((record) => record.value),
                    [{v: "x"}],
                    "collections are isolated"
                );
            })
        ]
    ]);
}

/** Shape checks for a CI adapter. Pass `{probeContext: true}` when `getContext()` works offline. */
export async function checkCIProvider(
    provider: CIProvider,
    options: {probeContext?: boolean} = {}
): Promise<ConformanceFailure[]> {
    const methods = [
        "getContext",
        "listFailedJobs",
        "listJobs",
        "listRecentPipelines",
        "getJobLog",
        "getDiff",
        "readFile",
        "upsertComment",
        "setStatus",
        "retryJob",
        "addLabels",
        "openFixMergeRequest",
        "createRelease"
    ] as const;
    return runChecks([
        ["has a name", () => assert(typeof provider.name === "string" && provider.name.length > 0, "name is empty")],
        ...methods.map((method): Check => [
            `implements ${method}`,
            () => assert(typeof provider[method] === "function", `${method} is missing`)
        ]),
        ...(options.probeContext
            ? [
                  [
                      "context names the provider and sets isFork",
                      async () => {
                          const context = await provider.getContext();
                          assert(context.provider === provider.name, `context.provider should be ${provider.name}`);
                          assert(typeof context.isFork === "boolean", "isFork must be a boolean");
                      }
                  ] as Check
              ]
            : [])
    ]);
}

/** Shape checks for an LLM adapter (no call is made). */
export async function checkLLMProvider(provider: LLMProvider): Promise<ConformanceFailure[]> {
    return runChecks([
        ["has a name", () => assert(typeof provider.name === "string" && provider.name.length > 0, "name is empty")],
        [
            "has a model",
            () => assert(typeof provider.model === "string" && provider.model.length > 0, "model is empty")
        ],
        ["implements generateStructured", () => assert(typeof provider.generateStructured === "function", "missing")]
    ]);
}

/** Validates a plugin manifest: API version, unique component names, no forbidden or unknown action. */
export function checkPluginManifest(manifest: PluginManifest): ConformanceFailure[] {
    const failures: ConformanceFailure[] = [];
    const fail = (check: string, message: string) => failures.push({check, message});
    if (!manifest || typeof manifest !== "object") return [{check: "manifest", message: "not an object"}];
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name ?? ""))
        fail("name", `invalid package name "${manifest.name}"`);
    if (typeof manifest.version !== "string" || manifest.version.length === 0) fail("version", "missing version");
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        fail(
            "apiVersion",
            `built for plugin API ${String(manifest.apiVersion)}, this aicd supports ${PLUGIN_API_VERSION}`
        );
    }
    const provides = manifest.provides ?? {};
    for (const [kind, factories] of Object.entries(provides)) {
        const names = new Set<string>();
        for (const factory of (factories ?? []) as {name?: unknown; create?: unknown}[]) {
            if (typeof factory.name !== "string" || factory.name.length === 0) fail(kind, "a component has no name");
            else if (names.has(factory.name)) fail(kind, `duplicate component name "${factory.name}"`);
            else names.add(factory.name);
            if (typeof factory.create !== "function") fail(kind, `component "${String(factory.name)}" has no create()`);
        }
    }
    for (const action of manifest.actions ?? []) {
        if ((FORBIDDEN_ACTIONS as readonly string[]).includes(action)) fail("actions", `forbidden action "${action}"`);
        else if (!ACTION_TYPES.includes(action)) fail("actions", `unknown action "${action}"`);
    }
    return failures;
}
