import type {Knex} from "knex";
import {randomUUID} from "crypto";
import {OutboxRow, InsertOutboxInput} from "./types";

export async function insertOutboxEvent(conn: Knex, input: InsertOutboxInput): Promise<void> {
    await conn("events_outbox").insert({
        aggregate_type: input.aggregateType,
        aggregate_id: String(input.aggregateId),
        event_type: input.eventType,
        event_id: randomUUID(),
        payload: JSON.stringify(input.payload),
    });
}

// Rows that exceed this attempt count are dropped as poison (logged); they
// would otherwise sit at the head of the drain queue forever.
const MAX_ATTEMPTS = 10;

export async function takePendingOutboxEvents(conn: Knex, limit: number): Promise<OutboxRow[]> {
    const rows = await conn("events_outbox")
        .select("id", "aggregate_type", "aggregate_id", "event_type", "event_id", "payload", "attempts")
        .whereNull("dispatched_at")
        .where("attempts", "<", MAX_ATTEMPTS)
        .orderBy("attempts", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();
    return rows as OutboxRow[];
}

/**
 * Retired rows: poison events beyond MAX_ATTEMPTS are marked dispatched with
 * last_error kept for the audit trail, so the queue never stalls on them.
 */
export async function retireDeadOutboxEvents(conn: Knex): Promise<number> {
    const count = await conn("events_outbox")
        .whereNull("dispatched_at")
        .where("attempts", ">=", MAX_ATTEMPTS)
        .count<{c: string}[]>("* as c")
        .then((rows) => Number(rows[0]?.c ?? 0));
    if (count === 0) return 0;

    await conn("events_outbox")
        .whereNull("dispatched_at")
        .where("attempts", ">=", MAX_ATTEMPTS)
        .returning(["id"])
        .update({dispatched_at: new Date()});
    return count;
}

export async function markOutboxEventDispatched(conn: Knex, id: string): Promise<void> {
    await conn("events_outbox").where({id}).update({dispatched_at: new Date()});
}

export async function markOutboxEventFailed(conn: Knex, id: string, err: string): Promise<void> {
    await conn("events_outbox")
        .where({id})
        .update({
            attempts: conn.raw("attempts + 1"),
            last_error: err.slice(0, 2000),
        });
}
