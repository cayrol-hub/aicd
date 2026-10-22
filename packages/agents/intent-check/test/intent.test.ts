import {describe, expect, it, vi} from "vitest";
import {SqliteStateStore} from "@aicd-ci/adapter-state-sqlite";
import {
    COMMENT_MARKER,
    isTestFile,
    locateQuote,
    renderIntentComment,
    runIntentCheck,
    splitDiff,
    SYSTEM_PROMPT,
    type IntentCheckInput,
    type LlmIntent
} from "@aicd-ci/agent-intent-check";
import {RunBudget} from "@aicd-ci/core";
import {LLMError, type AgentRuntime, type LLMProvider, type StructuredRequest, type Ticket} from "@aicd-ci/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

function fakeLlm(output: LlmIntent | Error): LLMProvider & {requests: StructuredRequest<unknown>[]} {
    const provider = {
        name: "fake",
        model: "fake-model",
        requests: [] as StructuredRequest<unknown>[],
        async generateStructured<T>(request: StructuredRequest<T>) {
            provider.requests.push(request as StructuredRequest<unknown>);
            if (output instanceof Error) throw output;
            return {
                output: output as T,
                usage: {model: "fake-model", inputTokens: 100, outputTokens: 20, costUsd: 0.002}
            };
        }
    };
    return provider;
}

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
    return {
        runId: "run_intent",
        context: {provider: "test", repository: "acme/app", isFork: false},
        state: new SqliteStateStore(":memory:"),
        budget: new RunBudget(1),
        logger,
        redact: (text) => text.replace(/sk_live_\w+/g, "[REDACTED]"),
        language: "en",
        sendCode: "diff_only",
        now: () => new Date("2026-10-21T10:00:00Z"),
        ...overrides
    };
}

const DIFF = `diff --git a/src/login.tsx b/src/login.tsx
index 1111111..2222222 100644
--- a/src/login.tsx
+++ b/src/login.tsx
@@ -10,6 +10,9 @@ export function Login() {
   return (
     <form>
+      <SsoButton provider="google" />
+      {error && <Toast kind="error">{error}</Toast>}
       <PasswordField />
     </form>
   );
diff --git a/src/billing.ts b/src/billing.ts
index 3333333..4444444 100644
--- a/src/billing.ts
+++ b/src/billing.ts
@@ -1,3 +1,3 @@
-export const FEE_RATE = 0.02;
+export const FEE_RATE = 0.03;
 export const key = "sk_live_abcdef";
diff --git a/test/login.test.tsx b/test/login.test.tsx
new file mode 100644
--- /dev/null
+++ b/test/login.test.tsx
@@ -0,0 +1,2 @@
+it("shows the SSO button", () => {});
+it("shows an error toast", () => {});
`;

const ticket: Ticket = {
    key: "ENG-12",
    title: "Login with SSO",
    description: "## Acceptance criteria\n- SSO button shown\n- Error toast on failure\n- Remember me checkbox",
    url: "https://acme.atlassian.net/browse/ENG-12",
    status: "In Progress",
    acceptanceCriteria: ["SSO button shown", "Error toast on failure", "Remember me checkbox"]
};

function input(overrides: Partial<IntentCheckInput> = {}): IntentCheckInput {
    return {
        mergeRequest: {title: "ENG-12 Login with SSO", description: "Adds SSO."},
        diff: DIFF,
        changedFiles: ["src/login.tsx", "src/billing.ts", "test/login.test.tsx"],
        tickets: [ticket],
        ...overrides
    };
}

const goodVerdict: LlmIntent = {
    criteria: [
        {
            id: "C1",
            status: "covered",
            explanation: "The SSO button is added to the form.",
            evidence: [{file: "src/login.tsx", quote: '<SsoButton provider="google" />'}]
        },
        {
            id: "C2",
            status: "covered",
            explanation: "An error toast is rendered.",
            // Claimed in the wrong file: relocated to the file that really contains it.
            evidence: [{file: "src/billing.ts", quote: '{error && <Toast kind="error">{error}</Toast>}'}]
        },
        {id: "C3", status: "not_covered", explanation: "No remember-me checkbox in the diff.", evidence: []}
    ],
    unrequested_changes: [
        {
            file: "src/billing.ts",
            quote: "export const FEE_RATE = 0.03;",
            reason: "Changes the fee rate, unrelated to SSO."
        }
    ]
};

describe("diff helpers", () => {
    it("splits a git diff by file and locates quotes", () => {
        const sections = splitDiff(DIFF);
        expect(sections.map((section) => section.path)).toEqual([
            "src/login.tsx",
            "src/billing.ts",
            "test/login.test.tsx"
        ]);
        expect(locateQuote('<SsoButton provider="google" />', "src/login.tsx", sections)).toBe("src/login.tsx");
        expect(locateQuote("FEE_RATE = 0.03", "wrong.ts", sections)).toBe("src/billing.ts");
        // Multi-line quotes match once the +/- prefixes are removed.
        expect(locateQuote('<SsoButton provider="google" />\n{error &&', "src/login.tsx", sections)).toBe(
            "src/login.tsx"
        );
        expect(locateQuote("not in the diff at all", "src/login.tsx", sections)).toBeUndefined();
    });

    it("splits plain unified diffs", () => {
        const plain =
            "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n--- old sql comment\n+c";
        expect(splitDiff(plain).map((section) => section.path)).toEqual(["x.ts", "y.ts"]);
    });

    it("detects test files but not spec documents", () => {
        expect(isTestFile("src/a.test.ts")).toBe(true);
        expect(isTestFile("pkg/handler_test.go")).toBe(true);
        expect(isTestFile("tests/test_api.py")).toBe(true);
        expect(isTestFile("src/test/java/AppTest.java")).toBe(true);
        expect(isTestFile("docs/specs/login.md")).toBe(false);
        expect(isTestFile("src/app.ts")).toBe(false);
    });
});

describe("runIntentCheck — deterministic", () => {
    it("reports a missing ticket and suggests linking one, without calling the LLM", async () => {
        const llm = fakeLlm(goodVerdict);
        const result = await runIntentCheck(runtime({llm}), input({tickets: []}));
        expect(llm.requests).toHaveLength(0);
        expect(result.report.findings).toEqual([{code: "no_ticket", message: expect.any(String)}]);
        expect(result.report.analysis).toBe("no_ticket");
        expect(result.report.testsChanged).toBe(true);
        expect(result.actions).toHaveLength(1);
        const comment = result.actions[0];
        expect(comment).toMatchObject({type: "comment", marker: COMMENT_MARKER});
        expect(comment?.type === "comment" && comment.body).toContain("No ticket linked");
        expect(result.llmCalls).toBe(0);
    });

    it("lists criteria as not checked without an LLM and notes tickets without criteria", async () => {
        const bare: Ticket = {key: "ENG-13", title: "Tidy", description: "Just tidy up.", acceptanceCriteria: []};
        const result = await runIntentCheck(runtime(), input({tickets: [ticket, bare], changedFiles: ["src/a.ts"]}));
        expect(result.report.analysis).toBe("unavailable");
        expect(result.report.criteria.map((c) => c.status)).toEqual(["unchecked", "unchecked", "unchecked"]);
        expect(result.report.findings).toEqual([{code: "no_criteria", ticket: "ENG-13", message: expect.any(String)}]);
        expect(result.report.testsChanged).toBe(false);
        expect(result.report.verdict).toBeUndefined();
        expect(result.actions.map((action) => action.type)).toEqual(["comment"]);
        const body = result.actions[0]?.type === "comment" ? result.actions[0].body : "";
        expect(body).toContain("ENG-13 has no acceptance criteria.");
        expect(body).toContain("no LLM analysis is available");
        expect(body).toContain("no test file changed");
    });

    it("never sends code when sendCode is none, and skips the LLM without a diff", async () => {
        const llm = fakeLlm(goodVerdict);
        const none = await runIntentCheck(runtime({llm, sendCode: "none"}), input());
        expect(none.report.analysis).toBe("send_code_none");
        const noDiff = await runIntentCheck(runtime({llm}), input({diff: "  "}));
        expect(noDiff.report.analysis).toBe("no_diff");
        const fork = await runIntentCheck(
            runtime({llm, context: {provider: "test", repository: "acme/app", isFork: true}}),
            input()
        );
        expect(fork.report.analysis).toBe("unavailable");
        expect(llm.requests).toHaveLength(0);
    });
});

describe("runIntentCheck — LLM", () => {
    it("keeps verified evidence, relocates quotes and flags unrequested changes", async () => {
        const llm = fakeLlm(goodVerdict);
        const onLlmCall = vi.fn();
        const result = await runIntentCheck(runtime({llm, onLlmCall}), input({options: {fail_on_gaps: true}}));

        const request = llm.requests[0];
        expect(request?.system).toBe(SYSTEM_PROMPT);
        expect(request?.prompt).toContain("<diff>\ndiff --git a/src/login.tsx");
        expect(request?.prompt).toContain('<ticket key="ENG-12">');
        expect(request?.prompt).toContain("C3 [ENG-12]: Remember me checkbox");
        // Redacted before prompting.
        expect(request?.prompt).not.toContain("sk_live_abcdef");

        expect(result.report.analysis).toBe("llm");
        expect(result.report.criteria.map((c) => [c.id, c.status])).toEqual([
            ["C1", "covered"],
            ["C2", "covered"],
            ["C3", "not_covered"]
        ]);
        expect(result.report.criteria[1]?.evidence).toEqual([
            {kind: "diff", ref: "src/login.tsx", quote: '{error && <Toast kind="error">{error}</Toast>}'}
        ]);
        expect(result.report.unrequestedChanges).toEqual([
            {
                file: "src/billing.ts",
                quote: "export const FEE_RATE = 0.03;",
                reason: "Changes the fee rate, unrelated to SSO."
            }
        ]);
        expect(result.report.verdict).toBe("gaps");
        expect(result.llmCalls).toBe(1);
        expect(result.costUsd).toBe(0.002);
        expect(onLlmCall).toHaveBeenCalledWith(expect.objectContaining({agent: "intent", accepted: true}));
        expect(result.actions[1]).toEqual({
            type: "set_status",
            status: {state: "failure", context: "aicd/intent", description: "2/3 criteria covered, 1 not covered"},
            reason: expect.any(String)
        });
    });

    it("downgrades covered claims whose quotes are not in the diff and drops invented changes", async () => {
        const llm = fakeLlm({
            criteria: [
                {
                    id: "c1",
                    status: "covered",
                    explanation: "Invented.",
                    evidence: [{file: "src/login.tsx", quote: "<SsoButton provider='github' />"}]
                },
                {id: "C2", status: "covered", explanation: "No quote.", evidence: []},
                {id: "C9", status: "covered", explanation: "Unknown id.", evidence: []}
            ],
            unrequested_changes: [{file: "src/x.ts", quote: "deleteEverything()", reason: "Invented."}]
        });
        const result = await runIntentCheck(runtime({llm}), input());
        expect(result.report.criteria.map((c) => [c.status, c.downgraded])).toEqual([
            ["unclear", "no_verified_quote"],
            ["unclear", "no_verified_quote"],
            ["unclear", "missing_verdict"]
        ]);
        expect(result.report.unrequestedChanges).toEqual([]);
        expect(result.report.rejectedQuotes).toBe(2);
        expect(result.report.verdict).toBe("pass");
        // fail_on_gaps is off: success, only when a verdict exists.
        expect(result.actions[1]).toMatchObject({type: "set_status", status: {state: "success"}});
    });

    it("lowers not_covered to unclear when the diff was truncated", async () => {
        const llm = fakeLlm(goodVerdict);
        const result = await runIntentCheck(
            runtime({llm}),
            input({options: {max_diff_chars: 700, fail_on_gaps: true}})
        );
        expect(result.report.diffTruncated).toBe(true);
        expect(result.report.criteria[2]).toMatchObject({status: "unclear", downgraded: "diff_truncated"});
        expect(result.report.verdict).toBe("pass");
        expect(llm.requests[0]?.prompt).toContain("The diff was truncated");
    });

    it("falls back to the deterministic report when the LLM fails", async () => {
        const llm = fakeLlm(
            new LLMError("bad output", {model: "fake-model", inputTokens: 10, outputTokens: 1, costUsd: 0.001})
        );
        const result = await runIntentCheck(runtime({llm}), input());
        expect(result.report.analysis).toBe("failed");
        expect(result.report.criteria.every((c) => c.status === "unchecked")).toBe(true);
        expect(result.actions.map((action) => action.type)).toEqual(["comment"]);
        expect(result.llmCalls).toBe(1);
        expect(result.costUsd).toBe(0.001);
    });

    it("asks only for unrequested changes when tickets have no criteria, without a status", async () => {
        const llm = fakeLlm({criteria: [], unrequested_changes: []});
        const result = await runIntentCheck(
            runtime({llm}),
            input({tickets: [{key: "ENG-13", title: "Tidy", description: "", acceptanceCriteria: []}]})
        );
        expect(llm.requests[0]?.prompt).toContain("no explicit criteria");
        expect(result.report.analysis).toBe("llm");
        expect(result.report.verdict).toBeUndefined();
        expect(result.actions.map((action) => action.type)).toEqual(["comment"]);
    });
});

describe("renderIntentComment", () => {
    it("renders the table, unrequested changes and files in English and French", async () => {
        const result = await runIntentCheck(runtime({llm: fakeLlm(goodVerdict)}), input());
        const en = renderIntentComment(result.report, {language: "en", runId: "run_1"});
        expect(en.startsWith(COMMENT_MARKER)).toBe(true);
        expect(en).toContain(
            "**Tickets:** [ENG-12](https://acme.atlassian.net/browse/ENG-12) Login with SSO (In Progress)"
        );
        expect(en).toContain("**2/3 criteria covered**, 1 not covered.");
        expect(en).toContain("| # | Criterion | Status | Evidence |");
        expect(en).toContain(
            '| 1 | SSO button shown <sub>ENG-12</sub> | Covered | The SSO button is added to the form.<br>`src/login.tsx` `<SsoButton provider="google" />` |'
        );
        expect(en).toContain("| Not covered |");
        expect(en).toContain("**Changes no ticket asks for**");
        expect(en).toContain(
            "- `src/billing.ts` — Changes the fee rate, unrelated to SSO. `export const FEE_RATE = 0.03;`"
        );
        expect(en).toContain("**Tests:** 1 test file(s) changed.");
        expect(en).toContain("<summary>Changed files (3)</summary>");
        expect(en).toContain("Run `run_1`");

        const fr = renderIntentComment(result.report, {language: "fr", runId: "run_1"});
        expect(fr).toContain("### aicd · Conformité au ticket");
        expect(fr).toContain("**Tickets :**");
        expect(fr).toContain("**2/3 critère(s) couvert(s)**, 1 non couvert(s).");
        expect(fr).toContain("| # | Critère | Statut | Preuves |");
        expect(fr).toContain("| Couvert |");
        expect(fr).toContain("**Tests :** 1 fichier(s) de test modifié(s).");
        expect(fr).toContain("Changements qu'aucun ticket ne demande");
    });

    it("renders the no-ticket comment in French and escapes table cells", async () => {
        const noTicket = await runIntentCheck(runtime({language: "fr"}), input({tickets: []}));
        const body = noTicket.actions[0]?.type === "comment" ? noTicket.actions[0].body : "";
        expect(body).toContain("**Aucun ticket lié.**");
        expect(body).toContain("Exécution `run_intent`");

        const piped = await runIntentCheck(
            runtime(),
            input({tickets: [{...ticket, acceptanceCriteria: ["a | b\nnew line"]}], changedFiles: ["src/a.ts"]})
        );
        const text = piped.actions[0]?.type === "comment" ? piped.actions[0].body : "";
        // Without an LLM verdict the criteria become a checklist for the reviewer.
        expect(text).toContain("**Acceptance criteria to check by hand**\n\n- [ ] a | b new line <sub>ENG-12</sub>");
        expect(text).toContain("configure an LLM (`llm-api-key` input or `AICD_LLM_API_KEY`)");
        expect(text).toContain(
            "**Tests:** no test file changed. Check that existing tests cover the acceptance criteria"
        );

        const injected = await runIntentCheck(
            runtime(),
            input({tickets: [{...ticket, title: "<!-- aicd:intent --> x", acceptanceCriteria: ["<img src=x>"]}]})
        );
        const html = injected.actions[0]?.type === "comment" ? injected.actions[0].body : "";
        expect(html.split(COMMENT_MARKER)).toHaveLength(2);
        expect(html).toContain("&lt;img src=x>");
    });
});
