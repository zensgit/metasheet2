/** Real scheduler timers -> real AutomationService constructor callback.
 * DB and the private producer are explicit doubles: this proves dispatch and
 * shutdown ownership, not activation authority, native IO or durable dedup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService, type AutomationRule } from '../../src/multitable/automation-service'
import type { ReadScheduleOccurrence } from '../../src/integration/automation-read-contracts'

const start = Date.parse('2026-10-01T00:00:10.000Z')
const planned = Date.parse('2026-10-01T00:01:00.000Z')
type Produce = (occurrence: ReadScheduleOccurrence, signal: AbortSignal) => Promise<void>
const readAction = { type: 'integration_read_preview' as const,
  config: { operation: 'plm.stock-preparation.pull-bom.v1', allowManual: false } }
function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return { id: 'synthetic-cron', sheet_id: 'synthetic-sheet', name: 'Synthetic cron',
    trigger_type: 'schedule.cron', trigger_config: { expression: '* * * * *', timezone: 'UTC' },
    action_type: readAction.type, action_config: readAction.config, actions: [readAction], enabled: true,
    created_by: 'synthetic-owner', created_at: new Date(start).toISOString(), updated_at: new Date(start).toISOString(),
    ...overrides }
}

describe('schedule read production callback wiring (not authority evidence)', () => {
  let services: AutomationService[]
  let restoreTimerCaptures: Array<() => void>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(start)
    services = []; restoreTimerCaptures = []
  })
  afterEach(async () => {
    await Promise.all(services.map(service => service.shutdown()))
    for (const restore of restoreTimerCaptures.reverse()) restore()
    vi.restoreAllMocks(); vi.useRealTimers()
  })
  function fixture(withPort = true, db: unknown = {}) {
    const query = vi.fn(async () => ({ rows: [{ deleted_at: null }], rowCount: 1 }))
    const source = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
    const produce = vi.fn<Parameters<Produce>, ReturnType<Produce>>().mockResolvedValue(undefined)
    const service = new AutomationService(new EventBus(), db as never, query, source,
      null, {}, undefined, withPort ? { produce } : undefined)
    services.push(service)
    // A called ordinary path would be observable but must not reach its mocked DB/logs.
    const execute = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
    const log = vi.spyOn(service.logs, 'record')
    return { service, query, source, produce, execute, log }
  }
  function captureTimeouts() {
    const original = globalThis.setTimeout, spy = vi.fn(original)
    // Manual fake-clock wrapper avoids reinstating a dead fake timer on Vitest's
    // cross-file mock restore. Node's promisify property is unused by these timers.
    globalThis.setTimeout = spy as unknown as typeof setTimeout
    restoreTimerCaptures.push(() => { globalThis.setTimeout = original })
    return { spy, latest() {
      const callback = spy.mock.calls.at(-1)?.[0], result = spy.mock.results.at(-1)
      if (typeof callback !== 'function' || result?.type !== 'return') throw new Error('Expected actual scheduler timeout')
      return { handle: result.value as ReturnType<typeof setTimeout>, fire: () => callback() }
    } }
  }
  function expectPrivateOnly(f: ReturnType<typeof fixture>) {
    expect(f.query).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.source).not.toHaveBeenCalled()
    expect(f.log).not.toHaveBeenCalled()
  }

  it.each(['actions', 'legacy'] as const)('cron %s read action reaches only the private producer with the frozen planned identity', async shape => {
    const f = fixture()
    f.service.registerSchedule(rule(shape === 'legacy' ? { actions: null } : {}))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    const [occurrence, signal] = f.produce.mock.calls[0]
    expect(occurrence).toEqual({ ruleId: 'synthetic-cron', scheduledAtMs: planned })
    expect(Object.keys(occurrence).sort()).toEqual(['ruleId', 'scheduledAtMs'])
    expect(Object.isFrozen(occurrence)).toBe(true)
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(false)
    expectPrivateOnly(f)
  })
  it('delayed real timer callback preserves its planned instant instead of manufacturing a new occurrence', async () => {
    const timers = captureTimeouts(), f = fixture()
    f.service.registerSchedule(rule())
    const pending = timers.latest(); clearTimeout(pending.handle)
    vi.setSystemTime(Date.parse('2026-10-01T00:04:15.000Z'))
    pending.fire(); await Promise.resolve()
    expect(f.produce.mock.calls[0][0]).toEqual({ ruleId: 'synthetic-cron', scheduledAtMs: planned })
    expect(timers.spy).toHaveBeenLastCalledWith(expect.any(Function), 45_000)
    expectPrivateOnly(f)
  })
  function dateRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
    return rule({ trigger_type: 'schedule.date_field',
      trigger_config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after', timeOfDay: '00:01', timezone: 'UTC' }, ...overrides })
  }
  it.each(['actions', 'legacy'] as const)('date %s read timer reaches only the private producer with a frozen wake, never ordinary scan/claim', async shape => {
    const ordinarySql = vi.fn(() => { throw new Error('ORDINARY_SQL_MUST_NOT_RUN') })
    const f = fixture(true, { getExecutor: ordinarySql })
    f.service.registerSchedule(dateRule(shape === 'legacy' ? { actions: null } : {}))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    const [wake, signal] = f.produce.mock.calls[0]
    expect(wake).toEqual({ ruleId: 'synthetic-cron', triggerType: 'schedule.date_field', scheduledAtMs: planned })
    expect(Object.keys(wake).sort()).toEqual(['ruleId', 'scheduledAtMs', 'triggerType'])
    expect(Object.isFrozen(wake)).toBe(true)
    expect(Reflect.set(wake, 'recordId', 'not-authority')).toBe(false)
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal.aborted).toBe(false)
    expect(ordinarySql).not.toHaveBeenCalled()
    expectPrivateOnly(f)
  })
  it('date startup catch-up uses current wake time while a delayed timer preserves its planned wake', async () => {
    const timers = captureTimeouts(), f = fixture()
    f.service.registerSchedule(dateRule({ trigger_config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after', timeOfDay: '00:00' } }))
    expect(f.produce.mock.calls[0][0]).toEqual({ ruleId: 'synthetic-cron', triggerType: 'schedule.date_field', scheduledAtMs: start })
    const pending = timers.latest(); clearTimeout(pending.handle)
    const nextWake = Date.parse('2026-10-02T00:00:00.000Z')
    vi.setSystemTime(nextWake + 120_000); pending.fire(); await Promise.resolve()
    expect(f.produce).toHaveBeenCalledTimes(2)
    expect(f.produce.mock.calls[1][0]).toEqual({ ruleId: 'synthetic-cron', triggerType: 'schedule.date_field', scheduledAtMs: nextWake })
    for (const [wake] of f.produce.mock.calls) expect(Object.isFrozen(wake)).toBe(true)
    expectPrivateOnly(f)
  })
  it.each(['missing', 'rejected'] as const)('date read with %s private producer never falls back to ordinary full-row scans or claims', async state => {
    const ordinarySql = vi.fn(() => { throw new Error('ORDINARY_SQL_MUST_NOT_RUN') })
    const f = fixture(state !== 'missing', { getExecutor: ordinarySql })
    if (state === 'rejected') f.produce.mockRejectedValueOnce(new Error('synthetic-date-unavailable'))
    f.service.registerSchedule(dateRule())
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(state === 'missing' ? 0 : 1)
    expect(ordinarySql).not.toHaveBeenCalled()
    expectPrivateOnly(f)
  })
  it('date read-containing mixed action snapshot never falls through to an ordinary sibling', async () => {
    const f = fixture()
    f.service.registerSchedule(dateRule({ action_type: 'send_webhook', action_config: {},
      actions: [{ type: 'send_webhook', config: {} }, readAction] }))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.produce.mock.calls[0][0].triggerType).toBe('schedule.date_field')
    // Routing does not validate this snapshot; the private producer must reject
    // its current multi-action DB rule before any admission.
    expectPrivateOnly(f)
  })
  it.each(['actions', 'legacy', 'mixed'] as const)('runDateReminderScanNow loads the real %s read rule then returns before ordinary scan/claim or private production', async shape => {
    const stored = dateRule(shape === 'legacy' ? { actions: null } : shape === 'mixed'
      ? { action_type: 'send_webhook', action_config: {}, actions: [{ type: 'send_webhook', config: {} }, readAction] } : {})
    const ordinarySql = vi.fn(() => { throw new Error('ORDINARY_SQL_MUST_NOT_RUN') })
    const db = { selectFrom: vi.fn(() => db), selectAll: vi.fn(() => db), where: vi.fn(() => db),
      executeTakeFirst: vi.fn(async () => stored), getExecutor: ordinarySql }
    const f = fixture(true, db)
    await f.service.runDateReminderScanNow(stored.id)
    expect(db.selectFrom.mock.calls).toEqual([['automation_rules']])
    expect(db.where.mock.calls).toEqual([['id', '=', stored.id]])
    expect(db.executeTakeFirst).toHaveBeenCalledTimes(1)
    expect(ordinarySql).not.toHaveBeenCalled()
    expect(f.produce).not.toHaveBeenCalled()
    expectPrivateOnly(f)
  })
  it('ordinary runDateReminderScanNow still enters its real metadata scan without invoking the private producer', async () => {
    const stored = dateRule({ action_type: 'send_webhook', action_config: {}, actions: [{ type: 'send_webhook', config: {} }] })
    // The ordinary scan first attempts best-effort ledger aging through the real
    // Kysely raw-SQL path. Its independent field lookup then finds no valid date
    // type, so this control intentionally stops before full row/claim effects.
    const ordinarySql = vi.fn(() => { throw new Error('SYNTHETIC_ORDINARY_AGING_UNAVAILABLE') })
    const db = { selectFrom: vi.fn(() => db), selectAll: vi.fn(() => db), where: vi.fn(() => db),
      executeTakeFirst: vi.fn(async () => stored), getExecutor: ordinarySql }
    const f = fixture(true, db)
    await f.service.runDateReminderScanNow(stored.id)
    expect(ordinarySql).toHaveBeenCalledTimes(1)
    expect(f.query.mock.calls).toEqual([['SELECT type FROM meta_fields WHERE sheet_id = $1 AND id = $2', ['synthetic-sheet', 'synthetic-date']]])
    expect(f.produce).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled()
  })
  it.each(['startup', 'timer'] as const)('stopping date %s producer aborts and drains its real callback with no ordinary fallback', async path => {
    const timers = captureTimeouts(), f = fixture()
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    f.produce.mockReturnValueOnce(held)
    const stored = dateRule(path === 'startup' ? { trigger_config: { dateFieldId: 'synthetic-date', offsetDays: 0, direction: 'after', timeOfDay: '00:00' } } : {})
    f.service.registerSchedule(stored)
    if (path === 'timer') await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    const stale = timers.latest(), signal = f.produce.mock.calls[0][1]
    let drained = false
    const stopping = f.service.stopProducerAdmissions().then(() => { drained = true })
    try {
      expect(signal.aborted).toBe(true)
      await Promise.resolve(); await Promise.resolve()
      expect(drained).toBe(false)
      const registrations = timers.spy.mock.calls.length
      stale.fire(); f.service.registerSchedule(stored)
      await vi.advanceTimersByTimeAsync(2 * 86_400_000)
      expect(f.produce).toHaveBeenCalledTimes(1)
      expect(timers.spy).toHaveBeenCalledTimes(registrations)
      expect(vi.getTimerCount()).toBe(0)
      expectPrivateOnly(f)
    } finally { finish(); await stopping }
    expect(drained).toBe(true)
  })
  it.each(['actions', 'legacy'] as const)('interval %s read forwards the exact createdAt anchored occurrence only to the private producer', async shape => {
    const f = fixture()
    f.service.registerSchedule(rule({ trigger_type: 'schedule.interval', trigger_config: { intervalMs: 50_000 },
      ...(shape === 'legacy' ? { actions: null } : {}) }))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.produce.mock.calls[0][0]).toEqual({ ruleId: 'synthetic-cron', triggerType: 'schedule.interval',
      scheduledAtMs: planned, intervalMs: 50_000, anchorMs: start })
    expect(Object.isFrozen(f.produce.mock.calls[0][0])).toBe(true)
    expectPrivateOnly(f)
  })
  it('create immediately registers the persisted interval phase, not the earlier host timestamp', async () => {
    const anchorMs = start - 123, storedTime = new Date(anchorMs)
    let inserted: Record<string, unknown> | undefined
    const db = {
      insertInto: vi.fn(() => db),
      values: vi.fn((value: Record<string, unknown>) => { inserted = value; return db }),
      returningAll: vi.fn(() => db),
      execute: vi.fn(async () => {
        if (!inserted) throw new Error('Expected actual INSERT values')
        return [{ ...inserted, trigger_config: JSON.parse(inserted.trigger_config as string),
          action_config: JSON.parse(inserted.action_config as string), actions: null,
          created_at: storedTime, updated_at: storedTime }]
      }),
    }
    const f = fixture(true, db)
    const created = await f.service.createRule('synthetic-sheet', { name: 'Persisted phase',
      triggerType: 'schedule.interval', triggerConfig: { intervalMs: 1000 },
      actionType: 'integration_read_preview',
      actionConfig: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false } })
    expect(db.returningAll).toHaveBeenCalledTimes(1)
    expect(created.created_at).toBe(storedTime.toISOString())
    expect(created.updated_at).toBe(storedTime.toISOString())
    await vi.advanceTimersByTimeAsync(876)
    expect(f.produce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.produce.mock.calls[0][0]).toEqual({ ruleId: created.id, triggerType: 'schedule.interval',
      scheduledAtMs: anchorMs + 1000, intervalMs: 1000, anchorMs })
    expectPrivateOnly(f)
  })
  it('a missing INSERT receipt cannot register or return a host-timestamped interval rule', async () => {
    const db = { insertInto: vi.fn(() => db), values: vi.fn(() => db),
      returningAll: vi.fn(() => db), execute: vi.fn(async () => []) }
    const f = fixture(true, db), registration = vi.spyOn(f.service, 'registerSchedule')
    await expect(f.service.createRule('synthetic-sheet', { triggerType: 'schedule.interval',
      triggerConfig: { intervalMs: 1000 }, actionType: 'integration_read_preview',
      actionConfig: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false } }))
      .rejects.toThrow('AUTOMATION_RULE_INSERT_NOT_RETURNED')
    expect(registration).not.toHaveBeenCalled()
    expect(f.produce).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('an absent private producer does not fall back to ordinary execution or write a fixed failure log', async () => {
    const f = fixture(false)
    f.service.registerSchedule(rule())
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).not.toHaveBeenCalled()
    expectPrivateOnly(f)
  })
  it('a multi-action read-containing snapshot cannot execute its ordinary sibling', async () => {
    const f = fixture()
    f.service.registerSchedule(rule({ action_type: 'send_webhook', action_config: {},
      actions: [{ type: 'send_webhook', config: {} }, readAction] }))
    await vi.advanceTimersByTimeAsync(50_000)
    // The real producer must reject this invalid current rule; routing does not
    // certify this old snapshot or grant permission to its sibling action.
    expect(f.produce).toHaveBeenCalledTimes(1)
    expectPrivateOnly(f)
  })
  it('replacement invalidates the dequeued old callback without consuming the new timer', async () => {
    const timers = captureTimeouts(), f = fixture()
    f.service.registerSchedule(rule())
    const stale = timers.latest()
    f.service.registerSchedule(rule({ trigger_config: { expression: '*/2 * * * *' } }))
    const registrations = timers.spy.mock.calls.length
    stale.fire()
    expect(f.produce).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.produce.mock.calls[0][0].scheduledAtMs).toBe(Date.parse('2026-10-01T00:02:00.000Z'))
    expectPrivateOnly(f)
  })
  it('unregistering prevents a dequeued old callback from producing or rearming', async () => {
    const timers = captureTimeouts(), f = fixture()
    f.service.registerSchedule(rule())
    const stale = timers.latest()
    f.service.unregisterSchedule('synthetic-cron')
    const registrations = timers.spy.mock.calls.length
    stale.fire(); await Promise.resolve()
    expect(f.produce).not.toHaveBeenCalled()
    expect(timers.spy).toHaveBeenCalledTimes(registrations)
    expect(vi.getTimerCount()).toBe(0)
    expectPrivateOnly(f)
  })
  it('producer stop synchronously aborts and drains the admitted real callback, then refuses old and new timers', async () => {
    const timers = captureTimeouts(), f = fixture()
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    f.produce.mockReturnValueOnce(held)
    f.service.registerSchedule(rule())
    await vi.advanceTimersByTimeAsync(50_000)
    const stale = timers.latest(), signal = f.produce.mock.calls[0][1]
    let drained = false
    const stopping = f.service.stopProducerAdmissions().then(() => { drained = true })
    try {
      expect(signal.aborted).toBe(true)
      await Promise.resolve(); expect(drained).toBe(false)
      const registrations = timers.spy.mock.calls.length
      stale.fire(); f.service.registerSchedule(rule())
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.produce).toHaveBeenCalledTimes(1)
      expect(timers.spy).toHaveBeenCalledTimes(registrations)
      expect(vi.getTimerCount()).toBe(0)
      expectPrivateOnly(f)
    } finally { finish(); await stopping }
    expect(drained).toBe(true)
  })
  it('private producer failure never falls through to ordinary or source execution', async () => {
    const f = fixture()
    f.produce.mockRejectedValueOnce(new Error('synthetic-unavailable'))
    f.service.registerSchedule(rule())
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.produce).toHaveBeenCalledTimes(1)
    expectPrivateOnly(f)
  })
  it('ordinary cron retains sheet liveness and ordinary execution without invoking the private producer', async () => {
    const f = fixture()
    f.service.registerSchedule(rule({ action_type: 'send_webhook', action_config: {}, actions: [{ type: 'send_webhook', config: {} }] }))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(f.query).toHaveBeenCalledWith('SELECT deleted_at FROM meta_sheets WHERE id = $1', ['synthetic-sheet'])
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'synthetic-cron' }), { _triggeredBy: 'schedule' })
    expect(f.produce).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled()
  })
})
