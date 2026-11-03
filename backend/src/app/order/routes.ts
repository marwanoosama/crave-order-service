import {Router} from "express";
import {authenticate} from "../../lib/auth/guard";
import {rbac, requireBranchAccess, requireRestaurantMember} from "../../lib/auth/rbac";
import {idempotency} from "../../lib/idempotency/idempotency";
import {withCache} from "../../lib/cache/withCache";
import {requireRegion} from "../../lib/sharding/region-resolver";
import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {OrderController} from "./controller/order.controller";

export const orderRouter = Router();

const orderController = container.resolve<OrderController>(TOKENS.OrderController);

orderRouter.post(
    "/orders",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.placeOrder,
);

orderRouter.get(
    "/orders/:publicId",
    authenticate,
    requireRegion,
    orderController.getOrder,
);

orderRouter.get(
    "/customer/orders/:publicId",
    authenticate,
    requireRegion,
    orderController.getOrder,
);

orderRouter.get(
    "/customer/orders",
    authenticate,
    requireRegion,
    orderController.listCustomerOrders,
);

orderRouter.patch(
    "/orders/:publicId/status",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.updateStatus,
);

orderRouter.patch(
    "/customer/orders/:publicId/status",
    authenticate,
    requireRegion,
    idempotency({strict: true}),
    orderController.updateStatus,
);

orderRouter.get(
    "/restaurant/orders",
    authenticate,
    requireRegion,
    requireBranchAccess("branchId"),
    rbac({resource: "orders", action: "read"}),
    withCache(10),
    orderController.listRestaurantOrders,
);

orderRouter.get(
    "/restaurants/:restaurantId/branches/:branchId/orders",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    rbac({resource: "orders", action: "read"}),
    withCache(10),
    orderController.listRestaurantOrders,
);

orderRouter.patch(
    "/restaurants/:restaurantId/branches/:branchId/orders/:publicId/status",
    authenticate,
    requireRegion,
    requireRestaurantMember("restaurantId"),
    requireBranchAccess("branchId"),
    idempotency({strict: true}),
    orderController.updateStatus,
);

orderRouter.patch(
    "/admin/orders/:publicId/status",
    authenticate,
    requireRegion,
    rbac({resource: "orders", action: "cancel"}),
    idempotency({strict: true}),
    orderController.updateStatus,
);
