/**
 * schedule.interval — the rule editor's `intervalMinutes` reaches the scheduler.
 *
 * The hole: the editor binds `triggerConfig.intervalMinutes`; the save path kept the config verbatim; the
 * scheduler reads only `intervalMs`. An interval rule created in the editor saved, showed as enabled, and the
 * scheduler logged "interval too small (nullms)" and armed nothing. A rule whose `intervalMs` came from the
 * API kept it on an editor save, so the minutes typed in the editor had no effect.
 *
 * Pinned, each on its own (the save conversion and the read-time fallback would mask each other in a plain
 * "editor payload fires" test, so S is asserted on the STORED row and L bypasses the save path):
 *   S — save (create via parseCreateRuleInput, update inside updateRule): intervalMinutes -> intervalMs,
 *       minutes win over a stale intervalMs, the stored row never carries intervalMinutes, an API
 *       intervalMs-only config is stored unchanged.
 *   V — save refuses a missing / non-number / non-finite / non-positive / below-floor period (400-class
 *       AutomationRuleValidationError, code VALIDATION_ERROR), and nothing is written.
 *   L — a stored legacy row with only intervalMinutes is armed at its period (boot and direct register); a
 *       legacy row with both keeps its stored intervalMs (read precedence).
 *   P — the period: zero fires at period - 1 ms, one at the period.
 *   C — cron and date_field configs are untouched by the normaliser.
 *
 * Harness: the REAL AutomationService + AutomationScheduler on fake timers, over the same small stateful
 * kysely fake as automation-disabled-schedule-rule.test.ts (one automation_rules map). `executeRule` is
 * spied. Zero-DB, no supertest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationRuleValidationError,
  AutomationService,
  normalizeIntervalTriggerConfigAtSave,
  parseCreateRuleInput,
  parseUpdateRuleInput,
} from '../../src/multitable/automation-service'
import {
  AutomationScheduler,
  MAX_TIMER_DELAY_MS,
  intervalMinutesToMs,
} from '../../src/multitable/automation-scheduler'
import type { AutomationRule as ExecutorRule } from '../../src/multitable/automation-executor'

const RULE_ENABLED_SQL = /SELECT\s+enabled\s+FROM\s+automation_rules\s+WHERE\s+id\s*=\s*\$1/i
const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const META_FIELD_TYPE_SQL = /SELECT\s+type\s+FROM\s+meta_fields/i

const MIN = 60 * 1000
const H = 60 * MIN
const DAY = 24 * H
const JSON_COLUMNS = ['trigger_config', 'action_config', 'conditions', 'actions'] as const

type Row = Record<string, unknown>
type Where = { column: string; value: unknown }

function parseJsonColumns(row: Row): Row {
  const out: Row = { ...row }
  for (const c of JSON_COLUMNS) {
    if (typeof out[c] === 'string') out[c] = JSON.parse(out[c] as string)
  }
  return out
}

function makeDb(rows: Map<string, Row>) {
  const start = (op: 'select' | 'insert' | 'update' | 'delete', table: string) => {
    const state: { values?: Row; set?: Row; wheres: Where[] } = { wheres: [] }
    const b: Record<string, unknown> = {}
    const self = () => b
    for (const m of [
      'selectAll', 'select', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns',
      'doUpdateSet', 'returningAll', 'leftJoin', 'innerJoin',
    ]) b[m] = vi.fn(self)
    b.values = vi.fn((v: Row) => { state.values = v; return b })
    b.set = vi.fn((v: Row) => { state.set = v; return b })
    b.where = vi.fn((column: unknown, _op: unknown, value: unknown) => {
      if (typeof column === 'string') state.wheres.push({ column, value })
      return b
    })
    const matching = (): Row[] => {
      if (table !== 'automation_rules') return []
      return [...rows.values()].filter((r) => state.wheres.every((w) => (
        Array.isArray(w.value) ? w.value.includes(r[w.column]) : r[w.column] === w.value
      )))
    }
    b.execute = vi.fn(async () => {
      if (table !== 'automation_rules') return []
      if (op === 'insert') {
        const v = parseJsonColumns(state.values ?? {})
        rows.set(String(v.id), { ...v, created_at: new Date(), updated_at: new Date() })
        return []
      }
      if (op === 'update') {
        const hit = matching()
        for (const r of hit) Object.assign(r, parseJsonColumns(state.set ?? {}))
        return hit.map((r) => ({ ...r }))
      }
      if (op === 'delete') {
        const hit = matching()
        for (const r of hit) rows.delete(String(r.id))
        return [{ numDeletedRows: BigInt(hit.length) }]
      }
      return matching().map((r) => ({ ...r }))
    })
    b.executeTakeFirst = vi.fn(async () => (await (b.execute as () => Promise<Row[]>)())[0])
    return b
  }
  return {
    selectFrom: vi.fn((t: string) => start('select', t)),
    insertInto: vi.fn((t: string) => start('insert', t)),
    updateTable: vi.fn((t: string) => start('update', t)),
    deleteFrom: vi.fn((t: string) => start('delete', t)),
  }
}

type Harness = {
  service: AutomationService
  rows: Map<string, Row>
  execute: ReturnType<typeof vi.spyOn>
  scheduler: { isRegistered(id: string): boolean; activeCount: number; destroy(): Promise<void> }
}

let live: Harness[] = []
let liveSchedulers: AutomationScheduler[] = []

function makeHarness(): Harness {
  const rows = new Map<string, Row>()
  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (RULE_ENABLED_SQL.test(sqlText)) {
      const r = rows.get(String(params?.[0] ?? ''))
      return r ? { rows: [{ enabled: r.enabled }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (LIVENESS_ONE_SQL.test(sqlText)) return { rows: [{ deleted_at: null }], rowCount: 1 }
    if (META_FIELD_TYPE_SQL.test(sqlText)) return { rows: [{ type: 'date' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const service = new AutomationService(new EventBus(), makeDb(rows) as never, queryFn as never)
  const execute = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
  vi.spyOn(service as never as { evaluateDateReminders: () => Promise<void> }, 'evaluateDateReminders')
    .mockResolvedValue(undefined)
  const scheduler = (service as never as { scheduler: Harness['scheduler'] }).scheduler
  const h = { service, rows, execute, scheduler }
  live.push(h)
  return h
}

/** What the rule editor POSTs for an interval rule (buildPayload shape, reduced to the fields that matter). */
function editorCreateBody(triggerConfig: Record<string, unknown>) {
  return {
    name: 'interval rule',
    triggerType: 'schedule.interval',
    triggerConfig,
    trigger: { type: 'schedule.interval', config: triggerConfig },
    actions: [{ type: 'update_record', config: { fields: { fld_status: 'x' } } }],
    actionType: 'update_record',
    actionConfig: { fields: { fld_status: 'x' } },
    executionMode: null,
  }
}

async function createFromBody(h: Harness, body: Record<string, unknown>) {
  return h.service.createRule('sheet_1', parseCreateRuleInput(body, 'u1'))
}

async function patchFromBody(h: Harness, ruleId: string, body: Record<string, unknown>) {
  const input = parseUpdateRuleInput(body)
  if (!input) throw new Error('empty patch')
  return h.service.updateRule(ruleId, 'sheet_1', input, 'u1')
}

/** Zero fires one ms before the period, exactly one at it, measured from NOW (the registration instant). */
async function expectPeriod(h: Harness, periodMs: number) {
  const before = h.execute.mock.calls.length
  await vi.advanceTimersByTimeAsync(periodMs - 1)
  expect(h.execute.mock.calls.length - before, `no fire before ${periodMs} ms`).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.execute.mock.calls.length - before, `one fire at ${periodMs} ms`).toBe(1)
}

const storedTriggerConfig = (h: Harness, id: string) => h.rows.get(id)?.trigger_config as Record<string, unknown>

function expectValidationRefusal(fn: () => unknown) {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught, 'expected an AutomationRuleValidationError').toBeInstanceOf(AutomationRuleValidationError)
  expect((caught as AutomationRuleValidationError).code).toBe('VALIDATION_ERROR')
  expect((caught as Error).message).toMatch(/schedule\.interval/)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-25T03:00:00.000Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const h of live) await h.scheduler.destroy()
  for (const s of liveSchedulers) await s.destroy()
  live = []
  liveSchedulers = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('intervalMinutesToMs — the one minutes-to-ms conversion', () => {
  it('converts finite positive minutes, rounded to whole ms; refuses the rest', () => {
    expect(intervalMinutesToMs(5)).toBe(5 * MIN)
    expect(intervalMinutesToMs(1.5)).toBe(90_000)
    expect(intervalMinutesToMs(1 / 60)).toBe(1000)
    // A value derived from a stored intervalMs converts back exactly (an untouched editor save is lossless);
    // 1001 / 60000 * 60000 is 1001.0000000000001 in floating point, so this pins the rounding.
    for (const ms of [1000, 1001, 45_123, 90_000, 7 * DAY]) expect(intervalMinutesToMs(ms / 60_000)).toBe(ms)
    for (const bad of [0, -1, 0.01, Number.NaN, Number.POSITIVE_INFINITY, 1e306, '5', '', null, undefined, {}]) {
      expect(intervalMinutesToMs(bad), String(bad)).toBeNull()
    }
  })
})

describe('S — save converts the editor\'s intervalMinutes to the stored intervalMs', () => {
  it('create: an editor payload with intervalMinutes is stored as intervalMs only, and fires at that period', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMinutes: 5 }))
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 5 * MIN })
    expect(storedTriggerConfig(h, rule.id)).not.toHaveProperty('intervalMinutes')
    expect(h.scheduler.isRegistered(rule.id)).toBe(true)
    await expectPeriod(h, 5 * MIN)
  })

  it('create: an API payload with intervalMs only is stored unchanged', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: 90_000, note: 'kept' }))
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 90_000, note: 'kept' })
    await expectPeriod(h, 90_000)
  })

  it('create: both present — intervalMinutes wins, the stale intervalMs is discarded', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H, intervalMinutes: 2 }))
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 2 * MIN })
    await expectPeriod(h, 2 * MIN)
  })

  it('update (editor PATCH shape): new minutes beside the stored intervalMs win and re-arm at the new period', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H }))
    // An already-loaded older editor bundle sends the stored intervalMs back next to the typed minutes.
    await patchFromBody(h, rule.id, editorCreateBody({ intervalMs: H, intervalMinutes: 2 }))
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 2 * MIN })
    await expectPeriod(h, 2 * MIN)
  })

  it('update: a config-only PATCH (no triggerType) on a stored interval rule is converted too', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H }))
    await patchFromBody(h, rule.id, { triggerConfig: { intervalMinutes: 3 } })
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 3 * MIN })
    await expectPeriod(h, 3 * MIN)
  })

  it('update: an API PATCH with intervalMs only is stored unchanged', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMinutes: 5 }))
    await patchFromBody(h, rule.id, { triggerType: 'schedule.interval', triggerConfig: { intervalMs: 45_000 } })
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 45_000 })
    await expectPeriod(h, 45_000)
  })

  it('a converted period above the 2^31-1 ms timer limit takes the chained-timeout path (no 1 ms loop)', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMinutes: 30 * 24 * 60 }))
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: 30 * DAY })
    expect(30 * DAY).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(5)
    expect(h.execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30 * DAY - 6)
    expect(h.execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})

describe('V — an interval that would never be armed is refused at save', () => {
  const refusedConfigs: Array<[string, Record<string, unknown>]> = [
    ['no period at all', {}],
    ['intervalMinutes 0', { intervalMinutes: 0 }],
    ['negative intervalMinutes', { intervalMinutes: -5 }],
    ['cleared input (\'\') beside a stale intervalMs', { intervalMinutes: '', intervalMs: H }],
    ['intervalMinutes as a string', { intervalMinutes: '5' }],
    ['intervalMinutes null', { intervalMinutes: null }],
    ['intervalMinutes below the 1000 ms floor', { intervalMinutes: 0.01 }],
    ['non-finite intervalMinutes', { intervalMinutes: Number.POSITIVE_INFINITY }],
    ['intervalMs below the floor', { intervalMs: 500 }],
    ['intervalMs 0', { intervalMs: 0 }],
    ['non-finite intervalMs', { intervalMs: Number.POSITIVE_INFINITY }],
    ['intervalMs as a string', { intervalMs: '60000' }],
  ]

  for (const [label, triggerConfig] of refusedConfigs) {
    it(`create refuses ${label}, before anything is written`, async () => {
      const h = makeHarness()
      expectValidationRefusal(() => parseCreateRuleInput(editorCreateBody(triggerConfig), 'u1'))
      expect(h.rows.size).toBe(0)
    })
  }

  it('update refuses an invalid period in an editor PATCH and in a config-only PATCH; the stored row is unchanged', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H }))
    await expect(patchFromBody(h, rule.id, editorCreateBody({ intervalMs: H, intervalMinutes: '' })))
      .rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(patchFromBody(h, rule.id, { triggerConfig: { intervalMinutes: 0 } }))
      .rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(patchFromBody(h, rule.id, { triggerConfig: { intervalMs: 999 } }))
      .rejects.toBeInstanceOf(AutomationRuleValidationError)
    expect(storedTriggerConfig(h, rule.id)).toEqual({ intervalMs: H })
  })

  it('update refuses switching a cron rule to interval without a period (the cron config has none)', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, {
      ...editorCreateBody({ expression: '*/5 * * * *' }),
      triggerType: 'schedule.cron',
    })
    await expect(patchFromBody(h, rule.id, { triggerType: 'schedule.interval' }))
      .rejects.toBeInstanceOf(AutomationRuleValidationError)
    expect(h.rows.get(rule.id)?.trigger_type).toBe('schedule.cron')
  })

  it('an edit that does not touch the trigger (rename) of a stored invalid interval row is not blocked', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H }))
    h.rows.get(rule.id)!.trigger_config = {}
    await expect(patchFromBody(h, rule.id, { name: 'renamed' })).resolves.toBeTruthy()
  })
})

describe('L — stored rows saved before the fix', () => {
  it('a legacy row with only intervalMinutes is armed on boot at its period', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, editorCreateBody({ intervalMs: H }))
    // The row as the pre-fix editor save left it — written straight into the table, bypassing the save path.
    const boot = makeHarness()
    boot.rows.set(rule.id, { ...h.rows.get(rule.id)!, trigger_config: { intervalMinutes: 4 } })
    await boot.service.loadAndRegisterAllScheduled()
    expect(boot.scheduler.isRegistered(rule.id)).toBe(true)
    await expectPeriod(boot, 4 * MIN)
  })

  it('the scheduler arms an intervalMinutes-only rule directly; a legacy row with both keeps its stored intervalMs', async () => {
    const fired: Array<{ id: string; at: number }> = []
    const s = new AutomationScheduler((rule) => { fired.push({ id: rule.id, at: Date.now() }) })
    liveSchedulers.push(s)
    const rule = (id: string, config: Record<string, unknown>): ExecutorRule => ({
      id,
      name: id,
      sheetId: 'sheet_1',
      trigger: { type: 'schedule.interval', config } as ExecutorRule['trigger'],
      actions: [],
      enabled: true,
      createdBy: 'u1',
      createdAt: '2026-06-25T00:00:00.000Z',
      updatedAt: '2026-06-25T00:00:00.000Z',
    })
    const t0 = Date.now()
    s.register(rule('minutes_only', { intervalMinutes: 2 }))
    s.register(rule('both', { intervalMs: 3 * MIN, intervalMinutes: 10 }))
    s.register(rule('bad_minutes', { intervalMinutes: 0 }))
    expect(s.isRegistered('minutes_only')).toBe(true)
    expect(s.isRegistered('both')).toBe(true)
    expect(s.isRegistered('bad_minutes')).toBe(false)
    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(fired.filter((f) => f.id === 'minutes_only').map((f) => f.at - t0)).toEqual([2 * MIN, 4 * MIN, 6 * MIN])
    expect(fired.filter((f) => f.id === 'both').map((f) => f.at - t0)).toEqual([3 * MIN, 6 * MIN])
  })
})

describe('C — cron and date_field are not touched by the interval normaliser', () => {
  it('returns the very same config object for every non-interval trigger type, even with interval-looking keys', () => {
    const cron = { expression: '0 * * * *', timezone: 'Asia/Shanghai', intervalMinutes: 5 }
    const dateField = { dateFieldId: 'fld_due', offsetDays: 1, direction: 'before', timeOfDay: '09:00', intervalMs: 5 }
    const event = { fieldId: 'fld_1' }
    expect(normalizeIntervalTriggerConfigAtSave('schedule.cron', cron)).toBe(cron)
    expect(normalizeIntervalTriggerConfigAtSave('schedule.date_field', dateField)).toBe(dateField)
    expect(normalizeIntervalTriggerConfigAtSave('record.updated', event)).toBe(event)
    expect(normalizeIntervalTriggerConfigAtSave('schedule.cron', null)).toBeNull()
  })

  it('cron create and config-only update store the config as sent', async () => {
    const h = makeHarness()
    const rule = await createFromBody(h, {
      ...editorCreateBody({ expression: '*/5 * * * *', intervalMinutes: 5 }),
      triggerType: 'schedule.cron',
    })
    expect(storedTriggerConfig(h, rule.id)).toEqual({ expression: '*/5 * * * *', intervalMinutes: 5 })
    await patchFromBody(h, rule.id, { triggerConfig: { expression: '0 * * * *' } })
    expect(storedTriggerConfig(h, rule.id)).toEqual({ expression: '0 * * * *' })
  })

  it('date_field create keeps its config plus the server-set effectiveAt, with no interval keys added', async () => {
    const h = makeHarness()
    const config = { dateFieldId: 'fld_due', offsetDays: 1, direction: 'before', timeOfDay: '09:00' }
    const rule = await createFromBody(h, { ...editorCreateBody(config), triggerType: 'schedule.date_field' })
    const stored = storedTriggerConfig(h, rule.id)
    expect(stored).toMatchObject(config)
    expect(Object.keys(stored).sort()).toEqual([...Object.keys(config), 'effectiveAt'].sort())
  })
})
