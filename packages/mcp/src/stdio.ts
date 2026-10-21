import {createInterface} from "node:readline";
import type {Logger} from "@aicd/plugin-sdk";
import type {McpServer} from "./server.js";

export interface StdioOptions {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    /** Must not write to `output` (stdout carries the protocol): log to stderr. */
    logger?: Logger;
}

/**
 * Serves `server` over newline-delimited JSON (the MCP stdio transport): one message per input line, one response
 * line per request, nothing else on `output`. Requests run concurrently; the promise resolves once the input has
 * ended and every pending response is written.
 */
export async function serveStdio(server: McpServer, options: StdioOptions = {}): Promise<void> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const lines = createInterface({input, crlfDelay: Infinity});
    const pending = new Set<Promise<void>>();

    for await (const line of lines) {
        if (line.trim().length === 0) continue;
        const task = server
            .handleText(line)
            .then((response) => {
                if (response) output.write(`${JSON.stringify(response)}\n`);
            })
            .catch((error: unknown) => {
                options.logger?.error(`mcp stdio: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => pending.delete(task));
        pending.add(task);
    }
    await Promise.all(pending);
}
