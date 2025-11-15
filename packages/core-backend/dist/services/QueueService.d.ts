/**
 * 队列服务实现
 * 支持 Bull/BullMQ 和内存队列，提供完整的任务队列管理
 */
import { EventEmitter } from 'eventemitter3';
import type { QueueService, Job, JobOptions, JobProcessor, JobStatus, QueueEventType, QueueStatus } from '../types/plugin';
/**
 * 队列提供者接口
 */
interface QueueProvider {
    add<T = any>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>;
    addBulk<T = any>(queueName: string, jobs: Array<{
        name: string;
        data: T;
        options?: JobOptions;
    }>): Promise<Job<T>[]>;
    process<T = any>(queueName: string, jobName: string, processor: JobProcessor<T>): void;
    pause(queueName: string): Promise<void>;
    resume(queueName: string): Promise<void>;
    empty(queueName: string): Promise<void>;
    clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>;
    getJob<T = any>(queueName: string, jobId: string): Promise<Job<T> | null>;
    removeJob(queueName: string, jobId: string): Promise<void>;
    retryJob(queueName: string, jobId: string): Promise<void>;
    getQueueStatus(queueName: string): Promise<QueueStatus>;
    getWaiting(queueName: string): Promise<Job[]>;
    getActive(queueName: string): Promise<Job[]>;
    getCompleted(queueName: string): Promise<Job[]>;
    getFailed(queueName: string): Promise<Job[]>;
    on(queueName: string, event: QueueEventType, handler: (job: Job, result?: any) => void): void;
    off(queueName: string, event: QueueEventType, handler?: Function): void;
}
/**
 * 内存队列实现
 */
declare class MemoryQueueProvider implements QueueProvider {
    private queues;
    private logger;
    constructor();
    private getQueue;
    add<T = any>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>;
    addBulk<T = any>(queueName: string, jobs: Array<{
        name: string;
        data: T;
        options?: JobOptions;
    }>): Promise<Job<T>[]>;
    process<T = any>(queueName: string, jobName: string, processor: JobProcessor<T>): void;
    pause(queueName: string): Promise<void>;
    resume(queueName: string): Promise<void>;
    empty(queueName: string): Promise<void>;
    clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>;
    getJob<T = any>(queueName: string, jobId: string): Promise<Job<T> | null>;
    removeJob(queueName: string, jobId: string): Promise<void>;
    retryJob(queueName: string, jobId: string): Promise<void>;
    getQueueStatus(queueName: string): Promise<QueueStatus>;
    getWaiting(queueName: string): Promise<Job[]>;
    getActive(queueName: string): Promise<Job[]>;
    getCompleted(queueName: string): Promise<Job[]>;
    getFailed(queueName: string): Promise<Job[]>;
    on(queueName: string, event: any, handler: (job: Job, result?: any) => void): void;
    off(queueName: string, event: any, handler?: Function): void;
}
/**
 * Bull/BullMQ 队列提供者
 */
declare class BullQueueProvider implements QueueProvider {
    private queues;
    private Bull;
    private redisConnection;
    private logger;
    constructor(Bull: any, redisConnection?: any);
    private getQueue;
    add<T = any>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>;
    addBulk<T = any>(queueName: string, jobs: Array<{
        name: string;
        data: T;
        options?: JobOptions;
    }>): Promise<Job<T>[]>;
    process<T = any>(queueName: string, jobName: string, processor: JobProcessor<T>): void;
    pause(queueName: string): Promise<void>;
    resume(queueName: string): Promise<void>;
    empty(queueName: string): Promise<void>;
    clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>;
    getJob<T = any>(queueName: string, jobId: string): Promise<Job<T> | null>;
    removeJob(queueName: string, jobId: string): Promise<void>;
    retryJob(queueName: string, jobId: string): Promise<void>;
    getQueueStatus(queueName: string): Promise<QueueStatus>;
    getWaiting(queueName: string): Promise<Job[]>;
    getActive(queueName: string): Promise<Job[]>;
    getCompleted(queueName: string): Promise<Job[]>;
    getFailed(queueName: string): Promise<Job[]>;
    on(queueName: string, event: QueueEventType, handler: (job: Job, result?: any) => void): void;
    off(queueName: string, event: QueueEventType, handler?: Function): void;
    private convertOptions;
    private convertBullJobToJob;
}
/**
 * 统一队列服务实现
 */
export declare class QueueServiceImpl extends EventEmitter implements QueueService {
    private provider;
    private logger;
    private metrics;
    constructor(provider?: QueueProvider);
    add<T = any>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>;
    process<T = any>(queueName: string, jobName: string, processor: JobProcessor<T>): void;
    addBulk<T = any>(queueName: string, jobs: Array<{
        name: string;
        data: T;
        options?: JobOptions;
    }>): Promise<Job<T>[]>;
    pause(queueName: string): Promise<void>;
    resume(queueName: string): Promise<void>;
    empty(queueName: string): Promise<void>;
    clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>;
    getJob<T = any>(queueName: string, jobId: string): Promise<Job<T> | null>;
    removeJob(queueName: string, jobId: string): Promise<void>;
    retryJob(queueName: string, jobId: string): Promise<void>;
    getQueueStatus(queueName: string): Promise<QueueStatus>;
    getWaiting(queueName: string): Promise<Job[]>;
    getActive(queueName: string): Promise<Job[]>;
    getCompleted(queueName: string): Promise<Job[]>;
    getFailed(queueName: string): Promise<Job[]>;
    on(queueName: string, event: QueueEventType, handler: (job: Job, result?: any) => void): void;
    off(queueName: string, event: QueueEventType, handler?: Function): void;
    /**
     * 获取队列统计信息
     */
    getMetrics(): {
        successRate: number;
        totalJobs: number;
        completedJobs: number;
        failedJobs: number;
    };
    /**
     * 重置统计信息
     */
    resetMetrics(): void;
    private setupGlobalListeners;
    /**
     * 创建 Bull 队列服务
     */
    static createBullService(Bull: any, redisConnection?: any): QueueServiceImpl;
    /**
     * 创建内存队列服务
     */
    static createMemoryService(): QueueServiceImpl;
}
export { MemoryQueueProvider, BullQueueProvider };
//# sourceMappingURL=QueueService.d.ts.map