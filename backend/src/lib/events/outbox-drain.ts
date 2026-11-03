import {db} from "../knex/knex";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {messageBroker} from "../messaging/init";
import {markOutboxEventDispatched, markOutboxEventFailed, retireDeadOutboxEvents, takePendingOutboxEvents} from "./outbox.repo";

export async function publishPendingOutboxEvents(region: string): Promise<void> {
    const conn = db(region);
    const trx = await conn.transaction();
    try {
        const rows = await takePendingOutboxEvents(trx, env.outboundEvents.batchSize);
        if (rows.length === 0) {
            await trx.commit();
            return;
        }

        for (const row of rows) {
            const envelope = {
                eventId: row.event_id,
                eventType: row.event_type,
                occurredAt: new Date().toISOString(),
                aggregateType: row.aggregate_type,
                aggregateId: row.aggregate_id,
                region,
                payload: row.payload,
            };
            try {
                await messageBroker.publish(
                    env.outboundEvents.exchange,
                    row.event_type,
                    Buffer.from(JSON.stringify(envelope), "utf8"),
                );
                await markOutboxEventDispatched(trx, row.id);
            } catch (err) {
                const errorText = errorMessage(err);
                await markOutboxEventFailed(trx, row.id, errorText);
                logger.error("outbox publish failed", {region, id: row.id, error: errorText});
                break;
            }
        }

        await trx.commit();
        await retireDeadOutboxEvents(conn);
    } catch (err) {
        await trx.rollback();
        throw err;
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
