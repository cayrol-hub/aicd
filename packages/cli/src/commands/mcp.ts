import {createMcpServer, serveStdio} from "@aicd-ci/mcp";
import {EXIT, VERSION, type GlobalOptions} from "../shared.js";
import {Session} from "../session.js";

/**
 * `aicd mcp`: a read-only MCP server on stdio for coding agents (Claude Code, Cursor…), over the local
 * state (`.aicd/state.db`). Logs go to stderr; stdout carries the protocol only.
 */
export async function mcpCommand(options: GlobalOptions): Promise<number> {
    const session = await Session.open({...options, quiet: !options.verbose, noLlm: true, ci: "local", readOnly: true});
    try {
        await serveStdio(createMcpServer({state: session.state, version: VERSION, logger: session.logger}), {
            logger: session.logger
        });
        return EXIT.ok;
    } finally {
        await session.close();
    }
}
