import type {IssueDraft, IssueTracker, Ticket} from "@aicd-ci/plugin-sdk";
import {adfToText, textToAdf} from "./adf.js";
import {extractAcceptanceCriteria} from "./criteria.js";
import {asRecord, asString, requestJson, unique} from "./http.js";

/** Prefixes that look like ticket keys but are not (UTF-8, SHA-256, ISO-8601…). */
const NOT_PROJECTS = new Set([
    "UTF",
    "SHA",
    "ISO",
    "RFC",
    "CVE",
    "GH",
    "GHSA",
    "HTTP",
    "TLS",
    "SSL",
    "AES",
    "RSA",
    "MD",
    "ES",
    "X"
]);

/** Ticket keys like `ENG-123` in a text, without the usual false positives; optionally limited to some projects. */
export function extractProjectKeys(text: string, projects?: string[]): string[] {
    const keys: string[] = [];
    for (const match of text.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?![A-Za-z0-9])/g)) {
        const project = match[1] ?? "";
        if (NOT_PROJECTS.has(project)) continue;
        if (projects && projects.length > 0 && !projects.includes(project)) continue;
        keys.push(match[0]);
    }
    return unique(keys);
}

export interface JiraTrackerOptions {
    /** Site URL, e.g. https://acme.atlassian.net. */
    baseUrl: string;
    /** With `apiToken`: basic authentication (Jira Cloud). */
    email?: string;
    apiToken?: string;
    /** Personal access token (Jira Data Center), used when there is no email + API token. */
    bearerToken?: string;
    /** Project of the issues created by aicd. */
    projectKey?: string;
    issueType?: string;
    /** Only keys of these projects are extracted (default: any project). */
    projectKeys?: string[];
    fetch?: typeof fetch;
}

/** Jira Cloud / Data Center through REST API v3. Descriptions are Atlassian Document Format, read as text. */
export class JiraTracker implements IssueTracker {
    readonly name = "jira";
    readonly #baseUrl: string;
    readonly #headers: Record<string, string>;
    readonly #fetch: typeof fetch;
    readonly #options: JiraTrackerOptions;

    constructor(options: JiraTrackerOptions) {
        this.#options = options;
        this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.#fetch = options.fetch ?? fetch;
        this.#headers =
            options.email && options.apiToken
                ? {Authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`}
                : options.bearerToken
                  ? {Authorization: `Bearer ${options.bearerToken}`}
                  : {};
    }

    extractKeys(text: string): string[] {
        return extractProjectKeys(text, this.#options.projectKeys);
    }

    async getTicket(key: string): Promise<Ticket | undefined> {
        if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return undefined;
        const body = await requestJson(
            this.#fetch,
            this.name,
            `${this.#baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels`,
            {headers: this.#headers, allowNotFound: true}
        );
        if (body === undefined) return undefined;
        const issue = asRecord(body);
        const fields = asRecord(issue.fields);
        const description = adfToText(fields.description);
        const status = asString(asRecord(fields.status).name);
        const labels = Array.isArray(fields.labels) ? fields.labels.filter((label) => typeof label === "string") : [];
        const issueKey = asString(issue.key) ?? key;
        return {
            key: issueKey,
            title: asString(fields.summary) ?? "",
            description,
            url: `${this.#baseUrl}/browse/${issueKey}`,
            ...(status ? {status} : {}),
            labels,
            acceptanceCriteria: extractAcceptanceCriteria(description)
        };
    }

    async createIssue(draft: IssueDraft): Promise<{key: string; url?: string}> {
        const project = this.#options.projectKey;
        if (!project) throw new Error("jira: project_key is required to create issues");
        const body = asRecord(
            await requestJson(this.#fetch, this.name, `${this.#baseUrl}/rest/api/3/issue`, {
                method: "POST",
                headers: this.#headers,
                body: JSON.stringify({
                    fields: {
                        project: {key: project},
                        issuetype: {name: this.#options.issueType ?? "Task"},
                        summary: draft.title.slice(0, 255),
                        description: textToAdf(draft.body),
                        // Jira labels cannot contain spaces.
                        ...(draft.labels?.length
                            ? {labels: draft.labels.map((label) => label.replace(/\s+/g, "-"))}
                            : {})
                    }
                })
            })
        );
        const key = asString(body.key);
        if (!key) throw new Error("jira: the created issue has no key");
        return {key, url: `${this.#baseUrl}/browse/${key}`};
    }
}
