export interface ProductStockChangedPayload {
    branchId: number;
    productId: number;
    newStock?: number;
    isAvailable?: boolean;
}

export interface ProductPriceChangedPayload {
    branchId: number;
    productId: number;
    newPrice: number;
}

export interface BranchEventPayload {
    branchId: number;
}

export interface RestaurantSuspendedPayload {
    restaurantId: number;
}
