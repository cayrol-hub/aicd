import {readFileSync} from "node:fs";
import {relative} from "node:path";
import {runPipelineOptimizer} from "@aicd/agent-pipeline-optimizer";
import {EXIT, findFiles, type GlobalOptions} from "../shared.js";
import {conclude, report} from "../outcome.js";
import {Session} from "../session.js";

const DEFAULT_CONFIG_FILES = [
    ".gitlab-ci.yml",
    ".gitlab-ci/**/*.yml",
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml"
];

/** `aicd optimize`: weekly scheduled pipeline on the default branch, or merge requests touching CI config. */
export async function optimize(options: GlobalOptions & {ci?: string; configFile?: string[]}): Promise<number> {
    const session = await Session.open(options);
    const {config} = session;
    try {
        if (!config.agents.pipeline_optimizer.enabled) {
            session.logger.info("pipeline optimizer disabled");
            return EXIT.ok;
        }
        const {
            enabled: _enabled,
            autonomy: _autonomy,
            config_files,
            ...agentOptions
        } = config.agents.pipeline_optimizer;
        const patterns = options.configFile ?? (config_files.length > 0 ? config_files : DEFAULT_CONFIG_FILES);
        const configFiles = (await findFiles(patterns, session.cwd)).map((file) => ({
            path: relative(session.cwd, file),
            content: readFileSync(file, "utf8")
        }));
        if (configFiles.length === 0) {
            session.logger.warn("no CI configuration file found");
            return EXIT.ok;
        }
        const result = await runPipelineOptimizer(session.runtime("pipeline-optimizer"), {
            ci: session.ci,
            configFiles,
            options: agentOptions
        });
        const runs = [{agent: "pipeline_optimizer" as const, result}];
        report(session, runs, await conclude(session, runs, {dryRun: options.dryRun ?? false}), options.json);
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
