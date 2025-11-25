// @ts-nocheck
/**
 * 调度服务实现
 * 支持 Cron 表达式调度和延迟任务，提供插件隔离
 */
import { EventEmitter } from 'eventemitter3';
import { Logger } from '../core/logger';
/**
 * 简单的 Cron 表达式解析器
 * 支持标准的 5 字段格式：分 时 日 月 周
 */
class SimpleCronExpression {
    minute;
    hour;
    dayOfMonth;
    month;
    dayOfWeek;
    timezone;
    currentDate;
    constructor(expression, timezone = 'UTC') {
        this.timezone = timezone;
        this.currentDate = new Date();
        this.parseExpression(expression);
    }
    parseExpression(expression) {
        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5) {
            throw new Error('Invalid cron expression. Expected 5 fields: minute hour dayOfMonth month dayOfWeek');
        }
        this.minute = this.parseField(parts[0], 0, 59);
        this.hour = this.parseField(parts[1], 0, 23);
        this.dayOfMonth = this.parseField(parts[2], 1, 31);
        this.month = this.parseField(parts[3], 1, 12);
        this.dayOfWeek = this.parseField(parts[4], 0, 7).map(d => d === 7 ? 0 : d); // 周日可以是0或7
    }
    parseField(field, min, max) {
        if (field === '*') {
            return Array.from({ length: max - min + 1 }, (_, i) => i + min);
        }
        if (field.includes('/')) {
            const [range, step] = field.split('/');
            const stepValue = parseInt(step, 10);
            const baseValues = range === '*' ?
                Array.from({ length: max - min + 1 }, (_, i) => i + min) :
                this.parseField(range, min, max);
            return baseValues.filter((_, i) => i % stepValue === 0);
        }
        if (field.includes(',')) {
            return field.split(',').flatMap(part => this.parseField(part.trim(), min, max));
        }
        if (field.includes('-')) {
            const [start, end] = field.split('-').map(s => parseInt(s.trim(), 10));
            return Array.from({ length: end - start + 1 }, (_, i) => i + start);
        }
        const value = parseInt(field, 10);
        if (isNaN(value) || value < min || value > max) {
            throw new Error(`Invalid field value: ${field}`);
        }
        return [value];
    }
    next() {
        const nextDate = new Date(this.currentDate);
        nextDate.setSeconds(0, 0); // 重置秒和毫秒
        nextDate.setMinutes(nextDate.getMinutes() + 1); // 从下一分钟开始
        for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
            if (this.matches(nextDate)) {
                this.currentDate = new Date(nextDate);
                return new Date(nextDate);
            }
            nextDate.setMinutes(nextDate.getMinutes() + 1);
        }
        return null; // 找不到匹配的时间
    }
    prev() {
        const prevDate = new Date(this.currentDate);
        prevDate.setSeconds(0, 0);
        prevDate.setMinutes(prevDate.getMinutes() - 1);
        for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
            if (this.matches(prevDate)) {
                return new Date(prevDate);
            }
            prevDate.setMinutes(prevDate.getMinutes() - 1);
        }
        return null;
    }
    hasNext() {
        const saved = new Date(this.currentDate);
        const next = this.next();
        this.currentDate = saved;
        return next !== null;
    }
    reset(date) {
        this.currentDate = date || new Date();
    }
    matches(date) {
        return this.minute.includes(date.getMinutes()) &&
            this.hour.includes(date.getHours()) &&
            this.dayOfMonth.includes(date.getDate()) &&
            this.month.includes(date.getMonth() + 1) &&
            this.dayOfWeek.includes(date.getDay());
    }
}
/**
 * 调度作业管理器
 */
class JobScheduler extends EventEmitter {
    jobs = new Map();
    timers = new Map();
    cronJobs = new Map();
    logger;
    constructor() {
        super();
        this.logger = new Logger('JobScheduler');
    }
    addJob(job) {
        this.jobs.set(job.name, job);
        if (job.cronExpression) {
            this.scheduleCronJob(job);
        }
        else if (job.delay) {
            this.scheduleDelayedJob(job);
        }
        this.logger.debug(`Scheduled job: ${job.name}`);
    }
    removeJob(name) {
        const job = this.jobs.get(name);
        if (!job)
            return;
        // 清理定时器
        const timer = this.timers.get(name);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(name);
        }
        // 清理 cron 任务
        const cronJob = this.cronJobs.get(name);
        if (cronJob) {
            clearTimeout(cronJob.timeout);
            this.cronJobs.delete(name);
        }
        this.jobs.delete(name);
        this.logger.debug(`Removed job: ${name}`);
    }
    getJob(name) {
        return this.jobs.get(name) || null;
    }
    listJobs() {
        return Array.from(this.jobs.values());
    }
    pauseJob(name) {
        const job = this.jobs.get(name);
        if (job) {
            job.isPaused = true;
            this.emit('job:paused', job);
        }
    }
    resumeJob(name) {
        const job = this.jobs.get(name);
        if (job) {
            job.isPaused = false;
            this.emit('job:resumed', job);
            // 重新调度
            if (job.cronExpression) {
                this.scheduleCronJob(job);
            }
        }
    }
    async triggerJob(name) {
        const job = this.jobs.get(name);
        if (!job) {
            throw new Error(`Job not found: ${name}`);
        }
        await this.executeJob(job);
    }
    scheduleCronJob(job) {
        if (!job.cronExpression || job.isPaused)
            return;
        try {
            const expression = new SimpleCronExpression(job.cronExpression, job.options.timezone);
            const nextRun = expression.next();
            if (!nextRun) {
                this.logger.warn(`No next run time for cron job: ${job.name}`);
                return;
            }
            job.nextRun = nextRun;
            const delay = nextRun.getTime() - Date.now();
            // 清理旧的定时器
            const oldCronJob = this.cronJobs.get(job.name);
            if (oldCronJob) {
                clearTimeout(oldCronJob.timeout);
            }
            const timeout = setTimeout(async () => {
                await this.executeJob(job);
                // 执行完成后重新调度下一次
                this.scheduleCronJob(job);
            }, delay);
            this.cronJobs.set(job.name, { expression, timeout });
            this.logger.debug(`Cron job ${job.name} scheduled for ${nextRun.toISOString()}`);
        }
        catch (error) {
            this.logger.error(`Failed to schedule cron job ${job.name}`, error);
            this.emit('job:error', job, error);
        }
    }
    scheduleDelayedJob(job) {
        if (!job.delay || job.isPaused)
            return;
        const timeout = setTimeout(async () => {
            await this.executeJob(job);
            this.removeJob(job.name); // 延迟任务只执行一次
        }, job.delay);
        this.timers.set(job.name, timeout);
        job.nextRun = new Date(Date.now() + job.delay);
        this.logger.debug(`Delayed job ${job.name} scheduled for ${job.nextRun.toISOString()}`);
    }
    async executeJob(job) {
        if (job.isPaused || job.isRunning)
            return;
        job.isRunning = true;
        job.lastRun = new Date();
        job.runCount++;
        this.emit('job:running', job);
        this.logger.debug(`Executing job: ${job.name}`);
        try {
            const result = await job.handler(job.options.context);
            job.isRunning = false;
            this.emit('job:completed', job, result);
            this.logger.debug(`Job completed: ${job.name}`);
        }
        catch (error) {
            job.isRunning = false;
            this.emit('job:failed', job, error);
            this.logger.error(`Job failed: ${job.name}`, error);
        }
    }
    destroy() {
        // 清理所有定时器
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        for (const cronJob of this.cronJobs.values()) {
            clearTimeout(cronJob.timeout);
        }
        this.timers.clear();
        this.cronJobs.clear();
        this.jobs.clear();
        this.logger.info('JobScheduler destroyed');
    }
}
/**
 * 调度服务实现
 */
export class SchedulerServiceImpl extends EventEmitter {
    scheduler;
    logger;
    pluginJobs = new Map(); // pluginName -> jobNames
    constructor() {
        super();
        this.scheduler = new JobScheduler();
        this.logger = new Logger('SchedulerService');
        // 转发调度器事件
        this.scheduler.on('job:running', (job, result) => this.emit('running', job, result));
        this.scheduler.on('job:completed', (job, result) => this.emit('completed', job, result));
        this.scheduler.on('job:failed', (job, error) => this.emit('failed', job, error));
        this.scheduler.on('job:paused', (job) => this.emit('paused', job));
        this.scheduler.on('job:resumed', (job) => this.emit('resumed', job));
        this.scheduler.on('job:error', (job, error) => this.emit('failed', job, error));
    }
    async schedule(name, cronExpression, handler, options = {}) {
        try {
            // 验证 cron 表达式
            const testExpression = new SimpleCronExpression(cronExpression, options.timezone);
            if (!testExpression.hasNext()) {
                throw new Error('Invalid cron expression: no future execution times');
            }
            const job = {
                name,
                cronExpression,
                handler,
                options,
                runCount: 0,
                isRunning: false,
                isPaused: false
            };
            // 检查启动日期
            if (options.startDate && options.startDate > new Date()) {
                const delay = options.startDate.getTime() - Date.now();
                setTimeout(() => {
                    this.scheduler.addJob(job);
                    this.emit('scheduled', job);
                }, delay);
            }
            else if (options.runOnInit) {
                // 立即执行一次
                setImmediate(async () => {
                    try {
                        await job.handler(options.context);
                    }
                    catch (error) {
                        this.logger.error(`Initial run failed for job ${name}`, error);
                    }
                });
                this.scheduler.addJob(job);
                this.emit('scheduled', job);
            }
            else {
                this.scheduler.addJob(job);
                this.emit('scheduled', job);
            }
            return job;
        }
        catch (error) {
            this.logger.error(`Failed to schedule job ${name}`, error);
            throw error;
        }
    }
    async unschedule(name) {
        try {
            this.scheduler.removeJob(name);
            // 从插件作业映射中移除
            for (const [pluginName, jobNames] of this.pluginJobs.entries()) {
                if (jobNames.has(name)) {
                    jobNames.delete(name);
                    if (jobNames.size === 0) {
                        this.pluginJobs.delete(pluginName);
                    }
                    break;
                }
            }
            this.emit('cancelled', { name });
        }
        catch (error) {
            this.logger.error(`Failed to unschedule job ${name}`, error);
            throw error;
        }
    }
    async reschedule(name, cronExpression) {
        const job = this.scheduler.getJob(name);
        if (!job) {
            throw new Error(`Job not found: ${name}`);
        }
        try {
            // 验证新的 cron 表达式
            const testExpression = new SimpleCronExpression(cronExpression, job.options.timezone);
            if (!testExpression.hasNext()) {
                throw new Error('Invalid cron expression: no future execution times');
            }
            // 更新任务并重新调度
            job.cronExpression = cronExpression;
            delete job.delay; // 清除延迟设置
            this.scheduler.removeJob(name);
            this.scheduler.addJob(job);
            this.logger.info(`Rescheduled job ${name} with new cron expression: ${cronExpression}`);
        }
        catch (error) {
            this.logger.error(`Failed to reschedule job ${name}`, error);
            throw error;
        }
    }
    async delay(name, delay, handler, options = {}) {
        try {
            const job = {
                name,
                delay,
                handler,
                options,
                runCount: 0,
                isRunning: false,
                isPaused: false,
                nextRun: new Date(Date.now() + delay)
            };
            this.scheduler.addJob(job);
            this.emit('scheduled', job);
            return job;
        }
        catch (error) {
            this.logger.error(`Failed to schedule delayed job ${name}`, error);
            throw error;
        }
    }
    async getJob(name) {
        return this.scheduler.getJob(name);
    }
    async listJobs() {
        return this.scheduler.listJobs();
    }
    async pause(name) {
        this.scheduler.pauseJob(name);
    }
    async resume(name) {
        this.scheduler.resumeJob(name);
    }
    async trigger(name) {
        await this.scheduler.triggerJob(name);
    }
    on(event, handler) {
        super.on(event, handler);
    }
    off(event, handler) {
        if (handler) {
            super.off(event, handler);
        }
        else {
            super.removeAllListeners(event);
        }
    }
    /**
     * 为插件注册任务（提供插件隔离）
     */
    async scheduleForPlugin(pluginName, jobName, cronExpression, handler, options = {}) {
        const fullJobName = `${pluginName}:${jobName}`;
        // 包装处理器以添加插件上下文
        const wrappedHandler = async (context) => {
            this.logger.debug(`Executing job ${fullJobName} for plugin ${pluginName}`);
            return handler(context);
        };
        const job = await this.schedule(fullJobName, cronExpression, wrappedHandler, {
            ...options,
            context: { ...options.context, pluginName }
        });
        // 记录插件与任务的关系
        if (!this.pluginJobs.has(pluginName)) {
            this.pluginJobs.set(pluginName, new Set());
        }
        this.pluginJobs.get(pluginName).add(fullJobName);
        return job;
    }
    /**
     * 为插件调度延迟任务
     */
    async delayForPlugin(pluginName, jobName, delay, handler, options = {}) {
        const fullJobName = `${pluginName}:${jobName}`;
        const wrappedHandler = async (context) => {
            this.logger.debug(`Executing delayed job ${fullJobName} for plugin ${pluginName}`);
            return handler(context);
        };
        const job = await this.delay(fullJobName, delay, wrappedHandler, {
            ...options,
            context: { ...options.context, pluginName }
        });
        // 记录插件与任务的关系
        if (!this.pluginJobs.has(pluginName)) {
            this.pluginJobs.set(pluginName, new Set());
        }
        this.pluginJobs.get(pluginName).add(fullJobName);
        return job;
    }
    /**
     * 取消插件的所有任务
     */
    async unschedulePluginJobs(pluginName) {
        const jobNames = this.pluginJobs.get(pluginName);
        if (!jobNames)
            return;
        const promises = Array.from(jobNames).map(jobName => this.unschedule(jobName));
        await Promise.all(promises);
        this.pluginJobs.delete(pluginName);
        this.logger.info(`Unscheduled all jobs for plugin: ${pluginName}`);
    }
    /**
     * 获取插件的所有任务
     */
    getPluginJobs(pluginName) {
        const jobNames = this.pluginJobs.get(pluginName);
        if (!jobNames)
            return [];
        return Array.from(jobNames)
            .map(name => this.scheduler.getJob(name))
            .filter(Boolean);
    }
    /**
     * 获取服务统计信息
     */
    getStats() {
        const jobs = this.scheduler.listJobs();
        return {
            totalJobs: jobs.length,
            activeJobs: jobs.filter(j => !j.isPaused).length,
            pausedJobs: jobs.filter(j => j.isPaused).length,
            runningJobs: jobs.filter(j => j.isRunning).length,
            cronJobs: jobs.filter(j => j.cronExpression).length,
            delayedJobs: jobs.filter(j => j.delay).length,
            pluginCount: this.pluginJobs.size
        };
    }
    /**
     * 销毁服务
     */
    destroy() {
        this.scheduler.destroy();
        this.pluginJobs.clear();
        this.removeAllListeners();
        this.logger.info('SchedulerService destroyed');
    }
}
export { SimpleCronExpression, JobScheduler };
// @ts-nocheck
//# sourceMappingURL=SchedulerService.js.map