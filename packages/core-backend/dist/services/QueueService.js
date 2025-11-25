// @ts-nocheck
/**
 * 队列服务实现
 * 支持 Bull/BullMQ 和内存队列，提供完整的任务队列管理
 */
import { EventEmitter } from 'eventemitter3';
import { Logger } from '../core/logger';
/**
 * 内存队列实现
 */
class MemoryQueueProvider {
    queues = new Map();
    logger;
    constructor() {
        this.logger = new Logger('MemoryQueueProvider');
    }
    getQueue(queueName) {
        if (!this.queues.has(queueName)) {
            this.queues.set(queueName, new MemoryQueue(queueName));
        }
        return this.queues.get(queueName);
    }
    async add(queueName, jobName, data, options = {}) {
        const queue = this.getQueue(queueName);
        return queue.add(jobName, data, options);
    }
    async addBulk(queueName, jobs) {
        const queue = this.getQueue(queueName);
        return Promise.all(jobs.map(job => queue.add(job.name, job.data, job.options)));
    }
    process(queueName, jobName, processor) {
        const queue = this.getQueue(queueName);
        queue.process(jobName, processor);
    }
    async pause(queueName) {
        const queue = this.getQueue(queueName);
        queue.pause();
    }
    async resume(queueName) {
        const queue = this.getQueue(queueName);
        queue.resume();
    }
    async empty(queueName) {
        const queue = this.getQueue(queueName);
        queue.empty();
    }
    async clean(queueName, grace, status) {
        const queue = this.getQueue(queueName);
        return queue.clean(grace, status);
    }
    async getJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        return queue.getJob(jobId);
    }
    async removeJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        queue.removeJob(jobId);
    }
    async retryJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        queue.retryJob(jobId);
    }
    async getQueueStatus(queueName) {
        const queue = this.getQueue(queueName);
        return queue.getStatus();
    }
    async getWaiting(queueName) {
        const queue = this.getQueue(queueName);
        return queue.getWaiting();
    }
    async getActive(queueName) {
        const queue = this.getQueue(queueName);
        return queue.getActive();
    }
    async getCompleted(queueName) {
        const queue = this.getQueue(queueName);
        return queue.getCompleted();
    }
    async getFailed(queueName) {
        const queue = this.getQueue(queueName);
        return queue.getFailed();
    }
    // Relaxed typing for Phase A compatibility
    on(queueName, event, handler) {
        const queue = this.getQueue(queueName);
        queue.on(event, handler);
    }
    off(queueName, event, handler) {
        const queue = this.getQueue(queueName);
        queue.off(event, handler);
    }
}
/**
 * 内存队列实现类
 */
class MemoryQueue extends EventEmitter {
    name;
    waiting = [];
    active = [];
    completed = [];
    failed = [];
    delayed = [];
    processors = new Map();
    paused = false;
    processing = false;
    nextJobId = 1;
    logger;
    constructor(name) {
        super();
        this.name = name;
        this.logger = new Logger(`MemoryQueue:${name}`);
        // 启动处理循环
        setImmediate(() => this.processNext());
        // 处理延迟任务
        setInterval(() => this.processDelayed(), 1000);
    }
    add(jobName, data, options = {}) {
        const job = {
            id: (this.nextJobId++).toString(),
            name: jobName,
            data,
            options,
            progress: 0,
            timestamp: Date.now(),
            attemptsMade: 0
        };
        if (options.delay && options.delay > 0) {
            job.timestamp = Date.now() + options.delay;
            this.delayed.push(job);
            this.emit('delayed', job);
        }
        else {
            this.waiting.push(job);
            this.emit('waiting', job);
        }
        this.processNext();
        return job;
    }
    process(jobName, processor) {
        this.processors.set(jobName, processor);
        this.processNext();
    }
    pause() {
        this.paused = true;
        this.emit('paused');
    }
    resume() {
        this.paused = false;
        this.emit('resumed');
        this.processNext();
    }
    empty() {
        this.waiting.length = 0;
        this.delayed.length = 0;
        this.emit('drained');
    }
    clean(grace, status) {
        const now = Date.now();
        const graceTime = grace * 1000;
        let cleanedJobs = [];
        const cleanQueue = (queue) => {
            const toClean = [];
            const remaining = [];
            for (const job of queue) {
                const jobTime = job.finishedOn || job.processedOn || job.timestamp;
                if (now - jobTime > graceTime) {
                    toClean.push(job);
                }
                else {
                    remaining.push(job);
                }
            }
            return { toClean, remaining };
        };
        switch (status) {
            case 'completed': {
                const { toClean, remaining } = cleanQueue(this.completed);
                this.completed = remaining;
                cleanedJobs = toClean;
                break;
            }
            case 'failed': {
                const { toClean, remaining } = cleanQueue(this.failed);
                this.failed = remaining;
                cleanedJobs = toClean;
                break;
            }
            case 'active': {
                const { toClean, remaining } = cleanQueue(this.active);
                this.active = remaining;
                cleanedJobs = toClean;
                break;
            }
            case 'waiting': {
                const { toClean, remaining } = cleanQueue(this.waiting);
                this.waiting = remaining;
                cleanedJobs = toClean;
                break;
            }
        }
        if (cleanedJobs.length > 0) {
            this.emit('cleaned', cleanedJobs);
        }
        return cleanedJobs;
    }
    getJob(jobId) {
        const allJobs = [...this.waiting, ...this.active, ...this.completed, ...this.failed, ...this.delayed];
        return allJobs.find(job => job.id === jobId) || null;
    }
    removeJob(jobId) {
        const removeFromArray = (array) => {
            const index = array.findIndex(job => job.id === jobId);
            if (index !== -1) {
                array.splice(index, 1);
                return true;
            }
            return false;
        };
        const removed = removeFromArray(this.waiting) ||
            removeFromArray(this.active) ||
            removeFromArray(this.completed) ||
            removeFromArray(this.failed) ||
            removeFromArray(this.delayed);
        if (removed) {
            this.emit('removed', jobId);
        }
    }
    retryJob(jobId) {
        const job = this.failed.find(job => job.id === jobId);
        if (job) {
            // 重置任务状态
            job.progress = 0;
            job.failedReason = undefined;
            job.attemptsMade = 0;
            delete job.processedOn;
            delete job.finishedOn;
            // 从失败队列移动到等待队列
            const index = this.failed.indexOf(job);
            if (index !== -1) {
                this.failed.splice(index, 1);
                this.waiting.push(job);
                this.emit('waiting', job);
                this.processNext();
            }
        }
    }
    getStatus() {
        return {
            waiting: this.waiting.length,
            active: this.active.length,
            completed: this.completed.length,
            failed: this.failed.length,
            delayed: this.delayed.length,
            paused: this.paused
        };
    }
    getWaiting() {
        return [...this.waiting];
    }
    getActive() {
        return [...this.active];
    }
    getCompleted() {
        return [...this.completed];
    }
    getFailed() {
        return [...this.failed];
    }
    async processNext() {
        if (this.paused || this.processing || this.waiting.length === 0) {
            return;
        }
        this.processing = true;
        while (!this.paused && this.waiting.length > 0) {
            const job = this.waiting.shift();
            const processor = this.processors.get(job.name);
            if (!processor) {
                // 没有处理器，跳过此任务
                continue;
            }
            // 移动到活跃队列
            this.active.push(job);
            job.processedOn = Date.now();
            this.emit('active', job);
            try {
                // 处理任务
                const result = await this.processJob(job, processor);
                // 移动到完成队列
                const activeIndex = this.active.indexOf(job);
                if (activeIndex !== -1) {
                    this.active.splice(activeIndex, 1);
                }
                job.returnValue = result;
                job.progress = 100;
                job.finishedOn = Date.now();
                this.completed.push(job);
                this.emit('completed', job, result);
            }
            catch (error) {
                // 处理失败
                const activeIndex = this.active.indexOf(job);
                if (activeIndex !== -1) {
                    this.active.splice(activeIndex, 1);
                }
                job.failedReason = error.message;
                job.finishedOn = Date.now();
                job.attemptsMade++;
                // 检查是否需要重试
                const maxAttempts = job.options.attempts || 1;
                if (job.attemptsMade < maxAttempts) {
                    // 计算退避延迟
                    const backoff = this.calculateBackoff(job);
                    if (backoff > 0) {
                        job.timestamp = Date.now() + backoff;
                        this.delayed.push(job);
                    }
                    else {
                        this.waiting.unshift(job); // 重新加入等待队列
                    }
                }
                else {
                    // 达到最大重试次数，移动到失败队列
                    this.failed.push(job);
                    this.emit('failed', job, error);
                }
            }
        }
        this.processing = false;
        // 如果还有等待的任务，继续处理
        if (!this.paused && this.waiting.length > 0) {
            setImmediate(() => this.processNext());
        }
    }
    async processJob(job, processor) {
        // 设置超时
        let timeoutId = null;
        const timeout = job.options.timeout;
        const processPromise = processor(job);
        if (timeout && timeout > 0) {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Job ${job.id} timed out after ${timeout}ms`));
                }, timeout);
            });
            try {
                return await Promise.race([processPromise, timeoutPromise]);
            }
            finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }
        }
        return processPromise;
    }
    calculateBackoff(job) {
        const backoff = job.options.backoff;
        if (!backoff)
            return 0;
        if (typeof backoff === 'string') {
            switch (backoff) {
                case 'fixed':
                    return 1000; // 默认1秒
                case 'exponential':
                    return Math.pow(2, job.attemptsMade) * 1000;
                default:
                    return 0;
            }
        }
        if (typeof backoff === 'object') {
            const { type, delay } = backoff;
            switch (type) {
                case 'fixed':
                    return delay;
                case 'exponential':
                    return Math.pow(2, job.attemptsMade) * delay;
                default:
                    return delay;
            }
        }
        return 0;
    }
    processDelayed() {
        if (this.paused || this.delayed.length === 0)
            return;
        const now = Date.now();
        const readyJobs = [];
        // 找出所有准备执行的延迟任务
        this.delayed = this.delayed.filter(job => {
            if (job.timestamp <= now) {
                readyJobs.push(job);
                return false;
            }
            return true;
        });
        // 将准备好的任务移动到等待队列
        for (const job of readyJobs) {
            this.waiting.push(job);
            this.emit('waiting', job);
        }
        if (readyJobs.length > 0) {
            this.processNext();
        }
    }
}
/**
 * Bull/BullMQ 队列提供者
 */
class BullQueueProvider {
    queues = new Map();
    Bull;
    redisConnection;
    logger;
    constructor(Bull, redisConnection) {
        this.Bull = Bull;
        this.redisConnection = redisConnection;
        this.logger = new Logger('BullQueueProvider');
    }
    getQueue(queueName) {
        if (!this.queues.has(queueName)) {
            const queue = new this.Bull(queueName, {
                redis: this.redisConnection,
                defaultJobOptions: {
                    removeOnComplete: 10,
                    removeOnFail: 50
                }
            });
            this.queues.set(queueName, queue);
        }
        return this.queues.get(queueName);
    }
    async add(queueName, jobName, data, options = {}) {
        try {
            const queue = this.getQueue(queueName);
            const bullJob = await queue.add(jobName, data, this.convertOptions(options));
            return this.convertBullJobToJob(bullJob);
        }
        catch (error) {
            this.logger.error(`Failed to add job to queue ${queueName}`, error);
            throw error;
        }
    }
    async addBulk(queueName, jobs) {
        try {
            const queue = this.getQueue(queueName);
            const bullJobs = await queue.addBulk(jobs.map(job => ({
                name: job.name,
                data: job.data,
                opts: this.convertOptions(job.options || {})
            })));
            return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
        }
        catch (error) {
            this.logger.error(`Failed to add bulk jobs to queue ${queueName}`, error);
            throw error;
        }
    }
    process(queueName, jobName, processor) {
        const queue = this.getQueue(queueName);
        queue.process(jobName, async (bullJob) => {
            const job = this.convertBullJobToJob(bullJob);
            return await processor(job);
        });
    }
    async pause(queueName) {
        const queue = this.getQueue(queueName);
        await queue.pause();
    }
    async resume(queueName) {
        const queue = this.getQueue(queueName);
        await queue.resume();
    }
    async empty(queueName) {
        const queue = this.getQueue(queueName);
        await queue.empty();
    }
    async clean(queueName, grace, status) {
        const queue = this.getQueue(queueName);
        const cleanedJobs = await queue.clean(grace * 1000, status);
        return cleanedJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
    }
    async getJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        const bullJob = await queue.getJob(jobId);
        return bullJob ? this.convertBullJobToJob(bullJob) : null;
    }
    async removeJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        const bullJob = await queue.getJob(jobId);
        if (bullJob) {
            await bullJob.remove();
        }
    }
    async retryJob(queueName, jobId) {
        const queue = this.getQueue(queueName);
        const bullJob = await queue.getJob(jobId);
        if (bullJob) {
            await bullJob.retry();
        }
    }
    async getQueueStatus(queueName) {
        const queue = this.getQueue(queueName);
        const waiting = await queue.getWaiting();
        const active = await queue.getActive();
        const completed = await queue.getCompleted();
        const failed = await queue.getFailed();
        const delayed = await queue.getDelayed();
        return {
            waiting: waiting.length,
            active: active.length,
            completed: completed.length,
            failed: failed.length,
            delayed: delayed.length,
            paused: await queue.isPaused()
        };
    }
    async getWaiting(queueName) {
        const queue = this.getQueue(queueName);
        const bullJobs = await queue.getWaiting();
        return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
    }
    async getActive(queueName) {
        const queue = this.getQueue(queueName);
        const bullJobs = await queue.getActive();
        return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
    }
    async getCompleted(queueName) {
        const queue = this.getQueue(queueName);
        const bullJobs = await queue.getCompleted();
        return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
    }
    async getFailed(queueName) {
        const queue = this.getQueue(queueName);
        const bullJobs = await queue.getFailed();
        return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob));
    }
    on(queueName, event, handler) {
        const queue = this.getQueue(queueName);
        queue.on(event, (bullJob, result) => {
            const job = this.convertBullJobToJob(bullJob);
            handler(job, result);
        });
    }
    off(queueName, event, handler) {
        const queue = this.getQueue(queueName);
        if (handler) {
            queue.off(event, handler);
        }
        else {
            queue.removeAllListeners(event);
        }
    }
    convertOptions(options) {
        const bullOptions = {};
        if (options.delay)
            bullOptions.delay = options.delay;
        if (options.priority)
            bullOptions.priority = options.priority;
        if (options.attempts)
            bullOptions.attempts = options.attempts;
        if (options.backoff)
            bullOptions.backoff = options.backoff;
        if (options.removeOnComplete !== undefined)
            bullOptions.removeOnComplete = options.removeOnComplete;
        if (options.removeOnFail !== undefined)
            bullOptions.removeOnFail = options.removeOnFail;
        if (options.timeout)
            bullOptions.timeout = options.timeout;
        if (options.repeat)
            bullOptions.repeat = options.repeat;
        return bullOptions;
    }
    convertBullJobToJob(bullJob) {
        return {
            id: bullJob.id.toString(),
            name: bullJob.name,
            data: bullJob.data,
            options: bullJob.opts || {},
            progress: bullJob.progress || 0,
            returnValue: bullJob.returnValue,
            failedReason: bullJob.failedReason,
            timestamp: bullJob.timestamp,
            processedOn: bullJob.processedOn,
            finishedOn: bullJob.finishedOn,
            attemptsMade: bullJob.attemptsMade || 0
        };
    }
}
/**
 * 统一队列服务实现
 */
export class QueueServiceImpl extends EventEmitter {
    provider;
    logger;
    metrics = { totalJobs: 0, completedJobs: 0, failedJobs: 0 };
    constructor(provider) {
        super();
        this.provider = provider || new MemoryQueueProvider();
        this.logger = new Logger('QueueService');
        // 设置全局事件监听用于统计
        this.setupGlobalListeners();
    }
    async add(queueName, jobName, data, options) {
        try {
            this.metrics.totalJobs++;
            const job = await this.provider.add(queueName, jobName, data, options);
            this.emit('job:added', { queueName, job });
            return job;
        }
        catch (error) {
            this.logger.error(`Failed to add job ${jobName} to queue ${queueName}`, error);
            this.emit('job:error', { operation: 'add', queueName, jobName, error });
            throw error;
        }
    }
    process(queueName, jobName, processor) {
        try {
            // 包装处理器以添加监控和错误处理
            const wrappedProcessor = async (job) => {
                this.logger.debug(`Processing job ${job.id} (${job.name}) in queue ${queueName}`);
                try {
                    const result = await processor(job);
                    this.logger.debug(`Job ${job.id} completed successfully`);
                    return result;
                }
                catch (error) {
                    this.logger.error(`Job ${job.id} failed: ${error.message}`);
                    throw error;
                }
            };
            this.provider.process(queueName, jobName, wrappedProcessor);
            this.emit('processor:registered', { queueName, jobName });
        }
        catch (error) {
            this.logger.error(`Failed to register processor for ${jobName} in queue ${queueName}`, error);
            this.emit('processor:error', { queueName, jobName, error });
        }
    }
    async addBulk(queueName, jobs) {
        try {
            this.metrics.totalJobs += jobs.length;
            const addedJobs = await this.provider.addBulk(queueName, jobs);
            this.emit('jobs:added:bulk', { queueName, count: jobs.length });
            return addedJobs;
        }
        catch (error) {
            this.logger.error(`Failed to add bulk jobs to queue ${queueName}`, error);
            this.emit('jobs:error', { operation: 'addBulk', queueName, error });
            throw error;
        }
    }
    async pause(queueName) {
        try {
            await this.provider.pause(queueName);
            this.emit('queue:paused', { queueName });
        }
        catch (error) {
            this.logger.error(`Failed to pause queue ${queueName}`, error);
            throw error;
        }
    }
    async resume(queueName) {
        try {
            await this.provider.resume(queueName);
            this.emit('queue:resumed', { queueName });
        }
        catch (error) {
            this.logger.error(`Failed to resume queue ${queueName}`, error);
            throw error;
        }
    }
    async empty(queueName) {
        try {
            await this.provider.empty(queueName);
            this.emit('queue:emptied', { queueName });
        }
        catch (error) {
            this.logger.error(`Failed to empty queue ${queueName}`, error);
            throw error;
        }
    }
    async clean(queueName, grace, status) {
        try {
            const cleanedJobs = await this.provider.clean(queueName, grace, status);
            this.emit('queue:cleaned', { queueName, count: cleanedJobs.length, status });
            return cleanedJobs;
        }
        catch (error) {
            this.logger.error(`Failed to clean queue ${queueName}`, error);
            throw error;
        }
    }
    async getJob(queueName, jobId) {
        return this.provider.getJob(queueName, jobId);
    }
    async removeJob(queueName, jobId) {
        try {
            await this.provider.removeJob(queueName, jobId);
            this.emit('job:removed', { queueName, jobId });
        }
        catch (error) {
            this.logger.error(`Failed to remove job ${jobId} from queue ${queueName}`, error);
            throw error;
        }
    }
    async retryJob(queueName, jobId) {
        try {
            await this.provider.retryJob(queueName, jobId);
            this.emit('job:retried', { queueName, jobId });
        }
        catch (error) {
            this.logger.error(`Failed to retry job ${jobId} in queue ${queueName}`, error);
            throw error;
        }
    }
    async getQueueStatus(queueName) {
        return this.provider.getQueueStatus(queueName);
    }
    async getWaiting(queueName) {
        return this.provider.getWaiting(queueName);
    }
    async getActive(queueName) {
        return this.provider.getActive(queueName);
    }
    async getCompleted(queueName) {
        return this.provider.getCompleted(queueName);
    }
    async getFailed(queueName) {
        return this.provider.getFailed(queueName);
    }
    on(queueName, event, handler) {
        this.provider.on(queueName, event, handler);
    }
    off(queueName, event, handler) {
        this.provider.off(queueName, event, handler);
    }
    /**
     * 获取队列统计信息
     */
    getMetrics() {
        const successRate = this.metrics.totalJobs > 0 ?
            (this.metrics.completedJobs / this.metrics.totalJobs) * 100 : 0;
        return {
            ...this.metrics,
            successRate: Number(successRate.toFixed(2))
        };
    }
    /**
     * 重置统计信息
     */
    resetMetrics() {
        this.metrics = { totalJobs: 0, completedJobs: 0, failedJobs: 0 };
    }
    setupGlobalListeners() {
        // 这里可以设置全局监听器来统计所有队列的指标
        // 由于我们不知道所有队列名称，暂时跳过全局监听
        // 实际使用中，可以通过提供者特定的方式来设置
    }
    /**
     * 创建 Bull 队列服务
     */
    static createBullService(Bull, redisConnection) {
        return new QueueServiceImpl(new BullQueueProvider(Bull, redisConnection));
    }
    /**
     * 创建内存队列服务
     */
    static createMemoryService() {
        return new QueueServiceImpl(new MemoryQueueProvider());
    }
}
export { MemoryQueueProvider, BullQueueProvider };
// @ts-nocheck
//# sourceMappingURL=QueueService.js.map