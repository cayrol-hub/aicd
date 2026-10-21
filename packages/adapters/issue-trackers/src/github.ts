import type {IssueDraft, IssueTracker, Ticket} from "@aicd-ci/plugin-sdk";
import {extractAcceptanceCriteria} from "./criteria.js";
import {asRecord, asString, requestJson, unique} from "./http.js";

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export interface GitHubIssuesTrackerOptions {
    /** `owner/repo`: target of `#123`, `GH-123` and of created issues. */
    repository?: string;
    token?: string;
    /** Default https://api.github.com (GitHub Enterprise: https://host/api/v3). */
    apiUrl?: string;
    fetch?: typeof fetch;
}

/** GitHub Issues. Keys are normalised to `owner/repo#123`; pull requests are not tickets. */
export class GitHubIssuesTracker implements IssueTracker {
    readonly name = "github";
    readonly #repository: string | undefined;
    readonly #apiUrl: string;
    readonly #headers: Record<string, string>;
    readonly #fetch: typeof fetch;

    constructor(options: GitHubIssuesTrackerOptions) {
        if (options.repository && !REPOSITORY.test(options.repository)) {
            throw new Error(`github: repository must be "owner/repo", got "${options.repository}"`);
        }
        this.#repository = options.repository;
        this.#apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
        this.#fetch = options.fetch ?? fetch;
        this.#headers = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options.token ? {Authorization: `Bearer ${options.token}`} : {})
        };
    }

    /** `owner/repo#123`, issue URLs, and with a configured repository `#123` and `GH-123`. */
    extractKeys(text: string): string[] {
        const keys: string[] = [];
        for (const match of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g)) {
            keys.push(`${match[1]}#${match[2]}`);
        }
        for (const match of text.matchAll(/(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
            keys.push(`${match[1]}#${match[2]}`);
        }
        if (this.#repository) {
            for (const match of text.matchAll(/(?<![\w/#&.-])#(\d+)\b/g)) keys.push(`${this.#repository}#${match[1]}`);
            for (const match of text.matchAll(/(?<![A-Za-z0-9])GH-(\d+)\b/g))
                keys.push(`${this.#repository}#${match[1]}`);
        }
        return unique(keys);
    }

    #parse(key: string): {repository: string; number: string} | undefined {
        const full = /^([\w.-]+\/[\w.-]+)?#(\d+)$/.exec(key);
        const short = /^GH-(\d+)$/.exec(key);
        const repository = full?.[1] ?? this.#repository;
        const number = full?.[2] ?? short?.[1];
        return repository && number ? {repository, number} : undefined;
    }

    async getTicket(key: string): Promise<Ticket | undefined> {
        const ref = this.#parse(key);
        if (!ref) return undefined;
        const body = await requestJson(
            this.#fetch,
            this.name,
            `${this.#apiUrl}/repos/${ref.repository}/issues/${ref.number}`,
            {headers: this.#headers, allowNotFound: true}
        );
        if (body === undefined) return undefined;
        const issue = asRecord(body);
        if (issue.pull_request !== undefined) return undefined;
        const description = asString(issue.body) ?? "";
        const labels = Array.isArray(issue.labels)
            ? issue.labels
                  .map((label) => (typeof label === "string" ? label : asString(asRecord(label).name)))
                  .filter((label): label is string => label !== undefined)
            : [];
        const url = asString(issue.html_url);
        const status = asString(issue.state);
        return {
            key: `${ref.repository}#${ref.number}`,
            title: asString(issue.title) ?? "",
            description,
            ...(url ? {url} : {}),
            ...(status ? {status} : {}),
            labels,
            acceptanceCriteria: extractAcceptanceCriteria(description)
        };
    }

    async createIssue(draft: IssueDraft): Promise<{key: string; url?: string}> {
        if (!this.#repository) throw new Error("github: repository is required to create issues");
        const body = asRecord(
            await requestJson(this.#fetch, this.name, `${this.#apiUrl}/repos/${this.#repository}/issues`, {
                method: "POST",
                headers: this.#headers,
                body: JSON.stringify({
                    title: draft.title,
                    body: draft.body,
                    ...(draft.labels?.length ? {labels: draft.labels} : {})
                })
            })
        );
        const number = body.number;
        if (typeof number !== "number") throw new Error("github: the created issue has no number");
        const url = asString(body.html_url);
        return {key: `${this.#repository}#${number}`, ...(url ? {url} : {})};
    }
}
