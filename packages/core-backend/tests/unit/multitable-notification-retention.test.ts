/**
 * E —— 通知中心保留期清理(默认关)的逻辑级用例。
 *
 * 被测: src/multitable/notification-retention.ts
 * 接线: src/index.ts(背景任务块 startNotificationRetention / 关停块 stopNotificationRetention?.())
 *
 * 这个文件钉五件事,每件都对应一个"去掉就红"的变异:
 *   G1 默认关   —— env 未设/0/负数/NaN/空串 ⇒ start 返回 no-op 且**零 SQL**       (M1)
 *   G2 批量上限 —— 每批满 batchSize ⇒ 单轮最多 MAX_BATCHES 批,绝不无界打转        (M2)
 *   G3 删除口径 —— 归一化后的**整条 SQL 等值断言**(表名/包裹/窗口/排序/LIMIT)      (M3)
 *   G4 stop 位  —— stop() 之后 tick 回调一条 SQL 都不发 + 间隔 env 的解析与绑定      (M4)
 *   G5 容错     —— 表不存在/其它错误都只 warn 不抛,下一轮继续                      (M5)
 *   G7 在飞轮次 —— 不重入(A2)、stop 截断在飞的批量循环并被 await(A4)、
 *                  积压不干等一个 interval 而是排续轮(A3)                        (fix r1)
 *
 * 真库那条(tests/integration/multitable-notification-retention-realdb.test.ts)证 SQL 在
 * 真 Postgres 上确实只删老行;这里证分支与形状。
 */
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}))

import { Logger } from '../../src/core/logger'
import { query } from '../../src/db/pg'
import {
  NOTIFICATION_RETENTION_BATCH_SIZE,
  NOTIFICATION_RETENTION_CATCHUP_DELAY_MS,
  NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN,
  NOTIFICATION_RETENTION_MAX_DAYS,
  resolveNotificationRetentionDays,
  resolveNotificationRetentionIntervalMs,
  startNotificationRetention,
  sweepNotificationRetention,
} from '../../src/multitable/notification-retention'

const mockedQuery = vi.mocked(query)

// G6 接线证据:照 tests/unit/metasheet-recovery-archive-wiring.test.ts 的先例读 src/index.ts 源文。
// 这是**文本级**断言,不是行为级 —— 背景任务块被 `NODE_ENV !== 'test' && !VITEST` 挡着,
// 在 vitest 里永远不会执行,所以行为级证不了"接了线"。文本级至少能钉死:导入在、启动在
// 那个块里、关停钩子在 shutdownTasks 里。三条任缺一条就红。
const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')

/** 冲掉所有 microtask —— runOnce 是 fire-and-forget,批量循环全在 microtask 链上。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

type TimerHarness = {
  unref: ReturnType<typeof vi.fn>
  handle: NodeJS.Timeout
  tick: () => void
  intervalMs: () => number | undefined
  clearCalls: () => unknown[]
  /** fix r1-A3:积压续轮走 setTimeout。只登记不执行,由用例手动放行。 */
  catchUpDelays: () => number[]
  fireCatchUp: () => void
  catchUpUnref: ReturnType<typeof vi.fn>
  catchUpCleared: () => unknown[]
}

function installTimerHarness(): TimerHarness {
  const unref = vi.fn()
  const handle = { unref } as unknown as NodeJS.Timeout
  let captured: (() => void) | undefined
  let ms: number | undefined
  const cleared: unknown[] = []

  const catchUpUnref = vi.fn()
  const catchUpHandle = { unref: catchUpUnref } as unknown as NodeJS.Timeout
  const catchUpDelays: number[] = []
  const catchUpCleared: unknown[] = []
  let catchUpFn: (() => void) | undefined
  // 只截住"续轮"那一档延时(NOTIFICATION_RETENTION_CATCHUP_DELAY_MS),其余 setTimeout 原样放行 ——
  // 不把 vitest/node 自己的定时器一起劫持。
  const realSetTimeout = global.setTimeout
  const realClearTimeout = global.clearTimeout

  vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
    captured = fn
    ms = delay
    return handle
  }) as unknown as typeof setInterval)
  vi.spyOn(global, 'clearInterval').mockImplementation(((handleArg: unknown) => {
    cleared.push(handleArg)
  }) as unknown as typeof clearInterval)
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay === NOTIFICATION_RETENTION_CATCHUP_DELAY_MS) {
      catchUpFn = fn
      catchUpDelays.push(delay)
      return catchUpHandle
    }
    return (realSetTimeout as unknown as (...args: unknown[]) => NodeJS.Timeout)(fn, delay, ...rest)
  }) as unknown as typeof setTimeout)
  vi.spyOn(global, 'clearTimeout').mockImplementation(((handleArg: unknown) => {
    if (handleArg === catchUpHandle) {
      catchUpCleared.push(handleArg)
      return
    }
    ;(realClearTimeout as unknown as (...args: unknown[]) => void)(handleArg)
  }) as unknown as typeof clearTimeout)

  return {
    unref,
    handle,
    tick: () => captured?.(),
    intervalMs: () => ms,
    clearCalls: () => cleared,
    catchUpDelays: () => [...catchUpDelays],
    fireCatchUp: () => catchUpFn?.(),
    catchUpUnref,
    catchUpCleared: () => catchUpCleared,
  }
}

/** 一个可以手动放行的 DELETE:第一轮挂在这里不返回,用来证"重入/关停"两条守卫。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function silentLogger(): Logger {
  const logger = new Logger('NotificationRetentionTest')
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void)
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void)
  return logger
}

beforeEach(() => {
  mockedQuery.mockReset()
  mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- G1 默认关(硬规则 3) -------------------------------------------------
describe('G1 默认关:没有显式正数天数就一条 SQL 都不发', () => {
  it('env 未设 ⇒ start 返回 no-op、零 SQL、零 timer', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({ env: {}, logger: silentLogger() })
    await flush()

    expect(mockedQuery).not.toHaveBeenCalled()
    expect(global.setInterval).not.toHaveBeenCalled()
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
    expect(timers.clearCalls()).toHaveLength(0)
    await flush()
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  // fix r2-minor:关停态原本**一条日志都不打**,运维分不清"没配所以没开"与"配了还没到点"。
  // 这条钉死:早退路径打且只打一行 values-free 的 info(点名 env 键),而"零 SQL / 零 timer"不变。
  it('env 未设 ⇒ 打一行 values-free 的"已关闭"info(且仍然零 SQL)', async () => {
    const timers = installTimerHarness()
    const logger = silentLogger()

    const stop = startNotificationRetention({ env: {}, logger })
    await flush()

    const lines = vi.mocked(logger.info).mock.calls.map((call) => String(call[0]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('disabled')
    expect(lines[0]).toContain('MULTITABLE_NOTIFICATION_RETENTION_DAYS')
    // values-free:关停日志同样不许出现表里的值字段名。
    for (const forbidden of ['user_id', 'actor_id', 'message', 'sheet_id', 'record_id', 'comment_id']) {
      expect(lines[0]).not.toContain(forbidden)
    }
    // 这行日志不得把"默认关"换成别的行为:依旧零 SQL、零 timer。
    expect(mockedQuery).not.toHaveBeenCalled()
    expect(global.setInterval).not.toHaveBeenCalled()
    expect(timers.clearCalls()).toHaveLength(0)
    await stop()
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['0', '零'],
    ['-1', '负数'],
    ['-30', '更负'],
    ['abc', 'NaN'],
    ['', '空串'],
    ['   ', '全空白'],
    ['NaN', '字面 NaN'],
    ['0.4', '不足一天'],
  ])('env=%s(%s)⇒ 同样是 no-op、零 SQL', async (raw) => {
    installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: raw },
      logger: silentLogger(),
    })
    await flush()

    expect(resolveNotificationRetentionDays(raw)).toBeNull()
    expect(mockedQuery).not.toHaveBeenCalled()
    expect(global.setInterval).not.toHaveBeenCalled()
    stop()
    await flush()
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('显式 options.retentionDays=0 也关(注入口与 env 口同一把尺)', async () => {
    installTimerHarness()
    startNotificationRetention({ retentionDays: 0, env: {}, logger: silentLogger() })
    await flush()
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('配了正数天数才开:env=30 ⇒ 立刻跑一轮', async () => {
    installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()

    expect(mockedQuery).toHaveBeenCalledTimes(1)
    expect(mockedQuery.mock.calls[0]?.[1]).toEqual([30, NOTIFICATION_RETENTION_BATCH_SIZE])
    stop()
  })

  it('天数上限 3650:超了夹住,不是关掉', () => {
    expect(resolveNotificationRetentionDays('99999')).toBe(NOTIFICATION_RETENTION_MAX_DAYS)
    expect(resolveNotificationRetentionDays('1')).toBe(1)
    expect(resolveNotificationRetentionDays('30.9')).toBe(30)
  })
})

// ---- G2 批量上限(硬规则 4) -----------------------------------------------
describe('G2 批量循环:满批继续、缺批立停、单轮最多 20 批', () => {
  it('每批都满 5000 ⇒ 恰好 20 批后停(超过就抛,让变异体跑红而不是挂死)', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => {
      if (queryFn.mock.calls.length > NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN + 5) {
        throw new Error('per-run batch cap breached')
      }
      return { rows: [] as unknown[], rowCount: NOTIFICATION_RETENTION_BATCH_SIZE }
    })

    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })

    expect(queryFn).toHaveBeenCalledTimes(NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN)
    expect(result.batches).toBe(NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN)
    expect(result.deleted).toBe(NOTIFICATION_RETENTION_MAX_BATCHES_PER_RUN * NOTIFICATION_RETENTION_BATCH_SIZE)
    expect(result.drained).toBe(false)
  })

  it('第一批就不足 batchSize ⇒ 立即停,只发一条 SQL', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: NOTIFICATION_RETENTION_BATCH_SIZE - 1 }))

    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: NOTIFICATION_RETENTION_BATCH_SIZE - 1, batches: 1, drained: true, stoppedEarly: false })
  })

  it('满批 + 缺批 ⇒ 两批后停', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: NOTIFICATION_RETENTION_BATCH_SIZE })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })

    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })

    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ deleted: NOTIFICATION_RETENTION_BATCH_SIZE + 3, batches: 2, drained: true, stoppedEarly: false })
  })

  it('零行 ⇒ 一条 SQL 就收工', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: 0, batches: 1, drained: true, stoppedEarly: false })
  })

  it('自定义 batchSize / maxBatchesPerRun 也被遵守(真库用例靠这个做有界排空)', async () => {
    // 同样带"越界就抛":每批都满 batchSize,去掉上限的变异体会在这里抛而不是把用例挂死。
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => {
      if (queryFn.mock.calls.length > 10) throw new Error('per-run batch cap breached')
      return { rows: [] as unknown[], rowCount: 2 }
    })
    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30, batchSize: 2, maxBatchesPerRun: 3 })
    expect(queryFn).toHaveBeenCalledTimes(3)
    expect(queryFn.mock.calls[0]?.[1]).toEqual([30, 2])
    expect(result).toEqual({ deleted: 6, batches: 3, drained: false, stoppedEarly: false })
  })
})

// ---- G3 删除口径(硬规则 8 / M3) ------------------------------------------

/**
 * fix r1-A5/B3:**整条 SQL 的等值断言**,不是子串断言。
 *
 * 反驳实证:只做 `toContain` 时,三个变异体全部 30/30 绿 ——
 *   (a) 子查询的表名换成父表 `meta_record_subscriptions`(真库上一行都删不掉);
 *   (b) `ORDER BY created_at` 改成 `... DESC`(先删最新的);
 *   (c) 去掉 `id IN (SELECT ...)` 包裹(PG 的 DELETE 不支持 ORDER BY/LIMIT ⇒ 42601,
 *       运行期被容错分支吞成 warn,永远删不掉一行)。
 * 这里把归一化空白后的整条语句钉成定值,上面三个变异体各差一处、立刻跑红。
 * 这条常量是在用例里**手写**的(不是从被测模块 import 的),所以不是同义反复。
 */
const EXPECTED_DELETE_SQL =
  'DELETE FROM meta_record_subscription_notifications ' +
  'WHERE id IN ( ' +
  'SELECT id ' +
  'FROM meta_record_subscription_notifications ' +
  'WHERE created_at < now() - make_interval(days => $1) ' +
  'ORDER BY created_at ' +
  'LIMIT $2 ' +
  ')'

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim()

describe('G3 删除 SQL 的形状:只删过期行,且不区分已读', () => {
  it('整条 SQL(归一化空白后)逐字等于预期:表名/包裹/窗口/排序/LIMIT 一处都不许漂', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
    await sweepNotificationRetention(queryFn, { retentionDays: 45 })

    const sql = String(queryFn.mock.calls[0]?.[0])
    expect(normalizeSql(sql)).toBe(EXPECTED_DELETE_SQL)
    // 冗余但有意:等值断言坏了时,下面几条指出是哪一处坏的。
    expect(sql).toContain('DELETE FROM meta_record_subscription_notifications')
    expect(sql).toContain('WHERE id IN (')
    expect(sql).toContain('created_at < now() - make_interval(days => $1)')
    expect(sql).toContain('ORDER BY created_at')
    expect(normalizeSql(sql)).not.toContain('ORDER BY created_at DESC')
    expect(sql).toContain('LIMIT $2')
    // 子查询必须回到**同一张表**(换成父表 meta_record_subscriptions 就一行都删不掉)。
    expect(normalizeSql(sql).match(/meta_record_subscription_notifications/g)).toHaveLength(2)
    expect(sql).not.toContain('meta_record_subscriptions ')
    expect(queryFn.mock.calls[0]?.[1]).toEqual([45, NOTIFICATION_RETENTION_BATCH_SIZE])
  })

  it('owner 默认口径:未读也删 —— SQL 里不许出现 read_at 过滤(要撤回就改这里并改本用例)', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
    await sweepNotificationRetention(queryFn, { retentionDays: 45 })
    expect(String(queryFn.mock.calls[0]?.[0])).not.toContain('read_at')
  })

  it('start 走的是 src/db/pg 的 query 座缝,SQL 形状一致', async () => {
    installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '7' },
      logger: silentLogger(),
    })
    await flush()

    const sql = String(mockedQuery.mock.calls[0]?.[0])
    expect(sql).toContain('created_at < now() - make_interval(days => $1)')
    expect(sql).toContain('LIMIT $2')
    expect(mockedQuery.mock.calls[0]?.[1]).toEqual([7, NOTIFICATION_RETENTION_BATCH_SIZE])
    stop()
  })
})

// ---- G4 timer 与 stop(硬规则 7 / M4) -------------------------------------
describe('G4 timer 与 stop', () => {
  it('interval 句柄被 unref,不吊住事件循环', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()

    expect(timers.unref).toHaveBeenCalledTimes(1)
    expect(timers.intervalMs()).toBe(24 * 60 * 60 * 1000)
    stop()
  })

  it('stop 之后 tick 回调一条 SQL 都不发,且 clearInterval 收掉同一个句柄', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    stop()
    expect(timers.clearCalls()).toEqual([timers.handle])

    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    stop()
    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)
  })

  it('stop 之前 tick 会再跑一轮(证明上一条不是因为 tick 本身没接上)', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(2)
    stop()
  })

  it('间隔夹在 10s..7d,非法值回 24h', () => {
    expect(resolveNotificationRetentionIntervalMs(undefined)).toBe(24 * 60 * 60 * 1000)
    expect(resolveNotificationRetentionIntervalMs('abc')).toBe(24 * 60 * 60 * 1000)
    expect(resolveNotificationRetentionIntervalMs('1')).toBe(10_000)
    expect(resolveNotificationRetentionIntervalMs('999999999999')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveNotificationRetentionIntervalMs('60000')).toBe(60_000)
  })

  // fix r1-A1:空串/全空白/0/负数 **不是**"小于下限,夹到 10 秒",而是"没配,回 24h"。
  // `Number('') === 0` 是有限数 —— 老实现只判 Number.isFinite,这四格全落到 10s(快 8640 倍),
  // 而 `MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS=`(键在值空)正是部署文件里的常见写法。
  it.each([
    ['', '空串'],
    ['   ', '全空白'],
    ['0', '零'],
    ['-1', '负数'],
    ['-86400000', '更负'],
  ])('间隔 env=%s(%s)⇒ 回默认 24h,不是被夹成 10 秒', (raw) => {
    expect(resolveNotificationRetentionIntervalMs(raw)).toBe(24 * 60 * 60 * 1000)
    expect(resolveNotificationRetentionIntervalMs(raw)).not.toBe(10_000)
  })

  it('间隔 env 名真的被读到:INTERVAL_MS=60000 ⇒ setInterval 收到 60000(名字打错就会静默回 24h)', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({
      env: {
        MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30',
        MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS: '60000',
      },
      logger: silentLogger(),
    })
    await flush()

    expect(timers.intervalMs()).toBe(60_000)
    await stop()
  })

  it('间隔 env 为空串 ⇒ 走的是 24h 那条路(fix r1-A1 的 env 级证据,不只是解析器级)', async () => {
    const timers = installTimerHarness()
    const stop = startNotificationRetention({
      env: {
        MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30',
        MULTITABLE_NOTIFICATION_RETENTION_INTERVAL_MS: '',
      },
      logger: silentLogger(),
    })
    await flush()

    expect(timers.intervalMs()).toBe(24 * 60 * 60 * 1000)
    await stop()
  })
})

// ---- G7 重入 / 关停 / 积压续轮(fix r1-A2 / A3 / A4) ------------------------
describe('G7 在飞的一轮:不重入、关停能截断、积压不等满一个 interval', () => {
  it('A2 上一轮还在飞时再来两次 tick ⇒ 并发轮数仍然是 1(SQL 只发出去一条)', async () => {
    const timers = installTimerHarness()
    const gate = deferred<{ rows: unknown[]; rowCount: number }>()
    mockedQuery.mockReturnValue(gate.promise as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()
    // 第一轮的第一条 DELETE 已发出,挂在 gate 上不返回。
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    timers.tick()
    timers.tick()
    await flush()
    // 没有重入守卫时,这两次 tick 会各起一轮、各占一条池连接 —— 那样这里会是 3。
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    gate.resolve({ rows: [], rowCount: 0 })
    await flush()
    await stop()
  })

  it('A2 上一轮结束后,下一次 tick 照常能跑(证明守卫不是把清理永久锁死)', async () => {
    const timers = installTimerHarness()
    const gate = deferred<{ rows: unknown[]; rowCount: number }>()
    mockedQuery.mockReturnValueOnce(gate.promise as never)
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()
    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    gate.resolve({ rows: [], rowCount: 0 })
    await flush()

    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(2)
    await stop()
  })

  it('A4 stop 截断在飞的批量循环:关停后一条新 DELETE 都不再发,且 stop 会等这轮收尾', async () => {
    const timers = installTimerHarness()
    const gate = deferred<{ rows: unknown[]; rowCount: number }>()
    let settled = false
    // 每批都"满批"(=2)⇒ 没有守卫的话这轮会一直打到 maxBatchesPerRun=6。
    mockedQuery.mockReturnValueOnce(gate.promise as never)
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 2 } as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
      batchSize: 2,
      maxBatchesPerRun: 6,
    })
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    const stopped = stop().then(() => {
      settled = true
    })
    // stop 必须还没返回:第一条 DELETE 还挂在 gate 上。
    await flush()
    expect(settled).toBe(false)

    gate.resolve({ rows: [], rowCount: 2 })
    await stopped
    expect(settled).toBe(true)
    // 关停位在下一批之前就被看到 ⇒ 总共只发了这一条(没守卫时是 6 条)。
    expect(mockedQuery).toHaveBeenCalledTimes(1)

    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(1)
  })

  it('A3 一轮打满批数上限仍没排空 ⇒ 排一个 1s 续轮(unref),而不是干等一个 24h interval', async () => {
    const timers = installTimerHarness()
    // 永远满批 ⇒ 每轮都撞上限、每轮都 drained=false。
    // 带"越界就抛"护栏(与 G2 两条同形,见本文件 :239-242 / :283-284,fix r2-blocker3):没有它时,去掉单轮批数
    // 上限的变异体(M2 `while (batches < maxBatches)` → `while (true)`)会把批量循环变成纯
    // microtask 死循环,饿死事件循环 ⇒ vitest 的超时 timer 永远触发不了,整个文件只能靠 worker
    // 堆内存耗尽(ERR_WORKER_OUT_OF_MEMORY,约 17s)才红。有了它,M2 在毫秒级以**断言红**结束。
    // 上界 = maxBatchesPerRun(3) × 本用例放行的轮数(初始轮 + 续轮 = 2)+ 5 格余量。
    const A3_MAX_CALLS = 3 * 2 + 5
    mockedQuery.mockImplementation((async () => {
      if (mockedQuery.mock.calls.length > A3_MAX_CALLS) {
        throw new Error('per-run batch cap breached')
      }
      return { rows: [], rowCount: 2 }
    }) as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
      batchSize: 2,
      maxBatchesPerRun: 3,
    })
    await flush()

    expect(mockedQuery).toHaveBeenCalledTimes(3)
    expect(timers.catchUpDelays()).toEqual([NOTIFICATION_RETENTION_CATCHUP_DELAY_MS])
    expect(NOTIFICATION_RETENTION_CATCHUP_DELAY_MS).toBeLessThan(24 * 60 * 60 * 1000)
    expect(timers.catchUpUnref).toHaveBeenCalledTimes(1)

    // 放行续轮 ⇒ 又是有界的一轮(3 批),积压按秒排空而不是按天。
    timers.fireCatchUp()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(6)

    await stop()
  })

  it('A3 排空的那一轮不排续轮(drained=true ⇒ 老老实实等下一个 interval)', async () => {
    const timers = installTimerHarness()
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
    })
    await flush()

    expect(timers.catchUpDelays()).toEqual([])
    await stop()
  })

  it('A3+A4 stop 会把还没放行的续轮 timer 一起收掉', async () => {
    const timers = installTimerHarness()
    // 同一道"越界就抛"护栏(fix r2-blocker3):本用例也是"永远满批",没有护栏时 M2 同样会在这里
    // 变成 microtask 死循环、把红从断言级降级成 worker OOM 级。
    // 上界 = maxBatchesPerRun(2) × 本用例放行的轮数(只有初始那一轮;续轮被 stop 收掉)+ 5 格余量。
    const A3A4_MAX_CALLS = 2 * 1 + 5
    mockedQuery.mockImplementation((async () => {
      if (mockedQuery.mock.calls.length > A3A4_MAX_CALLS) {
        throw new Error('per-run batch cap breached')
      }
      return { rows: [], rowCount: 2 }
    }) as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger: silentLogger(),
      batchSize: 2,
      maxBatchesPerRun: 2,
    })
    await flush()
    expect(timers.catchUpDelays()).toHaveLength(1)

    await stop()
    expect(timers.catchUpCleared()).toHaveLength(1)

    const callsAtStop = mockedQuery.mock.calls.length
    timers.fireCatchUp()
    await flush()
    expect(mockedQuery.mock.calls.length).toBe(callsAtStop)
  })
})

// ---- G5 容错(硬规则 5 / M5) ----------------------------------------------
describe('G5 容错:表不存在与一般错误都不抛', () => {
  it('42P01(表还没建)⇒ warn 一次,不抛,不炸启动', async () => {
    const timers = installTimerHarness()
    const logger = silentLogger()
    const schemaError = Object.assign(new Error('undefined table'), { code: '42P01' })
    mockedQuery.mockRejectedValue(schemaError as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger,
    })
    await flush()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(logger.warn).mock.calls[0]?.[0])).toContain('not ready')
    expect(timers.unref).toHaveBeenCalled()
    stop()
  })

  it('其它错误 ⇒ warn 不抛,下一轮照常继续', async () => {
    const timers = installTimerHarness()
    const logger = silentLogger()
    mockedQuery.mockRejectedValueOnce(new Error('deadlock detected') as never)
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger,
    })
    await flush()
    expect(logger.warn).toHaveBeenCalledTimes(1)

    timers.tick()
    await flush()
    expect(mockedQuery).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    stop()
  })

  it('日志 values-free:只出现计数/天数/毫秒,不出现表里的值字段名', async () => {
    installTimerHarness()
    const logger = silentLogger()
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 12 } as never)

    const stop = startNotificationRetention({
      env: { MULTITABLE_NOTIFICATION_RETENTION_DAYS: '30' },
      logger,
    })
    await flush()

    const lines = vi.mocked(logger.info).mock.calls.map((call) => String(call[0])).join(' | ')
    expect(lines).toContain('retentionDays=30')
    for (const forbidden of ['user_id', 'actor_id', 'message', 'sheet_id', 'record_id', 'comment_id']) {
      expect(lines).not.toContain(forbidden)
    }
    stop()
  })
})

// ---- G6 接线(规格第 12 行:与其它生命周期 start/stop 并列) --------------------
describe('G6 src/index.ts 接线', () => {
  it('导入了 startNotificationRetention', () => {
    expect(indexSource).toContain("import { startNotificationRetention } from './multitable/notification-retention'")
  })

  it('start 在背景任务块里,和其它 retention 并列(且在 NODE_ENV!==test 门之后)', () => {
    const gate = indexSource.indexOf("if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {")
    const start = indexSource.indexOf('this.stopNotificationRetention = startNotificationRetention({ logger: this.logger })')
    const neighbour = indexSource.indexOf('startFilesOrphanBlobRetention({ logger: this.logger })')
    expect(gate).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    expect(neighbour).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(gate)
    expect(Math.abs(start - neighbour)).toBeLessThan(600)
  })

  it('关停钩子挂在 shutdownTasks 里,句柄声明为可选字段', () => {
    expect(indexSource).toContain('private stopNotificationRetention?: () => Promise<void>')
    const stopAt = indexSource.indexOf('this.stopNotificationRetention?.()')
    expect(stopAt).toBeGreaterThan(-1)
    expect(indexSource.slice(Math.max(0, stopAt - 400), stopAt)).toContain('shutdownTasks.push(')
  })

  // fix r1-A4:关停必须 **await** 这条,否则 stop 只是置位,在飞的批量循环会和同一批
  // shutdownTasks 里的 `await pool.end()` 赛跑(邻居 approval 那条早就是 await 的)。
  it('shutdownTask 是 await 的,不是 fire-and-forget', () => {
    expect(indexSource).toContain('await this.stopNotificationRetention?.()')
    const stopAt = indexSource.indexOf('await this.stopNotificationRetention?.()')
    expect(stopAt).toBeGreaterThan(-1)
    // 这条 shutdownTask 的回调必须是 async,否则 await 根本写不进去。
    expect(indexSource.slice(Math.max(0, stopAt - 400), stopAt)).toContain('shutdownTasks.push(Promise.resolve().then(async () => {')
  })
})
