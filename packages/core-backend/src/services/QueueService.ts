/**
 * 队列服务实现
 * 支持 Bull/BullMQ 和内存队列，提供完整的任务队列管理
 */

import { EventEmitter } from 'eventemitter3'
import type {
  QueueService,
  Job,
  JobOptions,
  JobProcessor,
  JobStatus,
  QueueEventType,
  QueueStatus
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * 队列提供者接口
 */
interface QueueProvider {
  add<T = unknown>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>
  addBulk<T = unknown>(queueName: string, jobs: Array<{name: string, data: T, options?: JobOptions}>): Promise<Job<T>[]>
  process<T = unknown>(queueName: string, jobName: string, processor: JobProcessor<T>): void
  pause(queueName: string): Promise<void>
  resume(queueName: string): Promise<void>
  empty(queueName: string): Promise<void>
  clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>
  getJob<T = unknown>(queueName: string, jobId: string): Promise<Job<T> | null>
  removeJob(queueName: string, jobId: string): Promise<void>
  retryJob(queueName: string, jobId: string): Promise<void>
  getQueueStatus(queueName: string): Promise<QueueStatus>
  getWaiting(queueName: string): Promise<Job[]>
  getActive(queueName: string): Promise<Job[]>
  getCompleted(queueName: string): Promise<Job[]>
  getFailed(queueName: string): Promise<Job[]>
  on(queueName: string, event: QueueEventType, handler: (job: Job, result?: unknown) => void): void
  off(queueName: string, event: QueueEventType, handler?: (...args: unknown[]) => void): void
}

/**
 * 内存队列实现
 */
class MemoryQueueProvider implements QueueProvider {
  private queues = new Map<string, MemoryQueue>()
  private logger: Logger

  constructor() {
    this.logger = new Logger('MemoryQueueProvider')
  }

  private getQueue(queueName: string): MemoryQueue {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, new MemoryQueue(queueName))
    }
    return this.queues.get(queueName)!
  }

  async add<T = unknown>(queueName: string, jobName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    const queue = this.getQueue(queueName)
    return queue.add(jobName, data, options)
  }

  async addBulk<T = unknown>(queueName: string, jobs: Array<{name: string, data: T, options?: JobOptions}>): Promise<Job<T>[]> {
    const queue = this.getQueue(queueName)
    return Promise.all(jobs.map(job => queue.add(job.name, job.data, job.options)))
  }

  process<T = unknown>(queueName: string, jobName: string, processor: JobProcessor<T>): void {
    const queue = this.getQueue(queueName)
    queue.process(jobName, processor)
  }

  async pause(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    queue.pause()
  }

  async resume(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    queue.resume()
  }

  async empty(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    queue.empty()
  }

  async clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    return queue.clean(grace, status)
  }

  async getJob<T = unknown>(queueName: string, jobId: string): Promise<Job<T> | null> {
    const queue = this.getQueue(queueName)
    return queue.getJob(jobId)
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName)
    queue.removeJob(jobId)
  }

  async retryJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName)
    queue.retryJob(jobId)
  }

  async getQueueStatus(queueName: string): Promise<QueueStatus> {
    const queue = this.getQueue(queueName)
    return queue.getStatus()
  }

  async getWaiting(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    return queue.getWaiting()
  }

  async getActive(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    return queue.getActive()
  }

  async getCompleted(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    return queue.getCompleted()
  }

  async getFailed(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    return queue.getFailed()
  }

  // Relaxed typing for Phase A compatibility
  on(queueName: string, event: QueueEventType, handler: (job: Job, result?: unknown) => void): void {
    const queue = this.getQueue(queueName)
    queue.on(event, handler)
  }

  off(queueName: string, event: QueueEventType, handler?: (...args: unknown[]) => void): void {
    const queue = this.getQueue(queueName)
    queue.off(event, handler)
  }
}

/**
 * 内存队列实现类
 */
class MemoryQueue extends EventEmitter {
  private name: string
  private waiting: Job[] = []
  private active: Job[] = []
  private completed: Job[] = []
  private failed: Job[] = []
  private delayed: Job[] = []
  private processors = new Map<string, JobProcessor<unknown>>()
  private paused = false
  private processing = false
  private nextJobId = 1
  private logger: Logger
  private delayedTimer: NodeJS.Timeout

  constructor(name: string) {
    super()
    this.name = name
    this.logger = new Logger(`MemoryQueue:${name}`)

    // 启动处理循环
    setImmediate(() => this.processNext())

    // 处理延迟任务
    this.delayedTimer = setInterval(() => this.processDelayed(), 1000)
  }

  add<T = unknown>(jobName: string, data: T, options: JobOptions = {}): Job<T> {
    const job: Job<T> = {
      id: (this.nextJobId++).toString(),
      name: jobName,
      data,
      options,
      progress: 0,
      timestamp: Date.now(),
      attemptsMade: 0
    }

    if (options.delay && options.delay > 0) {
      job.timestamp = Date.now() + options.delay
      this.delayed.push(job)
      this.emit('delayed', job)
    } else {
      this.waiting.push(job)
      this.emit('waiting', job)
    }

    this.processNext()
    return job
  }

  process<T = unknown>(jobName: string, processor: JobProcessor<T>): void {
    this.processors.set(jobName, processor as JobProcessor<unknown>)
    this.processNext()
  }

  pause(): void {
    this.paused = true
    this.emit('paused')
  }

  resume(): void {
    this.paused = false
    this.emit('resumed')
    this.processNext()
  }

  empty(): void {
    this.waiting.length = 0
    this.delayed.length = 0
    this.emit('drained')
  }

  clean(grace: number, status: JobStatus): Job[] {
    const now = Date.now()
    const graceTime = grace * 1000
    let cleanedJobs: Job[] = []

    const cleanQueue = (queue: Job[]) => {
      const toClean: Job[] = []
      const remaining: Job[] = []

      for (const job of queue) {
        const jobTime = job.finishedOn || job.processedOn || job.timestamp
        if (now - jobTime > graceTime) {
          toClean.push(job)
        } else {
          remaining.push(job)
        }
      }

      return { toClean, remaining }
    }

    switch (status) {
      case 'completed': {
        const { toClean, remaining } = cleanQueue(this.completed)
        this.completed = remaining
        cleanedJobs = toClean
        break
      }
      case 'failed': {
        const { toClean, remaining } = cleanQueue(this.failed)
        this.failed = remaining
        cleanedJobs = toClean
        break
      }
      case 'active': {
        const { toClean, remaining } = cleanQueue(this.active)
        this.active = remaining
        cleanedJobs = toClean
        break
      }
      case 'waiting': {
        const { toClean, remaining } = cleanQueue(this.waiting)
        this.waiting = remaining
        cleanedJobs = toClean
        break
      }
    }

    if (cleanedJobs.length > 0) {
      this.emit('cleaned', cleanedJobs)
    }

    return cleanedJobs
  }

  getJob<T = unknown>(jobId: string): Job<T> | null {
    const allJobs = [...this.waiting, ...this.active, ...this.completed, ...this.failed, ...this.delayed]
    return allJobs.find(job => job.id === jobId) as Job<T> || null
  }

  removeJob(jobId: string): void {
    const removeFromArray = (array: Job[]) => {
      const index = array.findIndex(job => job.id === jobId)
      if (index !== -1) {
        array.splice(index, 1)
        return true
      }
      return false
    }

    const removed = removeFromArray(this.waiting) ||
                   removeFromArray(this.active) ||
                   removeFromArray(this.completed) ||
                   removeFromArray(this.failed) ||
                   removeFromArray(this.delayed)

    if (removed) {
      this.emit('removed', jobId)
    }
  }

  retryJob(jobId: string): void {
    const job = this.failed.find(job => job.id === jobId)
    if (job) {
      // 重置任务状态
      job.progress = 0
      job.failedReason = undefined
      job.attemptsMade = 0
      delete job.processedOn
      delete job.finishedOn

      // 从失败队列移动到等待队列
      const index = this.failed.indexOf(job)
      if (index !== -1) {
        this.failed.splice(index, 1)
        this.waiting.push(job)
        this.emit('waiting', job)
        this.processNext()
      }
    }
  }

  getStatus(): QueueStatus {
    return {
      waiting: this.waiting.length,
      active: this.active.length,
      completed: this.completed.length,
      failed: this.failed.length,
      delayed: this.delayed.length,
      paused: this.paused
    }
  }

  getWaiting(): Job[] {
    return [...this.waiting]
  }

  getActive(): Job[] {
    return [...this.active]
  }

  getCompleted(): Job[] {
    return [...this.completed]
  }

  getFailed(): Job[] {
    return [...this.failed]
  }

  private async processNext(): Promise<void> {
    if (this.paused || this.processing || this.waiting.length === 0) {
      return
    }

    this.processing = true

    while (!this.paused && this.waiting.length > 0) {
      const job = this.waiting.shift()!
      const processor = this.processors.get(job.name)

      if (!processor) {
        // 没有处理器，跳过此任务
        continue
      }

      // 移动到活跃队列
      this.active.push(job)
      job.processedOn = Date.now()
      this.emit('active', job)

      try {
        // 处理任务
        const result = await this.processJob(job, processor)

        // 移动到完成队列
        const activeIndex = this.active.indexOf(job)
        if (activeIndex !== -1) {
          this.active.splice(activeIndex, 1)
        }

        job.returnValue = result
        job.progress = 100
        job.finishedOn = Date.now()
        this.completed.push(job)
        this.emit('completed', job, result)

      } catch (error) {
        // 处理失败
        const activeIndex = this.active.indexOf(job)
        if (activeIndex !== -1) {
          this.active.splice(activeIndex, 1)
        }

        job.failedReason = (error as Error).message
        job.finishedOn = Date.now()
        job.attemptsMade = (job.attemptsMade || 0) + 1

        // 检查是否需要重试
        const maxAttempts = job.options?.attempts || 1
        if ((job.attemptsMade || 0) < maxAttempts) {
          // 计算退避延迟
          const backoff = this.calculateBackoff(job)
          if (backoff > 0) {
            job.timestamp = Date.now() + backoff
            this.delayed.push(job)
          } else {
            this.waiting.unshift(job) // 重新加入等待队列
          }
        } else {
          // 达到最大重试次数，移动到失败队列
          this.failed.push(job)
          this.emit('failed', job, error)
        }
      }
    }

    this.processing = false

    // 如果还有等待的任务，继续处理
    if (!this.paused && this.waiting.length > 0) {
      setImmediate(() => this.processNext())
    }
  }

  private async processJob(job: Job, processor: JobProcessor): Promise<unknown> {
    // 设置超时
    let timeoutId: NodeJS.Timeout | null = null
    const timeout = job.options?.timeout

    const processPromise = processor(job)

    if (timeout && timeout > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Job ${job.id} timed out after ${timeout}ms`))
        }, timeout)
      })

      try {
        return await Promise.race([processPromise, timeoutPromise])
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
      }
    }

    return processPromise
  }

  private calculateBackoff(job: Job): number {
    const backoff = job.options?.backoff
    if (!backoff) return 0

    const attemptsMade = job.attemptsMade || 0

    if (typeof backoff === 'string') {
      switch (backoff) {
        case 'fixed':
          return 1000 // 默认1秒
        case 'exponential':
          return Math.pow(2, attemptsMade) * 1000
        default:
          return 0
      }
    }

    if (typeof backoff === 'object') {
      const { type, delay } = backoff
      switch (type) {
        case 'fixed':
          return delay
        case 'exponential':
          return Math.pow(2, attemptsMade) * delay
        default:
          return delay
      }
    }

    return 0
  }

  private processDelayed(): void {
    if (this.paused || this.delayed.length === 0) return

    const now = Date.now()
    const readyJobs: Job[] = []

    // 找出所有准备执行的延迟任务
    this.delayed = this.delayed.filter(job => {
      if (job.timestamp <= now) {
        readyJobs.push(job)
        return false
      }
      return true
    })

    // 将准备好的任务移动到等待队列
    for (const job of readyJobs) {
      this.waiting.push(job)
      this.emit('waiting', job)
    }

    if (readyJobs.length > 0) {
      this.processNext()
    }
  }

  /**
   * 销毁队列，清理所有资源
   */
  destroy(): void {
    clearInterval(this.delayedTimer)
    this.waiting.length = 0
    this.active.length = 0
    this.completed.length = 0
    this.failed.length = 0
    this.delayed.length = 0
    this.processors.clear()
    this.removeAllListeners()
  }
}

/**
 * Bull 作业接口
 */
interface BullJob {
  id: string | number
  name: string
  data: unknown
  opts?: JobOptions
  progress?: number
  returnValue?: unknown
  failedReason?: string
  timestamp?: number
  processedOn?: number
  finishedOn?: number
  attemptsMade?: number
  remove(): Promise<void>
  retry(): Promise<void>
}

/**
 * Bull 队列接口
 */
interface BullQueue {
  add(name: string, data: unknown, options?: Record<string, unknown>): Promise<BullJob>
  addBulk(jobs: Array<{ name: string; data: unknown; opts?: Record<string, unknown> }>): Promise<BullJob[]>
  process(name: string, processor: (job: BullJob) => Promise<unknown>): void
  pause(): Promise<void>
  resume(): Promise<void>
  empty(): Promise<void>
  clean(grace: number, status: string): Promise<BullJob[]>
  getJob(id: string): Promise<BullJob | null>
  getWaiting(): Promise<BullJob[]>
  getActive(): Promise<BullJob[]>
  getCompleted(): Promise<BullJob[]>
  getFailed(): Promise<BullJob[]>
  getDelayed(): Promise<BullJob[]>
  isPaused(): Promise<boolean>
  on(event: string, handler: (job: BullJob, result?: unknown) => void): void
  off(event: string, handler?: (...args: unknown[]) => void): void
  removeAllListeners(event: string): void
}

/**
 * Bull 构造器类型
 */
type BullConstructor = new (name: string, options: Record<string, unknown>) => BullQueue

/**
 * Bull/BullMQ 队列提供者
 */
class BullQueueProvider implements QueueProvider {
  private queues = new Map<string, BullQueue>()
  private Bull: BullConstructor
  private redisConnection: Record<string, unknown> | undefined
  private logger: Logger

  constructor(Bull: BullConstructor, redisConnection?: Record<string, unknown>) {
    this.Bull = Bull
    this.redisConnection = redisConnection
    this.logger = new Logger('BullQueueProvider')
  }

  private getQueue(queueName: string): BullQueue {
    if (!this.queues.has(queueName)) {
      const queue = new this.Bull(queueName, {
        redis: this.redisConnection,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 50
        }
      })
      this.queues.set(queueName, queue)
    }
    return this.queues.get(queueName)!
  }

  async add<T = unknown>(queueName: string, jobName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    try {
      const queue = this.getQueue(queueName)
      const bullJob = await queue.add(jobName, data, this.convertOptions(options))
      return this.convertBullJobToJob(bullJob) as Job<T>
    } catch (error) {
      this.logger.error(`Failed to add job to queue ${queueName}`, error as Error)
      throw error
    }
  }

  async addBulk<T = unknown>(queueName: string, jobs: Array<{name: string, data: T, options?: JobOptions}>): Promise<Job<T>[]> {
    try {
      const queue = this.getQueue(queueName)
      const bullJobs = await queue.addBulk(
        jobs.map(job => ({
          name: job.name,
          data: job.data,
          opts: this.convertOptions(job.options || {})
        }))
      )
      return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob) as Job<T>)
    } catch (error) {
      this.logger.error(`Failed to add bulk jobs to queue ${queueName}`, error as Error)
      throw error
    }
  }

  process<T = unknown>(queueName: string, jobName: string, processor: JobProcessor<T>): void {
    const queue = this.getQueue(queueName)
    queue.process(jobName, async (bullJob: BullJob) => {
      const job = this.convertBullJobToJob(bullJob) as Job<T>
      return await processor(job)
    })
  }

  async pause(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    await queue.pause()
  }

  async resume(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    await queue.resume()
  }

  async empty(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName)
    await queue.empty()
  }

  async clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const cleanedJobs = await queue.clean(grace * 1000, status)
    return cleanedJobs.map((bullJob) => this.convertBullJobToJob(bullJob))
  }

  async getJob<T = unknown>(queueName: string, jobId: string): Promise<Job<T> | null> {
    const queue = this.getQueue(queueName)
    const bullJob = await queue.getJob(jobId)
    return bullJob ? this.convertBullJobToJob(bullJob) as Job<T> : null
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName)
    const bullJob = await queue.getJob(jobId)
    if (bullJob) {
      await bullJob.remove()
    }
  }

  async retryJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName)
    const bullJob = await queue.getJob(jobId)
    if (bullJob) {
      await bullJob.retry()
    }
  }

  async getQueueStatus(queueName: string): Promise<QueueStatus> {
    const queue = this.getQueue(queueName)
    const waiting = await queue.getWaiting()
    const active = await queue.getActive()
    const completed = await queue.getCompleted()
    const failed = await queue.getFailed()
    const delayed = await queue.getDelayed()

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      paused: await queue.isPaused()
    }
  }

  async getWaiting(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const bullJobs = await queue.getWaiting()
    return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob))
  }

  async getActive(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const bullJobs = await queue.getActive()
    return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob))
  }

  async getCompleted(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const bullJobs = await queue.getCompleted()
    return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob))
  }

  async getFailed(queueName: string): Promise<Job[]> {
    const queue = this.getQueue(queueName)
    const bullJobs = await queue.getFailed()
    return bullJobs.map((bullJob) => this.convertBullJobToJob(bullJob))
  }

  on(queueName: string, event: QueueEventType, handler: (job: Job, result?: unknown) => void): void {
    const queue = this.getQueue(queueName)
    queue.on(event, (bullJob: BullJob, result?: unknown) => {
      const job = this.convertBullJobToJob(bullJob)
      handler(job, result)
    })
  }

  off(queueName: string, event: QueueEventType, handler?: (...args: unknown[]) => void): void {
    const queue = this.getQueue(queueName)
    if (handler) {
      queue.off(event, handler)
    } else {
      queue.removeAllListeners(event)
    }
  }

  private convertOptions(options: JobOptions): Record<string, unknown> {
    const bullOptions: Record<string, unknown> = {}

    if (options.delay) bullOptions.delay = options.delay
    if (options.priority) bullOptions.priority = options.priority
    if (options.attempts) bullOptions.attempts = options.attempts
    if (options.backoff) bullOptions.backoff = options.backoff
    if (options.removeOnComplete !== undefined) bullOptions.removeOnComplete = options.removeOnComplete
    if (options.removeOnFail !== undefined) bullOptions.removeOnFail = options.removeOnFail
    if (options.timeout) bullOptions.timeout = options.timeout
    if (options.repeat) bullOptions.repeat = options.repeat

    return bullOptions
  }

  private convertBullJobToJob(bullJob: BullJob): Job {
    return {
      id: bullJob.id.toString(),
      name: bullJob.name,
      data: bullJob.data,
      options: bullJob.opts || {},
      progress: bullJob.progress || 0,
      returnValue: bullJob.returnValue,
      failedReason: bullJob.failedReason,
      timestamp: bullJob.timestamp || 0,
      processedOn: bullJob.processedOn,
      finishedOn: bullJob.finishedOn,
      attemptsMade: bullJob.attemptsMade || 0
    }
  }
}

/**
 * 统一队列服务实现
 */
export class QueueServiceImpl extends EventEmitter implements QueueService {
  private provider: QueueProvider
  private logger: Logger
  private metrics: {
    totalJobs: number
    completedJobs: number
    failedJobs: number
  } = { totalJobs: 0, completedJobs: 0, failedJobs: 0 }

  constructor(provider?: QueueProvider) {
    super()
    this.provider = provider || new MemoryQueueProvider()
    this.logger = new Logger('QueueService')

    // 设置全局事件监听用于统计
    this.setupGlobalListeners()
  }

  async add<T = unknown>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>> {
    try {
      this.metrics.totalJobs++
      const job = await this.provider.add(queueName, jobName, data, options)
      this.emit('job:added', { queueName, job })
      return job
    } catch (error) {
      this.logger.error(`Failed to add job ${jobName} to queue ${queueName}`, error as Error)
      this.emit('job:error', { operation: 'add', queueName, jobName, error })
      throw error
    }
  }

  process<T = unknown>(queueName: string, jobName: string, processor: JobProcessor<T>): void {
    try {
      // 包装处理器以添加监控和错误处理
      const wrappedProcessor: JobProcessor<T> = async (job: Job<T>) => {
        this.logger.debug(`Processing job ${job.id} (${job.name}) in queue ${queueName}`)

        try {
          const result = await processor(job)
          this.logger.debug(`Job ${job.id} completed successfully`)
          return result
        } catch (error) {
          this.logger.error(`Job ${job.id} failed: ${(error as Error).message}`)
          throw error
        }
      }

      this.provider.process(queueName, jobName, wrappedProcessor)
      this.emit('processor:registered', { queueName, jobName })
    } catch (error) {
      this.logger.error(`Failed to register processor for ${jobName} in queue ${queueName}`, error as Error)
      this.emit('processor:error', { queueName, jobName, error })
    }
  }

  async addBulk<T = unknown>(queueName: string, jobs: Array<{name: string, data: T, options?: JobOptions}>): Promise<Job<T>[]> {
    try {
      this.metrics.totalJobs += jobs.length
      const addedJobs = await this.provider.addBulk(queueName, jobs)
      this.emit('jobs:added:bulk', { queueName, count: jobs.length })
      return addedJobs
    } catch (error) {
      this.logger.error(`Failed to add bulk jobs to queue ${queueName}`, error as Error)
      this.emit('jobs:error', { operation: 'addBulk', queueName, error })
      throw error
    }
  }

  async pause(queueName: string): Promise<void> {
    try {
      await this.provider.pause(queueName)
      this.emit('queue:paused', { queueName })
    } catch (error) {
      this.logger.error(`Failed to pause queue ${queueName}`, error as Error)
      throw error
    }
  }

  async resume(queueName: string): Promise<void> {
    try {
      await this.provider.resume(queueName)
      this.emit('queue:resumed', { queueName })
    } catch (error) {
      this.logger.error(`Failed to resume queue ${queueName}`, error as Error)
      throw error
    }
  }

  async empty(queueName: string): Promise<void> {
    try {
      await this.provider.empty(queueName)
      this.emit('queue:emptied', { queueName })
    } catch (error) {
      this.logger.error(`Failed to empty queue ${queueName}`, error as Error)
      throw error
    }
  }

  async clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]> {
    try {
      const cleanedJobs = await this.provider.clean(queueName, grace, status)
      this.emit('queue:cleaned', { queueName, count: cleanedJobs.length, status })
      return cleanedJobs
    } catch (error) {
      this.logger.error(`Failed to clean queue ${queueName}`, error as Error)
      throw error
    }
  }

  async getJob<T = unknown>(queueName: string, jobId: string): Promise<Job<T> | null> {
    return this.provider.getJob(queueName, jobId)
  }

  async removeJob(queueName: string, jobId: string): Promise<void> {
    try {
      await this.provider.removeJob(queueName, jobId)
      this.emit('job:removed', { queueName, jobId })
    } catch (error) {
      this.logger.error(`Failed to remove job ${jobId} from queue ${queueName}`, error as Error)
      throw error
    }
  }

  async retryJob(queueName: string, jobId: string): Promise<void> {
    try {
      await this.provider.retryJob(queueName, jobId)
      this.emit('job:retried', { queueName, jobId })
    } catch (error) {
      this.logger.error(`Failed to retry job ${jobId} in queue ${queueName}`, error as Error)
      throw error
    }
  }

  async getQueueStatus(queueName: string): Promise<QueueStatus> {
    return this.provider.getQueueStatus(queueName)
  }

  async getWaiting(queueName: string): Promise<Job[]> {
    return this.provider.getWaiting(queueName)
  }

  async getActive(queueName: string): Promise<Job[]> {
    return this.provider.getActive(queueName)
  }

  async getCompleted(queueName: string): Promise<Job[]> {
    return this.provider.getCompleted(queueName)
  }

  async getFailed(queueName: string): Promise<Job[]> {
    return this.provider.getFailed(queueName)
  }

  onQueueEvent(queueName: string, event: QueueEventType, handler: (job: Job, result?: unknown) => void): void {
    this.provider.on(queueName, event, handler)
  }

  offQueueEvent(queueName: string, event: QueueEventType, handler?: (...args: unknown[]) => void): void {
    this.provider.off(queueName, event, handler)
  }

  /**
   * 获取队列统计信息
   */
  getMetrics() {
    const successRate = this.metrics.totalJobs > 0 ?
      (this.metrics.completedJobs / this.metrics.totalJobs) * 100 : 0

    return {
      ...this.metrics,
      successRate: Number(successRate.toFixed(2))
    }
  }

  /**
   * 重置统计信息
   */
  resetMetrics() {
    this.metrics = { totalJobs: 0, completedJobs: 0, failedJobs: 0 }
  }

  private setupGlobalListeners() {
    // 这里可以设置全局监听器来统计所有队列的指标
    // 由于我们不知道所有队列名称，暂时跳过全局监听
    // 实际使用中，可以通过提供者特定的方式来设置
  }

  /**
   * 创建 Bull 队列服务
   */
  static createBullService(Bull: BullConstructor, redisConnection?: Record<string, unknown>): QueueServiceImpl {
    return new QueueServiceImpl(new BullQueueProvider(Bull, redisConnection))
  }

  /**
   * 创建内存队列服务
   */
  static createMemoryService(): QueueServiceImpl {
    return new QueueServiceImpl(new MemoryQueueProvider())
  }
}

export { MemoryQueueProvider, BullQueueProvider }
