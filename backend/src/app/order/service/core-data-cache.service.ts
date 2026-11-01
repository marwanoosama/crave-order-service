import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {toSeconds} from "../../../pkg/utils/time";
import {BranchEventPayload, ProductPriceChangedPayload, ProductStockChangedPayload, RestaurantSuspendedPayload} from "../core-events.types";

const PRODUCT_CACHE_TTL = toSeconds(1, "h");
const BRANCH_REJECT_FLAG_TTL = toSeconds(7, "d");

@injectable()
export class CoreDataCacheService {
    constructor(@inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider) {}

    // Read by placeOrder before accepting an order.
    isBranchRejectingOrders = async (branchId: number): Promise<boolean> => {
        return (await this.cache.get(`branch:reject-new-orders:${branchId}`)) === "1";
    };

    // Triggered by core event "branch.updated": drop the cached branch and reject flag.
    handleBranchUpdated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload;
        if (!p?.branchId) return;

        await this.cache.del(`core:branch:${p.branchId}`);
        await this.cache.del(`branch:reject-new-orders:${p.branchId}`);
    };

    // Triggered by core event "branch.deactivated": drop the cached branch and start rejecting orders.
    handleBranchDeactivated = async (payload: unknown): Promise<void> => {
        const p = payload as BranchEventPayload;
        if (!p?.branchId) return;

        await this.cache.del(`core:branch:${p.branchId}`);
        await this.cache.set(`branch:reject-new-orders:${p.branchId}`, "1", BRANCH_REJECT_FLAG_TTL);
    };

    // Triggered by core event "product.stock.changed": update cached stock and availability.
    handleProductStockChanged = async (payload: unknown): Promise<void> => {
        const p = payload as ProductStockChangedPayload;
        if (!p?.branchId || !p?.productId) return;

        const patch: Record<string, unknown> = {};
        if (p.newStock !== undefined) patch.stock = p.newStock;
        if (p.isAvailable !== undefined) patch.isAvailable = p.isAvailable;

        await this.mergeProductCache(p.branchId, p.productId, patch);
    };

    // Triggered by core event "product.price.changed": update the cached price.
    handleProductPriceChanged = async (payload: unknown): Promise<void> => {
        const p = payload as ProductPriceChangedPayload;
        if (!p?.branchId || !p?.productId) return;

        await this.mergeProductCache(p.branchId, p.productId, {price: p.newPrice});
    };

    // Shared by the product handlers; keeps the other cached fields intact.
    private mergeProductCache = async (branchId: number, productId: number, patch: Record<string, unknown>): Promise<void> => {
        const key = `core:branch:${branchId}:product:${productId}`;
        const cached = await this.cache.get(key);
        const product = cached ? JSON.parse(cached) : {};

        await this.cache.set(
            key,
            JSON.stringify({...product, ...patch, productId}),
            PRODUCT_CACHE_TTL,
        );
    };

    // Triggered by core event "restaurant.suspended": drop the cached restaurant.
    handleRestaurantSuspended = async (payload: unknown): Promise<void> => {
        const p = payload as RestaurantSuspendedPayload;
        if (!p?.restaurantId) return;

        await this.cache.del(`core:restaurant:${p.restaurantId}`);
    };
}
