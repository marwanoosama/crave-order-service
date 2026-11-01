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


export async function insertOutboxEvents(conn: Knex, inputs: InsertOutboxInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await conn("events_outbox").insert(
        inputs.map((i) => ({
            aggregate_type: i.aggregateType,
            aggregate_id: String(i.aggregateId),
            event_type: i.eventType,
            event_id: randomUUID(),
            payload: JSON.stringify(i.payload),
        })),
    );
}


export async function claimBatch(conn: Knex, limit: number): Promise<OutboxRow[]> {
    const rows = await conn("events_outbox")
        .select("id", "aggregate_type", "aggregate_id", "event_type", "event_id", "payload", "attempts")
        .whereNull("dispatched_at")
        .orderBy("id", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked();
    return rows as OutboxRow[];
}

export async function markDispatched(conn: Knex, id: string): Promise<void> {
    await conn("events_outbox").where({id}).update({dispatched_at: new Date()});
}

export async function markFailed(conn: Knex, id: string, err: string): Promise<void> {
    await conn("events_outbox")
        .where({id})
        .update({
            attempts: conn.raw("attempts + 1"),
            last_error: err.slice(0, 2000),
        });
}
