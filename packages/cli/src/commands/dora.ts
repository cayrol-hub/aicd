import {computeDora, renderDora} from "@aicd/metrics";
import {EXIT, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

/** `aicd dora`: the four DORA metrics of an environment over the last days. */
export async function doraCommand(options: GlobalOptions & {env?: string; days?: string}): Promise<number> {
    const session = await Session.open({...options, noLlm: true, readOnly: true});
    try {
        const days = Number(options.days ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
            session.logger.error("--days must be an integer between 1 and 365");
            return EXIT.invalidConfig;
        }
        const end = new Date();
        const start = new Date(end.getTime() - days * 86_400_000);
        const dora = await computeDora(session.state, {environment: options.env ?? "production", start, end});
        process.stdout.write(
            `${renderDora(dora, {language: session.config.comment.language, format: options.json ? "json" : "markdown"})}\n`
        );
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
