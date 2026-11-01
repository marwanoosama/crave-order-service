import {coreClient} from "./core-client";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {toSeconds} from "../../pkg/utils/time";
import {logger} from "../logger/logger";
import {CoreEnvelope,CoreBranchMetadata,CoreBranchProduct,ReserveStockItem,ReserveStockResult,} from "./types";

const BRANCH_CACHE_TTL = toSeconds(1, "h");
const PRODUCT_CACHE_TTL = toSeconds(1, "h");

function branchCacheKey(branchId: number): string {
    return `core:branch:${branchId}`;
}

function productCacheKey(branchId: number, productId: number): string {
    return `core:branch:${branchId}:product:${productId}`;
}

function cache(): ICacheProvider {
    return container.resolve<ICacheProvider>(TOKENS.CacheProvider);
}


export async function getBranch(branchId: number, correlationId?: string): Promise<CoreBranchMetadata> {
    const c = cache();
    const cached = await c.get(branchCacheKey(branchId));
    if (cached) {
        try { return JSON.parse(cached) as CoreBranchMetadata; } catch {  }
    }
    const res = await coreClient.request<CoreEnvelope<CoreBranchMetadata>>({
        method: "GET",
        path: `/api/internal/branches/${branchId}`,
        correlationId,
    });
    await c.set(branchCacheKey(branchId), JSON.stringify(res.data), BRANCH_CACHE_TTL).catch((err) => {
        logger.warn("getBranch cache set failed", {branchId, error: (err as Error).message});
    });
    return res.data;
}


export async function getBranchesByIds(
    branchIds: number[],
    correlationId?: string,
): Promise<Map<number, CoreBranchMetadata>> {
    const result = new Map<number, CoreBranchMetadata>();
    if (branchIds.length === 0) return result;
    const unique = Array.from(new Set(branchIds));
    const c = cache();

    
    const misses: number[] = [];
    await Promise.all(
        unique.map(async (id) => {
            const raw = await c.get(branchCacheKey(id));
            if (raw) {
                try {
                    result.set(id, JSON.parse(raw) as CoreBranchMetadata);
                    return;
                } catch {  }
            }
            misses.push(id);
        }),
    );
    if (misses.length === 0) return result;

    
    const ids = misses.join(",");
    const res = await coreClient.request<CoreEnvelope<CoreBranchMetadata[]>>({
        method: "GET",
        path: `/api/internal/branches?ids=${encodeURIComponent(ids)}`,
        correlationId,
    });
    await Promise.all(
        res.data.map(async (b) => {
            result.set(Number(b.id), b);
            await c.set(branchCacheKey(Number(b.id)), JSON.stringify(b), BRANCH_CACHE_TTL).catch(() => {});
        }),
    );
    return result;
}


export async function getBranchProducts(
    branchId: number,
    productIds: number[],
    correlationId?: string,
): Promise<CoreBranchProduct[]> {
    if (productIds.length === 0) return [];
    const c = cache();
    const unique = Array.from(new Set(productIds));
    const cached: CoreBranchProduct[] = [];
    const misses: number[] = [];

    await Promise.all(
        unique.map(async (pid) => {
            const raw = await c.get(productCacheKey(branchId, pid));
            if (!raw) {
                misses.push(pid);
                return;
            }
            try {
                const parsed = JSON.parse(raw) as Partial<CoreBranchProduct>;
                
                
                
                if (parsed.name === undefined) {
                    misses.push(pid);
                    return;
                }
                cached.push(parsed as CoreBranchProduct);
            } catch {
                misses.push(pid);
            }
        }),
    );

    if (misses.length === 0) return cached;

    const ids = misses.join(",");
    const res = await coreClient.request<CoreEnvelope<CoreBranchProduct[]>>({
        method: "GET",
        path: `/api/internal/branches/${branchId}/products?ids=${encodeURIComponent(ids)}`,
        correlationId,
    });

    
    
    await Promise.all(
        res.data.map((p) =>
            c
                .set(productCacheKey(branchId, Number(p.productId)), JSON.stringify(p), PRODUCT_CACHE_TTL)
                .catch((err) =>
                    logger.warn("getBranchProducts cache set failed", {branchId, productId: p.productId, error: (err as Error).message}),
                ),
        ),
    );

    return [...cached, ...res.data];
}

export async function reserveStock(branchId: number, items: ReserveStockItem[], idempotencyKey?: string, correlationId?: string,): Promise<ReserveStockResult> {
    const res = await coreClient.request<CoreEnvelope<ReserveStockResult>>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/reserve-stock`,
        body: {items},
        idempotencyKey,
        correlationId,
    });
    return res.data;
}

export async function releaseStock(
    branchId: number,
    items: ReserveStockItem[],
    idempotencyKey?: string,
    correlationId?: string,
): Promise<ReserveStockResult> {
    const res = await coreClient.request<CoreEnvelope<ReserveStockResult>>({
        method: "POST",
        path: `/api/internal/branches/${branchId}/release-stock`,
        body: {items},
        idempotencyKey,
        correlationId,
    });
    return res.data;
}
