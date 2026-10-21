import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd/adapter-state-sqlite";
import {
    buildPostmortem,
    computeDurations,
    correlateIncident,
    GUARD_RESULTS_COLLECTION,
    slugify,
    type LlmNarrative,
    type LlmRanking,
    type TimelineEntry
} from "@aicd/agent-postmortem";
import {RunBudget} from "@aicd/core";
import {
    COLLECTIONS,
    type AgentRuntime,
    type AuditEntry,
    type DeploymentRecord,
    type IncidentRecord,
    type LLMProvider,
    type StateStore
} from "@aicd/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function runtime(state: StateStore, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_pm",
        context: {provider: "test", repository: "acme/shop", defaultBranch: "main", isFork: false},
        state,
        budget: new RunBudget(1),
        logger,
        redact: (text) => text.replace(/token=\w+/g, "token=[REDACTED]"),
        language: "en",
        sendCode: "diff_only",
        now: () => new Date("2026-10-21T10:12:00Z"),
        ...overrides
    };
}

function fakeLlm(output: unknown): LLMProvider & {calls: number; prompts: string[]} {
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
                usage: {model: "fake-model", inputTokens: 50, outputTokens: 10, costUsd: 0.001}
            };
        }
    };
    return provider as LLMProvider & {calls: number; prompts: string[]};
}

const SHA = {a: "a1a1a1a1a1a1a1a1", b: "b2b2b2b2b2b2b2b2", c: "c3c3c3c3c3c3c3c3"};

const dep = (overrides: Partial<DeploymentRecord> & {id: string; startedAt: string}): DeploymentRecord => ({
    environment: "production",
    service: "shop",
    status: "success",
    source: "gitlab",
    ...overrides
});

async function seededState(): Promise<StateStore> {
    const state = new SqliteStateStore(":memory:");
    const deployments = [
        dep({id: "dep-old", startedAt: "2026-10-19T10:00:00Z"}),
        dep({id: "dep-41", startedAt: "2026-10-21T08:00:00Z", version: "1.3.0"}),
        dep({
            id: "dep-42",
            startedAt: "2026-10-21T09:50:00Z",
            finishedAt: "2026-10-21T09:55:00Z",
            version: "1.4.0",
            status: "rolled_back",
            commits: [
                {sha: SHA.a, authoredAt: "2026-10-21T08:00:00Z", subject: "docs: readme"},
                {sha: SHA.b, authoredAt: "2026-10-21T09:00:00Z", subject: "feat: retry payments token=abc123"},
                {sha: SHA.c, authoredAt: "2026-10-21T09:00:00Z", subject: "fix: cart rounding"}
            ]
        }),
        dep({id: "dep-staging", environment: "staging", startedAt: "2026-10-21T10:00:00Z"}),
        dep({id: "dep-after", startedAt: "2026-10-21T10:30:00Z"})
    ];
    for (const deployment of deployments) await state.putRecord(COLLECTIONS.deployments, deployment.id, deployment);
    return state;
}

const incident: IncidentRecord = {
    id: "inc-7",
    title: "Checkout errors after release",
    environment: "production",
    severity: "critical",
    openedAt: "2026-10-21T10:10:00Z",
    url: "https://alerts.example/inc-7",
    source: "alertmanager",
    timeline: []
};

describe("correlateIncident", () => {
    it("picks the last deployment of the environment before the incident and ranks commits by recency", async () => {
        const state = await seededState();
        const result = await correlateIncident(runtime(state), {incident});
        expect(result.report.deployment).toMatchObject({id: "dep-42", version: "1.4.0"});
        expect(result.report.candidates).toBe(2);
        expect(result.report.suspects.map((s) => s.sha)).toEqual([SHA.c, SHA.b, SHA.a]);
        expect(result.report.suspects[1]?.subject).toBe("feat: retry payments token=[REDACTED]");
        expect(result.report.source).toBe("rules");

        const stored = await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, "inc-7");
        expect(stored?.value).toMatchObject({deploymentId: "dep-42", suspectCommits: [SHA.c, SHA.b, SHA.a]});
        expect(stored?.value.timeline).toEqual([
            {
                at: "2026-10-21T10:12:00.000Z",
                kind: "correlation",
                text: expect.stringContaining("Suspect deployment `dep-42`")
            }
        ]);

        expect(result.actions.map((a) => a.type)).toEqual(["create_issue", "notify"]);
        const issue = result.actions[0];
        expect(issue?.type === "create_issue" && issue.issue).toMatchObject({
            title: "Incident: Checkout errors after release",
            labels: ["incident", "critical"]
        });
        expect(issue?.type === "create_issue" && issue.issue.body).toContain("- `b2b2b2b2b2b2` feat: retry payments");
        expect(result.actions[1]).toMatchObject({notification: {severity: "critical", url: incident.url}});
    });

    it("replaces its timeline entry when run again and skips the issue when one is linked", async () => {
        const state = await seededState();
        await correlateIncident(runtime(state), {incident});
        const first = (await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, "inc-7"))!.value;
        const again = await correlateIncident(runtime(state), {incident: {...first, issueKey: "OPS-12"}});
        const stored = (await state.getRecord<IncidentRecord>(COLLECTIONS.incidents, "inc-7"))!.value;
        expect(stored.timeline.filter((entry) => entry.kind === "correlation")).toHaveLength(1);
        expect(again.actions.map((a) => a.type)).toEqual(["notify"]);
    });

    it("says so when no deployment is in the lookback window", async () => {
        const state = await seededState();
        const result = await correlateIncident(runtime(state, {language: "fr"}), {
            incident: {...incident, openedAt: "2026-10-21T07:00:00Z"},
            lookback_hours: 1
        });
        expect(result.report.deployment).toBeUndefined();
        expect(result.report.suspects).toEqual([]);
        expect(result.actions[1]).toMatchObject({
            notification: {
                title: "Incident : Checkout errors after release",
                text: "Aucun déploiement trouvé dans les 1 h précédant l'incident."
            }
        });
    });

    it("accepts an LLM ranking only for existing SHAs quoting their subject", async () => {
        const state = await seededState();
        const llm = fakeLlm({
            ranking: [
                {
                    sha: SHA.b.slice(0, 8),
                    reason: "Payment retries can double-submit checkouts.",
                    quote: "retry payments"
                },
                {sha: "deadbeefdeadbeef", reason: "Invented commit.", quote: "docs: readme"},
                {sha: SHA.a, reason: "Quote not in the subject.", quote: "rewrote the checkout"}
            ]
        } satisfies LlmRanking);
        const result = await correlateIncident(runtime(state, {llm}), {incident});
        expect(llm.prompts[0]).toContain("feat: retry payments token=[REDACTED]");
        expect(llm.prompts[0]).not.toContain("abc123");
        expect(result.report.source).toBe("llm");
        expect(result.report.suspects.map((s) => [s.sha, s.source])).toEqual([
            [SHA.b, "llm"],
            [SHA.c, "rules"],
            [SHA.a, "rules"]
        ]);
        expect(result.report.suspects[0]?.reason).toBe("Payment retries can double-submit checkouts.");
        expect(result).toMatchObject({llmCalls: 1, costUsd: 0.001});
    });

    it("keeps the deterministic ranking when every LLM item is rejected or the LLM fails", async () => {
        const state = await seededState();
        const rejected = await correlateIncident(
            runtime(state, {llm: fakeLlm({ranking: [{sha: "zzz", reason: "", quote: ""}]})}),
            {
                incident
            }
        );
        expect(rejected.report.source).toBe("rules");
        const failed = await correlateIncident(runtime(state, {llm: fakeLlm(new Error("down"))}), {incident});
        expect(failed.report.suspects.map((s) => s.sha)).toEqual([SHA.c, SHA.b, SHA.a]);
    });

    it("refuses an invalid opening date", async () => {
        await expect(
            correlateIncident(runtime(new SqliteStateStore(":memory:")), {incident: {...incident, openedAt: "soon"}})
        ).rejects.toThrow(/invalid openedAt/);
    });
});

async function postmortemState(): Promise<StateStore> {
    const state = await seededState();
    await state.putRecord(COLLECTIONS.deployments, "dep-43", {
        ...dep({id: "dep-43", startedAt: "2026-10-21T10:20:00Z", version: "1.3.0"}),
        rollbackOf: "dep-42"
    });
    await state.putRecord(GUARD_RESULTS_COLLECTION, "dep-42", {
        verdict: "rollback",
        health: "degraded",
        evaluatedAt: "2026-10-21T10:05:00Z"
    });
    await state.putRecord<IncidentRecord>(COLLECTIONS.incidents, "inc-7", {
        ...incident,
        deploymentId: "dep-42",
        suspectCommits: [SHA.b, SHA.c],
        issueKey: "OPS-12",
        resolvedAt: "2026-10-21T11:00:00Z",
        timeline: [{at: "2026-10-21T10:12:00Z", kind: "correlation", text: "Suspect deployment `dep-42`."}]
    });
    return state;
}

const audit: AuditEntry[] = [
    {
        runId: "r1",
        at: "2026-10-21T10:04:00Z",
        agent: "release-guardian",
        kind: "action",
        payload: {type: "pause_deployment", outcome: "done"}
    },
    {
        runId: "r1",
        at: "2026-10-21T10:06:00Z",
        agent: "release-guardian",
        kind: "action",
        payload: {type: "rollback_deployment", outcome: "done"}
    },
    {
        runId: "r1",
        at: "2026-10-21T10:07:00Z",
        agent: "release-guardian",
        kind: "action",
        payload: {type: "notify", outcome: "done"}
    },
    {
        runId: "r1",
        at: "2026-10-21T10:08:00Z",
        agent: "release-guardian",
        kind: "action",
        payload: {type: "pause_deployment", outcome: "failed"}
    }
];

describe("buildPostmortem", () => {
    it("builds a sorted timeline with durations and a deterministic narrative", async () => {
        const state = await postmortemState();
        const result = await buildPostmortem(runtime(state), {incidentId: "inc-7", audit});
        const {report} = result;
        expect(report.timeline.map((entry) => [entry.id, entry.kind, entry.at.slice(11, 16)])).toEqual([
            ["E1", "deployment_started", "09:50"],
            ["E2", "deployment_finished", "09:55"],
            ["E3", "pause", "10:04"],
            ["E4", "guard_verdict", "10:05"],
            ["E5", "alert_opened", "10:10"],
            ["E6", "note", "10:12"],
            ["E7", "issue_linked", "10:12"],
            ["E8", "rollback", "10:20"],
            ["E9", "resolved", "11:00"]
        ]);
        expect(report.durations).toEqual({detectMinutes: 20, mitigateMinutes: 10, resolveMinutes: 50});
        expect(report.source).toBe("rules");
        expect(report.path).toBe("docs/postmortems/2026-10-21-checkout-errors-after-release.md");
        expect(report.suspectCommits[0]).toEqual({sha: SHA.b, subject: "feat: retry payments token=[REDACTED]"});
        expect(report.claims.every((claim) => claim.cites.length > 0)).toBe(true);

        expect(result.actions).toHaveLength(1);
        const action = result.actions[0];
        expect(action?.type).toBe("open_fix_mr");
        if (action?.type !== "open_fix_mr") return;
        expect(action.fix).toMatchObject({
            title: 'docs: post-mortem "Checkout errors after release"',
            baseBranch: "main"
        });
        expect(action.fix.branch).toMatch(/^aicd\/fix-postmortem-checkout-errors/);
        expect(action.fix.changes).toEqual([{path: report.path, content: report.markdown}]);

        const md = report.markdown;
        expect(md).toContain("# Post-mortem: Checkout errors after release");
        expect(md).toContain("Blameless post-mortem");
        expect(md).toContain("| E4 | 2026-10-21 10:05 | Release guardian verdict: roll back (degraded) |");
        expect(md).toContain("| E8 | 2026-10-21 10:20 | Rollback deployment `dep-43` started (1.3.0) |");
        expect(md).toContain("- Time to detect: 20 min");
        expect(md).toContain("- Time to resolve: 50 min");
        expect(md).toContain(
            "It was detected 20 min after deployment `dep-42` started. It was resolved after 50 min. [E5, E1, E9]"
        );
        expect(md).toContain("- [ ] Confirm or refute the root-cause hypothesis. [E5]");
        expect(md).not.toContain("abc123");
    });

    it("renders in French", async () => {
        const state = await postmortemState();
        const {report} = await buildPostmortem(runtime(state, {language: "fr"}), {incidentId: "inc-7"});
        const md = report.markdown;
        expect(md).toContain("# Post-mortem : Checkout errors after release");
        expect(md).toContain("Post-mortem sans reproche");
        expect(md).toContain("| Gravité | critique |");
        expect(md).toContain("## Chronologie");
        expect(md).toContain("Verdict du gardien de déploiement : revenir en arrière (degraded)");
        expect(md).toContain("- Délai de détection : 20 min");
        expect(md).toContain("## Hypothèse de cause racine");
        expect(md).toContain("Hypothèse issue de la corrélation, non confirmée : déploiement `dep-42`");
    });

    it("keeps only LLM claims that cite existing timeline entries", async () => {
        const state = await postmortemState();
        const llm = fakeLlm({
            claims: [
                {section: "summary", text: "Checkout failed for 50 minutes after release 1.4.0.", cites: ["E1", "E9"]},
                {section: "impact", text: "Thousands of users were hit.", cites: ["E42"]},
                {section: "root_cause", text: "Payment retries, hypothesis.", cites: []},
                {section: "action_item", text: "Add an alert on checkout errors.", cites: ["[E5]"]}
            ]
        } satisfies LlmNarrative);
        const {report, llmCalls} = await buildPostmortem(runtime(state, {llm}), {incidentId: "inc-7", audit});
        expect(llmCalls).toBe(1);
        expect(llm.prompts[0]).toContain("E4 2026-10-21T10:05:00.000Z Release guardian verdict: roll back (degraded)");
        expect(report.source).toBe("llm");
        expect(report.claims).toEqual([
            {section: "summary", text: "Checkout failed for 50 minutes after release 1.4.0.", cites: ["E1", "E9"]},
            {section: "action_item", text: "Add an alert on checkout errors.", cites: ["E5"]}
        ]);
        expect(report.markdown).toContain("## Impact\n\n_Nothing known yet._");
    });

    it("falls back to the deterministic narrative when no LLM claim survives", async () => {
        const state = await postmortemState();
        const llm = fakeLlm({claims: [{section: "summary", text: "Invented.", cites: ["E99"]}]} satisfies LlmNarrative);
        const {report} = await buildPostmortem(runtime(state, {llm}), {incidentId: "inc-7"});
        expect(report.source).toBe("rules");
        expect(report.claims.some((claim) => claim.section === "root_cause")).toBe(true);
    });

    it("works without a correlated deployment", async () => {
        const state = new SqliteStateStore(":memory:");
        await state.putRecord<IncidentRecord>(COLLECTIONS.incidents, "inc-8", {
            ...incident,
            id: "inc-8",
            title: "Panne élevée !"
        });
        const {report} = await buildPostmortem(runtime(state), {incidentId: "inc-8"});
        expect(report.timeline.map((entry) => entry.kind)).toEqual(["alert_opened"]);
        expect(report.durations).toEqual({});
        expect(report.path).toBe("docs/postmortems/2026-10-21-panne-elevee.md");
        expect(report.markdown).toContain("Root cause unknown");
        expect(report.markdown).toContain("- Time to detect: unknown");
    });

    it("throws for an unknown incident", async () => {
        await expect(buildPostmortem(runtime(new SqliteStateStore(":memory:")), {incidentId: "nope"})).rejects.toThrow(
            /not found/
        );
    });
});

describe("helpers", () => {
    it("flags a rollback that came before the alert", () => {
        const entry = (id: string, kind: TimelineEntry["kind"], at: string): TimelineEntry => ({
            id,
            kind,
            at,
            data: {}
        });
        expect(
            computeDurations([
                entry("E1", "deployment_started", "2026-10-21T10:00:00Z"),
                entry("E2", "rollback", "2026-10-21T10:05:00Z"),
                entry("E3", "alert_opened", "2026-10-21T10:07:00Z")
            ])
        ).toEqual({detectMinutes: 7, mitigateMinutes: 0, mitigatedBeforeAlert: true});
        expect(slugify("  !!! ")).toBe("incident");
    });
});
