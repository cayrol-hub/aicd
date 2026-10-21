export interface Ticket {
    key: string;
    title: string;
    description: string;
    url?: string;
    status?: string;
    labels?: string[];
    /** Extracted from the description (headings, checklists, Gherkin). */
    acceptanceCriteria: string[];
}

export interface IssueDraft {
    title: string;
    body: string;
    labels?: string[];
}

export interface IssueTracker {
    readonly name: string;
    /** Ticket keys referenced in a text (MR title, branch, description). */
    extractKeys(text: string): string[];
    getTicket(key: string): Promise<Ticket | undefined>;
    createIssue(draft: IssueDraft): Promise<{key: string; url?: string}>;
}
