import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {toSeconds} from "../../../pkg/utils/time";
import {BranchEventPayload, ProductStockChangedPayload, RestaurantSuspendedPayload} from "../core-events.types";

const PRODUCT_CACHE_TTL = toSeconds(1, "h");
const BRANCH_REJECT_FLAG_TTL = toSeconds(7, "d");

@injectable()
export class CoreDataCacheService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    // Checked by placeOrder before accepting an order.
    isBranchRejectingOrders = async (branchId: number): Promise<boolean> => {
        return (await this.cache.get(`branch:reject-new-orders:${branchId}`)) === "1";
    };

    // Event "branch.updated": clear the cached branch and allow orders again.
    handleBranchUpdated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload | null;
        if (!p?.branchId) return;

        await this.cache.del(`core:branch:${p.branchId}`);
        await this.cache.del(`branch:reject-new-orders:${p.branchId}`);
    };

    // Event "branch.deactivated": clear the cached branch and reject new orders.
    handleBranchDeactivated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload | null;
        if (!p?.branchId) return;

        await this.cache.del(`core:branch:${p.branchId}`);
        await this.cache.set(`branch:reject-new-orders:${p.branchId}`, "1", BRANCH_REJECT_FLAG_TTL);
    };

    // Events "product.stock.changed" / "product.price.changed": refresh the
    // partial projection held in Redis. The projection intentionally has no
    // `name` — branch.client treats a nameless cache row as "stale shape" and
    // falls back to core so item names/images stay synced.
    handleProductChanged = async (payload: unknown): Promise<void> => {
        const p = payload as ProductStockChangedPayload & {newPrice?: number} | null;
        if (!p?.branchId || !p?.productId) return;

        const key = `core:branch:${p.branchId}:product:${p.productId}`;
        const cached = await this.cache.get(key);
        const product = cached ? JSON.parse(cached) : {};

        if (p.newStock !== undefined) product.stock = p.newStock;
        if (p.isAvailable !== undefined) product.isAvailable = p.isAvailable;
        if (p.newPrice !== undefined) product.price = p.newPrice;

        await this.cache.set(key, JSON.stringify({...product, productId: p.productId}), PRODUCT_CACHE_TTL);
    };

    // Event "restaurant.suspended": the branch cache rows denormalise
    // restaurantStatus, so EVERY branch of the restaurant must be evicted —
    // a deleted `core:restaurant:<id>` alone would not stop placeOrder
    // accepting orders for up to the branch TTL (1h).
    handleRestaurantSuspended = async (payload: unknown): Promise<void> => {
        const p = payload as RestaurantSuspendedPayload | null;
        if (!p?.restaurantId) return;

        await this.cache.del(`core:restaurant:${p.restaurantId}`);
        for (const branchId of p.branchIds ?? []) {
            await this.cache.del(`core:branch:${branchId}`);
        }
    };
}
