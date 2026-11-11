import "reflect-metadata";
import http from "http";
import {container} from "tsyringe";
import {logger} from "./lib/logger/logger";
import {destroyAll, pingAll} from "./lib/knex/knex";
import {messageBroker} from "./lib/messaging";
import {startCoreEventsConsumer} from "./lib/core-events/consumer";
import {attachWsServer} from "./lib/websocket/ws-server";
import {TOKENS} from "./lib/di/tokens";
import {cacheProvider} from "./lib/cache/redis";
import {CoreDataCacheService} from "./app/order/service/core-data-cache.service";
import {PermissionCacheService} from "./lib/rbac/permission-cache.service";
import {PresenceService} from "./app/agent/service/presence.service";
import {startAll, stopAll} from "./lib/jobs";
import {registerOrderModuleCoreEventHandlers} from "./app/order/core-events.handlers";
import {registerAssignmentJobs} from "./app/assignment/jobs";
import {registerOutboxDrainJobs} from "./lib/events/jobs";

const noopServer = http.createServer();
const io = attachWsServer(noopServer);

container.registerInstance(TOKENS.WsServer, io);
container.registerInstance(TOKENS.CacheProvider, cacheProvider);

registerOrderModuleCoreEventHandlers({
    coreData: new CoreDataCacheService(cacheProvider),
    perms: new PermissionCacheService(),
});

registerAssignmentJobs({
    cache: cacheProvider,
    presence: new PresenceService(cacheProvider),
});

registerOutboxDrainJobs();

async function main() {
    noopServer.listen(0);

    const shards = await pingAll();
    for (const r of shards) {
        if (r.ok) logger.info("worker shard reachable", {region: r.region, cluster: r.cluster});
        else logger.warn("worker shard unreachable", {region: r.region, cluster: r.cluster, error: r.error});
    }

    // starts a consumer that waits for new messages sent by the producer, then for each message it dedupes it first (skips if this eventId already ran), executes what should be executed using the handler looked up by the event's type, and confirms it when done — or sends it to the DLQ if it's garbage or the handler fails.
    startCoreEventsConsumer().catch((err) => logger.warn("worker rabbitmq not reachable at boot", {err}));

    startAll();
}

async function shutdown() {
    logger.info("worker shutdown requested");
    await stopAll();
    try { await io.close(); } catch {}
    try { await messageBroker.close(); } catch {}
    try { await destroyAll(); } catch {}
    noopServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
    logger.error("worker boot failed", {error: (err as Error).message});
    process.exit(1);
});
