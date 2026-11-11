import cron, {ScheduledTask} from "node-cron";
import {logger} from "../logger/logger";

/**
 * A scheduled background job. Anything added to the registry runs in the
 * worker process at the given cron cadence.
 *
 * The handler receives nothing — if it needs context (region, batch size, etc.)
 * it pulls from env or DI itself.
 */
export interface ScheduledJob {
    /** Stable id used in logs and metrics. e.g. `assignment-tick:eg`. */
    name: string;

    /**
     * Standard 5- or 6-field cron expression (node-cron syntax).
     *   "*\/10 * * * * *" — every 10 seconds (6-field form)
     *   "0 3 * * *"       — daily at 03:00 (5-field form)
     */
    cron: string;

    /** Optional timezone (IANA, e.g. "Africa/Cairo"). Defaults to UTC. */
    timezone?: string;

    /** The work. May be sync or async; throws are caught + logged by the scheduler. */
    handler: () => Promise<void> | void;
}

/**
 * Module-level registry of scheduled jobs. Populated at module-load time by
 * `register(...)` calls; consumed by `startAll()` at worker boot.
 *
 * Keep registrations side-effect-free at import time — the handler closures
 * resolve their dependencies (DI, env) when CALLED, not when registered.
 */
const jobs: ScheduledJob[] = [];

/** Add a job. Names must be unique; a duplicate name is a programmer error. */
export function register(job: ScheduledJob): void {
    if (jobs.some((j) => j.name === job.name)) {
        throw new Error(`duplicate scheduled job: ${job.name}`);
    }
    jobs.push(job);
}

/** Snapshot used by the scheduler. */
export function listJobs(): readonly ScheduledJob[] {
    return jobs;
}

const tasks: ScheduledTask[] = [];

/**
 * Boot every registered job. Each handler invocation is wrapped so a thrown
 * error doesn't tear down the cron task — the next tick still runs.
 *
 * Concurrent invocations of the same job are dropped: if a tick is still
 * running when the next fires, that tick is skipped (logged at debug).
 */
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

/** Stop all scheduled tasks. Called from the worker's SIGINT/SIGTERM handler. */
export async function stopAll(): Promise<void> {
    for (const t of tasks) {
        try {
            await t.stop();
        } catch {}
    }
    tasks.length = 0;
}
