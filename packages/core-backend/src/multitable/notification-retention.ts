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

/** 间隔解析:默认 24h,夹在 10s..7d(非法值回默认,不关清理 —— 天数才是开关)。 */
export function resolveNotificationRetentionIntervalMs(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_INTERVAL_MS
  const parsed = Number(typeof raw === 'number' ? raw : raw.trim())
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS
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
 */
export async function sweepNotificationRetention(
  queryFn: NotificationRetentionQueryFn,
  options: { retentionDays: number; batchSize?: number; maxBatchesPerRun?: number },
): Promise<{ deleted: number; batches: number; drained: boolean }> {
  const batchSize = options.batchSize ?? NOTIFICATION_RETENTION_BATCH_SIZE
  const maxBatches = options.maxBatchesPerRun ?? NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN

  let deleted = 0
  let batches = 0
  let drained = false

  while (batches < maxBatches) {
    const result = await queryFn(DELETE_SQL, [options.retentionDays, batchSize])
    const affected = affectedRows(result)
    deleted += affected
    batches += 1
    if (affected < batchSize) {
      drained = true
      break
    }
  }

  return { deleted, batches, drained }
}

/**
 * 启动定时清理。**未配置天数 ⇒ 立刻返回 no-op,零 SQL**。
 * 返回的 stop 函数幂等:置 stopped 位 + clearInterval,之后 tick 回调不再发任何查询。
 */
export function startNotificationRetention(options: NotificationRetentionOptions = {}): () => void {
  const env = options.env ?? process.env
  const retentionDays = options.retentionDays !== undefined
    ? resolveNotificationRetentionDays(options.retentionDays)
    : resolveNotificationRetentionDays(env.MULTITABLE_NOTIFICATION_RETENTION_DAYS)

  // 默认关:没有显式、合法、正数的天数就什么都不做(连一条 SQL 都不发)。
  if (retentionDays === null) return () => {}

  const logger = options.logger ?? new Logger('NotificationRetention')
  const intervalMs = options.intervalMs !== undefined
    ? resolveNotificationRetentionIntervalMs(options.intervalMs)
    : resolveNotificationRetentionIntervalMs(env.MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS)
  const queryFn: NotificationRetentionQueryFn = options.queryFn ?? ((sql, params) => query(sql, params))
  const batchSize = options.batchSize ?? NOTIFICATION_RETENTION_BATCH_SIZE
  const maxBatchesPerRun = options.maxBatchesPerRun ?? NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return

    try {
      const { deleted, batches, drained } = await sweepNotificationRetention(queryFn, {
        retentionDays: retentionDays as number,
        batchSize,
        maxBatchesPerRun,
      })

      if (deleted > 0) {
        logger.info(
          `Notification retention deleted ${deleted} row(s) in ${batches} batch(es) (retentionDays=${retentionDays}, drained=${drained})`,
        )
      }
      if (!drained) {
        logger.info(
          `Notification retention hit the per-run batch cap (${maxBatchesPerRun}); backlog continues next tick (retentionDays=${retentionDays})`,
        )
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

  // Fire-and-forget initial cleanup.
  void runOnce()

  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)

  // Avoid holding the event loop open in CLI/tests.
  timer.unref?.()

  logger.info(
    `Notification retention started (retentionDays=${retentionDays}, intervalMs=${intervalMs}, batchSize=${batchSize}, maxBatchesPerRun=${maxBatchesPerRun})`,
  )

  return () => {
    stopped = true
    clearInterval(timer)
    logger.info('Notification retention stopped')
  }
}
