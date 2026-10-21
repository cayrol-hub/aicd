import {createHash, createHmac, timingSafeEqual} from "node:crypto";

/** Constant-time string comparison: both sides are hashed first, so lengths leak nothing either. */
export function safeEqual(given: string, expected: string): boolean {
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

/** True when `given` matches one of `tokens`. Every token is compared, so timing does not reveal which one matched. */
export function matchesAnyToken(given: string, tokens: readonly string[]): boolean {
    let match = false;
    for (const token of tokens) {
        if (token.length > 0 && safeEqual(given, token)) match = true;
    }
    return match;
}

/** Checks a hex HMAC-SHA256 of the raw body (Sentry's `Sentry-Hook-Signature`, GitHub's after `sha256=`). */
export function verifyHmacSha256(secret: string, body: Uint8Array, hexSignature: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(hexSignature)) return false;
    const expected = createHmac("sha256", secret).update(body).digest();
    return timingSafeEqual(Buffer.from(hexSignature, "hex"), expected);
}

/** Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` header against the raw body. */
export function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=")) return false;
    return verifyHmacSha256(secret, body, header.slice("sha256=".length));
}

/** The token of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | undefined {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
    return match?.[1];
}
