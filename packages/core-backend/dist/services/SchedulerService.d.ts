/**
 * 调度服务实现
 * 支持 Cron 表达式调度和延迟任务，提供插件隔离
 */
import { EventEmitter } from 'eventemitter3';
import type { SchedulerService, ScheduledJob, ScheduleOptions, ScheduleHandler, ScheduleEventType } from '../types/plugin';
/**
 * Cron 解析器接口
 */
interface CronExpression {
    next(): Date | null;
    prev(): Date | null;
    hasNext(): boolean;
    reset(date?: Date): void;
}
/**
 * 简单的 Cron 表达式解析器
 * 支持标准的 5 字段格式：分 时 日 月 周
 */
declare class SimpleCronExpression implements CronExpression {
    private minute;
    private hour;
    private dayOfMonth;
    private month;
    private dayOfWeek;
    private timezone;
    private currentDate;
    constructor(expression: string, timezone?: string);
    private parseExpression;
    private parseField;
    next(): Date | null;
    prev(): Date | null;
    hasNext(): boolean;
    reset(date?: Date): void;
    private matches;
}
/**
 * 调度作业管理器
 */
declare class JobScheduler extends EventEmitter {
    private jobs;
    private timers;
    private cronJobs;
    private logger;
    constructor();
    addJob(job: ScheduledJob): void;
    removeJob(name: string): void;
    getJob(name: string): ScheduledJob | null;
    listJobs(): ScheduledJob[];
    pauseJob(name: string): void;
    resumeJob(name: string): void;
    triggerJob(name: string): Promise<void>;
    private scheduleCronJob;
    private scheduleDelayedJob;
    private executeJob;
    destroy(): void;
}
/**
 * 调度服务实现
 */
export declare class SchedulerServiceImpl extends EventEmitter implements SchedulerService {
    private scheduler;
    private logger;
    private pluginJobs;
    constructor();
    schedule(name: string, cronExpression: string, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>;
    unschedule(name: string): Promise<void>;
    reschedule(name: string, cronExpression: string): Promise<void>;
    delay(name: string, delay: number, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>;
    getJob(name: string): Promise<ScheduledJob | null>;
    listJobs(): Promise<ScheduledJob[]>;
    pause(name: string): Promise<void>;
    resume(name: string): Promise<void>;
    trigger(name: string): Promise<void>;
    on(event: ScheduleEventType, handler: (job: ScheduledJob, result?: any, error?: Error) => void): void;
    off(event: ScheduleEventType, handler?: Function): void;
    /**
     * 为插件注册任务（提供插件隔离）
     */
    scheduleForPlugin(pluginName: string, jobName: string, cronExpression: string, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>;
    /**
     * 为插件调度延迟任务
     */
    delayForPlugin(pluginName: string, jobName: string, delay: number, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>;
    /**
     * 取消插件的所有任务
     */
    unschedulePluginJobs(pluginName: string): Promise<void>;
    /**
     * 获取插件的所有任务
     */
    getPluginJobs(pluginName: string): ScheduledJob[];
    /**
     * 获取服务统计信息
     */
    getStats(): {
        totalJobs: number;
        activeJobs: number;
        pausedJobs: number;
        runningJobs: number;
        cronJobs: number;
        delayedJobs: number;
        pluginCount: number;
    };
    /**
     * 销毁服务
     */
    destroy(): void;
}
export { SimpleCronExpression, JobScheduler };
//# sourceMappingURL=SchedulerService.d.ts.map