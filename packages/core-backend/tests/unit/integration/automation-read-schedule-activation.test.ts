/** Pure host checks only. Actual locks, DB cutover, uniqueness and authority are
 * covered by schedule-activation-realdb, not inferred from these input tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import * as scheduler from '../../../src/multitable/automation-scheduler'
import {
  captureReadScheduleOccurrence, checkedReadScheduleConfig, isReadScheduleOccurrence, waitForReadScheduleDbClock,
  checkedReadScheduleDefinition, checkedReadIntervalAnchor, readSchedulePlanMatches,
} from '../../../src/integration/automation-read-schedule-activation'
import type { AutomationReadLedgerDependencies, ReadScheduleOccurrence } from '../../../src/integration/automation-read-contracts'

const config = () => ({ expression: '30 9 * * *', timezone: 'Asia/Shanghai' })
const occurrence = () => ({ ruleId: 'synthetic-rule', scheduledAtMs: Date.parse('2026-10-01T01:30:00.000Z') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('date wake is not an authorized record occurrence', () => {
  const confirmation = { fieldId: 'synthetic-date', fieldType: 'date' as const, schemaRevision: '11111111-1111-4111-8111-111111111111' }
  const dateConfig = { dateFieldId: confirmation.fieldId, direction: 'before', offsetDays: 0 }
  it('preserves a subminute wake but never matches a cron, interval or date occurrence directly', () => {
    const wake = { ...occurrence(), scheduledAtMs: occurrence().scheduledAtMs + 123, triggerType: 'schedule.date_field' as const }
    const captured = captureReadScheduleOccurrence(wake)
    expect(captured).toEqual(wake); expect(Object.isFrozen(captured)).toBe(true)
    const definition = checkedReadScheduleDefinition('schedule.date_field', dateConfig, null, confirmation)
    expect(definition).toEqual({ triggerType: 'schedule.date_field', config: dateConfig, dateField: confirmation })
    for (const plan of [definition, checkedReadScheduleDefinition('schedule.cron', config(), null),
      checkedReadScheduleDefinition('schedule.interval', { intervalMs: 1000 }, wake.scheduledAtMs - 1000)]) {
      expect(readSchedulePlanMatches(plan, captured)).toBe(false)
    }
  })
  it('requires a distinct exact date confirmation and never upgrades a legacy schedule plan', () => {
    for (const supplied of [undefined, null, { ...confirmation, fieldId: 'other' }, { ...confirmation, schemaRevision: 'caller' },
      { ...confirmation, fieldType: 'text' }, { ...confirmation, trusted: true }]) {
      expect(() => checkedReadScheduleDefinition('schedule.date_field', dateConfig, null, supplied)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    }
    expect(() => checkedReadScheduleDefinition('schedule.cron', config(), null, confirmation)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(() => checkedReadScheduleDefinition('schedule.date_field', dateConfig, 123, confirmation)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(() => captureReadScheduleOccurrence({ ...occurrence(), triggerType: 'schedule.date_field', recordId: 'caller' } as ReadScheduleOccurrence))
      .toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
})

describe('fixed interval plan: closed family and persisted phase, not authority', () => {
  const anchorMs = Date.parse('2026-10-01T00:00:00.123Z')
  const plan = () => ({ ruleId: 'synthetic-rule', triggerType: 'schedule.interval' as const,
    intervalMs: 1001, anchorMs, scheduledAtMs: anchorMs + 1001 })
  it('retains an exact subsecond phase and interval without replacing it with callback time', () => {
    const supplied = plan(), captured = captureReadScheduleOccurrence(supplied)
    supplied.scheduledAtMs += 1001; supplied.anchorMs++
    expect(captured).toEqual(plan()); expect(Object.isFrozen(captured)).toBe(true)
    const definition = checkedReadScheduleDefinition('schedule.interval', { intervalMs: 1001 }, String(anchorMs))
    expect(readSchedulePlanMatches(definition, captured)).toBe(true)
    expect(readSchedulePlanMatches(definition, { ...plan(), anchorMs: anchorMs + 1 })).toBe(false)
    expect(readSchedulePlanMatches(definition, { ...plan(), intervalMs: 1000 })).toBe(false)
    expect(readSchedulePlanMatches(definition, occurrence())).toBe(false)
    expect(readSchedulePlanMatches(checkedReadScheduleDefinition('schedule.cron', config(), null), captured)).toBe(false)
  })
  it.each([0, 999, 1000.5, 2147483648, Infinity, NaN, '1000', null, undefined])('refuses invalid interval %s', intervalMs => {
    expect(() => checkedReadScheduleDefinition('schedule.interval', { intervalMs }, anchorMs)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each([{ intervalMinutes: 1 }, { intervalMs: 1000, intervalMinutes: 1 }, { intervalMs: 1000, startAt: '2026-10-01' }, {}])(
    'does not silently normalize legacy or extra interval fields %#', config => {
      expect(() => checkedReadScheduleDefinition('schedule.interval', config, anchorMs)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    },
  )
  it.each([null, undefined, '', '1.5', 0, -1, Infinity, 8640000000000001])('refuses invalid phase %#', value => {
    expect(() => checkedReadIntervalAnchor(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each([anchorMs - 1001, anchorMs, anchorMs + 1000, anchorMs + 1002])('refuses off-phase/nonpositive ordinal %s', scheduledAtMs => {
    expect(() => captureReadScheduleOccurrence({ ...plan(), scheduledAtMs })).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it('never invokes a family/config getter or accepts caller extras', () => {
    const get = vi.fn(() => 'schedule.interval')
    expect(() => captureReadScheduleOccurrence(Object.defineProperty(plan(), 'triggerType', { enumerable: true, get })))
      .toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(get).not.toHaveBeenCalled()
    expect(() => captureReadScheduleOccurrence({ ...plan(), principal: 'caller' } as ReadScheduleOccurrence)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(() => checkedReadScheduleDefinition('schedule.cron', config(), anchorMs)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
})

describe('bounded metadata DB-clock readiness, not authority', () => {
  beforeEach(() => { vi.useFakeTimers() })
  function fixture(clocks: unknown[]) {
    let probes = 0, open = 0, completed = 0
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0)
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('transaction_isolation')) return { rows: [{ isolation: 'read committed' }], rowCount: null }
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '101' }], rowCount: null }
      if (sql === 'SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS now_ms') {
        return { rows: [{ now_ms: clocks[Math.min(probes++, clocks.length - 1)] }], rowCount: null }
      }
      throw new Error('Unexpected synthetic clock query')
    })
    const transaction = vi.fn(async work => {
      open++
      try { return await work({ query, isTransaction: true }) }
      finally { open--; completed++ }
    }) as unknown as AutomationReadLedgerDependencies['transaction']
    return { query, transaction, monotonic, probes: () => probes, open: () => open, completed: () => completed }
  }
  it.each([0, -1])('already due by %sms performs one clock probe and no timer/lock/source query', async lag => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - lag])
    await expect(waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)).resolves.toBeUndefined()
    expect(f.probes()).toBe(1); expect(f.completed()).toBe(1); expect(vi.getTimerCount()).toBe(0)
    expect(f.query.mock.calls.every(([sql]) => !sql.includes('FOR ') && !sql.includes('activation') && !sql.includes('source'))).toBe(true)
  })
  it('waits outside a completed transaction for small positive lag and keeps the original minute', async () => {
    const input = occurrence(), original = { ...input }, f = fixture([input.scheduledAtMs - 100, String(input.scheduledAtMs)])
    const pending = waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)
    input.scheduledAtMs += 60000
    await vi.advanceTimersByTimeAsync(0)
    expect(f.open()).toBe(0); expect(f.completed()).toBe(1); expect(vi.getTimerCount()).toBe(1)
    f.monotonic.mockReturnValue(100); await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBeUndefined()
    expect(f.probes()).toBe(2); expect(vi.getTimerCount()).toBe(0)
    expect(original.scheduledAtMs + 60000).toBe(input.scheduledAtMs)
  })
  it.each([1, -1])('host wall-clock movement %s cannot substitute the planned minute or wait budget', async direction => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 20, input.scheduledAtMs])
    const host = vi.spyOn(Date, 'now').mockReturnValue(input.scheduledAtMs + direction * 86400000)
    const pending = waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    host.mockReturnValue(input.scheduledAtMs - direction * 86400000)
    f.monotonic.mockReturnValue(20); await vi.advanceTimersByTimeAsync(20); await pending
    expect(f.probes()).toBe(2); expect(vi.getTimerCount()).toBe(0)
  })
  it('allows DB clock regression only within the same finite budget and four original-minute probes', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 10, input.scheduledAtMs - 20, input.scheduledAtMs - 30, input.scheduledAtMs])
    const pending = waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    for (const [elapsed, advance] of [[10, 10], [30, 20], [60, 30]]) {
      f.monotonic.mockReturnValue(elapsed); await vi.advanceTimersByTimeAsync(advance)
    }
    await expect(pending).resolves.toBeUndefined()
    expect(f.probes()).toBe(4); expect(f.open()).toBe(0)
  })
  it('rejects a future minute beyond 1000ms without arming a timer or retrying', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 1001])
    await expect(waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(f.probes()).toBe(1); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects probe exhaustion even when each positive lag is small', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 1])
    const pending = waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(0)
    for (let elapsed = 1; elapsed <= 3; elapsed++) {
      f.monotonic.mockReturnValue(elapsed); await vi.advanceTimersByTimeAsync(1)
    }
    await refused
    expect(f.probes()).toBe(4); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects budget exhaustion instead of extending it after the clock regresses', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 600, input.scheduledAtMs - 600, input.scheduledAtMs])
    const pending = waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    void refused.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    f.monotonic.mockReturnValue(600); await vi.advanceTimersByTimeAsync(600)
    f.monotonic.mockReturnValue(1000); await vi.advanceTimersByTimeAsync(400)
    await refused
    expect(f.probes()).toBe(2); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([null, '', 'not-clock', Number.NaN, Number.POSITIVE_INFINITY])('refuses malformed clock %s without retry or raw diagnostics', async value => {
    const f = fixture([value])
    await expect(waitForReadScheduleDbClock(f.transaction, occurrence(), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(f.probes()).toBe(1); expect(vi.getTimerCount()).toBe(0)
  })
  it('refuses SQL errors without retrying the failed transaction or disclosing its cause', async () => {
    const f = fixture([])
    f.query.mockRejectedValueOnce(new Error('private query values'))
    const error = await waitForReadScheduleDbClock(f.transaction, occurrence(), new AbortController().signal).catch(error => error)
    expect(error).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' }); expect(String(error)).not.toContain('private')
    expect(f.query).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a timer immediately and removes its listener without another probe', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs - 100]), controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = waitForReadScheduleDbClock(f.transaction, input, controller.signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await refused
    expect(vi.getTimerCount()).toBe(0); expect(f.probes()).toBe(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
  })
  it('drains a clock query even when cancellation arrives before its receipt', async () => {
    const input = occurrence(), f = fixture([]), controller = new AbortController()
    const actual = f.query.getMockImplementation()!
    let entered!: () => void, release!: () => void
    const probing = new Promise<void>(resolve => { entered = resolve })
    const receipt = new Promise<void>(resolve => { release = resolve })
    f.query.mockImplementation(async sql => {
      if (sql.includes('clock_timestamp()')) { entered(); await receipt; return { rows: [{ now_ms: input.scheduledAtMs }], rowCount: null } }
      return actual(sql)
    })
    let settled = false
    const pending = waitForReadScheduleDbClock(f.transaction, input, controller.signal).finally(() => { settled = true })
    const refused = expect(pending).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    await probing; controller.abort(); await Promise.resolve()
    expect(settled).toBe(false); expect(f.open()).toBe(1)
    release(); await refused
    expect(f.open()).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('a late due SQL receipt cannot extend the monotonic readiness budget', async () => {
    const input = occurrence(), f = fixture([input.scheduledAtMs]), actual = f.query.getMockImplementation()!
    f.query.mockImplementation(async sql => {
      if (sql.includes('clock_timestamp()')) f.monotonic.mockReturnValue(1001)
      return actual(sql)
    })
    await expect(waitForReadScheduleDbClock(f.transaction, input, new AbortController().signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(f.probes()).toBe(1)
  })
})

describe('Schedule activation closed cron config', () => {
  it('detaches and freezes either exact alias without silently renaming it', () => {
    const supplied = config(), result = checkedReadScheduleConfig(supplied)
    expect(result).toEqual(supplied)
    expect(result).not.toBe(supplied)
    expect(Object.isFrozen(result)).toBe(true)
    supplied.expression = '* * * * *'
    expect(result.expression).toBe('30 9 * * *')
    expect(checkedReadScheduleConfig({ cron: '* * * * *' })).toEqual({ cron: '* * * * *' })
    expect(checkedReadScheduleConfig(Object.assign(Object.create(null), config()))).toEqual(config())
  })

  it.each([
    ['missing expression', {}], ['missing alias with timezone', { timezone: 'UTC' }],
    ['both equal aliases', { expression: '* * * * *', cron: '* * * * *' }],
    ['both different aliases', { expression: '* * * * *', cron: '0 * * * *' }],
    ['extra', { ...config(), source: 'caller-source' }],
    ['symbol', { ...config(), [Symbol('authority')]: true }],
    ['prototype', Object.assign(Object.create({ source: 'inherited' }), config())],
    ['inherited expression', Object.assign(Object.create({ expression: '* * * * *' }), { timezone: 'UTC' })],
    ['array', ['* * * * *']], ['sparse array', new Array(2)],
    ['null', null], ['undefined', undefined], ['number', 1],
    ['empty expression', { expression: '' }], ['expression whitespace', { expression: ' * * * * *' }],
    ['too long expression', { expression: '1'.repeat(256) }],
    ['nonstring expression', { expression: 7 }], ['null alias', { cron: null }],
    ['six fields', { expression: '* * * * * *' }], ['minute out of range', { cron: '60 * * * *' }],
    ['impossible calendar', { expression: '0 0 30 2 *' }],
    ['junk timezone', { ...config(), timezone: 'Not/A_Zone' }],
    ['empty timezone', { ...config(), timezone: '' }], ['timezone whitespace', { ...config(), timezone: ' UTC' }],
    ['timezone trailing space', { ...config(), timezone: 'Asia/Shanghai ' }],
    ['null timezone', { ...config(), timezone: null }], ['timezone number', { ...config(), timezone: 8 }],
    ['numeric offset plus', { ...config(), timezone: '+01:00' }],
    ['numeric offset minus', { ...config(), timezone: '-05:00' }],
    ['compact offset', { ...config(), timezone: '+0100' }],
  ])('rejects %s in the fixed input vocabulary', (_name, value) => {
    expect(() => checkedReadScheduleConfig(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })

  it.each(['expression', 'cron', 'timezone'] as const)('never executes an own %s accessor', key => {
    let calls = 0
    const supplied: Record<string, unknown> = key === 'cron' ? { cron: '* * * * *' } : config()
    Object.defineProperty(supplied, key, { enumerable: true, get() { calls++; throw new Error('MUST_NOT_EXECUTE') } })
    expect(() => checkedReadScheduleConfig(supplied)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(calls).toBe(0)
  })

  it('rejects nonenumerable data without invoking serializers', () => {
    const supplied = config()
    Object.defineProperty(supplied, 'expression', { enumerable: false, value: '* * * * *' })
    expect(() => checkedReadScheduleConfig(supplied)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    let calls = 0
    expect(() => checkedReadScheduleConfig({ ...config(), toJSON() { calls++; return config() } }))
      .toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(calls).toBe(0)
  })
})

describe('Schedule planned minute and existing scheduler proof', () => {
  it.each([
    ['UTC expression', { expression: '30 1 * * *' }, '2026-10-01T01:30:00.000Z', true],
    ['UTC cron alias', { cron: '30 1 * * *', timezone: 'UTC' }, '2026-10-01T01:30:00.000Z', true],
    ['Etc UTC', { expression: '30 1 * * *', timezone: 'Etc/UTC' }, '2026-10-01T01:30:00.000Z', true],
    ['Shanghai wall clock', config(), '2026-10-01T01:30:00.000Z', true],
    ['wrong minute', config(), '2026-10-01T01:31:00.000Z', false],
    ['wrong hour', config(), '2026-10-01T02:30:00.000Z', false],
    ['wrong month', { cron: '0 0 29 2 *' }, '2026-10-01T00:00:00.000Z', false],
    ['leap calendar minute', { cron: '0 0 29 2 *' }, '2028-02-29T00:00:00.000Z', true],
    ['DOM restricted', { cron: '0 0 2 * *' }, '2026-10-01T00:00:00.000Z', false],
    ['DOW restricted', { cron: '0 0 * * 0' }, '2026-10-01T00:00:00.000Z', false],
    ['DOM DOW OR matches weekday', { cron: '0 0 2 * 4' }, '2026-10-01T00:00:00.000Z', true],
    ['DOM DOW OR matches day', { cron: '0 0 1 * 0' }, '2026-10-01T00:00:00.000Z', true],
    ['DOM DOW neither', { cron: '0 0 2 * 0' }, '2026-10-01T00:00:00.000Z', false],
    ['fractional zone offset', { cron: '15 9 * * *', timezone: 'Asia/Kathmandu' }, '2026-10-01T03:30:00.000Z', true],
    ['DST first overlap minute', { cron: '30 1 * * *', timezone: 'America/New_York' }, '2026-11-01T05:30:00.000Z', true],
    ['DST second overlap minute', { cron: '30 1 * * *', timezone: 'America/New_York' }, '2026-11-01T06:30:00.000Z', false],
    ['DST gap before jump', { cron: '30 2 * * *', timezone: 'America/New_York' }, '2026-03-08T06:30:00.000Z', false],
    ['DST gap no fallback to 0330', { cron: '30 2 * * *', timezone: 'America/New_York' }, '2026-03-08T07:30:00.000Z', false],
    ['DST after jump real 0330', { cron: '30 3 * * *', timezone: 'America/New_York' }, '2026-03-08T07:30:00.000Z', true],
  ])('%s', (_name, supplied, timestamp, expected) => {
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig(supplied), Date.parse(timestamp))).toBe(expected)
  })

  it('proves an accepted planned minute through nextCronOccurrenceMs at that minute, not now', () => {
    const next = vi.spyOn(scheduler, 'nextCronOccurrenceMs')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2031-01-01T00:00:00.000Z'))
    const input = captureReadScheduleOccurrence(occurrence())
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig(config()), input.scheduledAtMs)).toBe(true)
    now.mockReturnValue(Date.parse('2041-01-01T00:00:00.000Z'))
    expect(captureReadScheduleOccurrence(occurrence())).toEqual(input)
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig(config()), input.scheduledAtMs)).toBe(true)
    expect(next).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenNthCalledWith(1, '30 9 * * *', input.scheduledAtMs - 60000, 'Asia/Shanghai')
    expect(next).toHaveBeenNthCalledWith(2, '30 9 * * *', input.scheduledAtMs - 60000, 'Asia/Shanghai')
    // This proves no callback-now substitution here; request SHA identity is
    // separately checked against actual ledger admission in the realDB suite.
    expect(now).not.toHaveBeenCalled()
  })

  it('rejects nonmatching rare-cron minutes before a potentially multi-year scan', () => {
    const next = vi.spyOn(scheduler, 'nextCronOccurrenceMs')
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig({ cron: '0 0 29 2 *' }),
      Date.parse('2026-10-01T00:00:00.000Z'))).toBe(false)
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig(config()),
      Date.parse('2026-10-01T01:31:00.000Z'))).toBe(false)
    expect(isReadScheduleOccurrence(checkedReadScheduleConfig({ cron: '30 1 * * *', timezone: 'America/New_York' }),
      Date.parse('2026-11-01T06:30:00.000Z'))).toBe(false)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Schedule occurrence closed host plan input', () => {
  it('captures a detached immutable UTC minute', () => {
    const supplied = occurrence(), result = captureReadScheduleOccurrence(supplied)
    expect(result).toEqual(supplied)
    expect(result).not.toBe(supplied)
    expect(Object.isFrozen(result)).toBe(true)
    supplied.scheduledAtMs += 60000
    expect(result.scheduledAtMs).toBe(Date.parse('2026-10-01T01:30:00.000Z'))
  })
  it.each([
    ['missing minute', { ruleId: 'synthetic-rule' }], ['extra now', { ...occurrence(), now: 1 }],
    ['prototype', Object.assign(Object.create({ tenantId: 'untrusted' }), occurrence())],
    ['array', []], ['sparse', new Array(2)], ['null', null],
    ['rule whitespace', { ...occurrence(), ruleId: ' synthetic-rule' }],
    ['minute string', { ...occurrence(), scheduledAtMs: '1790818200000' }],
    ['second not minute', { ...occurrence(), scheduledAtMs: occurrence().scheduledAtMs + 1000 }],
    ['fraction', { ...occurrence(), scheduledAtMs: 1.5 }],
    ['infinity', { ...occurrence(), scheduledAtMs: Infinity }],
    ['unsafe integer', { ...occurrence(), scheduledAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['outside Date range', { ...occurrence(), scheduledAtMs: 8640000000060000 }],
    ['zero', { ...occurrence(), scheduledAtMs: 0 }],
  ])('rejects %s', (_name, value) => {
    expect(() => captureReadScheduleOccurrence(value as ReadScheduleOccurrence)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each(['ruleId', 'scheduledAtMs'] as const)('does not call a %s getter', key => {
    let calls = 0
    const supplied = occurrence()
    Object.defineProperty(supplied, key, { enumerable: true, get() { calls++; throw new Error('MUST_NOT_EXECUTE') } })
    expect(() => captureReadScheduleOccurrence(supplied)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(calls).toBe(0)
  })
})
