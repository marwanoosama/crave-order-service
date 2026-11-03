import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {logger} from "../../../lib/logger/logger";
import {fromMinor} from "../../../pkg/utils/money";
import {toMs} from "../../../pkg/utils/time";
import {env} from "../../../lib/config/env";
import {IPaymentProvider} from "../../../pkg/payments/payment.interface";
import {findOrderById, findOrderByPublicId} from "../../order/repository/order.repo";
import {OrderEntity} from "../../order/entity/order.entity";
import {OrderStatus} from "../../order/enums";
import {UnAuthorisedError} from "../../../lib/auth/errors";
import {
    createSession,
    findActiveSessionByOrderId,
} from "../repository/payment-session.repo";
import {
    createTransaction,
    findTransactionById,
    findTransactionByIdempotencyKey,
    findTransactionWithRestaurant,
    updateTransaction,
} from "../repository/transaction.repo";
import {PaymentSessionEntity} from "../entity/payment-session.entity";
import {
    PaymentSessionStatus,
    PaymentProviderName,
    PAYMENT_PROVIDER_IDS,
    TransactionType,
    TransactionStatus,
} from "../enums";
import {PaymentInitResponseDTO, PaymentResponseDTO} from "../dto/payment.response.dto";
import {RefundRequestDTO} from "../dto/payment.request.dto";
import {OrderNotFoundError} from "../../order/errors";
import {
    InvalidRefundAmountError,
    OrderNotPendingPaymentError,
    PaymentAlreadyRefundedError,
    PaymentCannotBeRefundedError,
    PaymentNotFoundError,
    PaymentProviderUnavailableError,
} from "../errors";

/**
 * The per-session `serverWebhook` destination Kashier calls back for this
 * order. The region query param is the only sharding hint Kashier can carry
 * (it cannot set custom headers on the callback). Returns undefined when no
 * public webhook URL is configured (e.g. local dev) — Kashier then skips the
 * callback and confirmation falls back to manual/provider verification.
 */
export function buildSessionWebhookUrl(region: string): string | undefined {
    const base = env.kashier.webhookUrl.trim();
    if (!base) return undefined;
    return base.includes("?")
        ? `${base}&region=${encodeURIComponent(region)}`
        : `${base}?region=${encodeURIComponent(region)}`;
}

interface InitOnlinePaymentResult {
    session: PaymentSessionEntity;
    expiresAt: string;
    dto: PaymentInitResponseDTO;
}

@injectable()
export class PaymentService {
    constructor(@inject(TOKENS.KashierProvider) private readonly kashier: IPaymentProvider) {}

    /**
     * POST /payments/init.
     *
     * Customer-indexable entry point: the client (re)requests the checkout
     * session for an order that is still awaiting payment. Idempotent at the
     * domain level — an existing active session is returned as-is.
     */
    async init(actor: {userId: number; role: string}, region: string, orderId: string): Promise<PaymentInitResponseDTO> {
        if (actor.role !== "customer") throw UnAuthorisedError;

        const order = await findOrderByPublicId(orderId, db(region));
        if (!order) throw OrderNotFoundError;
        if (Number(order.customerId) !== Number(actor.userId)) throw UnAuthorisedError;
        if (order.status !== OrderStatus.PENDING_PAYMENT) throw OrderNotPendingPaymentError;

        const {dto} = await this.initOnlinePayment(order);
        return dto;
    }

    /**
     * Called from OrderService.placeOrder for online orders, AFTER the order
     * row has been committed.
     *
     * Idempotent at the domain level: if an active session exists for this
     * order (initialized/pending), we return its redirectUrl rather than
     * minting a second one.
     */
    async initOnlinePayment(order: OrderEntity): Promise<InitOnlinePaymentResult> {
        const conn = db(order.region);
        const sessionTtlMs = toMs(env.payments.sessionTimeoutMin, "m");

        const existing = await findActiveSessionByOrderId(order.id, conn);
        if (existing) {
            // Session already alive — surface it as-is. Kashier's iframe enforces its own expireAt.
            const expiresAt = new Date(existing.createdAt.getTime() + sessionTtlMs).toISOString();
            return {
                session: existing,
                expiresAt,
                dto: PaymentInitResponseDTO.from(existing, expiresAt),
            };
        }

        let providerResp;
        try {
            providerResp = await this.kashier.createSession({
                merchantOrderId: order.publicId,
                amount: fromMinor(order.total).toFixed(2),
                currency: order.currency,
                description: `Crave order ${order.publicId}`,
                allowedMethods: "card,wallet",
                serverWebhookUrl: buildSessionWebhookUrl(order.region),
                customerReference: String(order.customerId),
            });
        } catch (err) {
            logger.error("kashier createSession failed", {
                orderPublicId: order.publicId,
                error: (err as Error).message,
            });
            throw PaymentProviderUnavailableError;
        }

        const session = await createSession({
            region: order.region,
            orderId: order.id,
            providerId: PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER],
            providerSessionId: providerResp.providerSessionId,
            redirectUrl: providerResp.redirectUrl,
            amount: order.total,
            currency: order.currency,
            status: PaymentSessionStatus.INITIALIZED,
            rawInitPayload: providerResp.rawResponse,
        }, conn);

        const expiresAt = providerResp.expiresAt
            ?? new Date(Date.now() + sessionTtlMs).toISOString();

        return {
            session,
            expiresAt,
            dto: PaymentInitResponseDTO.from(session, expiresAt),
        };
    }

    /**
     * GET /payments/:paymentId or /restaurants/:restaurantId/payments/:paymentId.
     *
     * - system_admin: can read any payment in the region.
     * - restaurant_user: must belong to the restaurant owning the transaction.
     * - customer: must be the paying customer (srcAccId).
     */
    async getById(
        actor: {userId: number; role: string; restaurantId?: number},
        paymentId: number,
        region: string,
        restaurantIdParam?: number,
    ): Promise<PaymentResponseDTO> {
        const conn = db(region);
        const found = await findTransactionWithRestaurant(paymentId, conn);
        if (!found) throw PaymentNotFoundError;

        if (actor.role === "system_admin") {
            return PaymentResponseDTO.from(found.transaction);
        }

        if (actor.role === "restaurant_user") {
            const expectedRestId = restaurantIdParam ?? actor.restaurantId;
            if (found.restaurantId !== null && Number(found.restaurantId) !== Number(expectedRestId)) {
                throw UnAuthorisedError;
            }
            return PaymentResponseDTO.from(found.transaction);
        }

        if (actor.role === "customer") {
            if (
                Number(found.transaction.srcAccId) !== Number(actor.userId) &&
                Number(found.transaction.dstAccId) !== Number(actor.userId)
            ) {
                throw UnAuthorisedError;
            }
            return PaymentResponseDTO.from(found.transaction);
        }

        throw UnAuthorisedError;
    }

    /**
     * POST /payments/:paymentId/refund.
     *
     * Admin-only refund entry point.
     * Idempotent: replaying with the same Idempotency-Key returns the existing
     * pending/succeeded refund transaction.
     */
    async refund(
        actor: {userId: number; role: string},
        region: string,
        paymentId: number,
        body: RefundRequestDTO,
        idempotencyKey?: string,
    ): Promise<{refundId: number; status: string; amount: number; currency: string}> {
        if (actor.role !== "system_admin") throw UnAuthorisedError;

        const conn = db(region);
        const chargeTx = await findTransactionById(paymentId, conn);
        if (!chargeTx) throw PaymentNotFoundError;

        if (chargeTx.transactionType !== TransactionType.CHARGE || chargeTx.status !== TransactionStatus.SUCCEEDED) {
            throw PaymentCannotBeRefundedError;
        }

        if (chargeTx.isRefunded) {
            throw PaymentAlreadyRefundedError;
        }

        const refundAmount = body.amount !== undefined ? body.amount : chargeTx.amount;
        if (refundAmount <= 0 || refundAmount > chargeTx.amount) {
            throw InvalidRefundAmountError;
        }

        const effectiveKey = idempotencyKey ?? `refund:${paymentId}:${chargeTx.providerReferenceId ?? "default"}`;
        const existing = await findTransactionByIdempotencyKey(effectiveKey, conn);
        if (existing) {
            return {
                refundId: existing.id,
                status: existing.status,
                amount: existing.amount,
                currency: existing.currency,
            };
        }

        const order = chargeTx.orderId ? await findOrderById(chargeTx.orderId, conn) : undefined;

        const refundTx = await createTransaction({
            region,
            orderId: chargeTx.orderId,
            transactionType: TransactionType.REFUND,
            method: chargeTx.method,
            providerId: chargeTx.providerId,
            providerReferenceId: null,
            status: TransactionStatus.PENDING,
            amount: refundAmount,
            currency: chargeTx.currency,
            srcAccId: chargeTx.dstAccId,
            dstAccId: chargeTx.srcAccId,
            idempotencyKey: effectiveKey,
        }, conn);

        if (chargeTx.providerId === PAYMENT_PROVIDER_IDS[PaymentProviderName.KASHIER]) {
            try {
                const kashierRes = await this.kashier.refund({
                    kashierOrderId: order ? order.publicId : (chargeTx.providerReferenceId ?? String(chargeTx.id)),
                    targetTransactionId: chargeTx.providerReferenceId ?? undefined,
                    amount: fromMinor(refundAmount).toFixed(2),
                    currency: chargeTx.currency,
                    reason: body.reason,
                });
                if (kashierRes.providerRefundId) {
                    await updateTransaction(refundTx.id, {providerReferenceId: kashierRes.providerRefundId}, conn);
                }
            } catch (err) {
                logger.error("kashier refund call failed", {
                    paymentId,
                    refundTxId: refundTx.id,
                    error: (err as Error).message,
                });
                await updateTransaction(refundTx.id, {status: TransactionStatus.FAILED}, conn);
                throw PaymentProviderUnavailableError;
            }
        }

        return {
            refundId: refundTx.id,
            status: refundTx.status,
            amount: refundTx.amount,
            currency: refundTx.currency,
        };
    }
}
