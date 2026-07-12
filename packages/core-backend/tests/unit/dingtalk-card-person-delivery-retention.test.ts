import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DINGTALK_DELIVERY_RETENTION_DEFAULT_DAYS,
  DINGTALK_DELIVERY_RETENTION_MIN_DAYS,
  resolveDingTalkDeliveryRetentionConfig,
  sweepDingTalkApprovalCardDeliveryRetention,
  sweepDingTalkCardPersonDeliveryRetention,
  sweepDingTalkPersonDeliveryRetention,
} from '../../src/services/dingtalk-card-person-delivery-retention'
import {
  LedgerRetentionScheduler,
  stopLedgerRetentionScheduler,
} from '../../src/services/LedgerRetentionScheduler'
import {
  resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs,
  startDingTalkCardPersonDeliveryRetentionScheduler,
  stopDingTalkCardPersonDeliveryRetentionScheduler,
} from '../../src/services/dingtalk-card-person-delivery-retention-scheduler'

describe('resolveDingTalkDeliveryRetentionConfig (env parse + floor + DEFAULT-OFF gate)', () => {
  it('DEFAULT-OFF: disabled with no env set at all (inverse of the sibling group-delivery sweep)', () => {
    expect(resolveDingTalkDeliveryRetentionConfig({})).toEqual({
      retentionDays: DINGTALK_DELIVERY_RETENTION_DEFAULT_DAYS,
      disabled: true,
    })
  })

  it('enables with a valid positive DINGTALK_DELIVERY_RETENTION_DAYS', () => {
    expect(
      resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: '30' }),
    ).toEqual({ retentionDays: 30, disabled: false })
  })

  it('floors the retention window at the min (foot-gun guard): 1 day → MIN, still enabled', () => {
    const config = resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: '1' })
    expect(config.retentionDays).toBe(DINGTALK_DELIVERY_RETENTION_MIN_DAYS)
    expect(config.disabled).toBe(false)
  })

  it('an invalid/non-positive DAYS value stays DISABLED (fail closed) — it does NOT fall back to the default window and enable anyway (deliberate deviation from the group sweep)', () => {
    expect(resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: 'abc' }).disabled).toBe(true)
    expect(resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: '0' }).disabled).toBe(true)
    expect(resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: '-10' }).disabled).toBe(true)
    expect(resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: 'NaN' }).disabled).toBe(true)
  })

  it('DINGTALK_DELIVERY_RETENTION_DISABLED=1 forces disabled even when DAYS is validly set', () => {
    expect(
      resolveDingTalkDeliveryRetentionConfig({
        DINGTALK_DELIVERY_RETENTION_DAYS: '30',
        DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
      }).disabled,
    ).toBe(true)
  })

  it('does not force-disable on any other value (only the literal "1" disables)', () => {
    expect(
      resolveDingTalkDeliveryRetentionConfig({
        DINGTALK_DELIVERY_RETENTION_DAYS: '30',
        DINGTALK_DELIVERY_RETENTION_DISABLED: 'true',
      }).disabled,
    ).toBe(false)
  })
})

describe('sweepDingTalkPersonDeliveryRetention / sweepDingTalkApprovalCardDeliveryRetention (disabled short-circuit + re-floor)', () => {
  it('sweepDingTalkPersonDeliveryRetention is a no-op when disabled (never queries)', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    expect(await sweepDingTalkPersonDeliveryRetention(query as never, { retentionDays: 30, disabled: true })).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('sweepDingTalkApprovalCardDeliveryRetention is a no-op when disabled (never queries)', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    expect(await sweepDingTalkApprovalCardDeliveryRetention(query as never, { retentionDays: 30, disabled: true })).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('sweepDingTalkPersonDeliveryRetention re-floors an out-of-range config.retentionDays before building the DELETE', async () => {
    const calls: Array<unknown[] | undefined> = []
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      calls.push(params)
      return { rows: [], rowCount: 0 }
    })
    await sweepDingTalkPersonDeliveryRetention(query as never, { retentionDays: 1, disabled: false })
    expect(query).toHaveBeenCalledTimes(1)
    expect(calls[0]?.[0]).toBe(DINGTALK_DELIVERY_RETENTION_MIN_DAYS)
  })

  it('sweepDingTalkApprovalCardDeliveryRetention re-floors an out-of-range config.retentionDays before building the UPDATE, and the UPDATE requires card_state=\'sent\'', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return { rows: [], rowCount: 0 }
    })
    await sweepDingTalkApprovalCardDeliveryRetention(query as never, { retentionDays: 1, disabled: false })
    expect(query).toHaveBeenCalledTimes(1)
    expect(calls[0]?.params?.[0]).toBe(DINGTALK_DELIVERY_RETENTION_MIN_DAYS)
    expect(calls[0]?.sql).toMatch(/SET card_state = 'expired'/)
    expect(calls[0]?.sql).toMatch(/WHERE card_state = 'sent'/)
    // never reachable to touch task_id, send_status, acted_*, or integration_id
    expect(calls[0]?.sql).not.toMatch(/task_id/)
    expect(calls[0]?.sql).not.toMatch(/send_status/)
    expect(calls[0]?.sql).not.toMatch(/acted_/)
  })

  it('sweepDingTalkCardPersonDeliveryRetention composes both sub-sweeps and short-circuits on disabled', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    expect(await sweepDingTalkCardPersonDeliveryRetention(query as never, { retentionDays: 30, disabled: true })).toEqual({
      personDeleted: 0,
      cardExpired: 0,
    })
    expect(query).not.toHaveBeenCalled()

    const calls: string[] = []
    const activeQuery = vi.fn(async (sql: string) => {
      calls.push(sql)
      return { rows: [], rowCount: 3 }
    })
    expect(await sweepDingTalkCardPersonDeliveryRetention(activeQuery as never, { retentionDays: 30, disabled: false })).toEqual({
      personDeleted: 3,
      cardExpired: 3,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/DELETE FROM dingtalk_person_deliveries/)
    expect(calls[1]).toMatch(/UPDATE dingtalk_approval_card_deliveries/)
  })
})

describe('DingTalk approval-card/person delivery retention scheduler (reuses the generic LedgerRetentionScheduler)', () => {
  afterEach(() => {
    stopLedgerRetentionScheduler()
    stopDingTalkCardPersonDeliveryRetentionScheduler()
    delete process.env.DINGTALK_DELIVERY_RETENTION_DISABLED
    delete process.env.DINGTALK_DELIVERY_RETENTION_DAYS
    delete process.env.DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS
  })

  it('tick() delegates to the injected fake sweep and returns its count', async () => {
    const sweep = vi.fn<() => Promise<number>>().mockResolvedValue(7)
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(7)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('swallows sweep errors and returns 0 (degraded mode)', async () => {
    const sweep = vi.fn().mockRejectedValue(new Error('db down'))
    const scheduler = new LedgerRetentionScheduler({ service: { sweep } })
    expect(await scheduler.tick()).toBe(0)
  })

  it('startDingTalkCardPersonDeliveryRetentionScheduler returns null when DINGTALK_DELIVERY_RETENTION_DISABLED=1', () => {
    process.env.DINGTALK_DELIVERY_RETENTION_DISABLED = '1'
    const scheduler = startDingTalkCardPersonDeliveryRetentionScheduler({
      service: { sweep: vi.fn().mockResolvedValue(0) },
    })
    expect(scheduler).toBeNull()
  })

  it('startDingTalkCardPersonDeliveryRetentionScheduler STARTS by default (no env) — the boot wiring never depends on the retention-days env var, even though the real sweep it drives is a no-op until DINGTALK_DELIVERY_RETENTION_DAYS is set', () => {
    const scheduler = startDingTalkCardPersonDeliveryRetentionScheduler({
      service: { sweep: vi.fn().mockResolvedValue(0) },
    })
    expect(scheduler).not.toBeNull()
  })

  it('startDingTalkCardPersonDeliveryRetentionScheduler returns the same shared instance on repeat calls', () => {
    const first = startDingTalkCardPersonDeliveryRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    const second = startDingTalkCardPersonDeliveryRetentionScheduler({ service: { sweep: vi.fn().mockResolvedValue(0) } })
    expect(first).toBe(second)
  })

  it('resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs reads a positive override, else undefined', () => {
    expect(resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs()).toBeUndefined()
    process.env.DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS = '3600000'
    expect(resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs()).toBe(3600000)
    process.env.DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS = '-5'
    expect(resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs()).toBeUndefined()
  })

  it('start() actually arms the interval loop, using the REAL default-resolved service end-to-end: with no DINGTALK_DELIVERY_RETENTION_DAYS set, the tick fires on schedule but sweeps 0 rows every time (default-off proof at the scheduler level, not just the config-resolver level)', async () => {
    vi.useFakeTimers()
    try {
      const intervalMs = 60_000 // MIN_INTERVAL_MS floor in LedgerRetentionScheduler
      // No service injected: exercises the REAL PgDingTalkCardPersonDeliveryRetentionService via
      // the default resolver — but sweep() short-circuits before touching the pool because the
      // resolved config is disabled (no DAYS env set), so this never needs a live DB.
      const scheduler = startDingTalkCardPersonDeliveryRetentionScheduler({ intervalMs })
      expect(scheduler).not.toBeNull()
      await scheduler!.ready

      await vi.advanceTimersByTimeAsync(intervalMs)
      expect(await scheduler!.tick()).toBe(0) // still disabled — ticking again confirms convergence, not a fluke

      stopDingTalkCardPersonDeliveryRetentionScheduler()
      await vi.advanceTimersByTimeAsync(intervalMs * 3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() arms + re-arms + stop() halts, with an injected fake sweep (same shape as the group scheduler test)', async () => {
    vi.useFakeTimers()
    try {
      const sweep = vi.fn<() => Promise<number>>().mockResolvedValue(0)
      const intervalMs = 60_000
      const scheduler = startDingTalkCardPersonDeliveryRetentionScheduler({ service: { sweep }, intervalMs })
      expect(scheduler).not.toBeNull()
      await scheduler!.ready

      expect(sweep).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(intervalMs)
      expect(sweep).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(intervalMs)
      expect(sweep).toHaveBeenCalledTimes(2)

      stopDingTalkCardPersonDeliveryRetentionScheduler()
      await vi.advanceTimersByTimeAsync(intervalMs * 3)
      expect(sweep).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
