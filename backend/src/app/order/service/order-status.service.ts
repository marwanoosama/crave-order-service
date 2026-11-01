import {OrderStatus, StatusActor} from "../enums";
import {CancellationWindowExpiredError, invalidStatusTransitionError, ReasonRequiredError} from "../errors";
import {AssertTransitionContext, AssertTransitionResult} from "../types";

interface TransitionRule {
    actors: StatusActor[];
    stamp: string | null;
    reasonRequired?: boolean;
}

const TRANSITIONS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, TransitionRule>>>> = {
    [OrderStatus.PENDING_PAYMENT]: {
        [OrderStatus.PLACED]: {actors: [StatusActor.SYSTEM], stamp: null},
        [OrderStatus.CANCELLED]: {actors: [StatusActor.CUSTOMER, StatusActor.SYSTEM], stamp: "cancelled_at"},
    },
    [OrderStatus.PLACED]: {
        [OrderStatus.ACCEPTED]: {actors: [StatusActor.RESTAURANT_MEMBER], stamp: "accepted_at"},
        [OrderStatus.REJECTED]: {
            actors: [StatusActor.RESTAURANT_MEMBER],
            stamp: "rejected_at",
            reasonRequired: true,
        },
        [OrderStatus.CANCELLED]: {
            actors: [StatusActor.CUSTOMER, StatusActor.RESTAURANT_MEMBER, StatusActor.SYSTEM, StatusActor.ADMIN],
            stamp: "cancelled_at",
            reasonRequired: true,
        },
    },
    [OrderStatus.ACCEPTED]: {
        [OrderStatus.PREPARING]: {actors: [StatusActor.RESTAURANT_MEMBER], stamp: null},
        [OrderStatus.CANCELLED]: {
            actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN],
            stamp: "cancelled_at",
            reasonRequired: true,
        },
    },
    [OrderStatus.PREPARING]: {
        [OrderStatus.READY]: {actors: [StatusActor.RESTAURANT_MEMBER], stamp: "ready_at"},
        [OrderStatus.CANCELLED]: {
            actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN],
            stamp: "cancelled_at",
            reasonRequired: true,
        },
    },
    [OrderStatus.READY]: {
        [OrderStatus.ASSIGNED]: {actors: [StatusActor.SYSTEM], stamp: "assigned_at"},
        [OrderStatus.CANCELLED]: {
            actors: [StatusActor.RESTAURANT_MEMBER, StatusActor.ADMIN],
            stamp: "cancelled_at",
            reasonRequired: true,
        },
    },
    [OrderStatus.ASSIGNED]: {
        [OrderStatus.PICKED]: {actors: [StatusActor.AGENT], stamp: "picked_at"},
        [OrderStatus.CANCELLED]: {
            actors: [StatusActor.ADMIN],
            stamp: "cancelled_at",
            reasonRequired: true,
        },
    },
    [OrderStatus.PICKED]: {
        [OrderStatus.DELIVERED]: {actors: [StatusActor.AGENT], stamp: "delivered_at"},
    },
};

const CUSTOMER_CANCEL_WINDOW_MS = 60 * 1000;

export function assertTransition(
    from: OrderStatus,
    to: OrderStatus,
    ctx: AssertTransitionContext,
): AssertTransitionResult {
    const rule = TRANSITIONS[from]?.[to];
    if (!rule || !rule.actors.includes(ctx.actor)) {
        throw invalidStatusTransitionError(from, to);
    }

    if (rule.reasonRequired && !ctx.reason?.trim()) {
        throw ReasonRequiredError;
    }

    if (ctx.actor === StatusActor.CUSTOMER && from === OrderStatus.PLACED && to === OrderStatus.CANCELLED) {
        if (ctx.acceptedAt) throw CancellationWindowExpiredError;
        if (ctx.placedAt && Date.now() - ctx.placedAt.getTime() > CUSTOMER_CANCEL_WINDOW_MS) {
            throw CancellationWindowExpiredError;
        }
    }

    return {stamp: rule.stamp};
}
