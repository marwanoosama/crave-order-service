import Redis from "ioredis";
import type {ICacheProvider} from "./cache.interface";

export class RedisCacheProvider implements ICacheProvider {
    
    constructor(public readonly client: Redis) {}

    

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, "EX", ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    /**
     * SCAN-based collective delete. Never uses KEYS (blocks the Redis
     * server); batches every 200 scanned keys to cap growth in fan-outs.
     */
    async delByPattern(pattern: string): Promise<number> {
        let cursor = "0";
        let deleted = 0;
        let batch: string[] = [];

        do {
            const [next, keys] = await this.client.scan(
                cursor,
                "MATCH",
                pattern,
                "COUNT",
                200,
            );
            cursor = next;
            if (keys.length > 0) batch = batch.concat(keys);
            if (batch.length > 0 && (cursor === "0" || batch.length >= 500)) {
                deleted += await this.client.del(...batch);
                batch = [];
            }
        } while (cursor !== "0");

        if (batch.length > 0) {
            deleted += await this.client.del(...batch);
        }
        return deleted;
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds
            ? await this.client.set(key, value, "EX", ttlSeconds, "NX")
            : await this.client.set(key, value, "NX");
        return res === "OK";
    }

    async exists(key: string): Promise<boolean> {
        return (await this.client.exists(key)) === 1;
    }

    async incr(key: string): Promise<number> {
        return this.client.incr(key);
    }

    async expire(key: string, ttlSeconds: number): Promise<void> {
        await this.client.expire(key, ttlSeconds);
    }

    async ttl(key: string): Promise<number> {
        return this.client.ttl(key);
    }

    

    async hsetWithTtl(
        key: string,
        fields: Record<string, string>,
        ttlSeconds?: number,
    ): Promise<void> {
        
        
        
        const tx = this.client.multi().hset(key, fields);
        if (ttlSeconds) tx.expire(key, ttlSeconds);
        await tx.exec();
    }

    

    async sadd(key: string, member: string): Promise<void> {
        await this.client.sadd(key, member);
    }

    async srem(key: string, member: string): Promise<void> {
        await this.client.srem(key, member);
    }

    async sismember(key: string, member: string): Promise<boolean> {
        return (await this.client.sismember(key, member)) === 1;
    }

    

    async geoadd(key: string, lng: number, lat: number, member: string): Promise<void> {
        await this.client.geoadd(key, lng, lat, member);
    }
    

    async zrem(key: string, member: string): Promise<void> {
        await this.client.zrem(key, member);
    }

    async geosearchByRadius(
        key: string,
        fromLng: number,
        fromLat: number,
        radiusMeters: number,
        count: number,
    ): Promise<string[]> {
        const raw = (await this.client.geosearch(
            key,
            "FROMLONLAT",
            fromLng,
            fromLat,
            "BYRADIUS",
            radiusMeters,
            "m",
            "ASC",
            "COUNT",
            count,
        )) as string[];
        return raw;
    }
}
