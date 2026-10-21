import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    analyzePipeline,
    diffPaths,
    loadHistory,
    parseCiConfig,
    percentile,
    recordJobRuns,
    recordPipelines,
    renderOptimizerReport,
    runPipelineOptimizer,
    type LlmPipelineFix,
    type OptimizerFinding
} from "@aicd-ci/agent-pipeline-optimizer";
import {RunBudget} from "@aicd-ci/core";
import {
    COLLECTIONS,
    type AgentRuntime,
    type JobRunRecord,
    type LLMProvider,
    type PipelineSummary,
    type ReadonlyCI,
    type StructuredRequest
} from "@aicd-ci/plugin-sdk";
import {GITHUB_WORKFLOW, GITHUB_WORKFLOW_GOOD, GITLAB_CI, GITLAB_CI_GOOD, gitlabHistory} from "./fixtures.js";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
const GITLAB_FILES = [{path: ".gitlab-ci.yml", content: GITLAB_CI}];
const GITHUB_FILES = [{path: ".github/workflows/ci.yml", content: GITHUB_WORKFLOW}];

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_opt",
        context: {
            provider: "gitlab",
            repository: "acme/app",
            branch: "main",
            defaultBranch: "main",
            pipelineId: "2000",
            isFork: false
        },
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text,
        language: "en",
        sendCode: "full",
        now: () => new Date("2026-10-21T10:00:00Z"),
        ...overrides
    };
}

function fakeCi(options: {pipelines?: PipelineSummary[] | Error; diff?: string} = {}): ReadonlyCI & {calls: unknown[]} {
    const calls: unknown[] = [];
    return {
        name: "fake",
        calls,
        getContext: async () => ({provider: "gitlab", repository: "acme/app", isFork: false}),
        listFailedJobs: async () => [],
        listJobs: async () => [
            {id: "9001", name: "install", status: "success", durationSeconds: 250},
            {id: "9002", name: "optimizer", status: "running"}
        ],
        listRecentPipelines: async (request) => {
            calls.push(request);
            if (options.pipelines instanceof Error) throw options.pipelines;
            return options.pipelines ?? [];
        },
        getJobLog: async () => "",
        getDiff: async () => options.diff,
        readFile: async () => undefined
    };
}

function fakeLlm(output: LlmPipelineFix | Error): LLMProvider & {prompts: string[]} {
    const provider = {
        name: "fake",
        model: "fake-model",
        prompts: [] as string[],
        async generateStructured<T>(request: StructuredRequest<T>) {
            provider.prompts.push(request.prompt);
            if (output instanceof Error) throw output;
            return {
                output: output as T,
                usage: {model: "fake-model", inputTokens: 900, outputTokens: 120, costUsd: 0.004}
            };
        }
    };
    return provider;
}

function historyRecords(pipelines: PipelineSummary[]): JobRunRecord[] {
    return pipelines.flatMap((pipeline) =>
        pipeline.jobs.map((job) => ({
            pipelineId: pipeline.id,
            jobId: job.id,
            name: job.name,
            status: job.status,
            ...(job.durationSeconds !== undefined ? {durationSeconds: job.durationSeconds} : {}),
            ...(job.queuedSeconds !== undefined ? {queuedSeconds: job.queuedSeconds} : {}),
            at: job.finishedAt ?? pipeline.createdAt
        }))
    );
}

const kinds = (findings: OptimizerFinding[]) =>
    findings.map((finding) => `${finding.kind}:${finding.job ?? finding.file ?? ""}`);

describe("history", () => {
    it("records finished jobs only, with stable ids", async () => {
        const state = new SqliteStateStore(":memory:");
        const count = await recordJobRuns(
            state,
            [
                {id: "1", name: "build", status: "success", durationSeconds: 60, finishedAt: "2026-10-20T10:00:00Z"},
                {id: "2", name: "test", status: "running"},
                {id: "3", name: "lint", status: "failed", queuedSeconds: 5}
            ],
            {pipelineId: "77", branch: "main"},
            new Date("2026-10-21T00:00:00Z")
        );
        expect(count).toBe(2);
        expect((await state.getRecord<JobRunRecord>(COLLECTIONS.jobRuns, "77:1"))?.value).toEqual({
            pipelineId: "77",
            jobId: "1",
            name: "build",
            status: "success",
            durationSeconds: 60,
            branch: "main",
            at: "2026-10-20T10:00:00Z"
        });
        expect(await recordJobRuns(state, [{id: "4", name: "x", status: "success"}], {})).toBe(0);
    });

    it("keeps the most recent pipelines", async () => {
        const state = new SqliteStateStore(":memory:");
        await recordPipelines(state, gitlabHistory(10));
        const history = await loadHistory(state, 4);
        expect(new Set(history.map((record) => record.pipelineId))).toEqual(new Set(["1006", "1007", "1008", "1009"]));
    });

    it("computes nearest-rank percentiles", () => {
        expect(percentile([], 50)).toBeUndefined();
        expect(percentile([5, 1, 3], 50)).toBe(3);
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    });
});

describe("parseCiConfig", () => {
    it("resolves extends, !reference and caches in GitLab", () => {
        const config = parseCiConfig("gitlab", GITLAB_FILES);
        expect(config.errors).toEqual([]);
        expect(config.jobs.map((job) => job.name)).toEqual([
            "install",
            "build",
            "lint",
            "eslint",
            "unit_tests",
            "e2e",
            "deploy"
        ]);
        const unit = config.jobs.find((job) => job.name === "unit_tests");
        expect(unit?.scripts).toEqual(["npm ci", "npm run test:unit -- --reporter=junit"]);
        expect(config.jobs.find((job) => job.name === "e2e")?.hasCache).toBe(true);
        expect(config.jobs.find((job) => job.name === "deploy")?.hasChangesRule).toBe(false);
    });

    it("reads GitHub triggers, concurrency and setup caches", () => {
        const config = parseCiConfig("github", [
            ...GITHUB_FILES,
            {path: ".github/workflows/release.yml", content: GITHUB_WORKFLOW_GOOD}
        ]);
        expect(config.workflows).toEqual([
            {file: ".github/workflows/ci.yml", onCodeChanges: true, hasPathFilter: false, cancelsSuperseded: false},
            {file: ".github/workflows/release.yml", onCodeChanges: true, hasPathFilter: true, cancelsSuperseded: true}
        ]);
        const cache = Object.fromEntries(config.jobs.map((job) => [job.name, job.hasCache]));
        expect(cache).toEqual({test: false, lint: true, python: true, build: true});
    });

    it("reports invalid YAML without throwing", () => {
        const config = parseCiConfig("gitlab", [{path: ".gitlab-ci.yml", content: "build: [unclosed\n"}]);
        expect(config.errors).toEqual([expect.stringContaining(".gitlab-ci.yml")]);
        expect(config.jobs).toEqual([]);
    });
});

describe("analyzePipeline", () => {
    it("finds configuration problems without history, with no saving numbers", () => {
        const analysis = analyzePipeline({provider: "gitlab", configFiles: GITLAB_FILES, history: []});
        expect(kinds(analysis.findings)).toEqual([
            "missing_cache:install",
            "missing_cache:build",
            "missing_cache:lint",
            "missing_cache:eslint",
            "missing_cache:unit_tests",
            "duplicate_job:eslint",
            "serialized_stages:.gitlab-ci.yml",
            "no_auto_cancel:.gitlab-ci.yml",
            "no_path_filter:.gitlab-ci.yml"
        ]);
        expect(analysis.findings.every((finding) => finding.estimatedSavingMinutesPerRun === undefined)).toBe(true);
        const cache = analysis.findings[0];
        expect(cache?.evidence).toEqual([{kind: "code", ref: ".gitlab-ci.yml:24", quote: "npm ci"}]);
        // build gets "npm ci" from the template it extends.
        expect(analysis.findings[1]?.evidence[0]?.ref).toBe(".gitlab-ci.yml:15");
        expect(analysis.findings.find((f) => f.kind === "serialized_stages")?.detail).toContain(
            "install → build → test → deploy"
        );
    });

    it("uses history for slow jobs, queues, retries and savings", () => {
        const history = historyRecords(gitlabHistory(10));
        const analysis = analyzePipeline({provider: "gitlab", configFiles: GITLAB_FILES, history});
        const byKind = (kind: string, job?: string) =>
            analysis.findings.find((f) => f.kind === kind && (!job || f.job === job));
        expect(byKind("slow_job", "unit_tests")).toMatchObject({evidence: [{kind: "history", ref: "job unit_tests"}]});
        expect(byKind("long_queue")?.estimatedSavingMinutesPerRun).toBe(3.2);
        expect(byKind("flaky_retry", "unit_tests")).toMatchObject({estimatedSavingMinutesPerRun: 2.4});
        expect(byKind("flaky_retry", "unit_tests")?.detail).toContain("4 of 10 pipelines");
        // p50 of unit_tests is 12.8 min; a cache is estimated to save a quarter of it.
        expect(byKind("missing_cache", "unit_tests")?.estimatedSavingMinutesPerRun).toBe(3.2);
        expect(byKind("duplicate_job")?.estimatedSavingMinutesPerRun).toBe(1);
        // Sorted by estimated saving, unknown savings last.
        const savings = analysis.findings.map((f) => f.estimatedSavingMinutesPerRun ?? -1);
        expect(savings).toEqual([...savings].sort((a, b) => b - a));
        expect(analysis.pipelines).toBe(10);
    });

    it("needs min_runs before trusting history", () => {
        const history = historyRecords(gitlabHistory(3));
        const analysis = analyzePipeline({
            provider: "gitlab",
            configFiles: GITLAB_FILES,
            history,
            options: {min_runs: 5}
        });
        expect(analysis.findings.some((f) => ["slow_job", "long_queue", "flaky_retry"].includes(f.kind))).toBe(false);
        expect(analysis.findings.every((f) => f.estimatedSavingMinutesPerRun === undefined)).toBe(true);
    });

    it("finds nothing in well-configured pipelines", () => {
        expect(
            analyzePipeline({
                provider: "gitlab",
                configFiles: [{path: ".gitlab-ci.yml", content: GITLAB_CI_GOOD}],
                history: []
            }).findings
        ).toEqual([]);
        expect(
            analyzePipeline({
                provider: "github",
                configFiles: [{path: ".github/workflows/ci.yml", content: GITHUB_WORKFLOW_GOOD}],
                history: []
            }).findings
        ).toEqual([]);
    });

    it("analyses GitHub workflows", () => {
        const analysis = analyzePipeline({
            provider: "github",
            configFiles: GITHUB_FILES,
            history: [],
            options: {language: "fr"}
        });
        expect(kinds(analysis.findings)).toEqual([
            "missing_cache:test",
            "no_auto_cancel:.github/workflows/ci.yml",
            "no_path_filter:.github/workflows/ci.yml"
        ]);
        expect(analysis.findings[0]?.title).toBe("Dépendances installées sans cache (npm)");
        expect(analysis.findings[2]?.evidence[0]).toEqual({
            kind: "code",
            ref: ".github/workflows/ci.yml:3",
            quote: "on:"
        });
    });

    it("handles empty inputs", () => {
        expect(analyzePipeline({provider: "gitlab", configFiles: [], history: []})).toEqual({
            findings: [],
            stats: [],
            pipelines: 0,
            errors: []
        });
    });
});

const goodFix: LlmPipelineFix = {
    summary: "Cache npm downloads in the test job.",
    addressed: [1],
    edits: [
        {
            path: ".github/workflows/ci.yml",
            search: "          node-version: 22\n      - run: npm ci\n      - run: npm test",
            replace: "          node-version: 22\n          cache: npm\n      - run: npm ci\n      - run: npm test"
        }
    ]
};

describe("runPipelineOptimizer", () => {
    it("proposes an issue on a scheduled run and records history", async () => {
        const rt = runtime();
        const ci = fakeCi({pipelines: gitlabHistory(10)});
        const result = await runPipelineOptimizer(rt, {ci, configFiles: GITLAB_FILES, options: {history_limit: 20}});
        expect(ci.calls).toEqual([{branch: "main", limit: 20}]);
        expect(result.report.pipelines).toBe(11);
        expect(await rt.state.getRecord(COLLECTIONS.jobRuns, "2000:9001")).toBeDefined();
        expect(await rt.state.getRecord(COLLECTIONS.jobRuns, "2000:9002")).toBeUndefined();
        expect(result.actions.map((action) => action.type)).toEqual(["create_issue"]);
        const issue = result.actions[0];
        expect(issue?.type === "create_issue" && issue.issue.title).toMatch(
            /^CI pipeline: \d+ optimization\(s\) \(~[\d.]+ min\/run\)$/
        );
        expect(result.report.totalEstimatedSavingMinutesPerRun).toBeGreaterThan(0);
        expect(result.llmCalls).toBe(0);
    });

    it("keeps working when the CI history is unavailable", async () => {
        const result = await runPipelineOptimizer(runtime(), {
            ci: fakeCi({pipelines: new Error("403 Forbidden")}),
            configFiles: GITHUB_FILES
        });
        expect(result.report.errors).toEqual(["could not list recent pipelines: 403 Forbidden"]);
        expect(result.report.findings.length).toBe(3);
    });

    it("comments on a merge request only when it touches CI configuration", async () => {
        const mr = {...runtime().context, branch: "feature/ci", mergeRequest: {id: "12"}};
        const llm = fakeLlm(goodFix);
        const untouched = await runPipelineOptimizer(runtime({context: mr, llm}), {
            ci: fakeCi({diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n"}),
            configFiles: GITHUB_FILES
        });
        expect(untouched.actions).toEqual([]);
        expect(untouched.report.ciConfigTouched).toBe(false);
        expect(llm.prompts).toHaveLength(0);

        const touched = await runPipelineOptimizer(runtime({context: mr}), {
            ci: fakeCi({diff: "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n"}),
            configFiles: GITHUB_FILES
        });
        expect(touched.actions.map((action) => action.type)).toEqual(["comment"]);
        const comment = touched.actions[0];
        expect(comment?.type === "comment" && comment.marker).toBe("<!-- aicd:optimizer -->");
        expect(comment?.type === "comment" && comment.body.startsWith("<!-- aicd:optimizer -->")).toBe(true);
    });

    it("proposes a fix merge request when the LLM edits apply, parse and remove a finding", async () => {
        const llm = fakeLlm(goodFix);
        const result = await runPipelineOptimizer(runtime({llm}), {ci: fakeCi(), configFiles: GITHUB_FILES});
        expect(llm.prompts[0]).toContain('<file path=".github/workflows/ci.yml">');
        expect(result.llmCalls).toBe(1);
        expect(result.costUsd).toBeCloseTo(0.004);
        expect(result.report.fix?.addressed.map((finding) => finding.kind)).toEqual(["missing_cache"]);
        const fix = result.actions.find((action) => action.type === "open_fix_mr");
        expect(fix?.type === "open_fix_mr" && fix.fix.branch).toMatch(/^aicd\/fix-ci-pipeline-optimization-/);
        expect(fix?.type === "open_fix_mr" && fix.fix.changes[0]?.content).toContain(
            "          cache: npm\n      - run: npm ci\n      - run: npm test"
        );
        expect(result.report.findings.map((f) => f.kind)).toContain("missing_cache");
    });

    it("rejects edits that break YAML, do not apply or change nothing useful", async () => {
        const cases: LlmPipelineFix[] = [
            {...goodFix, edits: [{...goodFix.edits[0]!, replace: "          node-version: [22\n"}]},
            {...goodFix, edits: [{...goodFix.edits[0]!, search: "node-version: 20"}]},
            {
                ...goodFix,
                edits: [{path: ".github/workflows/ci.yml", search: "name: CI", replace: "name: Continuous integration"}]
            },
            {...goodFix, edits: [{path: "package.json", search: "a", replace: "b"}]},
            {
                ...goodFix,
                edits: [
                    ...goodFix.edits,
                    {path: ".github/workflows/ci.yml", search: "          cache: pip\n", replace: ""}
                ]
            }
        ];
        for (const output of cases) {
            const result = await runPipelineOptimizer(runtime({llm: fakeLlm(output)}), {
                ci: fakeCi(),
                configFiles: GITHUB_FILES
            });
            expect(result.report.fix).toBeUndefined();
            expect(result.actions.map((action) => action.type)).toEqual(["create_issue"]);
        }
    });

    it("never sends configuration with sendCode none, and survives LLM failures", async () => {
        const llm = fakeLlm(goodFix);
        await runPipelineOptimizer(runtime({llm, sendCode: "none"}), {ci: fakeCi(), configFiles: GITHUB_FILES});
        expect(llm.prompts).toHaveLength(0);
        const failing = await runPipelineOptimizer(runtime({llm: fakeLlm(new Error("timeout"))}), {
            ci: fakeCi(),
            configFiles: GITHUB_FILES
        });
        expect(failing.llmCalls).toBe(0);
        expect(failing.actions.map((action) => action.type)).toEqual(["create_issue"]);
    });

    it("does not open an issue on every feature-branch push", async () => {
        const context = {...runtime().context, branch: "feature/x"};
        const result = await runPipelineOptimizer(runtime({context}), {ci: fakeCi(), configFiles: GITHUB_FILES});
        expect(result.report.findings.length).toBe(3);
        expect(result.actions).toEqual([]);
    });

    it("proposes nothing when there is nothing to optimize", async () => {
        const result = await runPipelineOptimizer(runtime(), {
            ci: fakeCi(),
            configFiles: [{path: ".gitlab-ci.yml", content: GITLAB_CI_GOOD}]
        });
        expect(result.actions).toEqual([]);
    });
});

describe("renderOptimizerReport", () => {
    it("renders a table in English and French", async () => {
        const history = historyRecords(gitlabHistory(10));
        const analysis = analyzePipeline({provider: "gitlab", configFiles: GITLAB_FILES, history});
        const report = {
            findings: analysis.findings,
            pipelines: 10,
            jobRuns: history.length,
            stats: [],
            onMergeRequest: false,
            errors: [],
            totalEstimatedSavingMinutesPerRun: 12.5
        };
        const en = renderOptimizerReport(report, {language: "en"});
        expect(en).toContain("| Job | Finding | Estimated saving |");
        expect(en).toContain("~3.2 min/run");
        expect(en).toContain("about **12.5 min** saved per pipeline run");
        const fr = renderOptimizerReport(
            {
                ...analyzePipeline({provider: "gitlab", configFiles: GITLAB_FILES, history, options: {language: "fr"}}),
                jobRuns: 0,
                onMergeRequest: false,
                errors: [],
                stats: []
            },
            {language: "fr"}
        );
        expect(fr).toContain("| Job | Constat | Gain estimé |");
        expect(fr).toContain("min/exécution");
        expect(fr).toContain("Jobs dupliqués : `lint`, `eslint`");
        expect(
            renderOptimizerReport(
                {findings: [], pipelines: 0, jobRuns: 0, stats: [], onMergeRequest: false, errors: []},
                {language: "fr"}
            )
        ).toContain("Aucune optimisation trouvée.");
    });

    it("extracts paths from a diff", () => {
        expect(
            diffPaths("diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml\n--- a/.gitlab-ci.yml\n+++ b/.gitlab-ci.yml\n")
        ).toEqual([".gitlab-ci.yml"]);
    });
});
