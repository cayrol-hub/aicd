import {describe, expect, it, vi} from "vitest";
import {notifierFactories, SlackNotifier, slackPayload, TeamsNotifier, WebhookNotifier} from "@aicd/adapter-notifiers";
import type {FactoryContext, Notification} from "@aicd/plugin-sdk";

const notification: Notification = {
    title: "Deployment paused",
    text: "Error rate *3x* the baseline",
    severity: "critical",
    url: "https://ci.example.com/pipelines/1",
    fields: {environment: "production", service: "api"}
};

function fakeFetch(status = 200, body = "ok") {
    return vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response(status === 204 ? null : body, {status})
    );
}

const sent = (fetchMock: ReturnType<typeof fakeFetch>) => {
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    return {url, init, body: JSON.parse(String(init?.body)) as Record<string, any>};
};

function context(env: NodeJS.ProcessEnv = {}, fetchImpl = fakeFetch()): FactoryContext {
    return {
        env,
        fetch: fetchImpl as unknown as typeof fetch,
        logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    };
}

describe("SlackNotifier", () => {
    it("posts Block Kit with header, text, fields and a link button", async () => {
        const fetchMock = fakeFetch();
        await new SlackNotifier({webhookUrl: "https://hooks.slack.test/x", fetch: fetchMock}).send(notification);
        const {url, init, body} = sent(fetchMock);
        expect(url).toBe("https://hooks.slack.test/x");
        expect(init?.method).toBe("POST");
        expect(body.text).toBe(":rotating_light: Deployment paused");
        expect(body.blocks.map((block: {type: string}) => block.type)).toEqual([
            "header",
            "section",
            "section",
            "actions"
        ]);
        expect(body.blocks[2].fields).toEqual([
            {type: "mrkdwn", text: "*environment*\nproduction"},
            {type: "mrkdwn", text: "*service*\napi"}
        ]);
        expect(body.blocks[3].elements[0]).toMatchObject({type: "button", url: notification.url});
    });

    it("splits fields by 10, skips the button without url, and truncates the header", () => {
        const fields = Object.fromEntries(Array.from({length: 12}, (_, i) => [`k${i}`, `v${i}`]));
        const payload = slackPayload({title: "x".repeat(200), text: "", severity: "info", fields}) as {
            blocks: Record<string, any>[];
        };
        expect(payload.blocks.map((block) => block.type)).toEqual(["header", "section", "section", "section"]);
        expect(payload.blocks[2]?.fields).toHaveLength(10);
        expect(payload.blocks[0]?.text.text.length).toBe(150);
        expect(payload.blocks[0]?.text.text.startsWith(":information_source:")).toBe(true);
    });

    it("throws a clear error on non-2xx, without the secret URL", async () => {
        const notifier = new SlackNotifier({
            webhookUrl: "https://hooks.slack.test/SECRET",
            fetch: fakeFetch(404, "no_service")
        });
        const error = (await notifier.send(notification).catch((e: unknown) => e)) as Error;
        expect(error.message).toBe("Slack notification failed: HTTP 404 no_service");
        expect(error.message).not.toContain("SECRET");
    });
});

describe("TeamsNotifier", () => {
    it("posts an Adaptive Card in a message attachment", async () => {
        const fetchMock = fakeFetch(202, "");
        await new TeamsNotifier({webhookUrl: "https://teams.test/hook", fetch: fetchMock}).send(notification);
        const {body} = sent(fetchMock);
        expect(body.type).toBe("message");
        const attachment = body.attachments[0];
        expect(attachment.contentType).toBe("application/vnd.microsoft.card.adaptive");
        expect(attachment.content).toMatchObject({type: "AdaptiveCard", version: "1.4"});
        expect(attachment.content.body[0]).toMatchObject({text: "Deployment paused", color: "Attention"});
        expect(attachment.content.body[2]).toEqual({
            type: "FactSet",
            facts: [
                {title: "environment", value: "production"},
                {title: "service", value: "api"}
            ]
        });
        expect(attachment.content.actions[0]).toMatchObject({type: "Action.OpenUrl", url: notification.url});
    });

    it("throws on non-2xx", async () => {
        const notifier = new TeamsNotifier({webhookUrl: "https://teams.test/hook", fetch: fakeFetch(500, "")});
        await expect(notifier.send(notification)).rejects.toThrow("Teams notification failed: HTTP 500");
    });
});

describe("WebhookNotifier", () => {
    it("posts the notification JSON with custom headers", async () => {
        const fetchMock = fakeFetch(204, "");
        await new WebhookNotifier({url: "https://hook.test", headers: {"X-Token": "t"}, fetch: fetchMock}).send(
            notification
        );
        const {init, body} = sent(fetchMock);
        expect(body).toEqual(notification);
        expect(init?.headers).toEqual({"Content-Type": "application/json", "X-Token": "t"});
    });
});

describe("notifierFactories", () => {
    const factory = (name: string) => notifierFactories.find((f) => f.name === name)!;

    it("provides slack, teams and webhook", () => {
        expect(notifierFactories.map((f) => f.name)).toEqual(["slack", "teams", "webhook"]);
    });

    it("reads the webhook URL from the env var named in webhook_url_env, and uses the context fetch", async () => {
        const fetchMock = fakeFetch();
        const notifier = factory("slack").create(
            {webhook_url_env: "SLACK_URL"},
            context({SLACK_URL: "https://hooks.slack.test/env"}, fetchMock)
        );
        expect(notifier.name).toBe("slack");
        await notifier.send(notification);
        expect(sent(fetchMock).url).toBe("https://hooks.slack.test/env");
    });

    it("accepts webhook_url or url", async () => {
        const fetchMock = fakeFetch();
        await factory("teams").create({webhook_url: "https://a.test"}, context({}, fetchMock)).send(notification);
        await factory("webhook").create({url: "https://b.test"}, context({}, fetchMock)).send(notification);
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["https://a.test", "https://b.test"]);
    });

    it("resolves webhook headers, secret ones from env", async () => {
        const fetchMock = fakeFetch();
        await factory("webhook")
            .create(
                {url: "https://b.test", headers: {"X-A": "1"}, headers_env: {Authorization: "HOOK_AUTH"}},
                context({HOOK_AUTH: "Bearer s"}, fetchMock)
            )
            .send(notification);
        expect(sent(fetchMock).init?.headers).toMatchObject({"X-A": "1", Authorization: "Bearer s"});
    });

    it("fails clearly when the URL is missing", () => {
        expect(() => factory("slack").create({}, context())).toThrow(
            'notifier "slack": set webhook_url_env (recommended), webhook_url or url'
        );
        expect(() => factory("slack").create({webhook_url_env: "MISSING"}, context())).toThrow(
            "env var MISSING (webhook_url_env) is not set"
        );
        expect(() => factory("webhook").create({url: "https://b.test", headers_env: {A: "NOPE"}}, context())).toThrow(
            "env var NOPE (headers_env.A) is not set"
        );
        expect(() => factory("webhook").create({url: "https://b.test", headers: ["x"]}, context())).toThrow(
            "headers must be a map"
        );
    });
});
