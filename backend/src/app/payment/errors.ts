import {AppError} from "../../lib/error/AppError";

export const OrderNotPendingPaymentError = new AppError("OrderNotPendingPayment", 409);
export const PaymentProviderUnavailableError = new AppError("Payment provider unavailable", 503);
export const PaymentNotFoundError = new AppError("PaymentNotFound", 404);
export const InvalidWebhookSignatureError = new AppError("InvalidSignature", 401);
export const MalformedWebhookError = new AppError("MalformedWebhook", 400);
export const PaymentAlreadyRefundedError = new AppError("PaymentAlreadyRefunded", 409);
export const InvalidRefundAmountError = new AppError("InvalidRefundAmount", 400);
export const PaymentCannotBeRefundedError = new AppError("PaymentCannotBeRefunded", 409);
