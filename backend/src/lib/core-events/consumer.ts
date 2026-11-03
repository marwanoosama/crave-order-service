import {ConsumeMessage, IMessageBroker} from "../../pkg/messaging/message-broker.interface";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {cacheProvider} from "../cache/init";
import {CoreEventHandler, CoreEventEnvelope} from "./types";

const DEDUPE_TTL_SEC = 24 * 60 * 60;

const topology = {
    exchange: env.rabbit.exchange,
    queue: env.rabbit.queue,
    bindingKeys: env.rabbit.bindings,
    deadLetterExchange: env.rabbit.dlx,
    deadLetterQueue: env.rabbit.dlq,
    prefetch: env.rabbit.prefetch,
};

// Consume core-service events, skip duplicates, then call the matching handler.
export async function startCoreEventsConsumer(broker: IMessageBroker, handlers: Map<string, CoreEventHandler>): Promise<void> {
    await broker.consume(topology, async (msg: ConsumeMessage) => {
        let event: CoreEventEnvelope;
        try {
            event = JSON.parse(msg.body.toString("utf8")) as CoreEventEnvelope;
        } catch {
            msg.nack(false);
            return;
        }

        if (!event.eventId || !event.eventType) {
            msg.nack(false);
            return;
        }

        // Dedupe marker is claimed up front to collapse bursts of identical
        // deliveries, but on REDelivery we still run the handler: all
        // handlers are idempotent cache invalidations, and skipping would
        // break at-least-once semantics (the cursor may have died before
        // the handler completed).
        const firstDelivery = await cacheProvider.trySet(`core-events:dedupe:${event.eventId}`, "1", DEDUPE_TTL_SEC);
        if (!firstDelivery) {
            logger.info("core-events: redelivery, re-processing idempotent handler", {
                eventType: event.eventType,
                eventId: event.eventId,
            });
        }

        const handler = handlers.get(event.eventType);
        if (!handler) {
            logger.warn("core-events: no handler, acking", {
                eventType: event.eventType,
                eventId: event.eventId,
            });
            msg.ack();
            return;
        }

        try {
            await handler(event.payload);
            msg.ack();
        } catch (err) {
            logger.error("core-events: handler failed, sending to DLQ", {
                eventType: event.eventType,
                eventId: event.eventId,
                error: (err as Error).message,
            });
            msg.nack(false);
        }
    });

    logger.info("core-events consumer started", {
        queue: env.rabbit.queue,
        bindings: env.rabbit.bindings,
    });
}
