import {ScheduledJob} from "./job.types";


const jobs: ScheduledJob[] = [];


export function register(job: ScheduledJob): void {
    if (jobs.some((j) => j.name === job.name)) {
        throw new Error(`duplicate scheduled job: ${job.name}`);
    }
    jobs.push(job);
}


export function listJobs(): readonly ScheduledJob[] {
    return jobs;
}
