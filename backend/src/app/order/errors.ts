import {AppError} from "../../lib/error/AppError";
import {OrderStatus} from "./enums";
import {UnavailableItem} from "./types";

export const OrderNotFoundError = new AppError("OrderNotFound", 404);
export const BranchNotAcceptingOrdersError = new AppError("BranchNotAcceptingOrders", 409);
export const CancellationWindowExpiredError = new AppError("CancellationWindowExpired", 409);
export const ReasonRequiredError = new AppError("Reason required for this transition", 400);
export const OnlinePaymentNotAvailableError = new AppError("OnlinePaymentNotAvailableInRegion", 409);

export function invalidStatusTransitionError(from: OrderStatus, to: OrderStatus) {
    return new AppError(`InvalidStatusTransition: ${from} -> ${to}`, 409);
}

export function outOfStockError(offending: UnavailableItem[]) {
    return new AppError(`OutOfStock: ${JSON.stringify(offending)}`, 409);
}
