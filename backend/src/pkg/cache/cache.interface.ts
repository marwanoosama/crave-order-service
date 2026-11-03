
export interface ICacheProvider {
    

    
    get(key: string): Promise<string | null>;

    
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;

    
    del(key: string): Promise<number>;

    /**
     * Deletes every key matching a Redis-style glob pattern, e.g.
     * "eg:GET:/api/restaurants/x/branches/3/orders...". Best-effort collective
     * delete backed by SCAN — bounded, non-blocking.
     */
    delByPattern(pattern: string): Promise<number>;

    
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

    
    geosearchByRadius(
        key: string,
        fromLng: number,
        fromLat: number,
        radiusMeters: number,
        count: number,
    ): Promise<string[]>;
}
