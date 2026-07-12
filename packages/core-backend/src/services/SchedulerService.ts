/**
 * 调度服务实现
 * 支持 Cron 表达式调度和延迟任务，提供插件隔离
 */

import { EventEmitter } from 'eventemitter3'
import type {
  SchedulerService,
  ScheduledJob,
  ScheduleOptions,
  ScheduleHandler,
  ScheduleEventType
} from '../types/plugin'
import { Logger } from '../core/logger'
// Roadmap §7.8 "Add timezone support": zoned wall-clock matching reuses the SAME primitives
// the multitable automation cron trigger already ships (T2-5) rather than a second hand-rolled
// implementation — see that module's docstring, which explicitly invites this reuse.
import { getZonedParts, isValidIanaTimeZone, isZonedFallbackRepeat } from '../multitable/automation-timezone'

/**
 * Cron 解析器接口
 */
interface CronExpression {
  next(): Date | null
  prev(): Date | null
  hasNext(): boolean
  reset(date?: Date): void
}

/**
 * Resolve a `SimpleCronExpression` timezone argument to the zoned-matching path, or `null` meaning
 * REAL UTC. `null` covers: undefined, empty string, `'UTC'`, `'Etc/UTC'`, and an invalid IANA zone
 * (never throws mid-match — this class is the RUNTIME; the fail-closed reject-on-save gate lives at
 * the write boundary, `directory-sync-timezone.ts` / `admin-directory.ts`).
 *
 * `null` used to mean "fall through to the host's LOCAL clock". It no longer does — see `matchesUtc`.
 */
function resolveZonedTimeZone(timezone: string | undefined): string | null {
  const tz = typeof timezone === 'string' ? timezone.trim() : ''
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return null
  if (!isValidIanaTimeZone(tz)) return null
  return tz
}

/**
 * Owner review P2 (2026-07-12) — "UTC" used to mean "whatever the host clock says".
 *
 * `resolveZonedTimeZone` returns null for absent/''/UTC/Etc/UTC/invalid, and `matches()` then fell
 * through to LOCAL `Date` getters (`getHours()`, `getDate()`, …). So a cron explicitly configured as
 * UTC — which is what `directory-sync-scheduler.ts` passes — actually fired on the host's local clock.
 * On a UTC-clocked container the two coincide, which is exactly why it hid; under `TZ=Asia/Taipei` the
 * owner measured a UTC cron landing 8 hours off. The suite could not catch it either, because
 * `scheduler-service.test.ts` pins `process.env.TZ='UTC'`.
 *
 * There is no legitimate caller that wants "host-local, whatever that happens to be" — a scheduler's
 * firing time must not depend on the machine's TZ env. So the local-getter path is GONE: an unspecified
 * or UTC zone now means REAL UTC (`getUTC*`), and an invalid zone degrades to real UTC rather than to
 * the host clock (the fail-closed reject lives at the save boundary; the runtime must stay deterministic).
 */
function matchesUtc(
  date: Date,
  minute: number[], hour: number[], dayOfMonth: number[], month: number[], dayOfWeek: number[],
): boolean {
  return minute.includes(date.getUTCMinutes()) &&
         hour.includes(date.getUTCHours()) &&
         dayOfMonth.includes(date.getUTCDate()) &&
         month.includes(date.getUTCMonth() + 1) &&
         dayOfWeek.includes(date.getUTCDay())
}

/**
 * 简单的 Cron 表达式解析器
 * 支持标准的 5 字段格式：分 时 日 月 周
 */
/** One minute in absolute (epoch) milliseconds — the scan's step unit. */
const MINUTE_MS = 60_000

class SimpleCronExpression implements CronExpression {
  private minute: number[] = []
  private hour: number[] = []
  private dayOfMonth: number[] = []
  private month: number[] = []
  private dayOfWeek: number[] = []
  private timezone: string
  private currentDate: Date
  // Resolved once at construction. `null` = REAL UTC matching (NOT the host clock — that path is gone).
  private zonedTimeZone: string | null

  constructor(expression: string, timezone: string = 'UTC') {
    this.timezone = timezone
    this.zonedTimeZone = resolveZonedTimeZone(timezone)
    this.currentDate = new Date()
    this.parseExpression(expression)
  }

  private parseExpression(expression: string): void {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) {
      throw new Error('Invalid cron expression. Expected 5 fields: minute hour dayOfMonth month dayOfWeek')
    }

    this.minute = this.parseField(parts[0], 0, 59)
    this.hour = this.parseField(parts[1], 0, 23)
    this.dayOfMonth = this.parseField(parts[2], 1, 31)
    this.month = this.parseField(parts[3], 1, 12)
    this.dayOfWeek = this.parseField(parts[4], 0, 7).map(d => d === 7 ? 0 : d) // 周日可以是0或7
  }

  private parseField(field: string, min: number, max: number): number[] {
    if (field === '*') {
      return Array.from({ length: max - min + 1 }, (_, i) => i + min)
    }

    if (field.includes('/')) {
      const [range, step] = field.split('/')
      const stepValue = parseInt(step, 10)
      const baseValues = range === '*' ?
        Array.from({ length: max - min + 1 }, (_, i) => i + min) :
        this.parseField(range, min, max)

      return baseValues.filter((_, i) => i % stepValue === 0)
    }

    if (field.includes(',')) {
      return field.split(',').flatMap(part => this.parseField(part.trim(), min, max))
    }

    if (field.includes('-')) {
      const [start, end] = field.split('-').map(s => parseInt(s.trim(), 10))
      return Array.from({ length: end - start + 1 }, (_, i) => i + start)
    }

    const value = parseInt(field, 10)
    if (isNaN(value) || value < min || value > max) {
      throw new Error(`Invalid field value: ${field}`)
    }

    return [value]
  }

  /**
   * The scan walks ABSOLUTE time (epoch ms), one minute at a time — NOT local wall-clock minutes.
   *
   * Owner review P2 (2026-07-12), second round: this used to step with `setMinutes(getMinutes() ± 1)`,
   * which advances the LOCAL wall clock. On the HOST's own DST day that clock is not monotonic — it
   * folds back an hour (fall-back) or jumps forward an hour (spring-forward) — so the scan either
   * revisits the same absolute instants or SKIPS a whole hour of them. Real candidates were then never
   * examined at all: with the host on `America/New_York`, a genuine 2026-11-01T06:30Z match was stepped
   * straight over and `next()` returned the FOLLOWING DAY (and `prev()` the previous one).
   *
   * That bug is independent of the cron's own timezone — it is the ITERATION that was zone-sensitive,
   * not the matching. Fixing `matches()` to real UTC (above) did not fix it, and the first round of
   * tests could not see it because they ran under `Asia/Taipei`, which observes no DST. Epoch-ms
   * stepping is monotonic by construction and immune to whatever the host clock does.
   */
  next(): Date | null {
    // Floor to the minute in ABSOLUTE time. `setSeconds(0, 0)` — which the previous revision used, with
    // a comment claiming it was "offset-invariant" — is NOT: it writes through LOCAL wall-clock fields,
    // and the resulting instant is re-derived from them. During a fall-back the same local wall time maps
    // to TWO instants, and that re-derivation collapses onto the FIRST one. So at the SECOND 01:30 local
    // (06:30:30Z, New_York) the base jumped an HOUR BACKWARD to 05:30Z, and next() returned 05:31Z —
    // EARLIER THAN NOW. JobScheduler clamps a negative delay to 0, fires, and reschedules: a per-minute
    // job HOT-LOOPS for the entire fall-back hour (owner P1, 2026-07-12).
    // Integer division on the epoch never touches a wall clock, so it cannot be folded.
    const baseMs = Math.floor(this.currentDate.getTime() / MINUTE_MS) * MINUTE_MS
    let ms = baseMs + MINUTE_MS

    for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
      const candidate = new Date(ms)
      if (this.matches(candidate)) {
        this.currentDate = new Date(ms)
        return new Date(ms)
      }
      ms += MINUTE_MS
    }

    return null // 找不到匹配的时间
  }

  prev(): Date | null {
    // Same absolute-time flooring — see next(). A local-wall-clock floor here returned 05:29Z instead of
    // 06:29Z at the second fold occurrence.
    const baseMs = Math.floor(this.currentDate.getTime() / MINUTE_MS) * MINUTE_MS
    let ms = baseMs - MINUTE_MS

    for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
      const candidate = new Date(ms)
      if (this.matches(candidate)) {
        return new Date(ms)
      }
      ms -= MINUTE_MS
    }

    return null
  }

  hasNext(): boolean {
    const saved = new Date(this.currentDate)
    const next = this.next()
    this.currentDate = saved
    return next !== null
  }

  reset(date?: Date): void {
    this.currentDate = date || new Date()
  }

  private matches(date: Date): boolean {
    // A resolved IANA zone takes the zoned branch; everything else (absent/''/UTC/Etc/UTC/invalid) is
    // REAL UTC — never the host clock. See `matchesUtc` for why the local-getter path was removed.
    if (this.zonedTimeZone) {
      let parts: ReturnType<typeof getZonedParts>
      try {
        parts = getZonedParts(date.getTime(), this.zonedTimeZone)
      } catch {
        // Defensive: a formatter failure mid-scan must never throw out of next()/prev().
        return false
      }
      // Day-of-week is derived from the civil date (locale-independent), matching
      // `automation-scheduler.ts`'s `cronMatchesZoned` technique exactly.
      const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
      const civilMatches =
        this.minute.includes(parts.minute) &&
        this.hour.includes(parts.hour) &&
        this.dayOfMonth.includes(parts.day) &&
        this.month.includes(parts.month) &&
        this.dayOfWeek.includes(dow)
      if (!civilMatches) return false
      // DST fall-back SINGLE-FIRE (owner review P2): on a clock-back night the same wall-clock minute
      // occurs at TWO absolute instants an hour apart, and BOTH matched — so a zoned cron fired twice.
      // The previously-documented mitigation ("the sync lease absorbs it") is false: the lease only
      // blocks a CONCURRENT run, and these two are an hour apart. Emit the FIRST instant, suppress the
      // second — the same proven rule the multitable automation scheduler uses (now shared, not cloned).
      return !isZonedFallbackRepeat(date.getTime(), this.zonedTimeZone)
    }
    return matchesUtc(date, this.minute, this.hour, this.dayOfMonth, this.month, this.dayOfWeek)
  }
}

/**
 * Node clamps setTimeout delays greater than 2^31-1 ms (~24.86 days) down to 1ms. Passed
 * a raw far-future delay (e.g. a yearly cron saved mid-year, ~175 days out), that clamp
 * would make the job fire immediately and hot-loop — re-scheduling itself right back into
 * the same clamp — gated only by whatever the handler itself does (e.g. a sync lease).
 * Arm delays above this safe ceiling in repeated max-size chunks: wait out one chunk,
 * recompute the remaining delay against the fixed target time, and re-arm. Only once the
 * remaining delay fits under the ceiling does the real fire-the-job timeout get set.
 */
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1 - 1_000_000 // headroom under Node's ~24.86-day clamp point

/**
 * 调度作业管理器
 */
class JobScheduler extends EventEmitter {
  private jobs = new Map<string, ScheduledJob>()
  private timers = new Map<string, NodeJS.Timeout>()
  private cronJobs = new Map<string, { expression: CronExpression, timeout: NodeJS.Timeout }>()
  private logger: Logger

  constructor() {
    super()
    this.logger = new Logger('JobScheduler')
  }

  addJob(job: ScheduledJob): void {
    const jobName = job.name || job.id || ''
    this.jobs.set(jobName, job)

    if (job.cronExpression) {
      this.scheduleCronJob(job)
    } else if (job.delay) {
      this.scheduleDelayedJob(job)
    }

    this.logger.debug(`Scheduled job: ${jobName}`)
  }

  removeJob(name: string): void {
    const job = this.jobs.get(name)
    if (!job) return

    // 清理定时器
    const timer = this.timers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(name)
    }

    // 清理 cron 任务
    const cronJob = this.cronJobs.get(name)
    if (cronJob) {
      clearTimeout(cronJob.timeout)
      this.cronJobs.delete(name)
    }

    this.jobs.delete(name)
    this.logger.debug(`Removed job: ${name}`)
  }

  getJob(name: string): ScheduledJob | null {
    return this.jobs.get(name) || null
  }

  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values())
  }

  pauseJob(name: string): void {
    const job = this.jobs.get(name)
    if (job) {
      job.isPaused = true
      this.emit('job:paused', job)
    }
  }

  resumeJob(name: string): void {
    const job = this.jobs.get(name)
    if (job) {
      job.isPaused = false
      this.emit('job:resumed', job)

      // 重新调度
      if (job.cronExpression) {
        this.scheduleCronJob(job)
      }
    }
  }

  async triggerJob(name: string): Promise<void> {
    const job = this.jobs.get(name)
    if (!job) {
      throw new Error(`Job not found: ${name}`)
    }

    await this.executeJob(job)
  }

  private scheduleCronJob(job: ScheduledJob): void {
    if (!job.cronExpression || job.isPaused) return

    const registrationName = job.name || job.id || ''
    // Review P2-1 — STALE-JOB GUARD. `armCronTimeout`'s post-run callback re-schedules the job object
    // it CAPTURED when the timer was armed. If that job was unregistered or REPLACED while the run was
    // in flight, re-arming it resurrects a job the caller already dismissed:
    //   * unschedule() mid-run → a ZOMBIE: `jobs` no longer holds it and getJob() returns null, but the
    //     timer keeps firing — an admin who disables directory sync gets a sync that keeps calling
    //     DingTalk until the process restarts.
    //   * a timezone edit mid-run (unschedule + schedule with a NEW job) → the finishing run re-arms the
    //     OLD object, silently REVERTING to the stale zone; it does not self-heal, because `jobs` holds
    //     the new job so the next applySchedule sees an unchanged timezone and reschedules in place.
    // Only ever (re)schedule the job that is CURRENTLY registered under this name. Identity, not name:
    // a replacement job carries the same name but is a different object.
    // (The other two call sites schedule a job that IS the registered one — schedule() sets `jobs`
    // immediately before, and resume() reads it out of `jobs` — so this guard is inert for them.)
    if (this.jobs.get(registrationName) !== job) {
      this.logger.debug(`Skipping re-schedule of a stale/unregistered cron job: ${registrationName}`)
      return
    }

    try {
      const expression = new SimpleCronExpression(job.cronExpression, job.options?.timezone)
      const nextRun = expression.next()

      if (!nextRun) {
        this.logger.warn(`No next run time for cron job: ${job.name}`)
        return
      }

      job.nextRun = nextRun
      const jobName = registrationName

      // 清理旧的定时器
      const oldCronJob = this.cronJobs.get(jobName)
      if (oldCronJob) {
        clearTimeout(oldCronJob.timeout)
      }

      this.armCronTimeout(job, jobName, expression, nextRun)

      this.logger.debug(`Cron job ${jobName} scheduled for ${nextRun.toISOString()}`)
    } catch (error) {
      this.logger.error(`Failed to schedule cron job ${job.name}`, error as Error)
      this.emit('job:error', job, error)
    }
  }

  /**
   * Arms the timer for a job's next cron fire, chunking delays that exceed
   * MAX_SAFE_TIMEOUT_MS so a single setTimeout call is never handed a value Node would
   * silently clamp. `nextRun` is the fixed target time computed once by scheduleCronJob;
   * each chunk re-derives the remaining delay from it rather than re-parsing the cron.
   * Always writes the latest timeout handle into `cronJobs` so removeJob/destroy can
   * cancel mid-chain — a job unscheduled between chunks must not fire.
   */
  private armCronTimeout(job: ScheduledJob, jobName: string, expression: CronExpression, nextRun: Date): void {
    const remainingMs = nextRun.getTime() - Date.now()

    if (remainingMs > MAX_SAFE_TIMEOUT_MS) {
      const timeout = setTimeout(() => {
        this.armCronTimeout(job, jobName, expression, nextRun)
      }, MAX_SAFE_TIMEOUT_MS)
      this.cronJobs.set(jobName, { expression, timeout })
      return
    }

    const timeout = setTimeout(async () => {
      await this.executeJob(job)
      // 执行完成后重新调度下一次
      this.scheduleCronJob(job)
    }, Math.max(remainingMs, 0))

    this.cronJobs.set(jobName, { expression, timeout })
  }

  private scheduleDelayedJob(job: ScheduledJob): void {
    if (!job.delay || job.isPaused) return
    const jobName = job.name || job.id || ''

    const timeout = setTimeout(async () => {
      await this.executeJob(job)
      this.removeJob(jobName) // 延迟任务只执行一次
    }, job.delay)

    this.timers.set(jobName, timeout)
    job.nextRun = new Date(Date.now() + job.delay)

    this.logger.debug(`Delayed job ${jobName} scheduled for ${job.nextRun.toISOString()}`)
  }

  private async executeJob(job: ScheduledJob): Promise<void> {
    if (job.isPaused || job.isRunning) return
    if (!job.handler) return
    const jobName = job.name || job.id || ''

    job.isRunning = true
    job.lastRun = new Date()
    job.runCount++

    this.emit('job:running', job)
    this.logger.debug(`Executing job: ${jobName}`)

    try {
      const result = await job.handler(job.options?.context)

      job.isRunning = false
      this.emit('job:completed', job, result)
      this.logger.debug(`Job completed: ${jobName}`)

    } catch (error) {
      job.isRunning = false
      this.emit('job:failed', job, error)
      this.logger.error(`Job failed: ${jobName}`, error as Error)
    }
  }

  destroy(): void {
    // 清理所有定时器
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }

    for (const cronJob of this.cronJobs.values()) {
      clearTimeout(cronJob.timeout)
    }

    this.timers.clear()
    this.cronJobs.clear()
    this.jobs.clear()

    this.logger.info('JobScheduler destroyed')
  }
}

/**
 * 调度服务实现
 */
export class SchedulerServiceImpl extends EventEmitter implements SchedulerService {
  private scheduler: JobScheduler
  private logger: Logger
  private pluginJobs = new Map<string, Set<string>>() // pluginName -> jobNames

  constructor() {
    super()
    this.scheduler = new JobScheduler()
    this.logger = new Logger('SchedulerService')

    // 转发调度器事件
    this.scheduler.on('job:running', (job, result) => this.emit('running', job, result))
    this.scheduler.on('job:completed', (job, result) => this.emit('completed', job, result))
    this.scheduler.on('job:failed', (job, error) => this.emit('failed', job, error))
    this.scheduler.on('job:paused', (job) => this.emit('paused', job))
    this.scheduler.on('job:resumed', (job) => this.emit('resumed', job))
    this.scheduler.on('job:error', (job, error) => this.emit('failed', job, error))
  }

  async schedule(name: string, cronExpression: string, handler: ScheduleHandler, options: ScheduleOptions = {}): Promise<ScheduledJob> {
    try {
      // 验证 cron 表达式
      const testExpression = new SimpleCronExpression(cronExpression, options.timezone)
      if (!testExpression.hasNext()) {
        throw new Error('Invalid cron expression: no future execution times')
      }

      const job: ScheduledJob = {
        name,
        cronExpression,
        handler,
        options,
        runCount: 0,
        isRunning: false,
        isPaused: false
      }

      // 检查启动日期
      if (options.startDate && options.startDate > new Date()) {
        const delayMs = options.startDate.getTime() - Date.now()
        setTimeout(() => {
          this.scheduler.addJob(job)
          this.emit('scheduled', job)
        }, delayMs)
      } else if (options.runOnInit) {
        // 立即执行一次
        setImmediate(async () => {
          try {
            if (job.handler) await job.handler(options.context)
          } catch (error) {
            this.logger.error(`Initial run failed for job ${name}`, error as Error)
          }
        })
        this.scheduler.addJob(job)
        this.emit('scheduled', job)
      } else {
        this.scheduler.addJob(job)
        this.emit('scheduled', job)
      }

      return job
    } catch (error) {
      this.logger.error(`Failed to schedule job ${name}`, error as Error)
      throw error
    }
  }

  async unschedule(name: string): Promise<void> {
    try {
      this.scheduler.removeJob(name)

      // 从插件作业映射中移除
      for (const [pluginName, jobNames] of this.pluginJobs.entries()) {
        if (jobNames.has(name)) {
          jobNames.delete(name)
          if (jobNames.size === 0) {
            this.pluginJobs.delete(pluginName)
          }
          break
        }
      }

      this.emit('cancelled', { name } as ScheduledJob)
    } catch (error) {
      this.logger.error(`Failed to unschedule job ${name}`, error as Error)
      throw error
    }
  }

  async reschedule(name: string, cronExpression: string): Promise<void> {
    const job = this.scheduler.getJob(name)
    if (!job) {
      throw new Error(`Job not found: ${name}`)
    }

    try {
      // 验证新的 cron 表达式
      const testExpression = new SimpleCronExpression(cronExpression, job.options?.timezone)
      if (!testExpression.hasNext()) {
        throw new Error('Invalid cron expression: no future execution times')
      }

      // 更新任务并重新调度
      job.cronExpression = cronExpression
      delete job.delay // 清除延迟设置

      this.scheduler.removeJob(name)
      this.scheduler.addJob(job)

      this.logger.info(`Rescheduled job ${name} with new cron expression: ${cronExpression}`)
    } catch (error) {
      this.logger.error(`Failed to reschedule job ${name}`, error as Error)
      throw error
    }
  }

  async delay(name: string, delay: number, handler: ScheduleHandler, options: ScheduleOptions = {}): Promise<ScheduledJob> {
    try {
      const job: ScheduledJob = {
        name,
        delay,
        handler,
        options,
        runCount: 0,
        isRunning: false,
        isPaused: false,
        nextRun: new Date(Date.now() + delay)
      }

      this.scheduler.addJob(job)
      this.emit('scheduled', job)

      return job
    } catch (error) {
      this.logger.error(`Failed to schedule delayed job ${name}`, error as Error)
      throw error
    }
  }

  async getJob(name: string): Promise<ScheduledJob | null> {
    return this.scheduler.getJob(name)
  }

  async listJobs(): Promise<ScheduledJob[]> {
    return this.scheduler.listJobs()
  }

  async pause(name: string): Promise<void> {
    this.scheduler.pauseJob(name)
  }

  async resume(name: string): Promise<void> {
    this.scheduler.resumeJob(name)
  }

  async trigger(name: string): Promise<void> {
    await this.scheduler.triggerJob(name)
  }

  onScheduleEvent(event: ScheduleEventType, handler: (job: ScheduledJob, result?: unknown, error?: Error) => void): void {
    super.on(event, handler)
  }

  offScheduleEvent(event: ScheduleEventType, handler?: (...args: unknown[]) => void): void {
    if (handler) {
      super.off(event, handler)
    } else {
      super.removeAllListeners(event)
    }
  }

  /**
   * 为插件注册任务（提供插件隔离）
   */
  async scheduleForPlugin(
    pluginName: string,
    jobName: string,
    cronExpression: string,
    handler: ScheduleHandler,
    options: ScheduleOptions = {}
  ): Promise<ScheduledJob> {
    const fullJobName = `${pluginName}:${jobName}`

    // 包装处理器以添加插件上下文
    const wrappedHandler: ScheduleHandler = async (context) => {
      this.logger.debug(`Executing job ${fullJobName} for plugin ${pluginName}`)
      return handler(context)
    }

    const contextObj = (options.context && typeof options.context === 'object') ? options.context as Record<string, unknown> : {}
    const job = await this.schedule(fullJobName, cronExpression, wrappedHandler, {
      ...options,
      context: { ...contextObj, pluginName }
    })

    // 记录插件与任务的关系
    if (!this.pluginJobs.has(pluginName)) {
      this.pluginJobs.set(pluginName, new Set())
    }
    this.pluginJobs.get(pluginName)!.add(fullJobName)

    return job
  }

  /**
   * 为插件调度延迟任务
   */
  async delayForPlugin(
    pluginName: string,
    jobName: string,
    delay: number,
    handler: ScheduleHandler,
    options: ScheduleOptions = {}
  ): Promise<ScheduledJob> {
    const fullJobName = `${pluginName}:${jobName}`

    const wrappedHandler: ScheduleHandler = async (context) => {
      this.logger.debug(`Executing delayed job ${fullJobName} for plugin ${pluginName}`)
      return handler(context)
    }

    const delayContextObj = (options.context && typeof options.context === 'object') ? options.context as Record<string, unknown> : {}
    const job = await this.delay(fullJobName, delay, wrappedHandler, {
      ...options,
      context: { ...delayContextObj, pluginName }
    })

    // 记录插件与任务的关系
    if (!this.pluginJobs.has(pluginName)) {
      this.pluginJobs.set(pluginName, new Set())
    }
    this.pluginJobs.get(pluginName)!.add(fullJobName)

    return job
  }

  /**
   * 取消插件的所有任务
   */
  async unschedulePluginJobs(pluginName: string): Promise<void> {
    const jobNames = this.pluginJobs.get(pluginName)
    if (!jobNames) return

    const promises = Array.from(jobNames).map(jobName => this.unschedule(jobName))
    await Promise.all(promises)

    this.pluginJobs.delete(pluginName)
    this.logger.info(`Unscheduled all jobs for plugin: ${pluginName}`)
  }

  /**
   * 获取插件的所有任务
   */
  getPluginJobs(pluginName: string): ScheduledJob[] {
    const jobNames = this.pluginJobs.get(pluginName)
    if (!jobNames) return []

    return Array.from(jobNames)
      .map(name => this.scheduler.getJob(name))
      .filter(Boolean) as ScheduledJob[]
  }

  /**
   * 获取服务统计信息
   */
  getStats() {
    const jobs = this.scheduler.listJobs()
    return {
      totalJobs: jobs.length,
      activeJobs: jobs.filter(j => !j.isPaused).length,
      pausedJobs: jobs.filter(j => j.isPaused).length,
      runningJobs: jobs.filter(j => j.isRunning).length,
      cronJobs: jobs.filter(j => j.cronExpression).length,
      delayedJobs: jobs.filter(j => j.delay).length,
      pluginCount: this.pluginJobs.size
    }
  }

  /**
   * 销毁服务
   */
  destroy(): void {
    this.scheduler.destroy()
    this.pluginJobs.clear()
    this.removeAllListeners()
    this.logger.info('SchedulerService destroyed')
  }
}

export { SimpleCronExpression, JobScheduler }
