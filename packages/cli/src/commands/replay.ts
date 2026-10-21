import {ConfigError} from "@aicd-ci/core";
import {formatReport, loadCases, replayCases} from "@aicd-ci/replay";
import {EXIT, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

export interface ReplayCommandOptions extends GlobalOptions {
    fixtures: string;
    minAccuracy?: string;
    llmOnly?: boolean;
}

/**
 * `aicd replay`: shadow mode on labelled fixtures. Nothing is published. The LLM is the configured one
 * (`--set llm.provider=… --set llm.model=…` to compare providers). With `--min-accuracy`, exits 1 below
 * the threshold — the release gate.
 */
export async function replay(options: ReplayCommandOptions): Promise<number> {
    const minAccuracy = options.minAccuracy === undefined ? undefined : Number(options.minAccuracy);
    if (minAccuracy !== undefined && (Number.isNaN(minAccuracy) || minAccuracy < 0 || minAccuracy > 1)) {
        throw new ConfigError(`--min-accuracy must be a number between 0 and 1, got "${options.minAccuracy}"`);
    }
    const session = await Session.open({...options, ci: "local", statePath: ":memory:"});
    try {
        const {config} = session;
        const result = await replayCases(loadCases(options.fixtures), {
            ...(session.llm ? {llm: session.llm} : {}),
            budgetUsd: config.llm.budget_per_run_usd,
            logger: session.logger,
            redact: session.redact,
            triage: {
                useLlm: Boolean(session.llm),
                sendCode: config.privacy.send_code,
                language: config.comment.language,
                retryFlaky: false,
                flakyWindow: config.agents.triage.flaky_window,
                flakyMinFlips: config.agents.triage.flaky_min_flips,
                llmOnly: Boolean(options.llmOnly)
            }
        });
        const model = session.llm ? `${session.llm.name}/${session.llm.model}` : "rules only";
        process.stdout.write(
            options.json ? `${JSON.stringify({model, ...result}, null, 2)}\n` : `${formatReport(result)} · ${model}\n`
        );
        if (minAccuracy !== undefined && result.accuracy < minAccuracy) {
            session.logger.error(
                `accuracy ${(result.accuracy * 100).toFixed(1)}% is below the required ${(minAccuracy * 100).toFixed(1)}%`
            );
            return EXIT.policyBlocked;
        }
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
