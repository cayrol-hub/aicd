import {writeFileSync} from "node:fs";
import {generateReleaseNotes, type ReleaseNotesReport} from "@aicd/agent-release-notes";
import {EXIT, type GlobalOptions} from "../shared.js";
import {conclude, report} from "../outcome.js";
import {Session} from "../session.js";

/** `aicd release-notes`: on tag pipelines. Writes the notes and proposes a draft release. */
export async function releaseNotes(
    options: GlobalOptions & {ci?: string; tag?: string; previous?: string; output?: string}
): Promise<number> {
    const session = await Session.open(options);
    const {config, context, logger} = session;
    try {
        const tag = options.tag ?? context.tag;
        if (!tag) {
            logger.error("no tag: pass --tag or run on a tag pipeline");
            return EXIT.invalidConfig;
        }
        const rn = config.agents.release_notes;
        const repositoryUrl =
            rn.repository_url ??
            (context.provider === "github" && context.repository
                ? `https://github.com/${context.repository}`
                : undefined);
        const result = await generateReleaseNotes(session.runtime("release-notes"), {
            cwd: session.cwd,
            tag,
            ...(options.previous ? {previousTag: options.previous} : {}),
            audiences: rn.audiences,
            options: {
                primaryAudience: rn.primary,
                useLlm: rn.use_llm,
                releaseName: rn.release_name,
                ...(rn.ticket_prefixes.length > 0 ? {ticketPrefixes: rn.ticket_prefixes} : {}),
                ...(repositoryUrl ? {repositoryUrl} : {}),
                ...(rn.ticket_url ? {ticketUrl: rn.ticket_url} : {}),
                ...(context.provider === "github" || context.provider === "gitlab" ? {forge: context.provider} : {})
            }
        });
        const notes = (result.report as ReleaseNotesReport).notes;
        const primary = notes[rn.primary] ?? Object.values(notes)[0];
        if (options.output && primary) {
            writeFileSync(options.output, `${primary.markdown}\n`);
            logger.info(`release notes written to ${options.output}`);
        } else if (primary && !options.json) {
            process.stdout.write(`${primary.markdown}\n`);
        }
        const runs = [{agent: "release_notes" as const, result}];
        report(session, runs, await conclude(session, runs, {dryRun: options.dryRun ?? false}), options.json);
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
