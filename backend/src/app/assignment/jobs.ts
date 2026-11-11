import {register} from "../../lib/jobs";
import {ICacheProvider} from "../../lib/cache/redis";
import {env} from "../../lib/config/env";
import {logger} from "../../lib/logger/logger";
import {PresenceService} from "../agent/service/presence.service";
import {AssignmentService} from "./service/assignment.service";

export function registerAssignmentJobs(deps: {
    cache: ICacheProvider;
    presence: PresenceService;
}): void {
    const everyNSec = `*/${env.delivery.assignmentTickSec} * * * * *`;
    const assignmentService = new AssignmentService(deps.cache, deps.presence);
    for (const region of env.regions) {
        register({
            name: `assignment-tick:${region}`,
            cron: everyNSec,
            handler: async () => {
                const result = await assignmentService.tickRegion(region);
                if (result.processed > 0) {
                    logger.info("assignment.tick", {region, ...result});
                }
            },
        });
    }
}
