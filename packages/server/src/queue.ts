import {COLLECTIONS, type Logger, type StateStore} from "@aicd/plugin-sdk";
import type {AicdEvent, EventHandlers} from "./events.js";

export type EventStatus = "pending" | "processing" | "done" | "failed";

/** One received event in `COLLECTIONS.events`, keyed `<source>:<delivery id>:<index>`. */
export interface EventRecord {
    event: AicdEvent;
    status: EventStatus;
    /** Handler runs started so far. */
    attempts: number;
    lastError?: string;
    receivedAt: string;
    deliveryId: string;
    finishedAt?: string;
}

export interface EventQueueOptions {
    state: StateStore;
    logger: Logger;
    handlers: EventHandlers;
    /** Handlers running at the same time. Default 2. */
    concurrency?: number;
    /** Handler runs before an event is marked failed. Default 3. */
    maxAttempts?: number;
    /** First retry delay, doubled on each retry (capped at 5 minutes). Default 1000. */
    retryDelayMs?: number;
    /** Done and failed events older than this are deleted on start; it is also the dedupe window. Default 7 days. */
    retentionMs?: number;
    now?: () => Date;
}

export interface EnqueueResult {
    accepted: number;
    duplicates: number;
}

const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 500;
const SCAN_LIMIT = 1_000_000;

/**
 * Durable at-least-once queue on the state store. Every state change is written before it takes effect, so
 * `start()` resumes what a crash or a restart interrupted: handlers must be idempotent. A delivery seen before is
 * a duplicate unless its previous run failed for good, in which case a redelivery runs it again.
 */
export class EventQueue {
    readonly #state: StateStore;
    readonly #logger: Logger;
    readonly #handlers: EventHandlers;
    readonly #concurrency: number;
    readonly #maxAttempts: number;
    readonly #retryDelayMs: number;
    readonly #retentionMs: number;
    readonly #now: () => Date;
    /** Events known to this process and not finished: queued, running or waiting for a retry. */
    readonly #records = new Map<string, EventRecord>();
    readonly #ready: string[] = [];
    readonly #retries = new Map<string, NodeJS.Timeout>();
    readonly #active = new Set<Promise<void>>();
    #idleWaiters: (() => void)[] = [];
    #started = false;
    #closed = false;

    constructor(options: EventQueueOptions) {
        this.#state = options.state;
        this.#logger = options.logger;
        this.#handlers = options.handlers;
        this.#concurrency = Math.max(1, options.concurrency ?? 2);
        this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
        this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
        this.#retentionMs = options.retentionMs ?? 7 * 24 * 3_600_000;
        this.#now = options.now ?? (() => new Date());
    }

    /** Resumes pending and interrupted events (oldest first), prunes old finished ones, then starts the workers. */
    async start(): Promise<{resumed: number; pruned: number}> {
        if (this.#started) return {resumed: 0, pruned: 0};
        const stored = await this.#state.listRecords<EventRecord>(COLLECTIONS.events, {limit: SCAN_LIMIT});
        const cutoff = this.#now().getTime() - this.#retentionMs;
        const resumed: [string, EventRecord][] = [];
        let pruned = 0;
        for (const {id, value} of stored) {
            if (value.status === "pending" || value.status === "processing") {
                resumed.push([id, {...value, status: "pending"}]);
            } else if (Date.parse(value.receivedAt) < cutoff) {
                await this.#state.deleteRecord(COLLECTIONS.events, id);
                pruned++;
            }
        }
        resumed.sort(([idA, a], [idB, b]) => a.receivedAt.localeCompare(b.receivedAt) || idA.localeCompare(idB));
        for (const [id, record] of resumed) {
            if (this.#records.has(id)) continue;
            this.#records.set(id, record);
            this.#ready.push(id);
        }
        this.#started = true;
        if (resumed.length > 0) this.#logger.info(`server: resuming ${resumed.length} queued event(s)`);
        this.#pump();
        return {resumed: resumed.length, pruned};
    }

    /**
     * Stores the events of one delivery as pending and schedules them. Throws when the queue is closed or the
     * state store fails, so that the webhook answers 503 and the provider retries.
     */
    async enqueue(deliveryKey: string, events: AicdEvent[]): Promise<EnqueueResult> {
        if (this.#closed) throw new Error("queue is closed");
        const result: EnqueueResult = {accepted: 0, duplicates: 0};
        for (const [index, event] of events.entries()) {
            const id = `${deliveryKey}:${index}`;
            if (this.#records.has(id)) {
                result.duplicates++;
                continue;
            }
            const record: EventRecord = {
                event,
                status: "pending",
                attempts: 0,
                receivedAt: this.#now().toISOString(),
                deliveryId: deliveryKey
            };
            // Reserved before the first await, so that two concurrent deliveries cannot both pass the check.
            this.#records.set(id, record);
            try {
                const existing = await this.#state.getRecord<EventRecord>(COLLECTIONS.events, id);
                if (existing && existing.value.status !== "failed") {
                    this.#records.delete(id);
                    result.duplicates++;
                    continue;
                }
                await this.#state.putRecord(COLLECTIONS.events, id, record);
            } catch (error) {
                this.#records.delete(id);
                throw error;
            }
            this.#ready.push(id);
            result.accepted++;
        }
        this.#pump();
        return result;
    }

    /** Resolves when nothing is queued, running or waiting for a retry (or when the queue closes). */
    onIdle(): Promise<void> {
        if (this.#isIdle()) return Promise.resolve();
        return new Promise((resolve) => this.#idleWaiters.push(resolve));
    }

    get stats(): {queued: number; running: number; retrying: number} {
        return {queued: this.#ready.length, running: this.#active.size, retrying: this.#retries.size};
    }

    /**
     * Stops taking work and waits for running handlers. Queued events and pending retries stay `pending` in the
     * state store and are resumed by the next `start()`.
     */
    async close(): Promise<void> {
        this.#closed = true;
        for (const timer of this.#retries.values()) clearTimeout(timer);
        this.#retries.clear();
        while (this.#active.size > 0) await Promise.allSettled([...this.#active]);
        this.#ready.length = 0;
        this.#records.clear();
        this.#notifyIdle(true);
    }

    #isIdle(): boolean {
        return this.#ready.length === 0 && this.#active.size === 0 && this.#retries.size === 0;
    }

    #notifyIdle(force = false): void {
        if (!force && !this.#isIdle()) return;
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
    }

    #pump(): void {
        while (this.#started && !this.#closed && this.#active.size < this.#concurrency) {
            const id = this.#ready.shift();
            if (id === undefined) break;
            const record = this.#records.get(id);
            if (!record) continue;
            const task = this.#process(id, record).finally(() => {
                this.#active.delete(task);
                this.#pump();
                this.#notifyIdle();
            });
            this.#active.add(task);
        }
        this.#notifyIdle();
    }

    async #process(id: string, record: EventRecord): Promise<void> {
        record.status = "processing";
        record.attempts++;
        await this.#save(id, record);
        const handler = this.#handlers[record.event.type] as ((event: AicdEvent) => Promise<void>) | undefined;
        let retry = false;
        try {
            if (handler) await handler(record.event);
            record.status = "done";
            delete record.lastError;
            record.finishedAt = this.#now().toISOString();
            this.#records.delete(id);
        } catch (error) {
            record.lastError = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
            if (record.attempts >= this.#maxAttempts) {
                record.status = "failed";
                record.finishedAt = this.#now().toISOString();
                this.#records.delete(id);
                this.#logger.error(
                    `server: ${record.event.type} event ${id} failed after ${record.attempts} attempt(s): ${record.lastError}`
                );
            } else {
                record.status = "pending";
                retry = true;
                this.#logger.warn(
                    `server: ${record.event.type} event ${id} failed (attempt ${record.attempts}), retrying`
                );
            }
        }
        await this.#save(id, record);
        // Scheduled after the write, so that the retry's "processing" snapshot cannot be overtaken by this one.
        if (retry) this.#scheduleRetry(id, record.attempts);
    }

    #scheduleRetry(id: string, attempts: number): void {
        if (this.#closed) return;
        const delay = Math.min(this.#retryDelayMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
        const timer = setTimeout(() => {
            this.#retries.delete(id);
            this.#ready.push(id);
            this.#pump();
        }, delay);
        this.#retries.set(id, timer);
    }

    /** Writes a snapshot; a state failure is logged and never stops the worker (the event is resumed on restart). */
    async #save(id: string, record: EventRecord): Promise<void> {
        try {
            await this.#state.putRecord(COLLECTIONS.events, id, {...record});
        } catch (error) {
            this.#logger.error(
                `server: cannot save event ${id}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
