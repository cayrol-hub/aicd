import {Command, Option} from "commander";
import {analyze} from "./commands/analyze.js";
import {deployRecord, guardCommand} from "./commands/deploy.js";
import {doctor} from "./commands/doctor.js";
import {doraCommand} from "./commands/dora.js";
import {explain} from "./commands/explain.js";
import {incidentCorrelateCommand, incidentRecord, postmortemCommand} from "./commands/incident.js";
import {init} from "./commands/init.js";
import {mcpCommand} from "./commands/mcp.js";
import {optimize} from "./commands/optimize.js";
import {checkQuarantineCommand, listQuarantineCommand} from "./commands/quarantine.js";
import {releaseNotes} from "./commands/release-notes.js";
import {replay} from "./commands/replay.js";
import {review} from "./commands/review.js";
import {serve} from "./commands/serve.js";
import {mapTestsCommand, missedTestsCommand, selectTestsCommand} from "./commands/tests.js";
import {collect, EXIT, guarded, makeLogger, resolveConfig, VERSION, type GlobalOptions} from "./shared.js";

const DEPLOYMENT_STATES = ["in_progress", "success", "failed", "paused", "rolled_back", "unknown"];

const withGlobals = (command: Command) =>
    command
        .option("-c, --config <file>", "configuration file (default: .aicd.yaml)")
        .option(
            "--set <key=value>",
            "override a configuration key, repeatable (e.g. agents.triage.autonomy=act)",
            collect
        )
        .addOption(new Option("--ci <name>", "CI adapter (auto-detected by default)").default("auto"))
        .option("-v, --verbose", "debug logs")
        .option("-q, --quiet", "warnings and errors only")
        .option("--json", "machine-readable output on stdout");

const withCi = withGlobals;

const withActions = (command: Command) => withCi(command).option("--dry-run", "decide everything, execute nothing");

export function buildProgram(setExitCode: (code: number) => void): Command {
    const program = new Command("aicd")
        .description("AI layer for any CI/CD: agents propose, deterministic policies decide, humans approve.")
        .version(VERSION)
        .enablePositionalOptions()
        .showHelpAfterError();

    /** Every action runs guarded: invalid configuration → 2, internal errors logged (→ 3 with fail_on_internal_error). */
    const run =
        <A extends unknown[]>(body: (...args: A) => Promise<number>) =>
        async (...args: A) => {
            const options = (args.find((arg) => arg && typeof arg === "object" && !(arg instanceof Command)) ??
                {}) as GlobalOptions;
            setExitCode(await guarded(makeLogger(options), () => body(...args), options));
        };

    withActions(program.command("analyze"))
        .description("end of every pipeline: triage failures, track flaky tests, triage security alerts")
        .option("--log <file>", "local adapter: log file of a failed job, repeatable", collect)
        .option("--junit <glob>", "JUnit reports, repeatable (default: inputs.junit)", collect)
        .option("--sarif <glob>", "SARIF reports, repeatable (default: inputs.sarif)", collect)
        .option("--diff <file>", "local adapter: diff file")
        .option("--state <path>", "SQLite state file (default: state.path)")
        .option("--strict", "exit 1 when an agent reports a failing status")
        .action(run(analyze));

    withActions(program.command("review"))
        .description("merge request pipelines, early: risk score and intent check against the ticket")
        .option("--diff <file>", "local adapter: diff file")
        .option("--strict", "exit 1 when an agent reports a failing status")
        .action(run(review));

    const tests = program.command("tests").description("test selection");
    withActions(tests.command("select"))
        .description("print the tests the change needs (empty output = run the whole suite)")
        .addOption(new Option("--format <format>", "output format").choices(["lines", "args", "json"]).default("lines"))
        .option("--full", "force the whole suite")
        .action(run(selectTestsCommand));
    withGlobals(tests.command("map"))
        .description("rebuild the test → source map (default branch, after a full run with coverage)")
        .option("--lcov <glob>", "lcov reports with per-test records, repeatable", collect)
        .action(run(mapTestsCommand));
    withGlobals(tests.command("missed"))
        .description("selections that skipped a test which later failed on the default branch")
        .option("--junit <glob>", "JUnit reports of the default branch run, repeatable", collect)
        .option("--since <date>", "ISO date")
        .action(run(missedTestsCommand));

    const quarantine = program.command("quarantine").description("flaky test quarantine");
    withGlobals(quarantine.command("list")).description("quarantined tests").action(run(listQuarantineCommand));
    withGlobals(quarantine.command("check"))
        .description("CI gate: exit 0 only when every failing test is quarantined")
        .option("--junit <glob>", "JUnit reports, repeatable", collect)
        .action(run(checkQuarantineCommand));

    withActions(program.command("optimize"))
        .description("weekly: find slow, uncached, serialized or redundant CI jobs and propose fixes")
        .option("--config-file <glob>", "CI configuration files, repeatable", collect)
        .action(run(optimize));

    withActions(program.command("release-notes"))
        .description("tag pipelines: write release notes and propose a draft release")
        .option("--tag <tag>", "tag (default: the pipeline's tag)")
        .option("--previous <tag>", "previous tag (default: the one before)")
        .option("--output <file>", "write the notes to a file")
        .action(run(releaseNotes));

    const deploy = program.command("deploy").description("deployments");
    withCi(deploy.command("record"))
        .description("record a deployment (start and end of the deploy job) for DORA, the guardian and post-mortems")
        .requiredOption("--env <environment>")
        .addOption(new Option("--status <state>").choices(DEPLOYMENT_STATES).makeOptionMandatory())
        .option("--id <id>", "deployment id (default: <env>-<sha>)")
        .option("--sha <sha>", "deployed commit (default: the pipeline's)")
        .option("--service <name>")
        .option("--release-version <version>", "version of the deployed service")
        .option("--url <url>")
        .option("--started-at <iso>")
        .option("--rollback-of <id>", "this deployment rolls back another one")
        .action(run(deployRecord));

    withActions(program.command("guard"))
        .description("post-deploy: watch metrics and errors, pause or roll back a degraded deployment")
        .option("--deployment <id>", "recorded deployment id")
        .option("--env <environment>", "the latest deployment of this environment")
        .action(run(guardCommand));

    const incident = program.command("incident").description("incidents");
    withGlobals(incident.command("record"))
        .description("record an incident opening or resolution")
        .requiredOption("--id <id>")
        .option("--title <title>")
        .option("--env <environment>")
        .addOption(new Option("--severity <severity>").choices(["info", "warning", "critical"]))
        .option("--opened-at <iso>")
        .option("--resolved-at <iso>")
        .option("--url <url>")
        .action(run(incidentRecord));
    withActions(incident.command("correlate"))
        .description("link an incident to the deployment and commits that probably caused it")
        .argument("<incident-id>")
        .action(run(incidentCorrelateCommand));

    withActions(program.command("postmortem"))
        .description("write the blameless post-mortem of an incident and propose it as a merge request")
        .argument("<incident-id>")
        .option("--output <file>", "also write the document locally")
        .action(run(postmortemCommand));

    withGlobals(program.command("dora"))
        .description("DORA metrics of an environment")
        .option("--env <environment>", "environment", "production")
        .option("--days <days>", "window in days", "30")
        .action(run(doraCommand));

    withGlobals(program.command("mcp"))
        .description("read-only MCP server on stdio for coding agents")
        .action(run(mcpCommand));

    withGlobals(program.command("serve"))
        .description("server mode: webhooks, durable queue, HTTP API and MCP")
        .option("--port <port>")
        .option("--host <host>")
        .action(run(serve));

    withGlobals(program.command("replay"))
        .description("shadow mode: run the agents on labelled past failures and score them, publish nothing")
        .requiredOption("--fixtures <dir>", "directory of replay cases")
        .option("--min-accuracy <ratio>", "exit 1 below this accuracy (0 to 1)")
        .option("--llm-only", "skip rules and history: evaluate the LLM alone")
        .action(run(replay));

    withGlobals(program.command("explain"))
        .description("show what a run saw, decided and did (default: the last run)")
        .argument("[run-id]")
        .option("--state <path>", "SQLite state file")
        .action(run(explain));

    withCi(program.command("doctor"))
        .description("check the configuration, CI detection, state, LLM and integrations")
        .action(run(doctor));

    withGlobals(program.command("validate"))
        .description("check the configuration and the policies, print the resolved configuration")
        .action(
            run(async (options: GlobalOptions) => {
                const logger = makeLogger(options);
                const resolved = await resolveConfig(options);
                resolved.warnings.forEach((warning) => logger.warn(warning));
                process.stdout.write(`${JSON.stringify(resolved.config, null, 2)}\n`);
                logger.info(
                    `configuration valid${resolved.file ? ` (${resolved.file})` : " (defaults, no file found)"}`
                );
                return EXIT.ok;
            })
        );

    withGlobals(program.command("init"))
        .description("write a commented .aicd.yaml and print the pipeline snippet for the detected CI")
        .option("--force", "overwrite an existing .aicd.yaml")
        .action(run((options: GlobalOptions & {force?: boolean}) => init(options, makeLogger(options))));

    return program;
}
