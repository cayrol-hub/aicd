import {createHmac} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {ArgoCDDeployer, deployerFactories, signBody, WebhookDeployer} from "@aicd-ci/adapter-deployers";
import type {DeploymentRef} from "@aicd-ci/plugin-sdk";

const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};

type Handler = (url: URL, init: RequestInit) => Response;

function fakeFetch(handlers: Handler[]) {
    const calls: {url: URL; init: RequestInit}[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({url, init});
        const handler = handlers.shift();
        if (!handler) throw new Error(`unexpected call ${init.method} ${url}`);
        return handler(url, init);
    });
    return {fetch: fn as unknown as typeof fetch, calls};
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});

const deployment: DeploymentRef = {
    id: "dep-42",
    environment: "production",
    service: "shop",
    commitSha: "cccccccccccc",
    startedAt: "2026-10-21T10:00:00Z"
};

const application = (overrides: Record<string, unknown> = {}) => ({
    status: {
        health: {status: "Healthy"},
        sync: {status: "Synced", revision: "cccccccccccc"},
        history: [
            {id: 3, revision: "aaaaaaaaaaaa"},
            {id: 4, revision: "bbbbbbbbbbbb"},
            {id: 5, revision: "cccccccccccc"}
        ],
        ...overrides
    }
});

function argo(
    fetchFn: typeof globalThis.fetch,
    overrides: Partial<ConstructorParameters<typeof ArgoCDDeployer>[0]> = {}
) {
    return new ArgoCDDeployer({
        url: "https://argocd.example/",
        token: "tok",
        application: "shop",
        mode: "application",
        environment: "production",
        fetch: fetchFn,
        ...overrides
    });
}

describe("ArgoCDDeployer, application mode", () => {
    it("maps the application status to a deployment state", async () => {
        const cases: [Record<string, unknown>, string][] = [
            [{}, "success"],
            [{operationState: {phase: "Running"}}, "in_progress"],
            [{operationState: {phase: "Failed"}}, "failed"],
            [{health: {status: "Degraded"}}, "failed"],
            [{health: {status: "Suspended"}}, "paused"],
            [{sync: {status: "Synced", revision: "bbbbbbbbbbbb"}}, "rolled_back"],
            [{health: {status: "Healthy"}, sync: {status: "OutOfSync", revision: "cccccccccccc"}}, "unknown"]
        ];
        for (const [status, expected] of cases) {
            const {fetch, calls} = fakeFetch([() => json(application(status))]);
            expect(await argo(fetch).getState(deployment)).toBe(expected);
            expect(calls[0]!.url.pathname).toBe("/api/v1/applications/shop");
            expect(calls[0]!.init.headers).toMatchObject({Authorization: "Bearer tok"});
        }
    });

    it("rolls back to the previous history entry", async () => {
        const {fetch, calls} = fakeFetch([() => json(application()), () => json({})]);
        await argo(fetch).rollback(deployment);
        expect(calls[1]!.init.method).toBe("POST");
        expect(calls[1]!.url.pathname).toBe("/api/v1/applications/shop/rollback");
        expect(JSON.parse(String(calls[1]!.init.body))).toEqual({name: "shop", id: 4, prune: false});
    });

    it("rolls back to the previous commit when the deployment knows it", async () => {
        const {fetch, calls} = fakeFetch([() => json(application()), () => json({})]);
        await argo(fetch).rollback({...deployment, previousCommitSha: "aaaaaaa"});
        expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({id: 3});
    });

    it("refuses to roll back without a previous entry or when the revision is unknown", async () => {
        const single = application({history: [{id: 5, revision: "cccccccccccc"}]});
        const first = fakeFetch([() => json(single)]);
        await expect(argo(first.fetch).rollback(deployment)).rejects.toThrow(/no previous history/);
        expect(first.calls).toHaveLength(1);
        const other = fakeFetch([() => json(application())]);
        await expect(argo(other.fetch).rollback({...deployment, commitSha: "dddddddddd"})).rejects.toThrow(
            /not in the history/
        );
    });

    it("pauses by terminating the running operation, and only then", async () => {
        const running = fakeFetch([() => json(application({operationState: {phase: "Running"}})), () => json({})]);
        await argo(running.fetch).pause(deployment);
        expect(running.calls[1]!.init.method).toBe("DELETE");
        expect(running.calls[1]!.url.pathname).toBe("/api/v1/applications/shop/operation");
        const idle = fakeFetch([() => json(application({operationState: {phase: "Succeeded"}}))]);
        await expect(argo(idle.fetch).pause(deployment)).rejects.toThrow(/no running operation/);
    });

    it("refuses deployments of another environment or service, without calling Argo CD", async () => {
        const {fetch, calls} = fakeFetch([]);
        await expect(argo(fetch).rollback({...deployment, environment: "staging"})).rejects.toThrow(/environment/);
        await expect(argo(fetch).pause({...deployment, service: "billing"})).rejects.toThrow(/service "billing"/);
        await expect(
            argo(fetch, {environment: undefined}).rollback({...deployment, service: undefined})
        ).rejects.toThrow(/cannot tell/);
        expect(await argo(fetch).getState({...deployment, environment: "staging"})).toBe("unknown");
        expect(calls).toHaveLength(0);
    });

    it("reports Argo CD errors with their message", async () => {
        const {fetch} = fakeFetch([() => json({message: "permission denied"}, 403)]);
        await expect(argo(fetch).getState(deployment)).rejects.toThrow(/HTTP 403 \(permission denied\)/);
    });
});

describe("ArgoCDDeployer, rollout mode", () => {
    const rollout = (fetchFn: typeof globalThis.fetch) =>
        argo(fetchFn, {mode: "rollout", namespace: "shop-prod", rolloutName: "shop-web", appNamespace: "argocd-apps"});

    it("runs pause and abort resource actions on the Rollout", async () => {
        const {fetch, calls} = fakeFetch([() => json({}), () => json({})]);
        await rollout(fetch).pause({...deployment, service: "shop-web"});
        await rollout(fetch).rollback(deployment);
        for (const [index, action] of ["pause", "abort"].entries()) {
            const call = calls[index]!;
            expect(call.url.pathname).toBe("/api/v1/applications/shop/resource/actions");
            expect(Object.fromEntries(call.url.searchParams)).toEqual({
                appNamespace: "argocd-apps",
                namespace: "shop-prod",
                resourceName: "shop-web",
                kind: "Rollout",
                group: "argoproj.io",
                version: "v1alpha1"
            });
            expect(JSON.parse(String(call.init.body))).toBe(action);
        }
    });

    it("reads the Rollout state from its manifest", async () => {
        const manifest = (value: unknown) => () => json({manifest: JSON.stringify(value)});
        const {fetch} = fakeFetch([
            manifest({status: {phase: "Healthy"}}),
            manifest({status: {phase: "Progressing", pauseConditions: [{reason: "CanaryPauseStep"}]}}),
            manifest({status: {phase: "Degraded", abort: true}}),
            () => json({manifest: "not json"})
        ]);
        const deployer = rollout(fetch);
        expect(await deployer.getState(deployment)).toBe("success");
        expect(await deployer.getState(deployment)).toBe("paused");
        expect(await deployer.getState(deployment)).toBe("rolled_back");
        expect(await deployer.getState(deployment)).toBe("unknown");
    });

    it("requires a namespace", () => {
        expect(() => argo(vi.fn() as unknown as typeof fetch, {mode: "rollout"})).toThrow(/namespace/);
    });
});

describe("WebhookDeployer", () => {
    it("posts the action signed with HMAC-SHA256", async () => {
        const {fetch, calls} = fakeFetch([() => json({})]);
        const deployer = new WebhookDeployer({
            url: "https://deploy.example/hook",
            secret: "s3cret",
            secretHeader: "X-Signature",
            environment: "production",
            fetch,
            now: () => new Date("2026-10-21T10:20:00Z")
        });
        await deployer.rollback(deployment);
        const body = String(calls[0]!.init.body);
        expect(JSON.parse(body)).toEqual({action: "rollback", deployment, sentAt: "2026-10-21T10:20:00.000Z"});
        const expected = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
        expect(calls[0]!.init.headers).toMatchObject({"X-Signature": expected});
        expect(signBody(body, "s3cret")).toBe(expected);
    });

    it("reads the state answered by the receiver", async () => {
        const {fetch} = fakeFetch([
            () => json({state: "paused"}),
            () => json({state: "weird"}),
            () => new Response("x")
        ]);
        const deployer = new WebhookDeployer({url: "https://deploy.example/hook", environment: "production", fetch});
        expect(await deployer.getState(deployment)).toBe("paused");
        expect(await deployer.getState(deployment)).toBe("unknown");
        expect(await deployer.getState(deployment)).toBe("unknown");
    });

    it("refuses a deployment of another environment or service and surfaces HTTP errors", async () => {
        const {fetch, calls} = fakeFetch([() => new Response("", {status: 500})]);
        const deployer = new WebhookDeployer({
            url: "https://deploy.example/hook",
            environment: "production",
            services: ["shop"],
            fetch
        });
        await expect(deployer.pause({...deployment, environment: "staging"})).rejects.toThrow(/environment/);
        await expect(deployer.pause({...deployment, service: "billing"})).rejects.toThrow(/billing/);
        expect(calls).toHaveLength(0);
        await expect(deployer.pause(deployment)).rejects.toThrow(/HTTP 500/);
    });
});

describe("deployerFactories", () => {
    const factory = (name: string) => deployerFactories.find((f) => f.name === name)!;

    it("builds an Argo CD deployer with the token from the environment", async () => {
        const {fetch, calls} = fakeFetch([() => json(application())]);
        const deployer = factory("argocd").create(
            {url: "https://argocd.example", application: "shop", environment: "production", token_env: "ARGO_TOKEN"},
            {env: {ARGO_TOKEN: "from-env"}, fetch, logger}
        );
        expect(await deployer.getState(deployment)).toBe("success");
        expect(calls[0]!.init.headers).toMatchObject({Authorization: "Bearer from-env"});
    });

    it("refuses an invalid configuration", () => {
        const context = {env: {}, fetch: vi.fn() as unknown as typeof fetch, logger};
        expect(() => factory("argocd").create({url: "https://a", application: "x"}, context)).toThrow(
            /ARGOCD_AUTH_TOKEN/
        );
        expect(() =>
            factory("argocd").create(
                {url: "https://a", application: "x", mode: "canary"},
                {
                    ...context,
                    env: {ARGOCD_AUTH_TOKEN: "t"}
                }
            )
        ).toThrow(/mode/);
        expect(() => factory("webhook").create({url: "https://h", secret_env: "HOOK_SECRET"}, context)).toThrow(
            /HOOK_SECRET/
        );
        expect(factory("webhook").create({url: "https://h"}, context).name).toBe("webhook");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/not signed/));
    });
});
