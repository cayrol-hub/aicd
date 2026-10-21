import type {IncomingMessage, ServerResponse} from "node:http";

/** An error answered as `{error, message}` with `status`. Messages are fixed texts: never secrets nor payloads. */
export class HttpError extends Error {
    override readonly name = "HttpError";

    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly headers: Record<string, string> = {}
    ) {
        super(message);
    }
}

export function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | number> = {}
): void {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
        ...(payload ? {"Content-Type": "application/json; charset=utf-8"} : {}),
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers
    });
    res.end(payload);
}

export function sendError(res: ServerResponse, error: HttpError): void {
    sendJson(res, error.status, {error: error.code, message: error.message}, error.headers);
}

/** First value of a request header. */
export function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

/** Refuses anything but `application/json` (or a `+json` type) with 415. */
export function requireJson(req: IncomingMessage): void {
    const type = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "application/json" && !/^application\/[\w.-]+\+json$/.test(type)) {
        throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
    }
}

/** Reads the raw body, refusing more than `limit` bytes with 413 (from `Content-Length` when declared). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const tooLarge = () =>
        new HttpError(413, "payload_too_large", `body larger than ${limit} bytes`, {Connection: "close"});
    const declared = Number(header(req, "content-length"));
    if (Number.isFinite(declared) && declared > limit) return Promise.reject(tooLarge());
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const settle = (body?: Buffer, error?: unknown) => {
            if (settled) return;
            settled = true;
            if (error) reject(error instanceof Error ? error : new Error(String(error)));
            else resolve(body ?? Buffer.alloc(0));
        };
        req.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) settle(undefined, tooLarge());
            else chunks.push(chunk);
        });
        req.on("end", () => settle(Buffer.concat(chunks)));
        req.on("error", (error) => settle(undefined, error));
    });
}

/** Parses a JSON body, answering 400 when it is not valid JSON. */
export function parseJson(body: Buffer): unknown {
    try {
        return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
        throw new HttpError(400, "invalid_json", "body is not valid JSON");
    }
}
