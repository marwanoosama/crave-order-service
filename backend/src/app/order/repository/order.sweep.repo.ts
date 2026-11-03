import {Knex} from "knex";

export interface PendingPaymentRow {
    id: string;
    public_id: string;
    branch_id: string;
}

/**
 * Rows backing the pending-payment sweep job: online orders that never
 * reached `placed` before the payment session expired.
 */
export async function findPendingPaymentOrders(
    region: string,
    cutoff: Date,
    conn: Knex,
): Promise<PendingPaymentRow[]> {
    return conn("orders")
        .select("id", "public_id", "branch_id")
        .where("region", region)
        .where("status", "pending_payment")
        .where("created_at", "<", cutoff)
        .limit(200) as Promise<PendingPaymentRow[]>;
}

/**
 * Guarded cancel: flips `pending_payment → cancelled` and stamps
 * `cancelled_at`, only if the order is still pending payment. Returns the
 * affected row or `undefined` when the order already moved on (payment
 * landed between the scan and this update).
 */
export async function cancelIfPendingPayment(
    publicId: string,
    conn: Knex,
): Promise<{id: string; public_id: string; branch_id: string} | undefined> {
    const [row] = await conn("orders")
        .where({public_id: publicId, status: "pending_payment"})
        .update({
            status: "cancelled",
            cancelled_at: conn.fn.now(),
            updated_at: conn.fn.now(),
        })
        .returning(["id", "public_id", "branch_id"]);

    return row
        ? {id: String(row.id), public_id: row.public_id, branch_id: String(row.branch_id)}
        : undefined;
}
