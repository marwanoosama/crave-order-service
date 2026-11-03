import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {CoreEventHandler} from "../../lib/core-events/types";
import {CoreDataCacheService} from "./service/core-data-cache.service";
import {PermissionCacheService} from "../../lib/rbac/permission-cache.service";

/**
 * Event-type → handler registry consumed by startCoreEventsConsumer.
 * Each handler delegates to a service method that owns the full action
 * (cache update + side effects), keeping the consumer registry a clean table.
 */
export function orderModuleCoreEventHandlers(): Map<string, CoreEventHandler> {
    const coreData = container.resolve<CoreDataCacheService>(TOKENS.CoreDataCacheService);
    const perms = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);

    return new Map<string, CoreEventHandler>([
        ["product.stock.changed", coreData.handleProductChanged],
        ["product.price.changed", coreData.handleProductChanged],
        ["branch.updated", coreData.handleBranchUpdated],
        ["branch.deactivated", coreData.handleBranchDeactivated],
        ["restaurant.suspended", coreData.handleRestaurantSuspended],
        ["rbac.permissions_changed", perms.handlePermissionsChanged],
    ]);
}
