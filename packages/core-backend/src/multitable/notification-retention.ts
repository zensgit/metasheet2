/**
 * 通知中心保留期清理(E,2026-09-12)—— **默认关**。
 *
 * 缺口:`meta_record_subscription_notifications`(迁移 zzzz20260505103000)在全仓 src 里
 * 没有任何回收/保留,只有迁移期的一次性 DELETE。F9b 之后规则侧 `send_notification` 也往里
 * 写,而通知是**按记录事件逐条发**的:一次千行导入 = 千次执行 x 收件人数行,表会无界增长。
 *
 * 形状镜像 `src/audit/operation-audit-retention.ts`(env 解析 + setInterval + unref +
 * isDatabaseSchemaError 容错 + 返回 stop 函数),但有两处**故意不同**:
 *
 *  1. **默认关**。审计日志可以按 NODE_ENV 默认开,通知不行 —— 它是用户可见数据,删掉就
 *     没了。`MULTITABLE_NOTIFICATION_RETENTION_DAYS` 未设/非法/<=0 ⇒ `start` 返回 no-op
 *     且**一条 SQL 都不发**;设了才按 1..3650 天生效。
 *  2. **批量删**。审计那条是一发 `DELETE ... WHERE occurred_at < ...` 全表删;这里改成
 *     `DELETE ... WHERE id IN (SELECT ... ORDER BY created_at LIMIT $2)` 循环,单批 5000、
 *     单轮最多 20 批,避免积压表上一条长事务把写入路径锁住。
 *
 * 删除口径(owner 默认,可在评审里撤回):删 `created_at < now() - N 天` 的**全部行**,
 * 不区分已读/未读 —— 未读超过 N 天也已失去时效。要改成"只删已读"就在 DELETE_SQL 的
 * WHERE 上加 `AND read_at IS NOT NULL`,其余不动。
 *
 * 多实例:**没有 leader lock**(与审计清理同形)。删除是幂等的 —— 两个实例同轮跑最坏是
 * 各自删掉对方没删的那部分,行只会被删一次,计数各算各的。
 *
 * 日志 values-free:只打行数/天数/毫秒,绝不打 user_id / message / sheet_id。
 */
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type NotificationRetentionQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** 单批删除行数上限 —— 一条 DELETE 最多锁这么多行。 */
export const NOTIFICATION_RETENTION_BATCH_SIZE = 5000
/** 单轮(一次 tick)最多几批 —— 剩下的留给下一轮,绝不在一个 tick 里无界打转。 */
export const NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN = 20
/** 天数上限;下限是 1(<=0 视为"没配",即关)。 */
export const NOTIFICATION_RETENTION_MAX_DAYS = 3650
/**
 * 积压续轮延时:一轮打满 maxBatchesPerRun 仍没排空时,隔这么久再排一轮,而不是等满一个
 * interval(默认 24h)。单轮的批数上限不变 —— 变的只是"下一轮什么时候来"。
 */
export const NOTIFICATION_RETENTION_CATCHUP_DELAY_MS = 1_000

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 10_000
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 删除条件的**唯一**来源。`created_at < now() - make_interval(days => $1)` 是这把刀的
 * 全部安全性:去掉它就是"删光通知表"。子查询按 created_at 排序取最老的一批,走
 * idx_meta_record_subscription_notifications_user 之外的顺序扫描也只扫 LIMIT 行。
 */
const DELETE_SQL = `DELETE FROM meta_record_subscription_notifications
     WHERE id IN (
       SELECT id
       FROM meta_record_subscription_notifications
       WHERE created_at < now() - make_interval(days => $1)
       ORDER BY created_at
       LIMIT $2
     )`

export type NotificationRetentionOptions = {
  retentionDays?: number
  intervalMs?: number
  batchSize?: number
  maxBatchesPerRun?: number
  logger?: Logger
  queryFn?: NotificationRetentionQueryFn
  env?: NodeJS.ProcessEnv
}

/**
 * 天数解析。**未设/空/非数字/<=0 一律返回 null = 关**(与审计那条"解析失败落默认 90 天"
 * 刻意相反:通知不能因为 env 打错一个字就开始删用户数据)。
 */
export function resolveNotificationRetentionDays(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null
  const trimmed = typeof raw === 'number' ? String(raw) : raw.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  const days = Math.floor(parsed)
  if (days <= 0) return null
  return Math.min(days, NOTIFICATION_RETENTION_MAX_DAYS)
}

/**
 * 间隔解析:默认 24h,夹在 10s..7d(非法值回默认,不关清理 —— 天数才是开关)。
 *
 * 反驳 r1-A1:**空串/全空白/0/负数必须回默认 24h,不能被 MIN 夹成 10 秒**。`Number('') === 0`
 * 是有限数,只判 `Number.isFinite` 会让 `MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS=`(键在
 * 值空,见 docker/app.env.example 的注释写法)落到 10s —— 比文档默认快 8640 倍。照仓库自己的
 * `meta-revision-retention.ts:338` 那条写法补 `parsed <= 0`,并在 Number() 之前先 trim 判空。
 */
export function resolveNotificationRetentionIntervalMs(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_INTERVAL_MS
  const trimmed = typeof raw === 'number' ? String(raw) : raw.trim()
  if (trimmed.length === 0) return DEFAULT_INTERVAL_MS
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS
  return Math.min(Math.max(Math.floor(parsed), MIN_INTERVAL_MS), MAX_INTERVAL_MS)
}

function affectedRows(result: { rows?: unknown[]; rowCount?: number | null } | null | undefined): number {
  if (!result) return 0
  if (typeof result.rowCount === 'number') return result.rowCount
  return Array.isArray(result.rows) ? result.rows.length : 0
}

/**
 * 一轮清理:循环批量删,直到某一批删得比 batchSize 少(积压清空)或达到单轮批数上限。
 * 纯函数式 —— queryFn 注入,真库用例直接喂 pool.query,单测喂 mock。
 *
 * 反驳 r1-A4:`shouldStop` 在**每批之前**问一次。关停时 stop 只置位、不打断已经发出的那条
 * DELETE,但循环不会再发下一条 —— 否则单轮上限 20 批意味着关停后最多还能对一个正在关闭的
 * 连接池发 19 条 5000 行 DELETE。返回的 `stoppedEarly` 让调用方把这轮记成"被打断",而不是
 * 误记成"积压清空"。
 */
export async function sweepNotificationRetention(
  queryFn: NotificationRetentionQueryFn,
  options: {
    retentionDays: number
    batchSize?: number
    maxBatchesPerRun?: number
    shouldStop?: () => boolean
  },
): Promise<{ deleted: number; batches: number; drained: boolean; stoppedEarly: boolean }> {
  const batchSize = options.batchSize ?? NOTIFICATION_RETENTION_BATCH_SIZE
  const maxBatches = options.maxBatchesPerRun ?? NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN

  let deleted = 0
  let batches = 0
  let drained = false
  let stoppedEarly = false

  while (batches < maxBatches) {
    if (options.shouldStop?.()) {
      stoppedEarly = true
      break
    }
    const result = await queryFn(DELETE_SQL, [options.retentionDays, batchSize])
    const affected = affectedRows(result)
    deleted += affected
    batches += 1
    if (affected < batchSize) {
      drained = true
      break
    }
  }

  return { deleted, batches, drained, stoppedEarly }
}

/**
 * 启动定时清理。**未配置天数 ⇒ 立刻返回 no-op,零 SQL**。
 *
 * 返回的 stop 是 **async 且幂等**:置 stopped 位 + clearInterval + clearTimeout,然后 **await
 * 在飞的那一轮**(反驳 r1-A4:老实现只挡下一次 tick,关停后在飞的批量循环还会继续对一个正在
 * `pool.end()` 的池发最多 19 条 DELETE)。形状照 `services/approval-attachment-runtime.ts:571-577`
 * 的 "stop awaits any in-flight tick before the pool closes"。
 */
export function startNotificationRetention(options: NotificationRetentionOptions = {}): () => Promise<void> {
  const env = options.env ?? process.env
  const retentionDays = options.retentionDays !== undefined
    ? resolveNotificationRetentionDays(options.retentionDays)
    : resolveNotificationRetentionDays(env.MULTITABLE_NOTIFICATION_RETENTION_DAYS)

  // 默认关:没有显式、合法、正数的天数就什么都不做(连一条 SQL 都不发)。
  if (retentionDays === null) return async () => {}

  const logger = options.logger ?? new Logger('NotificationRetention')
  const intervalMs = options.intervalMs !== undefined
    ? resolveNotificationRetentionIntervalMs(options.intervalMs)
    : resolveNotificationRetentionIntervalMs(env.MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS)
  const queryFn: NotificationRetentionQueryFn = options.queryFn ?? ((sql, params) => query(sql, params))
  const batchSize = options.batchSize ?? NOTIFICATION_RETENTION_BATCH_SIZE
  const maxBatchesPerRun = options.maxBatchesPerRun ?? NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN

  let stopped = false
  /** 反驳 r1-A2:重入位。上一轮还在飞时再来 tick 就直接丢弃 —— 并发轮数上界 = 1。 */
  let running = false
  /** stop 要 await 的那一轮(没有在飞的轮次时是个已决的空 Promise)。 */
  let inFlight: Promise<void> = Promise.resolve()
  let catchUpTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 反驳 r1-A3:一轮撞上单轮批数上限(积压没排空)时,**不要等满一个 interval**(默认 24h ⇒
   * 每实例每天最多回收 maxBatchesPerRun × batchSize 行,低于 PR 正文自述的增长模型,存量积压
   * 要按天排队)。改成排一个短延时的续轮,直到某一轮 drained 为止;timer 照样 unref、stop 照样
   * 清掉。单轮仍然有界(批数上限不变),变的只是"下一轮什么时候来"。
   */
  function scheduleCatchUp(): void {
    if (stopped || catchUpTimer) return
    catchUpTimer = setTimeout(() => {
      catchUpTimer = undefined
      kickRunOnce()
    }, NOTIFICATION_RETENTION_CATCHUP_DELAY_MS)
    catchUpTimer.unref?.()
  }

  async function runOnce(): Promise<void> {
    try {
      const { deleted, batches, drained, stoppedEarly } = await sweepNotificationRetention(queryFn, {
        retentionDays: retentionDays as number,
        batchSize,
        maxBatchesPerRun,
        shouldStop: () => stopped,
      })

      if (deleted > 0) {
        logger.info(
          `Notification retention deleted ${deleted} row(s) in ${batches} batch(es) (retentionDays=${retentionDays}, drained=${drained})`,
        )
      }
      if (!drained && !stoppedEarly) {
        logger.info(
          `Notification retention hit the per-run batch cap (${maxBatchesPerRun}); scheduling a catch-up run in ${NOTIFICATION_RETENTION_CATCHUP_DELAY_MS}ms (retentionDays=${retentionDays})`,
        )
        scheduleCatchUp()
      }
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        logger.warn('Notification retention skipped: meta_record_subscription_notifications not ready', error as Error)
        return
      }
      // 其它错误:warn 不抛,下一轮继续(一次失败不该拖垮进程,也不该关掉清理)。
      logger.warn('Notification retention failed', error as Error)
    }
  }

  /**
   * **唯一**的入轮闸门:stopped / running 都在这里判,判过才置 running 并登记 inFlight。
   * 去掉这里的 `running` 就是反驳 r1-A2 说的"并发轮数无上界"(每轮各占一条池连接做批量 DELETE)。
   */
  function kickRunOnce(): void {
    if (stopped || running) return
    running = true
    inFlight = runOnce()
      // runOnce 内部已经吞掉了所有错误;这层只是保证 fire-and-forget 永不变成 unhandled rejection。
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }

  // Fire-and-forget initial cleanup.
  kickRunOnce()

  const timer = setInterval(() => {
    kickRunOnce()
  }, intervalMs)

  // Avoid holding the event loop open in CLI/tests.
  timer.unref?.()

  logger.info(
    `Notification retention started (retentionDays=${retentionDays}, intervalMs=${intervalMs}, batchSize=${batchSize}, maxBatchesPerRun=${maxBatchesPerRun})`,
  )

  return async () => {
    stopped = true
    clearInterval(timer)
    if (catchUpTimer) {
      clearTimeout(catchUpTimer)
      catchUpTimer = undefined
    }
    // 关停顺序:先置位(在飞的批量循环下一批之前就会看到)、再收 timer、最后等在飞那轮真正收尾,
    // 这样 index.ts 的 shutdownTask 才能在 pool.end() 之前把这一轮完整交代掉。
    await inFlight
    logger.info('Notification retention stopped')
  }
}
