
export interface ScheduledJob {
    
    name: string;

    
    cron: string;

    
    timezone?: string;

    
    handler: () => Promise<void> | void;
}
