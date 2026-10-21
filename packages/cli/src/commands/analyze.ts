import {readFileSync} from "node:fs";
import {recordJobRuns} from "@aicd/agent-pipeline-optimizer";
import {runFlakyAgent} from "@aicd/agent-flaky";
import {DEFAULT_IGNORE_PATHS, runSecurityTriage} from "@aicd/agent-security-triage";
import {parseUnifiedDiff} from "@aicd/agent-risk-score";
import {runTriageAgent} from "@aicd/agent-triage";
import {EXIT, findFiles, readTests, type GlobalOptions} from "../shared.js";
import {conclude, report, type AgentRun} from "../outcome.js";
import {Session} from "../session.js";

export interface AnalyzeOptions extends GlobalOptions {
    ci?: string;
    log?: string[];
    junit?: string[];
    sarif?: string[];
    diff?: string;
    state?: string;
    strict?: boolean;
    /** Server mode: no local reports to read (JUnit, SARIF), only the forge's job logs. */
    remote?: boolean;
}

/**
 * `aicd analyze`: run at the end of every pipeline (green or red). Records job timings and test
 * outcomes, then runs triage (when something failed), the flaky test agent and the security agent
 * (when SARIF reports exist). Never fails the pipeline by itself, except with `--strict`.
 */
export async function analyze(options: AnalyzeOptions): Promise<number> {
    const session = await Session.open({
        ...options,
        ...(options.log ? {logFiles: options.log} : {}),
        ...(options.diff ? {diffFile: options.diff} : {}),
        ...(options.state ? {statePath: options.state} : {})
    });
    try {
        return await runAnalyze(session, options);
    } finally {
        await session.close();
    }
}

/** The body of `aicd analyze`, on an open session (also used by the server on failed pipelines). */
export async function runAnalyze(session: Session, options: AnalyzeOptions = {}): Promise<number> {
    const {config, ci, context, logger, state} = session;
    {
        const [jobs, allJobs, tests] = await Promise.all([
            ci.listFailedJobs(),
            ci.listJobs().catch((error: Error) => {
                logger.debug(`cannot list jobs: ${error.message}`);
                return [];
            }),
            options.remote ? Promise.resolve([]) : readTests(options.junit ?? config.inputs.junit, logger, session.cwd)
        ]);
        if (allJobs.length > 0) {
            await recordJobRuns(state, allJobs, {
                ...(context.pipelineId ? {pipelineId: context.pipelineId} : {}),
                ...(context.branch ? {branch: context.branch} : {})
            });
        }
        const failing = tests.filter((test) => test.status === "failed");
        const runs: AgentRun[] = [];

        if (config.agents.triage.enabled && (jobs.length > 0 || failing.length > 0)) {
            const diff = config.privacy.send_code === "none" ? undefined : await ci.getDiff().catch(() => undefined);
            runs.push({
                agent: "triage",
                result: await runTriageAgent(session.runtime("triage"), {
                    jobs,
                    tests,
                    ...(diff ? {diff} : {}),
                    options: {
                        retryFlaky: config.agents.triage.retry_flaky,
                        flakyWindow: config.agents.triage.flaky_window,
                        flakyMinFlips: config.agents.triage.flaky_min_flips,
                        minConfidence: config.comment.min_confidence
                    }
                })
            });
        } else if (tests.length > 0) {
            // Triage records outcomes itself; without it the history still needs this run.
            await state.recordTestOutcomes(
                tests.map((test) => ({
                    testId: test.id,
                    status: test.status,
                    runId: session.runId,
                    ...(context.branch ? {branch: context.branch} : {}),
                    ...(context.commitSha ? {commitSha: context.commitSha} : {}),
                    at: new Date().toISOString()
                }))
            );
        }

        if (config.agents.flaky.enabled && tests.length > 0) {
            const flaky = config.agents.flaky;
            runs.push({
                agent: "flaky",
                result: await runFlakyAgent(session.runtime("flaky"), {
                    currentRun: tests.map((test) => ({testId: test.id, status: test.status})),
                    options: {
                        window: flaky.window,
                        minFlips: flaky.min_flips,
                        minRuns: flaky.min_runs,
                        quarantineAfter: flaky.quarantine_after,
                        releaseAfter: flaky.release_after,
                        createIssues: flaky.create_issues
                    }
                })
            });
        }

        const sarifFiles =
            config.agents.security_triage.enabled && !options.remote
                ? await findFiles(options.sarif ?? config.inputs.sarif, session.cwd)
                : [];
        if (sarifFiles.length > 0) {
            const {enabled: _enabled, autonomy: _autonomy, ignore_paths, ...security} = config.agents.security_triage;
            const mrDiff = context.mergeRequest ? await ci.getDiff().catch(() => undefined) : undefined;
            const changedFiles = mrDiff ? [...new Set(parseUnifiedDiff(mrDiff).map((file) => file.path))] : [];
            runs.push({
                agent: "security_triage",
                result: await runSecurityTriage(session.runtime("security"), {
                    ci,
                    sarifDocuments: sarifFiles.map((file) => readFileSync(file, "utf8")),
                    changedFiles,
                    options: {...security, ignore_paths: [...DEFAULT_IGNORE_PATHS, ...ignore_paths]}
                })
            });
        }

        if (runs.length === 0) {
            logger.info(`nothing to analyse (${tests.length} test result(s), ${allJobs.length} job(s) recorded)`);
            return EXIT.ok;
        }
        const conclusion = await conclude(session, runs, {dryRun: options.dryRun ?? false});
        report(session, runs, conclusion, options.json);
        return options.strict && conclusion.failingStatus ? EXIT.policyBlocked : EXIT.ok;
    }
}
