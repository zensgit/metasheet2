/**
 * A schedule rule's TIMER must agree with its STORED `enabled` flag.
 *
 * The hole: `createRule` ended with an unconditional `registerSchedule(rule)`, and neither
 * `registerSchedule` nor `AutomationScheduler.register` looks at `enabled`. A `schedule.cron` /
 * `schedule.interval` / `schedule.date_field` rule CREATED with `enabled: false` therefore fired on its own
 * clock until the next save or restart (`updateRule` and the boot loader were already correct) — sending
 * webhooks / DingTalk messages and changing records while the UI showed it as off.
 *
 * Two guards, each pinned on its own:
 *   R  (registration) — a rule created disabled is never handed to the scheduler. Asserted on
 *      `isRegistered` / `activeCount`, NOT only on "did not fire", so the dispatch gate below cannot mask
 *      a regression of this one.
 *   D  (dispatch)     — the scheduled lane re-reads the rule's stored `enabled` at fire start and skips a
 *      rule that is disabled or gone in the database. Timers are per process and nothing invalidates them
 *      across instances, so a disable / delete handled by ANOTHER instance used to leave this one firing.
 *
 * The scheduler is the REAL `AutomationScheduler` on fake timers. The kysely chain is a small stateful
 * fake over one `automation_rules` map (insert / select / update / delete keyed by `id`), and `queryFn`
 * answers the raw reads from that same map, so "the database says disabled" is one fact, not two fixtures.
 * `executeRule` / `evaluateDateReminders` are spied (what fires is the subject, not what an action does).
 * Zero-DB, no supertest (tripwire #4154).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Logger } from '../../src/core/logger'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'

const RULE_ENABLED_SQL = /SELECT\s+enabled\s+FROM\s+automation_rules\s+WHERE\s+id\s*=\s*\$1/i
const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const META_FIELD_TYPE_SQL = /SELECT\s+type\s+FROM\s+meta_fields/i

const MIN = 60 * 1000
const H = 60 * MIN
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

/**
 * Stateful kysely fake. Every top-level call starts a fresh builder; the terminal `execute` /
 * `executeTakeFirst` applies the op to `rows` (automation_rules only — any other table reads empty).
 */
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
    b.executeTakeFirst = vi.fn(async () => {
      const r = (await (b.execute as () => Promise<Row[]>)())[0]
      return r
    })
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
  queryFn: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.spyOn>
  scan: ReturnType<typeof vi.spyOn>
  scheduler: { isRegistered(id: string): boolean; activeCount: number; destroy(): Promise<void> }
  enabledReads: string[]
}

let live: Harness[] = []

function makeHarness(opts: { enabledReadThrows?: boolean } = {}): Harness {
  const rows = new Map<string, Row>()
  const enabledReads: string[] = []
  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (RULE_ENABLED_SQL.test(sqlText)) {
      const id = String(params?.[0] ?? '')
      enabledReads.push(id)
      if (opts.enabledReadThrows) throw new Error('connection terminated: host=db.internal user=svc')
      const r = rows.get(id)
      return r ? { rows: [{ enabled: r.enabled }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (LIVENESS_ONE_SQL.test(sqlText)) return { rows: [{ deleted_at: null }], rowCount: 1 }
    if (META_FIELD_TYPE_SQL.test(sqlText)) return { rows: [{ type: 'date' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const service = new AutomationService(new EventBus(), makeDb(rows) as never, queryFn as never)
  const execute = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)
  const scan = vi.spyOn(service as never as { evaluateDateReminders: () => Promise<void> }, 'evaluateDateReminders')
    .mockResolvedValue(undefined)
  const scheduler = (service as never as { scheduler: Harness['scheduler'] }).scheduler
  const h = { service, rows, queryFn, execute, scan, scheduler, enabledReads }
  live.push(h)
  return h
}

const TRIGGERS = {
  cron: { triggerType: 'schedule.cron', triggerConfig: { expression: '*/5 * * * *' } },
  interval: { triggerType: 'schedule.interval', triggerConfig: { intervalMs: MIN } },
  date_field: {
    triggerType: 'schedule.date_field',
    triggerConfig: { dateFieldId: 'fld_due', offsetDays: 1, direction: 'before', timeOfDay: '09:00' },
  },
} as const
type Kind = keyof typeof TRIGGERS

function createInput(kind: Kind, enabled?: boolean) {
  return {
    name: `${kind} rule`,
    ...TRIGGERS[kind],
    triggerConfig: { ...TRIGGERS[kind].triggerConfig },
    actionType: 'update_record',
    actionConfig: { fields: { fld_status: 'x' } },
    ...(enabled === undefined ? {} : { enabled }),
  }
}

/** The spy that counts a fire for this trigger kind: date_field scans, the others execute once. */
const fires = (h: Harness, kind: Kind) => (kind === 'date_field' ? h.scan : h.execute).mock.calls.length

/** Long enough for each kind to fire at least once from 03:00 UTC: cron ≤5 min, interval 1 min, date 09:00. */
const WINDOW: Record<Kind, number> = { cron: 10 * MIN, interval: 3 * MIN, date_field: 7 * H }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-25T03:00:00.000Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const h of live) await h.scheduler.destroy()
  live = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('R — a schedule rule created disabled is not registered with the scheduler', () => {
  for (const kind of Object.keys(TRIGGERS) as Kind[]) {
    it(`${kind}: created with enabled:false → no timer, never fires (stored row says false)`, async () => {
      const h = makeHarness()
      const rule = await h.service.createRule('sheet_1', createInput(kind, false) as never)

      expect(rule.enabled).toBe(false)
      expect(h.rows.get(rule.id)?.enabled, 'the stored flag is false').toBe(false)

      await vi.advanceTimersByTimeAsync(WINDOW[kind])
      expect(fires(h, kind), 'a rule created disabled must not fire').toBe(0)
      // Asserted on the scheduler itself as well: the dispatch gate (D) also stops the fire above, so
      // "did not fire" alone would stay green if the registration guard regressed.
      expect(h.scheduler.isRegistered(rule.id), 'a disabled rule must not hold a timer').toBe(false)
      expect(h.scheduler.activeCount).toBe(0)
    })

    it(`${kind} (control): created enabled → registered and fires on its clock`, async () => {
      const h = makeHarness()
      const rule = await h.service.createRule('sheet_1', createInput(kind) as never)

      expect(rule.enabled).toBe(true)
      expect(h.scheduler.isRegistered(rule.id)).toBe(true)
      await vi.advanceTimersByTimeAsync(WINDOW[kind])
      expect(fires(h, kind), 'the zero above is the guard, not a dead harness').toBeGreaterThanOrEqual(1)
    })
  }

  it('date_field catch-up: a rule created disabled AFTER today\'s timeOfDay does not scan at create time', async () => {
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z')) // 09:00 already passed → register() would catch up NOW
    const off = makeHarness()
    const offRule = await off.service.createRule('sheet_1', createInput('date_field', false) as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(off.scheduler.isRegistered(offRule.id)).toBe(false)
    expect(off.scan).not.toHaveBeenCalled()

    const on = makeHarness()
    await on.service.createRule('sheet_1', createInput('date_field', true) as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(on.scan, 'control: an enabled rule takes the bounded catch-up scan').toHaveBeenCalledTimes(1)
  })
})

describe('sweep — every local writer of `enabled` leaves the timer consistent with the stored flag', () => {
  it('setRuleEnabled(true) on a rule created disabled registers it; it then fires', async () => {
    const h = makeHarness()
    const rule = await h.service.createRule('sheet_1', createInput('interval', false) as never)
    expect(h.scheduler.isRegistered(rule.id)).toBe(false)

    await h.service.setRuleEnabled(rule.id, 'sheet_1', true, 'u1')
    expect(h.rows.get(rule.id)?.enabled).toBe(true)
    expect(h.scheduler.isRegistered(rule.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('setRuleEnabled(false) unregisters; a later unrelated edit (rename) keeps it unregistered', async () => {
    const h = makeHarness()
    const rule = await h.service.createRule('sheet_1', createInput('cron') as never)
    expect(h.scheduler.isRegistered(rule.id)).toBe(true)

    await h.service.setRuleEnabled(rule.id, 'sheet_1', false, 'u1')
    expect(h.scheduler.isRegistered(rule.id)).toBe(false)
    await h.service.updateRule(rule.id, 'sheet_1', { name: 'renamed' }, 'u1')
    expect(h.scheduler.isRegistered(rule.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(WINDOW.cron)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('deleteRule unregisters', async () => {
    const h = makeHarness()
    const rule = await h.service.createRule('sheet_1', createInput('interval') as never)
    expect(await h.service.deleteRule(rule.id, 'sheet_1')).toBe(true)
    expect(h.scheduler.isRegistered(rule.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('boot (loadAndRegisterAllScheduled) arms only rows the database holds as enabled', async () => {
    const seed = makeHarness()
    const on = await seed.service.createRule('sheet_1', createInput('interval') as never)
    const off = await seed.service.createRule('sheet_1', createInput('interval', false) as never)

    // A fresh process over the same rows. The boot SELECT filters on enabled = true in SQL; the fake
    // applies that same `where`, so this pins the loader's filter, not the fake's.
    const boot = makeHarness()
    for (const [id, r] of seed.rows) boot.rows.set(id, { ...r })
    await boot.service.loadAndRegisterAllScheduled()
    expect(boot.scheduler.isRegistered(on.id)).toBe(true)
    expect(boot.scheduler.isRegistered(off.id)).toBe(false)
  })
})

describe('D — the scheduled lane re-checks the stored `enabled` flag at fire start', () => {
  for (const kind of Object.keys(TRIGGERS) as Kind[]) {
    it(`${kind}: disabled in the database by ANOTHER instance (this process still holds the timer) → skipped`, async () => {
      const h = makeHarness()
      const rule = await h.service.createRule('sheet_1', createInput(kind) as never)
      // Another instance handled PATCH { enabled:false }: the row changed, THIS process's timer did not.
      h.rows.get(rule.id)!.enabled = false
      expect(h.scheduler.isRegistered(rule.id), 'precondition: the local timer is still armed').toBe(true)

      await vi.advanceTimersByTimeAsync(WINDOW[kind])
      expect(fires(h, kind)).toBe(0)
      expect(h.enabledReads.length, 'the timer did fire; the gate refused it').toBeGreaterThanOrEqual(1)
    })
  }

  it('control: re-enabled in the database → the same armed timer fires again', async () => {
    const h = makeHarness()
    const rule = await h.service.createRule('sheet_1', createInput('interval') as never)
    h.rows.get(rule.id)!.enabled = false
    await vi.advanceTimersByTimeAsync(MIN)
    expect(h.execute).not.toHaveBeenCalled()
    h.rows.get(rule.id)!.enabled = true
    await vi.advanceTimersByTimeAsync(MIN)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('deleted in the database by another instance (row gone) → skipped', async () => {
    const h = makeHarness()
    const rule = await h.service.createRule('sheet_1', createInput('cron') as never)
    h.rows.delete(rule.id)
    await vi.advanceTimersByTimeAsync(WINDOW.cron)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('the enabled read FAILS → that tick does not run (fail-closed); the WARN carries the error class, never its text', async () => {
    const h = makeHarness({ enabledReadThrows: true })
    const warn = vi.mocked(console.warn)
    // The scheduler's own catch-all (`runScheduledRule`) logs `err.message` through Logger.error; a read
    // failure must be handled inside the gate so the driver text (host, user) never reaches that sink.
    const loggerError = vi.spyOn(Logger.prototype, 'error')
    const rule = await h.service.createRule('sheet_1', createInput('interval') as never)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(h.enabledReads).toEqual([rule.id])
    expect(h.execute, 'an unconfirmed rule does not send').not.toHaveBeenCalled()
    expect(loggerError, 'handled in the gate, not by the scheduler catch-all').not.toHaveBeenCalled()
    expect(JSON.stringify([...warn.mock.calls, ...loggerError.mock.calls])).not.toContain('db.internal')
    const skip = warn.mock.calls.find((c) => String(c[0]).includes('not enabled'))
    expect(skip?.[1]).toEqual({ ruleId: rule.id, sheetId: 'sheet_1', reason: 'lookup_failed', errorClass: 'Error' })
  })

  it('the skip WARN is values-free: ids and a reason only', async () => {
    const h = makeHarness()
    const warn = vi.mocked(console.warn)
    const rule = await h.service.createRule('sheet_1', createInput('interval') as never)
    h.rows.get(rule.id)!.enabled = false
    await vi.advanceTimersByTimeAsync(MIN)
    const skip = warn.mock.calls.find((c) => String(c[0]).includes('not enabled'))
    expect(skip?.[1]).toEqual({ ruleId: rule.id, sheetId: 'sheet_1', reason: 'disabled' })
  })
})
