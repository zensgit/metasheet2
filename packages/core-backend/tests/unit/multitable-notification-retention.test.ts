/**
 * E —— 通知中心保留期清理(默认关)的逻辑级用例。
 *
 * 被测: src/multitable/notification-retention.ts
 * 接线: src/index.ts(背景任务块 startNotificationRetention / 关停块 stopNotificationRetention?.())
 *
 * 这个文件钉五件事,每件都对应一个"去掉就红"的变异:
 *   G1 默认关   —— env 未设/0/负数/NaN/空串 ⇒ start 返回 no-op 且**零 SQL**       (M1)
 *   G2 批量上限 —— 每批满 batchSize ⇒ 单轮最多 MAX_BATCHES 批,绝不无界打转        (M2)
 *   G3 删除口径 —— SQL 必含 created_at 窗口 + ORDER BY + LIMIT,且**不区分已读**   (M3)
 *   G4 stop 位  —— stop() 之后 tick 回调一条 SQL 都不发                            (M4)
 *   G5 容错     —— 表不存在/其它错误都只 warn 不抛,下一轮继续                      (M5)
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
}

function installTimerHarness(): TimerHarness {
  const unref = vi.fn()
  const handle = { unref } as unknown as NodeJS.Timeout
  let captured: (() => void) | undefined
  let ms: number | undefined
  const cleared: unknown[] = []

  vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
    captured = fn
    ms = delay
    return handle
  }) as unknown as typeof setInterval)
  vi.spyOn(global, 'clearInterval').mockImplementation(((handleArg: unknown) => {
    cleared.push(handleArg)
  }) as unknown as typeof clearInterval)

  return {
    unref,
    handle,
    tick: () => captured?.(),
    intervalMs: () => ms,
    clearCalls: () => cleared,
  }
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
    expect(result).toEqual({ deleted: NOTIFICATION_RETENTION_BATCH_SIZE - 1, batches: 1, drained: true })
  })

  it('满批 + 缺批 ⇒ 两批后停', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: NOTIFICATION_RETENTION_BATCH_SIZE })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })

    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })

    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ deleted: NOTIFICATION_RETENTION_BATCH_SIZE + 3, batches: 2, drained: true })
  })

  it('零行 ⇒ 一条 SQL 就收工', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
    const result = await sweepNotificationRetention(queryFn, { retentionDays: 30 })
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: 0, batches: 1, drained: true })
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
    expect(result).toEqual({ deleted: 6, batches: 3, drained: false })
  })
})

// ---- G3 删除口径(硬规则 8 / M3) ------------------------------------------
describe('G3 删除 SQL 的形状:只删过期行,且不区分已读', () => {
  it('SQL 含 created_at 窗口 + ORDER BY + LIMIT,参数是 [天数, 批大小]', async () => {
    const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
    await sweepNotificationRetention(queryFn, { retentionDays: 45 })

    const sql = String(queryFn.mock.calls[0]?.[0])
    expect(sql).toContain('DELETE FROM meta_record_subscription_notifications')
    expect(sql).toContain('created_at < now() - make_interval(days => $1)')
    expect(sql).toContain('ORDER BY created_at')
    expect(sql).toContain('LIMIT $2')
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
    expect(indexSource).toContain('private stopNotificationRetention?: () => void')
    const stopAt = indexSource.indexOf('this.stopNotificationRetention?.()')
    expect(stopAt).toBeGreaterThan(-1)
    expect(indexSource.slice(Math.max(0, stopAt - 400), stopAt)).toContain('shutdownTasks.push(')
  })
})
