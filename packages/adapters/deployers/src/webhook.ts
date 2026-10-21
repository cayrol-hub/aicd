import {createHmac} from "node:crypto";
import type {Deployer, DeploymentRef, DeploymentState} from "@aicd/plugin-sdk";
import {assertTarget, matchesTarget, type DeployTarget} from "./guard.js";

export interface WebhookDeployerOptions {
    url: string;
    /** Header carrying `sha256=<hex HMAC of the raw body>`. Default: `X-Aicd-Signature`. */
    secretHeader?: string;
    /** HMAC-SHA256 key. Without it the request is sent unsigned. */
    secret?: string;
    /** Environment this webhook drives; deployments of another environment are refused. */
    environment?: string;
    /** Services this webhook drives; a deployment naming another service is refused. */
    services?: string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Injected in tests. */
    now?: () => Date;
}

const STATES: readonly DeploymentState[] = ["in_progress", "success", "failed", "paused", "rolled_back", "unknown"];

/** HMAC-SHA256 of the raw body, as sent in the signature header. */
export function signBody(body: string, secret: string): string {
    return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Generic deployer: POSTs `{action, deployment, sentAt}` (action `pause`, `rollback` or `state`) to a URL you own,
 * signed with HMAC-SHA256 so the receiver can authenticate it (and reject old `sentAt` values to stop replays).
 * For `state`, the receiver answers `{"state": "<DeploymentState>"}`; anything else reads as `unknown`.
 */
export class WebhookDeployer implements Deployer {
    readonly name = "webhook";
    readonly #options: WebhookDeployerOptions;
    readonly #fetch: typeof fetch;
    readonly #target: DeployTarget | undefined;

    constructor(options: WebhookDeployerOptions) {
        if (!options.url) throw new Error("webhook deployer: url is required");
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
        // Without any configured target the receiver is trusted to check the deployment itself.
        this.#target =
            options.environment !== undefined || (options.services?.length ?? 0) > 0
                ? {
                      services: options.services ?? [],
                      ...(options.environment !== undefined ? {environment: options.environment} : {})
                  }
                : undefined;
    }

    #check(deployment: DeploymentRef): void {
        if (this.#target) assertTarget(this.name, this.#target, deployment);
    }

    async #post(action: "pause" | "rollback" | "state", deployment: DeploymentRef): Promise<Response> {
        const body = JSON.stringify({
            action,
            deployment,
            sentAt: (this.#options.now ?? (() => new Date()))().toISOString()
        });
        const headers: Record<string, string> = {"Content-Type": "application/json"};
        if (this.#options.secret) {
            headers[this.#options.secretHeader ?? "X-Aicd-Signature"] = signBody(body, this.#options.secret);
        }
        const response = await this.#fetch(this.#options.url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000)
        });
        if (!response.ok) throw new Error(`webhook deployer ${action}: HTTP ${response.status}`);
        return response;
    }

    async getState(deployment: DeploymentRef): Promise<DeploymentState> {
        if (this.#target && !matchesTarget(this.#target, deployment)) return "unknown";
        const response = await this.#post("state", deployment);
        try {
            const {state} = (await response.json()) as {state?: string};
            return STATES.includes(state as DeploymentState) ? (state as DeploymentState) : "unknown";
        } catch {
            return "unknown";
        }
    }

    async pause(deployment: DeploymentRef): Promise<void> {
        this.#check(deployment);
        await this.#post("pause", deployment);
    }

    async rollback(deployment: DeploymentRef): Promise<void> {
        this.#check(deployment);
        await this.#post("rollback", deployment);
    }
}
