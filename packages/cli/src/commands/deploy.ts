import {guardDeployment} from "@aicd/agent-release-guardian";
import {deploymentCommits, previousDeployment, recordDeployment} from "@aicd/metrics";
import {COLLECTIONS, type DeploymentRecord, type DeploymentState, type StateStore} from "@aicd/plugin-sdk";
import {EXIT, type GlobalOptions} from "../shared.js";
import {conclude, report} from "../outcome.js";
import {Session} from "../session.js";

export interface DeployRecordOptions extends GlobalOptions {
    ci?: string;
    id?: string;
    env: string;
    status: DeploymentState;
    sha?: string;
    service?: string;
    releaseVersion?: string;
    url?: string;
    startedAt?: string;
    rollbackOf?: string;
}

/**
 * Records a deployment (and the commits it ships) for DORA metrics, the release guardian and
 * post-mortems. Call it at the start (`in_progress`) and at the end (`success` / `failed`) of a deploy job.
 */
export async function recordDeploymentFrom(
    state: StateStore,
    input: Omit<DeployRecordOptions, keyof GlobalOptions | "ci"> & {cwd: string; source: string},
    now: Date = new Date()
): Promise<DeploymentRecord> {
    const id = input.id ?? `${input.env}-${input.sha?.slice(0, 12) ?? now.getTime()}`;
    const existing = await state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, id);
    const startedAt = input.startedAt ?? existing?.value.startedAt ?? now.toISOString();
    let commits = existing?.value.commits?.length ? existing.value.commits : undefined;
    let previousCommitSha = existing?.value.previousCommitSha;
    if (!commits && input.sha) {
        const previous = await previousDeployment(state, input.env, startedAt);
        previousCommitSha = previous?.commitSha;
        const found = await deploymentCommits({
            ...(previous?.commitSha ? {fromSha: previous.commitSha} : {}),
            toSha: input.sha,
            cwd: input.cwd
        });
        // No checkout (server mode): leave commits unknown rather than record an empty list.
        commits = found.length > 0 ? found : undefined;
    }
    // A redelivered "success" never undoes what the guardian did.
    const previousStatus = existing?.value.status;
    const status: DeploymentState =
        previousStatus === "rolled_back" || previousStatus === "paused" ? previousStatus : input.status;
    const finished = status === "success" || status === "failed" || status === "rolled_back";
    return recordDeployment(state, {
        id,
        environment: input.env,
        status,
        startedAt,
        source: input.source,
        ...(input.sha ? {commitSha: input.sha} : {}),
        ...(previousCommitSha ? {previousCommitSha} : {}),
        ...(input.service ? {service: input.service} : {}),
        ...(input.releaseVersion ? {version: input.releaseVersion} : {}),
        ...(input.url ? {url: input.url} : {}),
        ...(input.rollbackOf ? {rollbackOf: input.rollbackOf} : {}),
        ...(commits ? {commits} : {}),
        ...(finished ? {finishedAt: now.toISOString()} : {})
    });
}

/** `aicd deploy record`. */
export async function deployRecord(options: DeployRecordOptions): Promise<number> {
    const session = await Session.open({...options, noLlm: true});
    try {
        const record = await recordDeploymentFrom(session.state, {
            ...options,
            sha: options.sha ?? session.context.commitSha,
            cwd: session.cwd,
            source: session.ci.name
        });
        session.logger.info(
            `deployment ${record.id} (${record.environment}) recorded as ${record.status}, ${record.commits?.length ?? 0} commit(s)`
        );
        if (options.json) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        return EXIT.ok;
    } finally {
        await session.close();
    }
}

/**
 * Watches a deployment and pauses or rolls it back when it degrades (autonomy per environment).
 * Shared by `aicd guard` and the server's deployment handler.
 */
export async function guard(
    session: Session,
    deployment: DeploymentRecord,
    options: {dryRun?: boolean; json?: boolean} = {}
): Promise<number> {
    const g = session.config.agents.release_guardian;
    if (!g.enabled) {
        session.logger.info("release guardian disabled");
        return EXIT.ok;
    }
    if (g.metrics.length === 0 && !g.error_source) {
        session.logger.warn("release guardian: no metric and no error source configured, nothing to watch");
        return EXIT.ok;
    }
    const result = await guardDeployment(session.runtime("release-guardian"), {
        deployment,
        metrics: g.metrics.map((metric) => ({
            source: metric.source,
            query: {name: metric.name, query: metric.query, bad: metric.bad},
            absolute_min: metric.absolute_min
        })),
        sources: session.metricsSources(),
        ...(g.error_source ? {errorSource: g.error_source} : {}),
        options: {
            baseline_minutes: g.baseline_minutes,
            observe_minutes: g.observe_minutes,
            step_seconds: g.step_seconds,
            relative_increase: g.relative_increase,
            new_errors_threshold: g.new_errors_threshold,
            severe_factor: g.severe_factor
        },
        ...(deployment.commits ? {commits: deployment.commits} : {})
    });
    const runs = [{agent: "release_guardian" as const, result, environment: deployment.environment}];
    const conclusion = await conclude(session, runs, {dryRun: options.dryRun ?? false});
    for (const outcome of conclusion.outcomes) {
        if (outcome.outcome !== "done") continue;
        if (outcome.type === "rollback_deployment" || outcome.type === "pause_deployment") {
            await recordDeployment(session.state, {
                ...deployment,
                status: outcome.type === "rollback_deployment" ? "rolled_back" : "paused"
            });
        }
    }
    report(session, runs, conclusion, options.json);
    return EXIT.ok;
}

/** `aicd guard`: a post-deploy job. It waits for the observation window, then decides. */
export async function guardCommand(
    options: GlobalOptions & {ci?: string; deployment?: string; env?: string}
): Promise<number> {
    const session = await Session.open(options);
    try {
        let deployment: DeploymentRecord | undefined;
        if (options.deployment) {
            deployment = (await session.state.getRecord<DeploymentRecord>(COLLECTIONS.deployments, options.deployment))
                ?.value;
        } else if (options.env) {
            const recent = await session.state.listRecords<DeploymentRecord>(COLLECTIONS.deployments, {limit: 200});
            deployment = recent.map((r) => r.value).find((d) => d.environment === options.env);
        }
        if (!deployment) {
            session.logger.error("deployment not found: record it first with `aicd deploy record`");
            return EXIT.invalidConfig;
        }
        return await guard(session, deployment, options);
    } finally {
        await session.close();
    }
}
