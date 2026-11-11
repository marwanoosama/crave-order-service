import type {ConsumeMessage as AmqpConsumeMessage} from "amqplib";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {cacheProvider} from "../cache/redis";
import {messageBroker} from "../messaging";

// Safety window for redelivery (consumer restart, nack-requeue, ops DLQ replay).
// Longer than realistic redelivery lag, short enough to keep Redis bounded.
// Safe to expire: all handlers are idempotent cache invalidations.
const DEDUPE_TTL_SEC = 24 * 60 * 60;


const handlers = new Map<string, (payload: unknown) => Promise<void>>();

export function registerHandler(eventType: string, handler: (payload: unknown) => Promise<void>): void {
    if (handlers.has(eventType)) {
        throw new Error(`Handler already registered for ${eventType}`);
    }
    handlers.set(eventType, handler);
}

const CORE_EVENTS = {
    exchange: env.rabbit.exchange,
    queue: env.rabbit.queue,
    bindingKeys: env.rabbit.bindings,
    deadLetterExchange: env.rabbit.dlx,
    deadLetterQueue: env.rabbit.dlq,
    prefetch: env.rabbit.prefetch,
};

export async function startCoreEventsConsumer(): Promise<void> {
    await messageBroker.consume(CORE_EVENTS, onMessage);
    logger.info("core-events consumer started", {
        queue: env.rabbit.queue,
        bindings: env.rabbit.bindings,
    });
}

async function onMessage(raw: AmqpConsumeMessage, ack: () => void, reject: () => void): Promise<void> {
    // parse the envelope. Unparseable → dead-letter queue, never lost.
    let envelope: {eventId?: unknown; eventType?: unknown; payload?: unknown};
    try {
        envelope = JSON.parse(raw.content.toString("utf8"));
    } catch {
        return reject();
    }
    if (typeof envelope.eventId !== "string" || typeof envelope.eventType !== "string") {
        return reject();
    }

    // dedupe (Redis SETNX with TTL): a redelivery of the same eventId is a no-op.
    const fresh = await cacheProvider.trySet(
        `core-events:dedupe:${envelope.eventId}`,
        "1",
        DEDUPE_TTL_SEC,
    );
    if (!fresh) return ack();

    // route: event types we never registered for are acked and dropped.
    const handler = handlers.get(envelope.eventType);
    if (!handler) {
        logger.warn("core-events: no handler, acking", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
        });
        return ack();
    }

    // run, then confirm. Handler failure → dead-letter queue.
    try {
        await handler(envelope.payload);
        ack();
    } catch (err) {
        logger.error("core-events: handler failed, sending to DLQ", {
            eventType: envelope.eventType,
            eventId: envelope.eventId,
            error: (err as Error).message,
        });
        reject();
    }
}
