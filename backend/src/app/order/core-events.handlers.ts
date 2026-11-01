import {container} from "../../lib/di/container";
import {TOKENS} from "../../lib/di/tokens";
import {CoreDataCacheService} from "./service/core-data-cache.service";
import {PermissionCacheService} from "../../lib/rbac/permission-cache.service";
import {registerHandler} from "../../lib/core-events/consumer";

export function registerOrderModuleCoreEventHandlers() {
    const coreData = container.resolve<CoreDataCacheService>(TOKENS.CoreDataCacheService);
    const permissions = container.resolve<PermissionCacheService>(TOKENS.PermissionCacheService);

    registerHandler("product.stock.changed", coreData.handleProductStockChanged);
    registerHandler("product.price.changed", coreData.handleProductPriceChanged);
    registerHandler("branch.updated", coreData.handleBranchUpdated);
    registerHandler("branch.deactivated", coreData.handleBranchDeactivated);
    registerHandler("restaurant.suspended", coreData.handleRestaurantSuspended);
    registerHandler("rbac.permissions_changed", permissions.handlePermissionsChanged);
}
