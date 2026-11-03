import {NextFunction, Request, Response} from "express";
import {inject, injectable} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendPaginated, sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {parseFilters, parsePaginationQuery} from "../../../lib/http/pagination/parse-query";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {OrderService} from "../service/order.service";
import {CreateOrderRequestDTO, UpdateOrderStatusRequestDTO} from "../dto/order.request.dto";
import {OrderStatus} from "../enums";
import {ActorContext} from "../types";

@injectable()
export class OrderController {
    constructor(@inject(TOKENS.OrderService) private readonly orderService: OrderService) {}

    placeOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const data = await validateBody(CreateOrderRequestDTO, req.body);
            const result = await this.orderService.placeOrder(
                this.getActor(req),
                data,
                req.region,
                req.correlationId,
            );
            sendSuccess(res, result, 201);
        } catch (err) {
            next(err);
        }
    };

    getOrder = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const result = await this.orderService.getOrder(
                this.getActor(req),
                req.region,
                String(req.params.publicId),
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };

    listCustomerOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const year = Number(req.query.year) || new Date().getUTCFullYear();
            const pagination = parsePaginationQuery(req.query as Record<string, unknown>, ["createdAt"]);
            const result = await this.orderService.listCustomerOrders(
                this.getActor(req),
                req.region,
                year,
                pagination,
            );
            sendPaginated(res, result.data, result.meta);
        } catch (err) {
            next(err);
        }
    };

    listRestaurantOrders = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const query = req.query as Record<string, unknown>;
            const restaurantId = Number(req.params.restaurantId ?? req.query.restaurantId ?? req.user?.restaurantId);
            const branchId = Number(req.params.branchId ?? req.query.branchId);

            const result = await this.orderService.listRestaurantOrders(
                req.region,
                restaurantId,
                branchId,
                req.query.status as OrderStatus | undefined,
                req.query.from ? new Date(String(req.query.from)) : undefined,
                req.query.to ? new Date(String(req.query.to)) : undefined,
                parseFilters(query, ["status", "createdAt", "total"]),
                parsePaginationQuery(query, ["createdAt"]),
            );
            sendPaginated(res, result.data, result.meta);
        } catch (err) {
            next(err);
        }
    };

    updateStatus = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const data = await validateBody(UpdateOrderStatusRequestDTO, req.body);
            const result = await this.orderService.updateStatus(
                this.getActor(req),
                req.region,
                String(req.params.publicId),
                data,
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };

    private getActor = (req: Request): ActorContext => ({
        userId: req.user!.userId,
        role: req.user!.role,
        restaurantId: req.user!.restaurantId,
        restaurantRole: req.user!.restaurantRole,
        branchIds: req.user!.branchIds,
    });
}
