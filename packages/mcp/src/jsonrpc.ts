/** JSON-RPC 2.0 error codes used by the server. */
export const JSONRPC_ERRORS = {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: unknown;
}

export interface JsonRpcFailure {
    jsonrpc: "2.0";
    id: JsonRpcId | null;
    error: {code: number; message: string; data?: unknown};
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * A protocol error: answered as a JSON-RPC error, not as a tool result. Tool handlers throw `McpError` with
 * `invalidParams` for arguments the input schema cannot express (e.g. "one of a or b"); any other thrown error
 * becomes a tool result with `isError: true`.
 */
export class McpError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "McpError";
    }
}

/** Shortcut for an `invalidParams` (-32602) protocol error. */
export function invalidParams(message: string, data?: unknown): McpError {
    return new McpError(JSONRPC_ERRORS.invalidParams, message, data);
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
    return {jsonrpc: "2.0", id, error: {code, message, ...(data === undefined ? {} : {data})}};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
