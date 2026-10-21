/**
 * Masks secrets and personal data. Runs on everything that could leave the runner
 * (LLM prompts, comments, audit log) before it leaves.
 */

export type RedactionRule = "secrets" | "emails" | "ip_addresses" | "high_entropy";

export interface RedactorOptions {
    rules?: RedactionRule[];
    /** Literal values to mask, e.g. the values of secret environment variables. */
    knownSecrets?: string[];
    /** Extra user patterns (regular expression sources). */
    extraPatterns?: string[];
}

export interface RedactionResult {
    text: string;
    count: number;
}

export type Redactor = (text: string) => RedactionResult;

const mask = (label: string) => `[REDACTED:${label}]`;

/** Known token formats. Order matters: the most specific first. */
const SECRET_PATTERNS: [RegExp, string][] = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private-key"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "github-token"],
    [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "github-token"],
    [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "gitlab-token"],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "anthropic-key"],
    [/\bsk-[A-Za-z0-9_-]{32,}\b/g, "api-key"],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, "google-api-key"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "jwt"],
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "auth-header"]
];

/** `password=…`, `api_key: …` and URL credentials: keep the key, mask the value. */
const ASSIGNMENT =
    /(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["']?)([^\s"']{4,})\2/gi;
const URL_CREDENTIALS = /(:\/\/)[^\s:@/]+:[^\s@/]+@/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const CANDIDATE_TOKEN = /[A-Za-z0-9+/=_-]{32,}/g;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
    const counts = new Map<string, number>();
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}

/** Hex strings (commit SHAs, hashes) stay readable: they are evidence, not secrets. */
function looksLikeSecret(token: string): boolean {
    if (/^[0-9a-f]+$/i.test(token)) return false;
    if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
    return entropy(token) > 4.2;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
    const rules = new Set<RedactionRule>(options.rules ?? ["secrets", "emails", "ip_addresses", "high_entropy"]);
    const known = (options.knownSecrets ?? [])
        .filter((value) => value.length >= 6)
        .sort((a, b) => b.length - a.length)
        .map((value) => new RegExp(escapeRegExp(value), "g"));
    const extra = (options.extraPatterns ?? []).map((source) => new RegExp(source, "g"));

    return (input: string) => {
        let count = 0;
        const replace = (text: string, pattern: RegExp, replacement: string | ((...args: string[]) => string)) =>
            text.replace(pattern, (...args: string[]) => {
                count++;
                return typeof replacement === "string" ? replacement : replacement(...args);
            });

        let text = input;
        for (const pattern of known) text = replace(text, pattern, mask("secret"));
        for (const pattern of extra) text = replace(text, pattern, mask("custom"));
        if (rules.has("secrets")) {
            for (const [pattern, label] of SECRET_PATTERNS) text = replace(text, pattern, mask(label));
            text = replace(text, ASSIGNMENT, (_match, key, quote) => `${key}${quote}${mask("assignment")}${quote}`);
            text = replace(text, URL_CREDENTIALS, (_match, scheme) => `${scheme}${mask("url-credentials")}@`);
        }
        if (rules.has("emails")) text = replace(text, EMAIL, mask("email"));
        if (rules.has("ip_addresses")) text = replace(text, IPV4, mask("ip"));
        if (rules.has("high_entropy")) {
            text = text.replace(CANDIDATE_TOKEN, (token) => {
                if (token.startsWith("REDACTED")) return token;
                // A path (two slashes or more) is judged segment by segment: only a random segment is masked.
                if ((token.match(/\//g) ?? []).length >= 2) {
                    return token
                        .split("/")
                        .map((segment) => {
                            if (segment.length < 32 || !looksLikeSecret(segment)) return segment;
                            count++;
                            return mask("high-entropy");
                        })
                        .join("/");
                }
                if (!looksLikeSecret(token)) return token;
                count++;
                return mask("high-entropy");
            });
        }
        return {text, count};
    };
}

/** Values of environment variables whose name says they hold a secret. */
export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
    const name = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
    return Object.entries(env)
        .filter(([key, value]) => name.test(key) && typeof value === "string" && value.length >= 6)
        .map(([, value]) => value as string);
}
