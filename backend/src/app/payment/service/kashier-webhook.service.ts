import {injectable, inject} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {IPaymentProvider} from "../../../pkg/payments/payment.interface";
import {KashierWebhookEnvelope} from "../../../pkg/payments/kashier/types";
import {OrderStatus} from "../../order/enums";
import {findOrderByPublicId, updateOrderStatus} from "../../order/repository/order.repo";
import {findItemsByOrderIds} from "../../order/repository/order-item.repo";
import {OrderSummaryResponseDTO, OrderStatusResponseDTO} from "../../order/dto/order.response.dto";
import {
    findLatestSessionByOrderId,
    updateSession,
} from "../repository/payment-session.repo";
import {
    createTransaction,
    findLatestRefundByOrderId,
    findTransactionsByOrderIds,
    updateTransaction,
} from "../repository/transaction.repo";
import {recordWebhookOrSkip, markWebhookProcessed} from "../repository/payment-webhook-event.repo";
import {
    PaymentSessionStatus,
    TransactionType,
    TransactionMethod,
    TransactionStatus,
    PAYMENT_PROVIDER_IDS,
    PaymentProviderName,
} from "../enums";
import {InvalidWebhookSignatureError, MalformedWebhookError} from "../errors";
import {insertOutboxEvent} from "../../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../../lib/events/event-types";

const KASHIER_PROVIDER_ID = PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER];

@injectable()
export class KashierWebhookService {
    constructor(@inject(TOKENS.KashierProvider) private readonly kashier: IPaymentProvider) {}

    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    /**
     * Top-level entry from WebhookController. Always returns void on success
     * — caller responds 200. Throws AppError on signature failure / malformed
     * payload (caller surfaces 401 / 400 respectively). Internal exceptions
     * during reconciliation are stamped as `process_error` and re-thrown so
     * Kashier retries.
     */
    async processKashierWebhook(rawBody: Buffer, signatureHeader: string | undefined, region: string): Promise<void> {
        const envelope = parseEnvelope(rawBody);
        if (!signatureHeader) throw InvalidWebhookSignatureError;

        const ok = this.kashier.verifyWebhook({
            payload: envelope.data as unknown as Record<string, unknown>,
            signatureKeys: envelope.data.signatureKeys ?? [],
            signature: signatureHeader,
        });
        if (!ok) throw InvalidWebhookSignatureError;

        const conn = db(region);

        // De-dupe at the SQL boundary. transactionId is stable across Kashier retries.
        const recorded = await recordWebhookOrSkip({
            region,
            providerId: KASHIER_PROVIDER_ID,
            providerEventId: envelope.data.transactionId,
            signature: signatureHeader,
            payload: envelope,
        }, conn);

        if (!recorded) {
            logger.info("kashier webhook duplicate, skipping", {transactionId: envelope.data.transactionId});
            return;
        }

        try {
            await this.reconcile(envelope, region);
            await markWebhookProcessed(recorded.id, null, conn);
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            logger.error("kashier webhook reconciliation failed", {transactionId: envelope.data.transactionId, error: msg});
            await markWebhookProcessed(recorded.id, msg, conn);
            throw err;
        }
    }

    private async reconcile(envelope: KashierWebhookEnvelope, region: string): Promise<void> {
        if (envelope.event === "refund") {
            await this.reconcileRefund(envelope, region);
            return;
        }

        if (envelope.event !== "pay") {
            logger.info("kashier webhook event ignored", {event: envelope.event});
            return;
        }

        const conn = db(region);
        const order = await findOrderByPublicId(envelope.data.merchantOrderId, conn);
        if (!order) {
            logger.warn("kashier webhook for unknown order", {merchantOrderId: envelope.data.merchantOrderId});
            return;
        }

        // Money can arrive late (slow checkout, third-party capture): after
        // this log support must reconcile manually against the transaction
        // ledger — nothing is silently dropped.
        if (
            envelope.data.status === "SUCCESS" &&
            order.status !== OrderStatus.PENDING_PAYMENT &&
            order.status !== OrderStatus.PLACED
        ) {
            logger.warn("kashier capture for order in unexpected state — needs manual review", {
                merchantOrderId: envelope.data.merchantOrderId,
                orderStatus: order.status,
                transactionId: envelope.data.transactionId,
                amount: sessionAmountNote(envelope),
            });
        }

        // The webhook's `kashierOrderId` is a transaction-level Kashier id, NOT
        // the session `_id` we stored as `provider_session_id`. So we resolve
        // the session via the order: latest session for this order. A session
        // stays payable within its expireAt even after a FAILED attempt
        // (Kashier maxFailureAttempts), so "latest regardless of status" is
        // what a SUCCESS must reconcile against.
        const session = await findLatestSessionByOrderId(order.id, conn);
        if (!session) {
            logger.warn("kashier webhook with no session for order", {
                merchantOrderId: envelope.data.merchantOrderId,
                kashierOrderId: envelope.data.kashierOrderId,
            });
            return;
        }

        const trx = await conn.transaction();
        try {
            // Transaction still in flight at the provider (e.g. wallet
            // confirmation). Nothing mutated yet — ack the webhook.
            if (envelope.data.status === "PENDING") {
                await trx.rollback();
                if (session.status === PaymentSessionStatus.INITIALIZED) {
                    await updateSession(session.id, {
                        status: PaymentSessionStatus.PENDING,
                        rawLastPayload: envelope,
                    }, conn);
                }
                return;
            }

            if (envelope.data.status === "SUCCESS") {
                await updateSession(session.id, {
                    status: PaymentSessionStatus.CAPTURED,
                    rawLastPayload: envelope,
                }, trx);

                await createTransaction({
                    region,
                    orderId: order.id,
                    transactionType: TransactionType.CHARGE,
                    method: TransactionMethod.ONLINE,
                    providerId: KASHIER_PROVIDER_ID,
                    providerReferenceId: envelope.data.transactionId,
                    status: TransactionStatus.SUCCEEDED,
                    amount: session.amount,
                    currency: session.currency,
                    srcAccId: order.customerId,
                    dstAccId: order.restaurantOwnerId,
                    idempotencyKey: `kashier:${envelope.data.transactionId}`,
                }, trx);

                // payment.completed — fired for both `pending_payment → placed`
                // captures and for any out-of-band capture events. In-trx.
                await insertOutboxEvent(trx, {
                    aggregateType: "payment",
                    aggregateId: order.publicId,
                    eventType: EVENT_TYPES.PAYMENT_COMPLETED,
                    payload: {
                        orderId: order.publicId,
                        region,
                        restaurantId: Number(order.restaurantId),
                        branchId: Number(order.branchId),
                        customerId: Number(order.customerId),
                        provider: "kashier",
                        providerReferenceId: envelope.data.transactionId,
                        amount: session.amount,
                        currency: session.currency,
                        method: "online",
                        completedAt: new Date().toISOString(),
                    },
                });

                if (order.status === OrderStatus.PENDING_PAYMENT) {
                    const placed = await updateOrderStatus(order.publicId, OrderStatus.PLACED, null, trx);

                    // Now the order is officially placed — emit order.placed
                    // for the analytics contract, items snapshot in the same trx.
                    const items = await findItemsByOrderIds([placed.id], trx);
                    await insertOutboxEvent(trx, {
                        aggregateType: "order",
                        aggregateId: placed.publicId,
                        eventType: EVENT_TYPES.ORDER_PLACED,
                        payload: {
                            orderId: placed.publicId,
                            region: placed.region,
                            countryCode: placed.countryCode,
                            restaurantId: Number(placed.restaurantId),
                            branchId: Number(placed.branchId),
                            customerId: Number(placed.customerId),
                            status: placed.status,
                            paymentMethod: placed.paymentMethod,
                            subtotal: placed.subtotal,
                            deliveryFee: placed.deliveryFee,
                            serviceFee: placed.serviceFee,
                            total: placed.total,
                            currency: placed.currency,
                            items: items.map((i) => ({
                                productId: Number(i.productId),
                                quantity: i.quantity,
                                unitPrice: i.unitPriceSnapshot,
                                lineTotal: i.lineTotal,
                            })),
                            placedAt: placed.createdAt.toISOString(),
                        },
                    });

                    await trx.commit();
                    // WS announcements after commit so we never publish a state we then roll back.
                    this.io.to(`branch:${placed.branchId}`).emit("order.created", OrderSummaryResponseDTO.from(placed, items.length));
                    this.io.to(`customer:${placed.customerId}`).emit("order.status_changed", OrderStatusResponseDTO.from(placed));
                    return;
                }
                await trx.commit();
                return;
            }

            // FAILED branch — record the failed charge for audit, leave order in pending_payment.
            await updateSession(session.id, {
                status: PaymentSessionStatus.FAILED,
                rawLastPayload: envelope,
            }, trx);

            await createTransaction({
                region,
                orderId: order.id,
                transactionType: TransactionType.CHARGE,
                method: TransactionMethod.ONLINE,
                providerId: KASHIER_PROVIDER_ID,
                providerReferenceId: envelope.data.transactionId,
                status: TransactionStatus.FAILED,
                amount: session.amount,
                currency: session.currency,
                srcAccId: order.customerId,
                dstAccId: null,
                idempotencyKey: `kashier:${envelope.data.transactionId}`,
            }, trx);

            await insertOutboxEvent(trx, {
                aggregateType: "payment",
                aggregateId: order.publicId,
                eventType: EVENT_TYPES.PAYMENT_FAILED,
                payload: {
                    orderId: order.publicId,
                    region,
                    restaurantId: Number(order.restaurantId),
                    branchId: Number(order.branchId),
                    customerId: Number(order.customerId),
                    provider: "kashier",
                    providerReferenceId: envelope.data.transactionId,
                    amount: session.amount,
                    currency: session.currency,
                    method: "online",
                    failedAt: new Date().toISOString(),
                },
            });

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    }

    private async reconcileRefund(envelope: KashierWebhookEnvelope, region: string): Promise<void> {
        const conn = db(region);
        const order = await findOrderByPublicId(envelope.data.merchantOrderId, conn);
        if (!order) {
            logger.warn("kashier refund webhook for unknown order", {
                merchantOrderId: envelope.data.merchantOrderId,
            });
            return;
        }

        const trx = await conn.transaction();
        try {
            let refundTx = await findLatestRefundByOrderId(order.id, trx);
            const orderTxs = await findTransactionsByOrderIds([order.id], trx);
            const chargeTx = orderTxs.find(
                (t) => t.transactionType === TransactionType.CHARGE && t.status === TransactionStatus.SUCCEEDED,
            );

            if (envelope.data.status === "SUCCESS") {
                if (!refundTx) {
                    refundTx = await createTransaction({
                        region,
                        orderId: order.id,
                        transactionType: TransactionType.REFUND,
                        method: TransactionMethod.ONLINE,
                        providerId: KASHIER_PROVIDER_ID,
                        providerReferenceId: envelope.data.transactionId,
                        status: TransactionStatus.SUCCEEDED,
                        amount: chargeTx ? chargeTx.amount : order.total,
                        currency: order.currency,
                        srcAccId: order.restaurantOwnerId,
                        dstAccId: order.customerId,
                        idempotencyKey: `kashier:refund:${envelope.data.transactionId}`,
                    }, trx);
                } else {
                    await updateTransaction(refundTx.id, {
                        status: TransactionStatus.SUCCEEDED,
                        providerReferenceId: envelope.data.transactionId,
                    }, trx);
                }

                if (chargeTx) {
                    await updateTransaction(chargeTx.id, {
                        isRefunded: true,
                        refundedPaymentId: refundTx.id,
                    }, trx);
                }

                await insertOutboxEvent(trx, {
                    aggregateType: "payment",
                    aggregateId: order.publicId,
                    eventType: EVENT_TYPES.PAYMENT_REFUNDED,
                    payload: {
                        orderId: order.publicId,
                        region,
                        restaurantId: Number(order.restaurantId),
                        branchId: Number(order.branchId),
                        customerId: Number(order.customerId),
                        provider: "kashier",
                        providerReferenceId: envelope.data.transactionId,
                        refundId: refundTx.id,
                        amount: refundTx.amount,
                        currency: refundTx.currency,
                        refundedAt: new Date().toISOString(),
                    },
                });

                await trx.commit();
                return;
            }

            // Refund failed at provider
            if (refundTx) {
                await updateTransaction(refundTx.id, {
                    status: TransactionStatus.FAILED,
                    providerReferenceId: envelope.data.transactionId,
                }, trx);
            }

            await insertOutboxEvent(trx, {
                aggregateType: "payment",
                aggregateId: order.publicId,
                eventType: EVENT_TYPES.PAYMENT_REFUND_FAILED,
                payload: {
                    orderId: order.publicId,
                    region,
                    refundId: refundTx?.id ?? null,
                    providerReferenceId: envelope.data.transactionId,
                    occurredAt: new Date().toISOString(),
                },
            });

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }
    }
}

function parseEnvelope(rawBody: Buffer): KashierWebhookEnvelope {
    let parsed: any;
    try {
        parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
        throw MalformedWebhookError;
    }
    if (!parsed?.event || !parsed?.data?.transactionId || !Array.isArray(parsed?.data?.signatureKeys)) {
        throw MalformedWebhookError;
    }
    return parsed as KashierWebhookEnvelope;
}

function sessionAmountNote(envelope: KashierWebhookEnvelope): string {
    return `${envelope.data.amount} ${envelope.data.currency}`;
}
