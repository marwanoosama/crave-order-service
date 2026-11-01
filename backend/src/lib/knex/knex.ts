import {Knex} from "knex";
import {destroyAllShards, getArchiveShard, getHotShard, listConfiguredRegions} from "./shards";


export function db(region: string): Knex {
    return getHotShard(region);
}


export function dbArchive(region: string): Knex {
    return getArchiveShard(region);
}

export async function destroyAll(): Promise<void> {
    await destroyAllShards();
}

export interface ShardPing {
    region: string;
    cluster: "hot" | "archive";
    ok: boolean;
    error?: string;
}

export async function pingAll(): Promise<ShardPing[]> {
    const out: ShardPing[] = [];
    for (const region of listConfiguredRegions("hot")) {
        out.push(await pingOne(region, "hot"));
    }
    
    for (const region of listConfiguredRegions("archive")) {
        out.push(await pingOne(region, "archive"));
    }
    return out;
}

async function pingOne(region: string, cluster: "hot" | "archive"): Promise<ShardPing> {
    try {
        const conn = cluster === "hot" ? getHotShard(region) : getArchiveShard(region);
        await conn.raw("SELECT 1");
        return {region, cluster, ok: true};
    } catch (err) {
        return {region, cluster, ok: false, error: (err as Error).message};
    }
}
