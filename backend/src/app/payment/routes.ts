import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireRestaurantMember} from "../../lib/auth/rbac";
import {requireConcreteRegion} from "../../lib/sharding/region-resolver";
import {idempotency} from "../../lib/idempotency/idempotency";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {PaymentController} from "./controller/payment.controller";
import {WebhookController} from "./controller/webhook.controller";

export const paymentRouter = Router();

const paymentController = container.resolve<PaymentController>(TOKENS.PaymentController);
const webhookController = container.resolve<WebhookController>(TOKENS.WebhookController);

// Customers request (or re-request) the checkout session for an order that is
// still pending_payment. `init` itself is domain-idempotent; the middleware
// keeps repeated clicks cheap.
paymentRouter.post(
    "/payments/init",
    authenticate,
    requireConcreteRegion,
    idempotency({strict: true}),
    paymentController.init,
);

// Public webhook — verified by HMAC inside the controller; no auth middleware.
// Region comes from `?region=eg` (Kashier can't set custom headers).
paymentRouter.post(
    "/payments/webhook/kashier",
    requireConcreteRegion,
    webhookController.kashier,
);

paymentRouter.post(
    "/payments/webhook/:provider",
    requireConcreteRegion,
    webhookController.kashier,
);

// Admin-initiated refund against a captured charge transaction.
paymentRouter.post(
    "/payments/:paymentId/refund",
    authenticate,
    requireConcreteRegion,
    idempotency({strict: true}),
    paymentController.refund,
);

// Direct payment read (system_admin or paying customer or restaurant owner)
paymentRouter.get(
    "/payments/:paymentId",
    authenticate,
    requireConcreteRegion,
    paymentController.getById,
);

// Restaurant-scoped read. requireRestaurantMember + rbac handle the auth;
// the service only verifies the payment actually belongs to this restaurant.
paymentRouter.get(
    "/restaurants/:restaurantId/payments/:paymentId",
    authenticate,
    requireConcreteRegion,
    requireRestaurantMember("restaurantId"),
    rbac({resource: "payments", action: "read"}),
    paymentController.getById,
);
