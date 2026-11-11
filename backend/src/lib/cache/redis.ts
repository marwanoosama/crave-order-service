// noinspection SpellCheckingInspection

import Redis from "ioredis";
import {Request, Response, NextFunction} from "express";
import {env} from "../config/env";
import {container} from "tsyringe";
import {TOKENS} from "../di/tokens";

export interface ICacheProvider {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<number>;
    trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
    exists(key: string): Promise<boolean>;
    incr(key: string): Promise<number>;
    expire(key: string, ttlSeconds: number): Promise<void>;
    ttl(key: string): Promise<number>;
    hsetWithTtl(key: string, fields: Record<string, string>, ttlSeconds?: number): Promise<void>;
    sadd(key: string, member: string): Promise<void>;
    srem(key: string, member: string): Promise<void>;
    sismember(key: string, member: string): Promise<boolean>;
    geoadd(key: string, lng: number, lat: number, member: string): Promise<void>;
    zrem(key: string, member: string): Promise<void>;
    geosearchByRadius(key: string, fromLng: number, fromLat: number, radiusMeters: number, count: number): Promise<string[]>;
}

export const redisClient = new Redis({host: env.redis.host, port: env.redis.port, password: env.redis.password, lazyConnect: true, maxRetriesPerRequest: 3});

redisClient.on("error", (err) => console.error("Redis Error:", err.message));
redisClient.connect().catch((err) => console.error("Redis Connect Error:", err.message));

export class RedisCacheProvider implements ICacheProvider {
    constructor(public readonly client: Redis) {}

    async get(key: string): Promise<string | null> {
        return this.client.get(key);
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
        else await this.client.set(key, value);
    }

    async del(key: string): Promise<number> {
        return this.client.del(key);
    }

    async trySet(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
        const res = ttlSeconds ? await this.client.set(key, value, "EX", ttlSeconds, "NX") : await this.client.set(key, value, "NX");
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

    async hsetWithTtl(key: string, fields: Record<string, string>, ttlSeconds?: number): Promise<void> {
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

    // remove from sorted set
    async zrem(key: string, member: string): Promise<void> {
        await this.client.zrem(key, member);
    }

    // agents are stored in one list, key: (agents), value: ([(agent-101, 31.2, 30,5), (agent-102, 31.1, 30,9), ...])
    async geoadd(key: string, lng: number, lat: number, member: string): Promise<void> {
        await this.client.geoadd(key, lng, lat, member);
    }

    // gets nearby agents' id's
    async geosearchByRadius(key: string, fromLng: number, fromLat: number, radiusMeters: number, count: number): Promise<string[]> {
        const raw = (await this.client.geosearch(key, "FROMLONLAT", fromLng, fromLat, "BYRADIUS", radiusMeters, "m", "ASC", "COUNT", count)) as string[];
        return raw;
    }
}

export const cacheProvider = new RedisCacheProvider(redisClient);

export function withCache(ttl = 3600, userScoped = false) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            let key = `${req.method}:${req.originalUrl}`;
            if (userScoped) key = `${key}:${req.user?.userId}`;
            if (req.region) key = `${req.region}:${key}`;

            const cached = await cacheProvider.get(key);
            if (cached) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).json(JSON.parse(cached));
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if (res.statusCode >= 200 && res.statusCode < 300) cacheProvider.set(key, JSON.stringify(body), ttl).catch(() => {});
                res.setHeader("X-Cache", "MISS");
                return originalJson(body);
            }) as Response["json"];
            next();
        } catch (err) {
            next(err);
        }
    };
}
