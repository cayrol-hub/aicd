import type {IssueDraft, IssueTracker, Ticket} from "@aicd/plugin-sdk";
import {extractAcceptanceCriteria} from "./criteria.js";
import {asRecord, asString, requestJson} from "./http.js";
import {extractProjectKeys} from "./jira.js";

const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) { identifier title description url state { name } labels { nodes { name } } }
}`;

const CREATE_MUTATION = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;

export interface LinearTrackerOptions {
    apiKey: string;
    /** Team of the issues created by aicd (required by `createIssue`). */
    teamId?: string;
    /** Only keys of these teams are extracted, e.g. ["ENG"] (default: any team). */
    teamKeys?: string[];
    apiUrl?: string;
    fetch?: typeof fetch;
}

/** Linear through its GraphQL API. Keys are issue identifiers like `ENG-123`. */
export class LinearTracker implements IssueTracker {
    readonly name = "linear";
    readonly #options: LinearTrackerOptions;
    readonly #fetch: typeof fetch;
    readonly #apiUrl: string;

    constructor(options: LinearTrackerOptions) {
        this.#options = options;
        this.#fetch = options.fetch ?? fetch;
        this.#apiUrl = options.apiUrl ?? "https://api.linear.app/graphql";
    }

    extractKeys(text: string): string[] {
        return extractProjectKeys(text, this.#options.teamKeys);
    }

    async #graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        const body = asRecord(
            await requestJson(this.#fetch, this.name, this.#apiUrl, {
                method: "POST",
                // Personal API keys go as is; OAuth tokens already carry "Bearer ".
                headers: {Authorization: this.#options.apiKey},
                body: JSON.stringify({query, variables})
            })
        );
        const errors = Array.isArray(body.errors) ? body.errors.map((error) => asRecord(error)) : [];
        if (errors.length > 0) {
            const notFound = errors.some(
                (error) =>
                    /not found/i.test(asString(error.message) ?? "") ||
                    asString(asRecord(error.extensions).code) === "ENTITY_NOT_FOUND"
            );
            if (notFound) return undefined;
            throw new Error(`linear API: ${errors.map((error) => asString(error.message) ?? "error").join("; ")}`);
        }
        return asRecord(body.data);
    }

    async getTicket(key: string): Promise<Ticket | undefined> {
        const data = await this.#graphql(ISSUE_QUERY, {id: key});
        if (!data || data.issue == null) return undefined;
        const issue = asRecord(data.issue);
        const description = asString(issue.description) ?? "";
        const url = asString(issue.url);
        const status = asString(asRecord(issue.state).name);
        const nodes = asRecord(issue.labels).nodes;
        const labels = Array.isArray(nodes)
            ? nodes.map((node) => asString(asRecord(node).name)).filter((name): name is string => name !== undefined)
            : [];
        return {
            key: asString(issue.identifier) ?? key,
            title: asString(issue.title) ?? "",
            description,
            ...(url ? {url} : {}),
            ...(status ? {status} : {}),
            labels,
            acceptanceCriteria: extractAcceptanceCriteria(description)
        };
    }

    /** Labels are not set: Linear needs label ids, not names. */
    async createIssue(draft: IssueDraft): Promise<{key: string; url?: string}> {
        const teamId = this.#options.teamId;
        if (!teamId) throw new Error("linear: team_id is required to create issues");
        const data = await this.#graphql(CREATE_MUTATION, {
            input: {teamId, title: draft.title, description: draft.body}
        });
        const result = asRecord(data?.issueCreate);
        const issue = asRecord(result.issue);
        const key = asString(issue.identifier);
        if (result.success !== true || !key) throw new Error("linear: issue creation failed");
        const url = asString(issue.url);
        return {key, ...(url ? {url} : {})};
    }
}
