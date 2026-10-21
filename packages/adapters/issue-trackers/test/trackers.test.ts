import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";
import {
    adfToText,
    extractAcceptanceCriteria,
    findTickets,
    GitHubIssuesTracker,
    JiraTracker,
    LinearTracker,
    MarkdownSpecTracker,
    textToAdf,
    trackerFactories,
    TrackerHttpError
} from "@aicd/adapter-issue-trackers";
import type {FactoryContext, IssueTracker, Ticket} from "@aicd/plugin-sdk";

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
}

/** A fake fetch answering from a route table; records every call. */
function fakeFetch(routes: Record<string, {status?: number; body?: unknown}>): typeof fetch & {calls: Call[]} {
    const calls: Call[] = [];
    const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        calls.push({
            url,
            method,
            headers: (init.headers ?? {}) as Record<string, string>,
            ...(init.body ? {body: JSON.parse(String(init.body))} : {})
        });
        const route = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
        if (!route) return new Response("not found", {status: 404});
        return new Response(JSON.stringify(route.body ?? {}), {status: route.status ?? 200});
    }) as typeof fetch & {calls: Call[]};
    fn.calls = calls;
    return fn;
}

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

describe("extractAcceptanceCriteria", () => {
    it("reads list items under a markdown heading and stops at the next heading", () => {
        const text = [
            "Some context.",
            "",
            "## Acceptance criteria",
            "- The button is disabled while saving",
            "* An error toast is shown on failure",
            "1. The form keeps its values",
            "  after a reload",
            "",
            "## Notes",
            "- not a criterion"
        ].join("\n");
        expect(extractAcceptanceCriteria(text)).toEqual([
            "The button is disabled while saving",
            "An error toast is shown on failure",
            "The form keeps its values after a reload"
        ]);
    });

    it("recognises French, bold and colon headings, with paragraphs", () => {
        const text = [
            "**Critères d'acceptation**",
            "- Le montant est affiché en F CFA",
            "",
            "Comportement attendu :",
            "Le bouton reste actif",
            "après une erreur.",
            "",
            "### Contexte",
            "Hors sujet."
        ].join("\n");
        expect(extractAcceptanceCriteria(text)).toEqual([
            "Le montant est affiché en F CFA",
            "Le bouton reste actif après une erreur."
        ]);
    });

    it("keeps checklist items anywhere and Gherkin scenarios together", () => {
        const text = [
            "Intro",
            "- [ ] Export as CSV",
            "- [x] Import from CSV",
            "",
            "```gherkin",
            "Scenario: Login with a valid password",
            "  Given a registered user",
            "  When they submit a valid password",
            "  Then they see the dashboard",
            "  And a welcome message",
            "```",
            "",
            "Scénario : Paiement refusé",
            "  Étant donné un solde insuffisant",
            "  Quand l'utilisateur paie",
            "  Alors le paiement est refusé"
        ].join("\n");
        expect(extractAcceptanceCriteria(text)).toEqual([
            "Export as CSV",
            "Import from CSV",
            "Scenario: Login with a valid password Given a registered user When they submit a valid password Then they see the dashboard And a welcome message",
            "Scénario : Paiement refusé Étant donné un solde insuffisant Quand l'utilisateur paie Alors le paiement est refusé"
        ]);
    });

    it("handles definition of done, AC and dedupes up to 30 items", () => {
        expect(
            extractAcceptanceCriteria("Definition of done:\n- tests pass\n- Tests pass\n\nAC\n- docs updated")
        ).toEqual(["tests pass", "docs updated"]);
        const many = ["# AC", ...Array.from({length: 40}, (_, i) => `- item ${i}`)].join("\n");
        expect(extractAcceptanceCriteria(many)).toHaveLength(30);
        expect(extractAcceptanceCriteria("")).toEqual([]);
        expect(extractAcceptanceCriteria("Just a description without criteria.")).toEqual([]);
    });
});

describe("ADF", () => {
    const doc = {
        type: "doc",
        version: 1,
        content: [
            {type: "paragraph", content: [{type: "text", text: "Users cannot pay."}]},
            {type: "heading", attrs: {level: 2}, content: [{type: "text", text: "Acceptance criteria"}]},
            {
                type: "bulletList",
                content: [
                    {
                        type: "listItem",
                        content: [
                            {
                                type: "paragraph",
                                content: [
                                    {type: "text", text: "Pay with "},
                                    {type: "text", text: "card", marks: [{type: "code"}]}
                                ]
                            },
                            {
                                type: "bulletList",
                                content: [
                                    {
                                        type: "listItem",
                                        content: [{type: "paragraph", content: [{type: "text", text: "3DS"}]}]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            {
                type: "orderedList",
                attrs: {order: 3},
                content: [{type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "Third"}]}]}]
            },
            {
                type: "taskList",
                content: [
                    {type: "taskItem", attrs: {state: "TODO"}, content: [{type: "text", text: "Refund works"}]},
                    {type: "taskItem", attrs: {state: "DONE"}, content: [{type: "text", text: "Receipt sent"}]}
                ]
            },
            {
                type: "paragraph",
                content: [
                    {type: "text", text: "Expected behaviour", marks: [{type: "strong"}]},
                    {type: "hardBreak"},
                    {type: "mention", attrs: {text: "@ana"}}
                ]
            },
            {type: "codeBlock", attrs: {language: "ts"}, content: [{type: "text", text: "pay()"}]},
            {type: "mediaSingle", content: [{type: "media", attrs: {id: "x"}}]}
        ]
    };

    it("converts ADF to text with headings, lists and checklists preserved", () => {
        expect(adfToText(doc)).toBe(
            [
                "Users cannot pay.",
                "",
                "## Acceptance criteria",
                "",
                "- Pay with `card`",
                "  - 3DS",
                "",
                "3. Third",
                "",
                "- [ ] Refund works",
                "- [x] Receipt sent",
                "",
                "**Expected behaviour**",
                "@ana",
                "",
                "```ts",
                "pay()",
                "```"
            ].join("\n")
        );
        expect(extractAcceptanceCriteria(adfToText(doc))).toEqual([
            "Pay with `card`",
            "3DS",
            "Third",
            "Refund works",
            "Receipt sent",
            "@ana"
        ]);
    });

    it("tolerates strings, null and malformed nodes", () => {
        expect(adfToText("plain")).toBe("plain");
        expect(adfToText(null)).toBe("");
        expect(adfToText({type: "doc", content: [{nope: true}, {type: "paragraph"}]})).toBe("");
    });

    it("builds ADF from markdown-like text", () => {
        expect(textToAdf("# Title\nline 1\nline 2\n\n- a\n- b\n1. c\n```sh\nnpm test\n```")).toEqual({
            type: "doc",
            version: 1,
            content: [
                {type: "heading", attrs: {level: 1}, content: [{type: "text", text: "Title"}]},
                {
                    type: "paragraph",
                    content: [{type: "text", text: "line 1"}, {type: "hardBreak"}, {type: "text", text: "line 2"}]
                },
                {
                    type: "bulletList",
                    content: [
                        {type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "a"}]}]},
                        {type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "b"}]}]}
                    ]
                },
                {
                    type: "orderedList",
                    content: [{type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "c"}]}]}]
                },
                {type: "codeBlock", attrs: {language: "sh"}, content: [{type: "text", text: "npm test"}]}
            ]
        });
    });
});

describe("JiraTracker", () => {
    const base = "https://acme.atlassian.net";

    it("extracts keys without false positives", () => {
        const jira = new JiraTracker({baseUrl: base, fetch: fakeFetch({})});
        expect(jira.extractKeys("feat/ENG-12-login fixes PAY-7, ENG-12 again; UTF-8 and SHA-256, GH-4")).toEqual([
            "ENG-12",
            "PAY-7"
        ]);
        expect(new JiraTracker({baseUrl: base, projectKeys: ["PAY"]}).extractKeys("ENG-1 PAY-2")).toEqual(["PAY-2"]);
    });

    it("reads an issue with basic auth and converts its description", async () => {
        const fetch = fakeFetch({
            [`GET ${base}/rest/api/3/issue/ENG-12`]: {
                body: {
                    key: "ENG-12",
                    fields: {
                        summary: "Login with SSO",
                        status: {name: "In Progress"},
                        labels: ["auth"],
                        description: {
                            type: "doc",
                            version: 1,
                            content: [
                                {type: "heading", attrs: {level: 3}, content: [{type: "text", text: "AC"}]},
                                {
                                    type: "bulletList",
                                    content: [
                                        {
                                            type: "listItem",
                                            content: [
                                                {type: "paragraph", content: [{type: "text", text: "SSO button shown"}]}
                                            ]
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        });
        const jira = new JiraTracker({baseUrl: `${base}/`, email: "a@b.c", apiToken: "tok", fetch});
        const ticket = await jira.getTicket("ENG-12");
        expect(ticket).toEqual({
            key: "ENG-12",
            title: "Login with SSO",
            description: "### AC\n\n- SSO button shown",
            url: `${base}/browse/ENG-12`,
            status: "In Progress",
            labels: ["auth"],
            acceptanceCriteria: ["SSO button shown"]
        });
        expect(fetch.calls[0]?.url).toBe(`${base}/rest/api/3/issue/ENG-12?fields=summary,description,status,labels`);
        expect(fetch.calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    });

    it("returns undefined on 404 and throws on other errors", async () => {
        const fetch = fakeFetch({[`GET ${base}/rest/api/3/issue/ENG-2`]: {status: 500}});
        const jira = new JiraTracker({baseUrl: base, bearerToken: "pat", fetch});
        expect(await jira.getTicket("ENG-1")).toBeUndefined();
        await expect(jira.getTicket("ENG-2")).rejects.toThrow(TrackerHttpError);
        expect(fetch.calls[0]?.headers.Authorization).toBe("Bearer pat");
    });

    it("creates an issue with an ADF description", async () => {
        const fetch = fakeFetch({[`POST ${base}/rest/api/3/issue`]: {status: 201, body: {id: "1", key: "OPS-9"}}});
        const jira = new JiraTracker({baseUrl: base, projectKey: "OPS", fetch});
        expect(await jira.createIssue({title: "Flaky test", body: "- a", labels: ["flaky test"]})).toEqual({
            key: "OPS-9",
            url: `${base}/browse/OPS-9`
        });
        expect(fetch.calls[0]?.body).toMatchObject({
            fields: {
                project: {key: "OPS"},
                issuetype: {name: "Task"},
                summary: "Flaky test",
                labels: ["flaky-test"],
                description: {type: "doc", version: 1, content: [{type: "bulletList"}]}
            }
        });
        await expect(new JiraTracker({baseUrl: base, fetch}).createIssue({title: "x", body: ""})).rejects.toThrow(
            /project_key/
        );
    });
});

describe("GitHubIssuesTracker", () => {
    const api = "https://api.github.com";

    it("extracts and normalises keys", () => {
        const github = new GitHubIssuesTracker({repository: "acme/app", token: "t", fetch: fakeFetch({})});
        expect(
            github.extractKeys(
                "Fixes #12, other/lib#3, GH-4, https://github.com/acme/web/issues/5, page#anchor and &#39;"
            )
        ).toEqual(["acme/web#5", "other/lib#3", "acme/app#12", "acme/app#4"]);
        expect(new GitHubIssuesTracker({}).extractKeys("Fixes #12")).toEqual([]);
        expect(() => new GitHubIssuesTracker({repository: "nope"})).toThrow(/owner\/repo/);
    });

    it("reads issues, skips pull requests and 404s", async () => {
        const fetch = fakeFetch({
            [`GET ${api}/repos/acme/app/issues/12`]: {
                body: {
                    number: 12,
                    title: "Export",
                    body: "### Expected behavior\nA CSV file is downloaded.",
                    html_url: "https://github.com/acme/app/issues/12",
                    state: "open",
                    labels: [{name: "feature"}, "ux"]
                }
            },
            [`GET ${api}/repos/acme/app/issues/13`]: {body: {number: 13, title: "PR", pull_request: {}}}
        });
        const github = new GitHubIssuesTracker({repository: "acme/app", token: "t", fetch});
        expect(await github.getTicket("#12")).toEqual({
            key: "acme/app#12",
            title: "Export",
            description: "### Expected behavior\nA CSV file is downloaded.",
            url: "https://github.com/acme/app/issues/12",
            status: "open",
            labels: ["feature", "ux"],
            acceptanceCriteria: ["A CSV file is downloaded."]
        });
        expect(fetch.calls[0]?.headers.Authorization).toBe("Bearer t");
        expect(await github.getTicket("GH-13")).toBeUndefined();
        expect(await github.getTicket("acme/app#99")).toBeUndefined();
        expect(await github.getTicket("garbage")).toBeUndefined();
    });

    it("creates issues", async () => {
        const fetch = fakeFetch({
            [`POST https://ghe.local/api/v3/repos/acme/app/issues`]: {
                status: 201,
                body: {number: 7, html_url: "https://ghe.local/acme/app/issues/7"}
            }
        });
        const github = new GitHubIssuesTracker({repository: "acme/app", apiUrl: "https://ghe.local/api/v3/", fetch});
        expect(await github.createIssue({title: "T", body: "B", labels: ["aicd"]})).toEqual({
            key: "acme/app#7",
            url: "https://ghe.local/acme/app/issues/7"
        });
        expect(fetch.calls[0]?.body).toEqual({title: "T", body: "B", labels: ["aicd"]});
    });
});

describe("LinearTracker", () => {
    const url = "https://api.linear.app/graphql";

    it("reads an issue through GraphQL", async () => {
        const fetch = fakeFetch({
            [`POST ${url}`]: {
                body: {
                    data: {
                        issue: {
                            identifier: "ENG-5",
                            title: "Dark mode",
                            description: "## Acceptance Criteria\n- [ ] Toggle in settings",
                            url: "https://linear.app/acme/issue/ENG-5",
                            state: {name: "Todo"},
                            labels: {nodes: [{name: "ui"}]}
                        }
                    }
                }
            }
        });
        const linear = new LinearTracker({apiKey: "lin_api_x", fetch});
        expect(linear.extractKeys("branch eng-5 ENG-5")).toEqual(["ENG-5"]);
        expect(await linear.getTicket("ENG-5")).toEqual({
            key: "ENG-5",
            title: "Dark mode",
            description: "## Acceptance Criteria\n- [ ] Toggle in settings",
            url: "https://linear.app/acme/issue/ENG-5",
            status: "Todo",
            labels: ["ui"],
            acceptanceCriteria: ["Toggle in settings"]
        });
        expect(fetch.calls[0]?.headers.Authorization).toBe("lin_api_x");
        expect(fetch.calls[0]?.body).toMatchObject({variables: {id: "ENG-5"}});
    });

    it("maps a not-found error to undefined and throws on other GraphQL errors", async () => {
        const notFound = fakeFetch({
            [`POST ${url}`]: {body: {errors: [{message: "Entity not found: Issue"}], data: null}}
        });
        expect(await new LinearTracker({apiKey: "k", fetch: notFound}).getTicket("ENG-404")).toBeUndefined();
        const broken = fakeFetch({[`POST ${url}`]: {body: {errors: [{message: "Authentication required"}]}}});
        await expect(new LinearTracker({apiKey: "k", fetch: broken}).getTicket("ENG-1")).rejects.toThrow(
            /Authentication required/
        );
    });

    it("creates issues in the configured team", async () => {
        const fetch = fakeFetch({
            [`POST ${url}`]: {
                body: {data: {issueCreate: {success: true, issue: {identifier: "ENG-6", url: "https://linear.app/x"}}}}
            }
        });
        expect(
            await new LinearTracker({apiKey: "k", teamId: "team-1", fetch}).createIssue({title: "T", body: "B"})
        ).toEqual({key: "ENG-6", url: "https://linear.app/x"});
        expect(fetch.calls[0]?.body).toMatchObject({
            variables: {input: {teamId: "team-1", title: "T", description: "B"}}
        });
        await expect(new LinearTracker({apiKey: "k", fetch}).createIssue({title: "T", body: "B"})).rejects.toThrow(
            /team_id/
        );
    });
});

describe("MarkdownSpecTracker", () => {
    function repo(): string {
        const cwd = mkdtempSync(join(tmpdir(), "aicd-specs-"));
        mkdirSync(join(cwd, "docs/specs"), {recursive: true});
        writeFileSync(
            join(cwd, "docs/specs/login.md"),
            "# Login\n\n## Acceptance criteria\n- Email and password are required\n"
        );
        writeFileSync(join(cwd, "secret.md"), "# Secret");
        return cwd;
    }

    it("extracts spec paths and spec: references", () => {
        const tracker = new MarkdownSpecTracker({cwd: "/repo"});
        expect(
            tracker.extractKeys(
                "Implements docs/specs/login.md and ./specs/pay.md, see spec:billing/refunds. not other/docs/specs/x.md"
            )
        ).toEqual(["docs/specs/login.md", "specs/pay.md", "spec:billing/refunds"]);
    });

    it("reads a spec file and refuses paths outside the roots", async () => {
        const cwd = repo();
        const tracker = new MarkdownSpecTracker({cwd});
        expect(await tracker.getTicket("docs/specs/login.md")).toEqual({
            key: "docs/specs/login.md",
            title: "Login",
            description: "# Login\n\n## Acceptance criteria\n- Email and password are required\n",
            url: "docs/specs/login.md",
            labels: [],
            acceptanceCriteria: ["Email and password are required"]
        });
        expect((await tracker.getTicket("spec:login"))?.title).toBe("Login");
        expect(await tracker.getTicket("spec:missing")).toBeUndefined();
        expect(await tracker.getTicket("docs/specs/../../secret.md")).toBeUndefined();
        expect(await tracker.getTicket("spec:../../secret")).toBeUndefined();
        await expect(tracker.createIssue()).rejects.toThrow(/not supported/);
    });
});

describe("trackerFactories", () => {
    const context = (env: NodeJS.ProcessEnv): FactoryContext => ({env, fetch: fakeFetch({}), logger});
    const factory = (name: string) => trackerFactories.find((f) => f.name === name)!;

    it("provides the four trackers", () => {
        expect(trackerFactories.map((f) => f.name)).toEqual(["jira", "github", "linear", "markdown"]);
    });

    it("reads secrets from the environment variables named in the config", async () => {
        const fetch = fakeFetch({
            "GET https://acme.atlassian.net/rest/api/3/issue/ENG-1": {body: {key: "ENG-1", fields: {}}}
        });
        const jira = factory("jira").create(
            {base_url: "https://acme.atlassian.net", email: "a@b.c", api_token_env: "MY_JIRA"},
            {...context({MY_JIRA: "secret"}), fetch}
        );
        await jira.getTicket("ENG-1");
        expect(fetch.calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from("a@b.c:secret").toString("base64")}`);
        expect(
            factory("github")
                .create({}, context({GITHUB_REPOSITORY: "acme/app"}))
                .extractKeys("#1")
        ).toEqual(["acme/app#1"]);
        expect(factory("linear").create({api_key_env: "LIN"}, context({LIN: "k"})).name).toBe("linear");
        expect(
            factory("markdown")
                .create({roots: ["rfcs"]}, context({}))
                .extractKeys("rfcs/a.md")
        ).toEqual(["rfcs/a.md"]);
    });

    it("refuses secrets written in the config and missing required values", () => {
        expect(() => factory("jira").create({base_url: "https://x", api_token: "plain"}, context({}))).toThrow(
            /api_token_env/
        );
        expect(() => factory("github").create({token: "plain"}, context({}))).toThrow(/token_env/);
        expect(() => factory("jira").create({}, context({}))).toThrow(/base_url/);
        expect(() => factory("linear").create({}, context({}))).toThrow(/LINEAR_API_KEY/);
    });
});

describe("findTickets", () => {
    function tracker(name: string, tickets: Record<string, Ticket | Error>): IssueTracker & {gets: string[]} {
        const gets: string[] = [];
        return {
            name,
            gets,
            extractKeys: (text) => [...text.matchAll(/[A-Z]+-\d+/g)].map((m) => m[0]),
            async getTicket(key) {
                gets.push(key);
                const value = tickets[key];
                if (value instanceof Error) throw value;
                return value;
            },
            async createIssue() {
                return {key: "x"};
            }
        };
    }
    const ticket = (key: string): Ticket => ({key, title: key, description: "", acceptanceCriteria: []});

    it("dedupes keys and tickets, ignores 404s and logs other errors", async () => {
        const warn = vi.fn();
        const a = tracker("a", {
            "ENG-1": ticket("ENG-1"),
            "ENG-2": new TrackerHttpError("a", 404, "missing"),
            "ENG-3": new Error("boom")
        });
        const b = tracker("b", {"ENG-1": ticket("ENG-1")});
        const tickets = await findTickets([a, b], ["ENG-1 title", "ENG-1 ENG-2 ENG-3", ""], {
            logger: {...logger, warn}
        });
        expect(tickets.map((t) => t.key)).toEqual(["ENG-1"]);
        expect(a.gets).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/ENG-3: boom/);
    });

    it("returns nothing without keys and respects the limit", async () => {
        expect(await findTickets([tracker("a", {})], ["no key here"])).toEqual([]);
        const many = tracker("a", {});
        await findTickets([many], ["A-1 A-2 A-3"], {limit: 2});
        expect(many.gets).toEqual(["A-1", "A-2"]);
    });
});
