import type {Notification, Notifier} from "@aicd/plugin-sdk";

export interface WebhookTarget {
    webhookUrl: string;
    /** Injected in tests. Default: global fetch. */
    fetch?: typeof fetch;
}

const SEVERITY_EMOJI: Record<Notification["severity"], string> = {
    info: ":information_source:",
    warning: ":warning:",
    critical: ":rotating_light:"
};

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** POSTs a JSON payload; throws on non-2xx. The URL is never part of the error: webhook URLs are secrets. */
async function post(
    label: string,
    fetchImpl: typeof fetch,
    url: string,
    payload: unknown,
    headers: Record<string, string> = {}
): Promise<void> {
    const response = await fetchImpl(url, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...headers},
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const detail = truncate((await response.text().catch(() => "")).trim(), 200);
        throw new Error(`${label} notification failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
}

/** Slack message in Block Kit: header with a severity emoji, text, fields, and a link button. */
export function slackPayload(notification: Notification): Record<string, unknown> {
    const emoji = SEVERITY_EMOJI[notification.severity];
    const fields = Object.entries(notification.fields ?? {});
    const blocks: Record<string, unknown>[] = [
        {
            type: "header",
            text: {type: "plain_text", text: truncate(`${emoji} ${notification.title}`, 150), emoji: true}
        },
        {type: "section", text: {type: "mrkdwn", text: truncate(notification.text || " ", 3000)}}
    ];
    // Slack accepts at most 10 fields per section.
    for (let start = 0; start < fields.length; start += 10) {
        blocks.push({
            type: "section",
            fields: fields
                .slice(start, start + 10)
                .map(([name, value]) => ({type: "mrkdwn", text: truncate(`*${name}*\n${value}`, 2000)}))
        });
    }
    if (notification.url) {
        blocks.push({
            type: "actions",
            elements: [{type: "button", text: {type: "plain_text", text: "Open"}, url: notification.url}]
        });
    }
    // `text` is the fallback shown in notifications and to clients without Block Kit.
    return {text: truncate(`${emoji} ${notification.title}`, 3000), blocks};
}

/** Slack incoming webhook. */
export class SlackNotifier implements Notifier {
    readonly name = "slack";
    readonly #url: string;
    readonly #fetch: typeof fetch;

    constructor(options: WebhookTarget) {
        this.#url = options.webhookUrl;
        this.#fetch = options.fetch ?? fetch;
    }

    async send(notification: Notification): Promise<void> {
        await post("Slack", this.#fetch, this.#url, slackPayload(notification));
    }
}

const TEAMS_COLOR: Record<Notification["severity"], string> = {
    info: "Accent",
    warning: "Warning",
    critical: "Attention"
};

/** Teams message carrying one Adaptive Card. */
export function teamsPayload(notification: Notification): Record<string, unknown> {
    const fields = Object.entries(notification.fields ?? {});
    const body: Record<string, unknown>[] = [
        {
            type: "TextBlock",
            text: notification.title,
            weight: "Bolder",
            size: "Medium",
            color: TEAMS_COLOR[notification.severity],
            wrap: true
        },
        {type: "TextBlock", text: notification.text, wrap: true}
    ];
    if (fields.length > 0) {
        body.push({type: "FactSet", facts: fields.map(([title, value]) => ({title, value}))});
    }
    return {
        type: "message",
        attachments: [
            {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: {
                    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                    type: "AdaptiveCard",
                    version: "1.4",
                    body,
                    ...(notification.url
                        ? {actions: [{type: "Action.OpenUrl", title: "Open", url: notification.url}]}
                        : {})
                }
            }
        ]
    };
}

/** Microsoft Teams incoming webhook (Workflows or legacy connector), Adaptive Card format. */
export class TeamsNotifier implements Notifier {
    readonly name = "teams";
    readonly #url: string;
    readonly #fetch: typeof fetch;

    constructor(options: WebhookTarget) {
        this.#url = options.webhookUrl;
        this.#fetch = options.fetch ?? fetch;
    }

    async send(notification: Notification): Promise<void> {
        await post("Teams", this.#fetch, this.#url, teamsPayload(notification));
    }
}

export interface WebhookNotifierOptions {
    url: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
}

/** Generic webhook: POSTs the `Notification` as JSON. */
export class WebhookNotifier implements Notifier {
    readonly name = "webhook";
    readonly #options: WebhookNotifierOptions;
    readonly #fetch: typeof fetch;

    constructor(options: WebhookNotifierOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
    }

    async send(notification: Notification): Promise<void> {
        await post("Webhook", this.#fetch, this.#options.url, notification, this.#options.headers);
    }
}
