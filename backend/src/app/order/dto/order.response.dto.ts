import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {OrderStatus, PaymentMethod} from "../enums";

export class OrderItemResponseDTO {
    productId!: number;
    name!: string;
    imageUrl!: string | null;
    quantity!: number;
    unitPrice!: number;
    lineTotal!: number;

    static from(item: OrderItemEntity): OrderItemResponseDTO {
        return Object.assign(new OrderItemResponseDTO(), {
            productId: item.productId,
            name: item.nameSnapshot,
            imageUrl: item.imageUrlSnapshot,
            quantity: item.quantity,
            unitPrice: item.unitPriceSnapshot,
            lineTotal: item.lineTotal,
        });
    }
}

export interface OrderResponsePaymentInfo {
    sessionId: string;
    providerSessionId: string;
    redirectUrl: string;
    expiresAt: string;
}

export class OrderResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    paymentMethod!: PaymentMethod;
    branch!: {id: number};
    restaurant!: {id: number};
    customerAddress!: {lat: number; lng: number; addressText: string};
    subtotal!: number;
    deliveryFee!: number;
    serviceFee!: number;
    total!: number;
    currency!: string;
    items!: OrderItemResponseDTO[];
    createdAt!: string;
    payment?: OrderResponsePaymentInfo;

    static from(
        order: OrderEntity,
        items: OrderItemEntity[],
        payment?: OrderResponsePaymentInfo,
    ): OrderResponseDTO {
        return Object.assign(new OrderResponseDTO(), {
            publicId: order.publicId,
            status: order.status,
            paymentMethod: order.paymentMethod,
            branch: {id: Number(order.branchId)},
            restaurant: {id: Number(order.restaurantId)},
            customerAddress: {
                lat: Number(order.deliveryLat),
                lng: Number(order.deliveryLng),
                addressText: order.deliveryAddressTextSnapshot,
            },
            subtotal: order.subtotal,
            deliveryFee: order.deliveryFee,
            serviceFee: order.serviceFee,
            total: order.total,
            currency: order.currency,
            items: items.map(OrderItemResponseDTO.from),
            createdAt: order.createdAt.toISOString(),
            ...(payment ? {payment} : {}),
        });
    }
}

export class OrderSummaryResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    total!: number;
    currency!: string;
    itemsCount!: number;
    restaurant!: {id: number};
    branchId!: number;
    createdAt!: string;

    static from(order: OrderEntity, itemsCount: number): OrderSummaryResponseDTO {
        return Object.assign(new OrderSummaryResponseDTO(), {
            publicId: order.publicId,
            status: order.status,
            total: order.total,
            currency: order.currency,
            itemsCount,
            restaurant: {id: Number(order.restaurantId)},
            branchId: Number(order.branchId),
            createdAt: order.createdAt.toISOString(),
        });
    }
}

export class OrderStatusResponseDTO {
    publicId!: string;
    status!: OrderStatus;
    updatedAt!: string;

    static from(order: OrderEntity): OrderStatusResponseDTO {
        return Object.assign(new OrderStatusResponseDTO(), {
            publicId: order.publicId,
            status: order.status,
            updatedAt: order.updatedAt.toISOString(),
        });
    }
}

export interface OrderPaymentSummary {
    method: "online" | "cod";
    status: "pending" | "authorized" | "captured" | "failed" | "refunded";
    amount: number;
    currency: string;
    refundedAmount: number;
}

export class OrderDetailResponseDTO extends OrderResponseDTO {
    paymentSummary?: OrderPaymentSummary;
    history!: Array<{status: OrderStatus; ts: string}>;

    static fromDetail(
        order: OrderEntity,
        items: OrderItemEntity[],
        paymentSummary?: OrderPaymentSummary,
    ): OrderDetailResponseDTO {
        return Object.assign(new OrderDetailResponseDTO(), OrderResponseDTO.from(order, items), {
            paymentSummary,
            history: buildHistory(order),
        });
    }
}

function buildHistory(order: OrderEntity): Array<{status: OrderStatus; ts: string}> {
    const history: Array<{status: OrderStatus; ts: string}> = [];

    const add = (status: OrderStatus, ts: Date | null) => {
        if (ts) history.push({status, ts: ts.toISOString()});
    };

    if (order.paymentMethod === PaymentMethod.ONLINE) {
        add(OrderStatus.PENDING_PAYMENT, order.createdAt);
        if (order.status !== OrderStatus.PENDING_PAYMENT) {
            add(OrderStatus.PLACED, order.createdAt);
        }
    } else {
        add(OrderStatus.PLACED, order.createdAt);
    }
    add(OrderStatus.ACCEPTED, order.acceptedAt);
    add(OrderStatus.REJECTED, order.rejectedAt);
    add(OrderStatus.READY, order.readyAt);
    add(OrderStatus.ASSIGNED, order.assignedAt);
    add(OrderStatus.PICKED, order.pickedAt);
    add(OrderStatus.DELIVERED, order.deliveredAt);
    add(OrderStatus.CANCELLED, order.cancelledAt);

    return history;
}
