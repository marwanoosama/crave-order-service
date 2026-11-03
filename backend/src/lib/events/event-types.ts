export const EVENT_TYPES = {
    ORDER_PLACED: "order.placed",
    ORDER_ACCEPTED: "order.accepted",
    ORDER_REJECTED: "order.rejected",
    ORDER_DELIVERED: "order.delivered",
    ORDER_CANCELLED: "order.cancelled",
    PAYMENT_COMPLETED: "payment.completed",
    PAYMENT_FAILED: "payment.failed",
    PAYMENT_REFUNDED: "payment.refunded",
    PAYMENT_REFUND_FAILED: "payment.refund_failed",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
