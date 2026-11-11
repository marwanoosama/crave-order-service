import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {env} from "../../../lib/config/env";
import {db} from "../../../lib/knex/knex";
import {ICacheProvider} from "../../../lib/cache/redis";
import {OrderStatus} from "../../order/enums";
import {OfflineWhilePickedForbidden} from "../errors";

/*
  * delivery agents are stored in 3 separate key-value redis pairs
  * 1.meta key (value is a hash, each agent and his data) => Key: presence:meta:eg:agent-101, value: lat: 33.1, lng: 31.2, lastSeenAt: 123456
  * 2.geo-key (value is a list containing all agents with their lng, lat, lastseen) => key: (presence:geo:eg), value: ([(agent-101, 31.2, 30,5), (agent-102, 31.1, 30,9), ...])
  * 3.busty-key (value is a set containing busy agents )
*/

@injectable()
export class PresenceService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    // one agent's record: (lat, lng, last seen at)
    // Key: presence:meta:eg:agent-101
    // value:
    // lat: 33.1, lng: 31.2, lastSeenAt: 123456
    static metaKey(region: string, agentId: number): string {
        return `presence:meta:${region}:${agentId}`;
    }

    // agents are stored in one list, key: (presence:geo:eg), value: ([(agent-101, 31.2, 30,5), (agent-102, 31.1, 30,9), ...])
    static geoKey(region: string): string {
        return `presence:geo:${region}`;
    }

    // busy agents are stored in a set key: (presence:busy:eg, value: [agent-101, agent-102, agent-103, ....])
    static busyKey(region: string): string {
        return `presence:busy:${region}`;
    }

    // update or insert agent's location
    async upsert(region: string, agentId: number, lat: number, lng: number): Promise<void> {
        const ttl = env.delivery.presenceStaleSec;
        // hash set, stores named fields
        // Key: presence:meta:eg:agent-101
        // value:
        // lat: 33.1, lng: 31.2, lastSeenAt: 123456
        await this.cache.hsetWithTtl(PresenceService.metaKey(region, agentId), {lat: String(lat), lng: String(lng), lastSeenAt: String(Date.now())}, ttl);

        // adds it to the list with other agents
        // agents are stored in one list, key: (agents), value: ([(agent-101, 31.2, 30,5), (agent-102, 31.1, 30,9), ...])
        await this.cache.geoadd(PresenceService.geoKey(region), lng, lat, String(agentId));
    }

    async goOffline(region: string, agentId: number): Promise<void> {
        const conn = db(region);
        const stuck = await conn("orders")
            .select("public_id", "status")
            .where({delivery_agent_id: agentId, status: OrderStatus.PICKED})
            .first();
        if (stuck) throw OfflineWhilePickedForbidden;

        await conn("orders")
            .where({delivery_agent_id: agentId, status: OrderStatus.ASSIGNED})
            .update({delivery_agent_id: null, status: OrderStatus.READY, assigned_at: null, updated_at: conn.fn.now()});

        await this.cache.del(PresenceService.metaKey(region, agentId));
        await this.cache.zrem(PresenceService.geoKey(region), String(agentId)); // remove from geo region list
        await this.cache.srem(PresenceService.busyKey(region), String(agentId));
    }

    async markBusy(region: string, agentId: number): Promise<void> {
        await this.cache.sadd(PresenceService.busyKey(region), String(agentId));
    }

    async clearBusy(region: string, agentId: number): Promise<void> {
        await this.cache.srem(PresenceService.busyKey(region), String(agentId));
    }
}
