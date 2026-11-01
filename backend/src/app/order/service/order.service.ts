import {randomUUID} from "crypto";
import {inject, injectable} from "tsyringe";
import {Server as IoServer} from "socket.io";
import {container} from "../../../lib/di/container";
import {TOKENS} from "../../../lib/di/tokens";
import {db} from "../../../lib/knex/knex";
import {assertRegion} from "../../../lib/sharding/regions";
import {ICacheProvider} from "../../../pkg/cache/cache.interface";
import {logger} from "../../../lib/logger/logger";
import {UnAuthorisedError} from "../../../lib/auth/errors";
import {multiplyMinor, sumMinor} from "../../../pkg/utils/money";
import {FilterParams, PaginationParams} from "../../../lib/http/pagination/cursor-pagination";
import {
    getBranch,
    getBranchProducts,
    releaseStock as coreReleaseStock,
    reserveStock as coreReserveStock,
} from "../../../lib/core-client/branch.client";
import {CoreBranchProduct} from "../../../lib/core-client/types";
import {flattenAddress, getCustomerAddress} from "../../../lib/core-client/address.client";
import {CoreDataCacheService} from "./core-data-cache.service";
import {PaymentService} from "../../payment/service/payment.service";
import {assertTransition} from "./order-status.service";
import {OrderEntity} from "../entity/order.entity";
import {OrderItemEntity} from "../entity/order-item.entity";
import {Currency, OrderStatus, PaymentMethod, StatusActor} from "../enums";
import {ActorContext, CreateOrderInput, OrderLineDraft, UnavailableItem} from "../types";
import {
    BranchNotAcceptingOrdersError,
    OnlinePaymentNotAvailableError,
    OrderNotFoundError,
    outOfStockError,
} from "../errors";
import {env} from "../../../lib/config/env";
import {
    OrderDetailResponseDTO,
    OrderResponseDTO,
    OrderResponsePaymentInfo,
    OrderStatusResponseDTO,
    OrderSummaryResponseDTO,
} from "../dto/order.response.dto";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {
    createOrder,
    findOrderByPublicId,
    findOrdersByCustomer,
    findOrdersByRestaurantBranch,
    updateOrderStatus,
} from "../repository/order.repo";
import {bulkInsertItems, countItemsByOrderIds, findItemsByOrderIds} from "../repository/order-item.repo";
import {insertOutboxEvent} from "../../../lib/events/outbox.repo";
import {EVENT_TYPES} from "../../../lib/events/event-types";

const SERVICE_FEE_MINOR = 1000;

const OUTBOX_EVENT_FOR_STATUS: Partial<Record<OrderStatus, string>> = {
    [OrderStatus.ACCEPTED]: EVENT_TYPES.ORDER_ACCEPTED,
    [OrderStatus.REJECTED]: EVENT_TYPES.ORDER_REJECTED,
    [OrderStatus.CANCELLED]: EVENT_TYPES.ORDER_CANCELLED,
};

@injectable()
export class OrderService {
    constructor(
        @inject(TOKENS.CacheProvider) private readonly cache: ICacheProvider,
        @inject(TOKENS.CoreDataCacheService) private readonly coreData: CoreDataCacheService,
        @inject(TOKENS.PaymentService) private readonly paymentService: PaymentService,
    ) {}

    private get io(): IoServer {
        return container.resolve<IoServer>(TOKENS.WsServer);
    }

    placeOrder = async (
        actor: ActorContext,
        body: CreateOrderRequestDTO,
        region: string | undefined,
        correlationId?: string,
    ): Promise<OrderResponseDTO> => {
        // get the branch from core-service and check if it's active and accepting orders
        // we check first in cache, if not send a request to core-service
        const branch = await getBranch(body.branchId, correlationId);
        if (!branch.isActive || !branch.acceptOrders || branch.restaurantStatus !== "active") {
            throw BranchNotAcceptingOrdersError;
        }

        // check if branch is rejecting orders using the core cache service
        // if the branch status is changed from the core service to not accepting orders
        // an event is triggered and the cache is changed
        if (await this.coreData.isBranchRejectingOrders(body.branchId)) {
            throw BranchNotAcceptingOrdersError;
        }

        // make sure of the region name passed and correct it
        const resolvedRegion = assertRegion(region ?? branch.region);
        if (body.paymentMethod === PaymentMethod.ONLINE && !env.payments.onlineRegions.has(resolvedRegion)) {
            throw OnlinePaymentNotAvailableError;
        }

        const address = await getCustomerAddress(body.customerAddressId, correlationId);
        if (Number(address.userId) !== Number(actor.userId)) throw UnAuthorisedError;

        // get the requested products from branches
        const products = await getBranchProducts(
            body.branchId,
            body.items.map((item) => item.productId),
            correlationId,
        );

        // build the order lines (each product and its quantity, ...)
        const lines = this.buildOrderLines(body.items, products);
        const subtotal = sumMinor(lines.map((line) => line.lineTotal));
        const total = subtotal + branch.deliveryFee + SERVICE_FEE_MINOR;
        const publicId = randomUUID();

        // stock is reserved before the DB write, release on failure
        await coreReserveStock(body.branchId, body.items, publicId, correlationId);

        const conn = db(resolvedRegion);
        const trx = await conn.transaction();
        let order: OrderEntity;
        let items: OrderItemEntity[];
        try {
            const orderInput: CreateOrderInput = {
                region: resolvedRegion,
                publicId,
                countryCode: branch.region,
                restaurantId: Number(branch.restaurantId),
                restaurantOwnerId: Number(branch.restaurantOwnerId),
                branchId: Number(branch.id),
                customerId: actor.userId,
                customerAddressId: Number(address.id),
                deliveryLat: Number(address.lat),
                deliveryLng: Number(address.lng),
                deliveryAddressTextSnapshot: flattenAddress(address),
                branchLat: Number(branch.lat),
                branchLng: Number(branch.lng),
                status: body.paymentMethod === PaymentMethod.ONLINE
                    ? OrderStatus.PENDING_PAYMENT
                    : OrderStatus.PLACED,
                subtotal,
                deliveryFee: branch.deliveryFee,
                serviceFee: SERVICE_FEE_MINOR,
                total,
                currency: branch.currency as Currency,
                paymentMethod: body.paymentMethod,
            };

            order = await createOrder(orderInput, trx);

            items = await bulkInsertItems(
                lines.map((line) => ({
                    region: resolvedRegion,
                    orderId: order.id,
                    productId: line.productId,
                    quantity: line.quantity,
                    unitPriceSnapshot: line.unitPrice,
                    nameSnapshot: line.name,
                    imageUrlSnapshot: line.imageUrl,
                    lineTotal: line.lineTotal,
                })),
                trx,
            );

            // online orders are placed later
            // event is set in outbox table and then the event is consumed by the background worker
            if (order.status === OrderStatus.PLACED) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: order.publicId,
                    eventType: EVENT_TYPES.ORDER_PLACED,
                    payload: buildOrderPlacedPayload(order, items),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            await this.releaseStock(body.branchId, body.items, publicId, correlationId);
            throw err;
        }

        let payment: OrderResponsePaymentInfo | undefined;
        if (body.paymentMethod === PaymentMethod.ONLINE) {
            try {
                const {dto} = await this.paymentService.initOnlinePayment(order);
                payment = {
                    sessionId: dto.sessionId,
                    providerSessionId: dto.providerSessionId,
                    redirectUrl: dto.redirectUrl,
                    expiresAt: dto.expiresAt,
                };
            } catch (err) {
                logger.warn("payment init failed; voiding order", {
                    publicId: order.publicId,
                    error: (err as Error).message,
                });

                await updateOrderStatus(
                    order.publicId,
                    OrderStatus.CANCELLED,
                    "cancelled_at",
                    db(resolvedRegion),
                ).catch((voidErr) =>
                    logger.error("failed to void order", {
                        publicId: order.publicId,
                        error: (voidErr as Error).message,
                    }),
                );
                await this.releaseStock(body.branchId, body.items, publicId, correlationId);
                throw err;
            }
        }

        await this.clearBranchOrdersCache(resolvedRegion, branch.id);
        if (body.paymentMethod === PaymentMethod.COD) {
            this.io.to(`branch:${branch.id}`).emit("order.created", OrderSummaryResponseDTO.from(order, items.length));
        }

        return OrderResponseDTO.from(order, items, payment);
    };

    getOrder = async (actor: ActorContext, region: string, publicId: string): Promise<OrderDetailResponseDTO> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        this.assertReadAccess(actor, order);

        const items = await findItemsByOrderIds([order.id], conn);
        return OrderDetailResponseDTO.from(order, items);
    };

    listCustomerOrders = async (actor: ActorContext, region: string, year: number, pagination: PaginationParams) => {
        const conn = db(region);
        const result = await findOrdersByCustomer(
            {
                customerId: actor.userId,
                yearStart: new Date(Date.UTC(year, 0, 1)),
                yearEnd: new Date(Date.UTC(year + 1, 0, 1)),
            },
            pagination,
            conn,
        );
        const counts = await countItemsByOrderIds(result.data.map((order) => order.id), conn);

        return {
            data: result.data.map((order) => OrderSummaryResponseDTO.from(order, counts.get(order.id) ?? 0)),
            meta: result.meta,
        };
    };

    listRestaurantOrders = async (region: string, restaurantId: number, branchId: number, status: OrderStatus | undefined, from: Date | undefined, to: Date | undefined, filters: FilterParams[], pagination: PaginationParams) => {
        const conn = db(region);
        const result = await findOrdersByRestaurantBranch(
            {restaurantId, branchId, status, from, to},
            pagination,
            filters,
            conn,
        );
        const counts = await countItemsByOrderIds(result.data.map((order) => order.id), conn);

        return {
            data: result.data.map((order) => OrderSummaryResponseDTO.from(order, counts.get(order.id) ?? 0)),
            meta: result.meta,
        };
    };

    updateStatus = async (actor: ActorContext, region: string, publicId: string, body: UpdateOrderStatusRequestDTO): Promise<OrderStatusResponseDTO> => {
        const conn = db(region);
        const order = await findOrderByPublicId(publicId, conn);
        if (!order) throw OrderNotFoundError;

        const statusActor = this.resolveStatusActor(actor, order);
        const {stamp} = assertTransition(order.status, body.status, {
            actor: statusActor,
            reason: body.reason,
            placedAt: order.createdAt,
            acceptedAt: order.acceptedAt,
        });

        const trx = await conn.transaction();
        let updated: OrderEntity;
        try {
            updated = await updateOrderStatus(order.publicId, body.status, stamp, trx);

            const eventType = OUTBOX_EVENT_FOR_STATUS[body.status];
            if (eventType) {
                await insertOutboxEvent(trx, {
                    aggregateType: "order",
                    aggregateId: updated.publicId,
                    eventType,
                    payload: buildOrderTransitionPayload(updated, body.reason, statusActor),
                });
            }

            await trx.commit();
        } catch (err) {
            await trx.rollback();
            throw err;
        }

        await this.clearBranchOrdersCache(region, order.branchId);

        const payload = OrderStatusResponseDTO.from(updated);
        this.io.to(`customer:${updated.customerId}`).emit("order.status_changed", payload);
        this.io.to(`branch:${updated.branchId}`).emit("order.status_changed", payload);

        return payload;
    };

    private buildOrderLines = (requested: Array<{productId: number; quantity: number}>, products: CoreBranchProduct[]): OrderLineDraft[] => {
        const byProduct = new Map(products.map((product) => [Number(product.productId), product]));
        const unavailable: UnavailableItem[] = [];
        const lines: OrderLineDraft[] = [];

        for (const item of requested) {
            const product = byProduct.get(item.productId);

            if (!product || !product.isAvailable) {
                unavailable.push({productId: item.productId, requested: item.quantity, available: 0});
                continue;
            }
            if (product.stock < item.quantity) {
                unavailable.push({productId: item.productId, requested: item.quantity, available: product.stock});
                continue;
            }

            lines.push({
                productId: item.productId,
                quantity: item.quantity,
                unitPrice: product.price,
                lineTotal: multiplyMinor(product.price, item.quantity),
                name: product.name,
                imageUrl: product.imageUrl,
            });
        }

        if (unavailable.length > 0) throw outOfStockError(unavailable);
        return lines;
    };

    private releaseStock = async (
        branchId: number,
        items: Array<{productId: number; quantity: number}>,
        idempotencyKey: string,
        correlationId?: string,
    ) => {
        try {
            await coreReleaseStock(branchId, items, idempotencyKey, correlationId);
        } catch (err) {
            logger.error("stock release failed after order rollback", {
                branchId,
                error: (err as Error).message,
            });
        }
    };

    private clearBranchOrdersCache = async (region: string, branchId: number) => {
        await this.cache
            .del(`${region}:GET:/api/restaurant/orders?branchId=${branchId}`)
            .catch((err) =>
                logger.warn("branch orders cache invalidation failed", {
                    region,
                    branchId,
                    error: (err as Error).message,
                }),
            );
    };

    private assertReadAccess = (actor: ActorContext, order: OrderEntity) => {
        if (actor.role === "system_admin") return;
        if (Number(actor.userId) === Number(order.customerId)) return;

        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (actor.restaurantRole === "owner") return;
            if ((actor.branchIds ?? []).includes(Number(order.branchId))) return;
        }

        throw UnAuthorisedError;
    };

    private resolveStatusActor = (actor: ActorContext, order: OrderEntity): StatusActor => {
        if (actor.role === "system_admin") return StatusActor.ADMIN;
        if (actor.role === "delivery_agent" && Number(actor.userId) === Number(order.deliveryAgentId)) {
            return StatusActor.AGENT;
        }

        if (actor.role === "restaurant_user") {
            if (Number(actor.restaurantId) !== Number(order.restaurantId)) throw UnAuthorisedError;
            if (
                actor.restaurantRole !== "owner" &&
                !(actor.branchIds ?? []).includes(Number(order.branchId))
            ) {
                throw UnAuthorisedError;
            }
            return StatusActor.RESTAURANT_MEMBER;
        }

        if (Number(actor.userId) === Number(order.customerId)) return StatusActor.CUSTOMER;
        throw UnAuthorisedError;
    };
}

function buildOrderPlacedPayload(order: OrderEntity, items: OrderItemEntity[]) {
    return {
        orderId: order.publicId,
        region: order.region,
        countryCode: order.countryCode,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        paymentMethod: order.paymentMethod,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        total: order.total,
        currency: order.currency,
        items: items.map((item) => ({
            productId: Number(item.productId),
            quantity: item.quantity,
            unitPrice: item.unitPriceSnapshot,
            lineTotal: item.lineTotal,
        })),
        placedAt: order.createdAt.toISOString(),
    };
}

function buildOrderTransitionPayload(order: OrderEntity, reason: string | undefined, actor: StatusActor) {
    return {
        orderId: order.publicId,
        region: order.region,
        restaurantId: Number(order.restaurantId),
        branchId: Number(order.branchId),
        customerId: Number(order.customerId),
        status: order.status,
        reason: reason ?? null,
        actor,
        occurredAt: order.updatedAt.toISOString(),
    };
}
