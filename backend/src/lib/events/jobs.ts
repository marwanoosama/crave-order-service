import {register} from "../jobs/job-registry";
import {env} from "../config/env";
import {logger} from "../logger/logger";
import {messageBroker} from "../messaging/init";
import {publishPendingOutboxEvents} from "./outbox-drain";

export function registerOutboxDrainJobs(): void {
    const everyNSec = `*/${env.outboundEvents.drainTickSec} * * * * *`;

    messageBroker
        .connect()
        .then(() =>
            messageBroker.declareTopology({
                exchange: env.outboundEvents.exchange,
                queue: "__outbox-drain-noop__",
                bindingKeys: [],
                prefetch: 1,
            }),
        )
        .catch((err) =>
            logger.warn("outbound exchange setup failed (will retry on first publish)", {
                error: (err as Error).message,
            }),
        );

    for (const region of env.regions) {
        register({
            name: `outbox-drain:${region}`,
            cron: everyNSec,
            handler: async () => {
                try {
                    await publishPendingOutboxEvents(region);
                } catch (err) {
                    logger.error("outbox-drain failed", {region, error: (err as Error).message});
                }
            },
        });
    }
}
