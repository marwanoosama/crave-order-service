import {Request, Response, NextFunction} from "express";
import {injectable, inject} from "tsyringe";
import {TOKENS} from "../../../lib/di/tokens";
import {sendSuccess} from "../../../lib/http/response";
import {validateBody} from "../../../lib/validation/validate";
import {RegionNotResolvedError} from "../../../lib/sharding/errors";
import {PaymentService} from "../service/payment.service";
import {InitPaymentRequestDTO, RefundRequestDTO} from "../dto/payment.request.dto";

@injectable()
export class PaymentController {
    constructor(@inject(TOKENS.PaymentService) private readonly paymentService: PaymentService) {}

    init = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const data = await validateBody(InitPaymentRequestDTO, req.body);
            const result = await this.paymentService.init(
                this.getActor(req),
                req.region,
                data.orderId,
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };

    getById = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const paymentId = Number(req.params.paymentId);
            if (!Number.isFinite(paymentId) || paymentId <= 0) {
                return res.status(400).json({error: "invalid paymentId"});
            }
            const restaurantIdParam = req.params.restaurantId ? Number(req.params.restaurantId) : undefined;
            const result = await this.paymentService.getById(
                this.getActor(req),
                paymentId,
                req.region!,
                restaurantIdParam,
            );
            sendSuccess(res, result);
        } catch (err) {
            next(err);
        }
    };

    refund = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.region || req.region === "all") throw RegionNotResolvedError;

            const paymentId = Number(req.params.paymentId);
            if (!Number.isFinite(paymentId) || paymentId <= 0) {
                return res.status(400).json({error: "invalid paymentId"});
            }

            const data = await validateBody(RefundRequestDTO, req.body);
            const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

            const result = await this.paymentService.refund(
                this.getActor(req),
                req.region!,
                paymentId,
                data,
                idempotencyKey,
            );
            res.status(202).json({success: true, data: result});
        } catch (err) {
            next(err);
        }
    };

    private getActor = (req: Request): {userId: number; role: string; restaurantId?: number} => ({
        userId: req.user!.userId,
        role: req.user!.role,
        restaurantId: req.user!.restaurantId,
    });
}
