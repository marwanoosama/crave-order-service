import {PaginationMeta} from "../../lib/http/pagination/cursor-pagination";
import {Currency, OrderStatus, PaymentMethod, StatusActor} from "./enums";

export interface CreateOrderInput {
    region: string;
    publicId: string;
    countryCode: string;
    restaurantId: number;
    restaurantOwnerId: number;
    branchId: number;
    customerId: number;
    customerAddressId: number;
    deliveryLat: number;
    deliveryLng: number;
    deliveryAddressTextSnapshot: string;
    branchLat: number;
    branchLng: number;
    status: OrderStatus;
    subtotal: number;
    deliveryFee: number;
    serviceFee: number;
    total: number;
    currency: Currency;
    paymentMethod: PaymentMethod;
}

export interface InsertOrderItemInput {
    region: string;
    orderId: number;
    productId: number;
    quantity: number;
    unitPriceSnapshot: number;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    lineTotal: number;
}

export interface ListCustomerOrdersFilter {
    customerId: number;
    yearStart: Date;
    yearEnd: Date;
}

export interface ListRestaurantOrdersFilter {
    restaurantId: number;
    branchId: number;
    status?: OrderStatus;
    from?: Date;
    to?: Date;
}

export interface ListResult<T> {
    data: T[];
    meta: PaginationMeta;
}

export interface ActorContext {
    userId: number;
    role: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}

export interface UnavailableItem {
    productId: number;
    requested: number;
    available: number;
}

export interface OrderLineDraft {
    productId: number;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    name: string;
    imageUrl: string | null;
}

export interface AssertTransitionContext {
    actor: StatusActor;
    reason?: string;
    placedAt?: Date | null;
    acceptedAt?: Date | null;
}

export interface AssertTransitionResult {
    stamp: string | null;
}
