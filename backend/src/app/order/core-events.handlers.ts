import {CoreDataCacheService} from "./service/core-data-cache.service";
import {PermissionCacheService} from "../../lib/rbac/permission-cache.service";
import {registerHandler} from "../../lib/core-events/consumer";

/**
 * Thin wrappers — each handler delegates to a service method that owns the
 * full action (cache update, side-effects, downstream HTTP, etc.). The
 * consumer registry stays a clean event-type → service-method table.
 *
 * The caller (server.ts resolves from the DI container, worker.ts constructs
 * them directly) passes the two services in so this module stays decoupled
 * from the DI container.
 */
export function registerOrderModuleCoreEventHandlers(deps: {
    coreData: CoreDataCacheService;
    perms: PermissionCacheService;
}) {
    registerHandler("product.stock.changed",     deps.coreData.handleProductStockChanged);
    registerHandler("product.price.changed",     deps.coreData.handleProductPriceChanged);
    registerHandler("branch.updated",            deps.coreData.handleBranchUpdated);
    registerHandler("branch.deactivated",        deps.coreData.handleBranchDeactivated);
    registerHandler("restaurant.suspended",      deps.coreData.handleRestaurantSuspended);
    registerHandler("rbac.permissions_changed",  deps.perms.handlePermissionsChanged);
}