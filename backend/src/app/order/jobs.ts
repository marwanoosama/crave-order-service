import {logger} from "../../lib/logger/logger";
import {db} from "../../lib/knex/knex";
import {register} from "../../lib/jobs/job-registry";
import {insertOutboxEvent} from "../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../lib/events/event-types";
import {env} from "../../lib/config/env";
import {toMs} from "../../pkg/utils/time";
import {findItemsByOrderIds} from "./repository/order-item.repo";
import {
    cancelIfPendingPayment,
    findPendingPaymentOrders,
} from "./repository/order.sweep.repo";
import {releaseStock as coreReleaseStock} from "../../lib/core-client/branch.client";

/**
 * Background sweep: cancels online orders stuck in `pending_payment` longer
 * than the payment-session timeout (the customer never completed checkout),
 * then returns the stock core-service reserved at placement.
 *
 * Ordering matters: the DB flips the order to `cancelled` FIRST (guarded on
 * the expected status), and only then releases stock. If the process dies
 * before the release, the next tick re-attempts it — release is idempotent in
 * core (Idempotency-Key = order publicId). If the payment succeeds just
 * before the sweep, the guarded UPDATE returns no row and nothing happens.
 */
export function registerPendingPaymentSweepJobs(): void {
    for (const region of env.regions) {
        register({
            name: `pending-payment-sweep:${region}`,
            cron: "*/30 * * * * *", // every 30s; cheap guarded scans
            handler: async () => {
                try {
                    await sweepPendingPaymentOrders(region);
                } catch (err) {
                    logger.error("pending-payment sweep failed", {region, error: (err as Error).message});
                }
            },
        });
    }
}

export async function sweepPendingPaymentOrders(region: string): Promise<number> {
    const cutoff = new Date(Date.now() - toMs(env.payments.sessionTimeoutMin, "m"));
    const stale = await findPendingPaymentOrders(region, cutoff, db(region));
    if (stale.length === 0) return 0;

    let cancelled = 0;
    for (const row of stale) {
        const conn = db(region);
        const trx = await conn.transaction();
        let cancelled_row: {id: string; public_id: string; branch_id: string} | undefined;
        try {
            cancelled_row = await cancelIfPendingPayment(row.public_id, trx);

            if (cancelled_row) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: cancelled_row.public_id,
                    eventType: EVENT_TYPES.ORDER_CANCELLED,
                    payload: {
                        orderId: cancelled_row.public_id,
                        region,
                        branchId: Number(cancelled_row.branch_id),
                        status: "cancelled",
                        reason: "payment_pending_timeout",
                        actor: "system",
                        occurredAt: new Date().toISOString(),
                    },
                });
            }
            await trx.commit();
        } catch (err) {
            await trx.rollback();
            logger.warn("pending-payment sweep: cancel failed", {
                region,
                orderId: row.public_id,
                error: (err as Error).message,
            });
            continue;
        }

        if (!cancelled_row) continue;
        cancelled++;

        await releaseReservedStock(region, cancelled_row);
    }

    if (cancelled > 0) {
        logger.info("pending-payment sweep: cancelled stale orders", {region, cancelled});
    }
    return cancelled;
}

async function releaseReservedStock(
    region: string,
    order: {id: string; public_id: string; branch_id: string},
): Promise<void> {
    try {
        const items = await findItemsByOrderIds([Number(order.id)], db(region));
        if (items.length === 0) return;

        await coreReleaseStock(
            Number(order.branch_id),
            items.map((item) => ({productId: item.productId, quantity: item.quantity})),
            order.public_id, // Idempotency-Key: retries never double-increment in core
        );
    } catch (err) {
        // Non-fatal: the reservation stays held in core until support re-runs
        // the release with the same idempotency key (order publicId).
        logger.error("pending-payment sweep: stock release failed", {
            orderId: order.public_id,
            branchId: order.branch_id,
            error: (err as Error).message,
        });
    }
}
