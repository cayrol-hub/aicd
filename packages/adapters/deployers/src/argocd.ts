import type {Deployer, DeploymentRef, DeploymentState} from "@aicd-ci/plugin-sdk";
import {assertTarget, matchesTarget, type DeployTarget} from "./guard.js";

export interface ArgoCDOptions {
    /** Base URL of the Argo CD server, e.g. `https://argocd.example.com`. */
    url: string;
    token: string;
    application: string;
    /** `application`: sync history and operations; `rollout`: Argo Rollouts actions through Argo CD. */
    mode: "application" | "rollout";
    /** Rollout mode: name of the Rollout resource. Default: the application name. */
    rolloutName?: string;
    /** Rollout mode: Kubernetes namespace of the Rollout (required). */
    namespace?: string;
    /** Namespace of the Argo CD Application itself, when apps live outside the control plane namespace. */
    appNamespace?: string;
    /** Environment this application serves; deployments of another environment are refused. */
    environment?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

interface ArgoApplication {
    status?: {
        health?: {status?: string};
        sync?: {status?: string; revision?: string};
        operationState?: {phase?: string};
        history?: {id: number; revision?: string; deployedAt?: string}[];
    };
}

interface RolloutManifest {
    spec?: {paused?: boolean};
    status?: {phase?: string; abort?: boolean; pauseConditions?: unknown[]};
}

const sameRevision = (a: string | undefined, b: string | undefined) =>
    !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));

/**
 * Argo CD. Application mode: state from the application (operation, health, sync), rollback to the previous
 * entry of the sync history, pause = terminate the running sync operation. Rollout mode: `pause` and `abort`
 * resource actions on an Argo Rollouts `Rollout` through Argo CD (abort returns traffic to the stable version).
 * Acting on a deployment of another application or environment is refused.
 */
export class ArgoCDDeployer implements Deployer {
    readonly name = "argocd";
    readonly #options: ArgoCDOptions;
    readonly #fetch: typeof fetch;
    readonly #target: DeployTarget;

    constructor(options: ArgoCDOptions) {
        if (!options.url || !options.token || !options.application) {
            throw new Error("argocd: url, token and application are required");
        }
        if (options.mode === "rollout" && !options.namespace) {
            throw new Error("argocd: namespace is required in rollout mode");
        }
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
        this.#target = {
            services: [...new Set([options.application, ...(options.rolloutName ? [options.rolloutName] : [])])],
            ...(options.environment !== undefined ? {environment: options.environment} : {})
        };
    }

    #appPath(suffix = ""): string {
        return `/api/v1/applications/${encodeURIComponent(this.#options.application)}${suffix}`;
    }

    async #request(method: string, path: string, query: Record<string, string> = {}, body?: unknown) {
        const url = new URL(`${this.#options.url.replace(/\/+$/, "")}${path}`);
        if (this.#options.appNamespace) url.searchParams.set("appNamespace", this.#options.appNamespace);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        const response = await this.#fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${this.#options.token}`,
                Accept: "application/json",
                ...(body !== undefined ? {"Content-Type": "application/json"} : {})
            },
            ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
            signal: AbortSignal.timeout(this.#options.timeoutMs ?? 15_000)
        });
        if (!response.ok) {
            let detail = "";
            try {
                const text = await response.text();
                detail = ((JSON.parse(text) as {message?: string}).message ?? text).slice(0, 200);
            } catch {
                // The status alone is enough.
            }
            throw new Error(`argocd ${method} ${url.pathname}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
        }
        return response;
    }

    async #application(): Promise<ArgoApplication> {
        return (await (await this.#request("GET", this.#appPath())).json()) as ArgoApplication;
    }

    #rolloutQuery(): Record<string, string> {
        return {
            namespace: this.#options.namespace ?? "",
            resourceName: this.#options.rolloutName ?? this.#options.application,
            kind: "Rollout",
            group: "argoproj.io",
            version: "v1alpha1"
        };
    }

    async #rolloutAction(action: "pause" | "abort"): Promise<void> {
        await this.#request("POST", this.#appPath("/resource/actions"), this.#rolloutQuery(), action);
    }

    /** Never throws for a deployment of another application: it is just not ours to judge ("unknown"). */
    async getState(deployment: DeploymentRef): Promise<DeploymentState> {
        if (!matchesTarget(this.#target, deployment)) return "unknown";
        return this.#options.mode === "rollout" ? this.#rolloutState() : this.#applicationState(deployment);
    }

    async #applicationState(deployment: DeploymentRef): Promise<DeploymentState> {
        const status = (await this.#application()).status ?? {};
        const current = status.sync?.revision;
        if (
            deployment.commitSha &&
            current &&
            !sameRevision(current, deployment.commitSha) &&
            (status.history ?? []).some((entry) => sameRevision(entry.revision, deployment.commitSha))
        ) {
            return "rolled_back";
        }
        const phase = status.operationState?.phase;
        if (phase === "Running" || phase === "Terminating") return "in_progress";
        if (phase === "Failed" || phase === "Error") return "failed";
        switch (status.health?.status) {
            case "Suspended":
                return "paused";
            case "Degraded":
            case "Missing":
                return "failed";
            case "Progressing":
                return "in_progress";
            case "Healthy":
                return status.sync?.status === "Synced" ? "success" : "unknown";
            default:
                return "unknown";
        }
    }

    async #rolloutState(): Promise<DeploymentState> {
        const response = await this.#request("GET", this.#appPath("/resource"), this.#rolloutQuery());
        const {manifest} = (await response.json()) as {manifest?: string};
        let rollout: RolloutManifest;
        try {
            rollout = JSON.parse(manifest ?? "{}") as RolloutManifest;
        } catch {
            return "unknown";
        }
        if (rollout.status?.abort) return "rolled_back";
        if (rollout.spec?.paused || (rollout.status?.pauseConditions?.length ?? 0) > 0) return "paused";
        switch (rollout.status?.phase) {
            case "Paused":
                return "paused";
            case "Degraded":
                return "failed";
            case "Progressing":
                return "in_progress";
            case "Healthy":
                return "success";
            default:
                return "unknown";
        }
    }

    /** Application mode: terminates the running sync. Rollout mode: `pause` action on the Rollout. */
    async pause(deployment: DeploymentRef): Promise<void> {
        assertTarget(this.name, this.#target, deployment);
        if (this.#options.mode === "rollout") return this.#rolloutAction("pause");
        const phase = (await this.#application()).status?.operationState?.phase;
        if (phase !== "Running") {
            throw new Error(
                `argocd: no running operation to terminate on ${this.#options.application} (phase: ${phase ?? "none"})`
            );
        }
        await this.#request("DELETE", this.#appPath("/operation"));
    }

    /**
     * Application mode: rolls back to the history entry deployed before this deployment (its `previousCommitSha`
     * when known), refusing when there is none. Rollout mode: `abort` action on the Rollout.
     */
    async rollback(deployment: DeploymentRef): Promise<void> {
        assertTarget(this.name, this.#target, deployment);
        if (this.#options.mode === "rollout") return this.#rolloutAction("abort");
        const history = [...((await this.#application()).status?.history ?? [])].sort((a, b) => a.id - b.id);
        let index = history.length - 1;
        if (deployment.commitSha) {
            index = history.findLastIndex((entry) => sameRevision(entry.revision, deployment.commitSha));
            if (index < 0) {
                throw new Error(
                    `argocd: revision ${deployment.commitSha} is not in the history of ${this.#options.application}, refusing to roll back`
                );
            }
        }
        const current = history[index];
        const earlier = history.slice(0, Math.max(0, index));
        const previous = deployment.previousCommitSha
            ? earlier.findLast((entry) => sameRevision(entry.revision, deployment.previousCommitSha))
            : earlier.findLast((entry) => !current || entry.revision !== current.revision);
        if (!previous) {
            throw new Error(`argocd: no previous history entry to roll back ${this.#options.application} to`);
        }
        await this.#request(
            "POST",
            this.#appPath("/rollback"),
            {},
            {
                name: this.#options.application,
                id: previous.id,
                prune: false,
                ...(this.#options.appNamespace ? {appNamespace: this.#options.appNamespace} : {})
            }
        );
    }
}
