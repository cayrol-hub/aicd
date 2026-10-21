import type {IssueTracker, Logger, Ticket} from "@aicd/plugin-sdk";
import {TrackerHttpError} from "./http.js";

export interface FindTicketsOptions {
    logger?: Logger;
    /** Most tickets fetched in total (default 10). */
    limit?: number;
}

/**
 * Tickets referenced in the given texts (MR title, description, branch name…), fetched from every tracker
 * that recognises a key. Unknown tickets (404) are skipped silently, other errors are logged and skipped.
 */
export async function findTickets(
    trackers: IssueTracker[],
    texts: string[],
    options: FindTicketsOptions = {}
): Promise<Ticket[]> {
    const limit = options.limit ?? 10;
    const text = texts.filter(Boolean).join("\n");
    const requests: {tracker: IssueTracker; key: string}[] = [];
    const seen = new Set<string>();
    for (const tracker of trackers) {
        for (const key of tracker.extractKeys(text)) {
            const id = `${tracker.name}:${key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            requests.push({tracker, key});
        }
    }

    const results = await Promise.all(
        requests.slice(0, limit).map(async ({tracker, key}) => {
            try {
                return await tracker.getTicket(key);
            } catch (error) {
                if (!(error instanceof TrackerHttpError && error.status === 404)) {
                    options.logger?.warn(`${tracker.name}: cannot read ticket ${key}: ${(error as Error).message}`);
                }
                return undefined;
            }
        })
    );

    const tickets: Ticket[] = [];
    const keys = new Set<string>();
    for (const ticket of results) {
        if (!ticket || keys.has(ticket.key)) continue;
        keys.add(ticket.key);
        tickets.push(ticket);
    }
    return tickets;
}
