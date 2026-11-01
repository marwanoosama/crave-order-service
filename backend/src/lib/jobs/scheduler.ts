import cron, {ScheduledTask} from "node-cron";
import {logger} from "../logger/logger";
import {listJobs} from "./job-registry";

const tasks: ScheduledTask[] = [];


export function startAll(): void {
    const running = new Set<string>();
    for (const job of listJobs()) {
        if (!cron.validate(job.cron)) {
            throw new Error(`invalid cron expression for job ${job.name}: ${job.cron}`);
        }
        const task = cron.schedule(
            job.cron,
            async () => {
                if (running.has(job.name)) {
                    logger.debug("job skipped (previous tick still running)", {job: job.name});
                    return;
                }
                running.add(job.name);
                const start = Date.now();
                try {
                    await job.handler();
                } catch (err) {
                    logger.error("job failed", {job: job.name, error: (err as Error).message});
                } finally {
                    running.delete(job.name);
                    logger.debug("job tick", {job: job.name, ms: Date.now() - start});
                }
            },
            {timezone: job.timezone},
        );
        tasks.push(task);
        logger.info("job scheduled", {name: job.name, cron: job.cron});
    }
}


export async function stopAll(): Promise<void> {
    for (const t of tasks) {
        try {
            await t.stop();
        } catch {}
    }
    tasks.length = 0;
}
