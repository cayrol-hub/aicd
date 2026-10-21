import {readFileSync} from "node:fs";
import {glob} from "tinyglobby";
import {createLogger, loadConfig, type AicdConfig, type LogLevel, type ResolvedConfig} from "@aicd-ci/core";
import {parseJUnit, type TestCaseResult} from "@aicd-ci/parsers";
import type {Logger} from "@aicd-ci/plugin-sdk";
import {createRedactor, secretsFromEnv} from "@aicd-ci/redaction";

export interface GlobalOptions {
    config?: string;
    set?: string[];
    verbose?: boolean;
    quiet?: boolean;
    json?: boolean;
    dryRun?: boolean;
}

/** Exit codes are part of the public contract. */
export const EXIT = {ok: 0, policyBlocked: 1, invalidConfig: 2, internalError: 3} as const;

export const VERSION = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {version: string}
).version;

export function makeLogger(options: GlobalOptions): Logger {
    const level: LogLevel = options.verbose ? "debug" : options.quiet ? "warn" : "info";
    return createLogger(level);
}

export async function resolveConfig(
    options: GlobalOptions,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    untrustedFile = false
): Promise<ResolvedConfig> {
    return loadConfig({
        ...(options.config ? {file: options.config} : {}),
        overrides: options.set ?? [],
        env,
        cwd,
        untrustedFile
    });
}

export function makeRedactor(config: AicdConfig, env: NodeJS.ProcessEnv = process.env): (text: string) => string {
    const redactor = createRedactor({
        rules: config.privacy.redact,
        knownSecrets: secretsFromEnv(env),
        extraPatterns: config.privacy.extra_patterns
    });
    return (text) => redactor(text).text;
}

export function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/.aicd/**"];

export async function findFiles(patterns: string[], cwd: string = process.cwd()): Promise<string[]> {
    if (patterns.length === 0) return [];
    return (await glob(patterns, {cwd, ignore: IGNORE, absolute: true})).sort();
}

export async function readTests(patterns: string[], logger: Logger, cwd?: string): Promise<TestCaseResult[]> {
    const files = await findFiles(patterns, cwd);
    return files.flatMap((file) => {
        try {
            return parseJUnit(readFileSync(file, "utf8"));
        } catch (error) {
            logger.warn(`cannot parse ${file}: ${(error as Error).message}`);
            return [];
        }
    });
}

/**
 * Runs a command body: configuration errors → exit 2; internal errors are logged and exit 0 (aicd never breaks a
 * pipeline by itself) unless `fail_on_internal_error` is set (configuration, `--set` or environment) → exit 3.
 */
export async function guarded(
    logger: Logger,
    body: () => Promise<number>,
    options: GlobalOptions = {}
): Promise<number> {
    try {
        return await body();
    } catch (error) {
        if ((error as Error).name === "ConfigError") {
            logger.error((error as Error).message);
            return EXIT.invalidConfig;
        }
        logger.error(`internal error: ${(error as Error).stack ?? String(error)}`);
        const failOnInternal = await resolveConfig(options)
            .then((resolved) => resolved.config.fail_on_internal_error)
            .catch(() => false);
        return failOnInternal ? EXIT.internalError : EXIT.ok;
    }
}
