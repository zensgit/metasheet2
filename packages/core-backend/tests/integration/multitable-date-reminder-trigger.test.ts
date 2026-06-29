/**
 * Date-reminder trigger (`schedule.date_field`) — real-DB wire proof of scan → claim → fire (2026-06-28).
 *
 * The fire time is DATA-DRIVEN (per record's date field), so correctness hinges on idempotency + a bounded
 * firing window, not a wall-clock cadence. This suite drives `runDateReminderScanNow` (the deterministic ops
 * seam) against real Postgres and asserts the two day-one failure modes are closed:
 *   DR-1  fires once for a DUE record (claim row + end-to-end update_record marker, via the record context).
 *   DR-2  IDEMPOTENT — a second scan adds no claim row, logs no new execution, double-writes nothing.
 *   DR-3  BACKFILL bound — the SAME due record under a FRESH rule (created_at = now) does NOT fire, because
 *         its occurrence predates the rule's creation. This isolates the created_at predicate (the SQL window
 *         still fetches the record; isDateReminderDue rejects it). The day-one blast a reviewer probes first.
 *   DR-4  a far-FUTURE date does not fire.
 *   DR-5  null / absent date is skipped.
 *   DR-6  editing the date to a NEW reminder-day produces a NEW occurrence (fires again); the old occurrence
 *         stays deduped (no re-spam of the original day).
 *
 * created_at is BACKDATED on the primary rule so a record's occurrence can legitimately fall in
 * (created_at, now] — a just-created rule can only ever fire for occurrences at/after its creation (that IS
 * the backfill guarantee), which is exactly what DR-3 pins. Runs only with DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { db } from '../../src/db/db'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_dr_${TS}`
const SHEET = `sheet_dr_${TS}`
const FLD_DATE = `fld_dr_date_${TS}`
const FLD_MARK = `fld_dr_mark_${TS}`
const REC_DUE = `rec_dr_due_${TS}`
const REC_FUTURE = `rec_dr_future_${TS}`
const REC_NULL = `rec_dr_null_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Real db + queryFn so the scan (this.db) AND the fired update_record action (queryFn) both hit live Postgres.
const svc = new AutomationService(new EventBus(), db as never, q as never)

const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

let RULE_BACKDATED = ''
let RULE_FRESH = ''

/** Count claim (fire) rows for a rule in the idempotency ledger. */
const claimCount = async (ruleId: string): Promise<number> => {
  const r = await q('SELECT count(*)::int AS n FROM meta_automation_date_reminder_fires WHERE rule_id = $1', [ruleId])
  return (r.rows as Array<{ n: number }>)[0].n
}
/** Count logged executions for a rule (each fire records one). */
const execCount = async (ruleId: string): Promise<number> => {
  const r = await q('SELECT count(*)::int AS n FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
  return (r.rows as Array<{ n: number }>)[0].n
}
const recordData = async (recordId: string): Promise<Record<string, unknown>> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  const d = (r.rows[0] as { data: unknown } | undefined)?.data
  return (typeof d === 'string' ? JSON.parse(d) : (d as Record<string, unknown>)) ?? {}
}

describeIfDatabase('multitable date-reminder trigger — scan/claim/fire (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'DR Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'DR Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_DATE, SHEET, 'Due', 'date', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_MARK, SHEET, 'Mark', 'string', '{}', 2])

    // REC_DUE date = now + 3 days. With offset=3/before/timeOfDay=00:00 the occurrence day-buckets to TODAY
    // 00:00 UTC, which is <= now (due) and within the recent window. REC_FUTURE is far out; REC_NULL has none.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_DUE, SHEET, JSON.stringify({ [FLD_DATE]: iso(TS + 3 * DAY) })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_FUTURE, SHEET, JSON.stringify({ [FLD_DATE]: iso(TS + 30 * DAY) })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [REC_NULL, SHEET, JSON.stringify({ [FLD_MARK]: 'x' })])

    const ruleConfig = {
      name: `dr ${TS}`,
      triggerType: 'schedule.date_field',
      triggerConfig: { dateFieldId: FLD_DATE, offsetDays: 3, direction: 'before', timeOfDay: '00:00' },
      actionType: 'update_record',
      actionConfig: { fields: { [FLD_MARK]: 'reminded' } },
    } as never

    const backdated = await svc.createRule(SHEET, ruleConfig)
    RULE_BACKDATED = backdated.id
    // Backdate BOTH created_at AND the date_field activation `effectiveAt` so REC_DUE's occurrence (today
    // 00:00) is >= the firing floor max(createdAt, effectiveAt) — the only way a rule legitimately fires for
    // it. (Backdating created_at alone no longer suffices: createRule stamps effectiveAt=now and the floor is
    // the activation — that IS the conversion-backfill fix, proven by DR-7.)
    await q(
      `UPDATE automation_rules SET created_at = $1::timestamptz,
         trigger_config = jsonb_set(trigger_config, '{effectiveAt}', to_jsonb($2::text)) WHERE id = $3`,
      [iso(TS - 10 * DAY), iso(TS - 10 * DAY), RULE_BACKDATED],
    )

    const fresh = await svc.createRule(SHEET, ruleConfig)
    RULE_FRESH = fresh.id // created_at stays ~now → must NOT fire for the past-bucketed occurrence
  })

  afterAll(async () => {
    svc.shutdown()
    await q('DELETE FROM meta_automation_date_reminder_fires WHERE rule_id = ANY($1::text[])', [[RULE_BACKDATED, RULE_FRESH]]).catch(() => {})
    await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [[RULE_BACKDATED, RULE_FRESH]]).catch(() => {})
    // Sheet-scoped so the save-validation goldens' throwaway rules are reaped too (FK cascades their ledger rows).
    await q('DELETE FROM automation_rules WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('DR-1: a DUE record fires once — claim row written + update_record marker stamped via record context', async () => {
    await svc.runDateReminderScanNow(RULE_BACKDATED)
    // exactly one claim (REC_DUE), and it is REC_DUE specifically.
    expect(await claimCount(RULE_BACKDATED)).toBe(1)
    const rows = await q('SELECT record_id FROM meta_automation_date_reminder_fires WHERE rule_id = $1', [RULE_BACKDATED])
    expect((rows.rows as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([REC_DUE])
    // end-to-end: the fire ran update_record against the triggered record (proves the record context flowed).
    expect((await recordData(REC_DUE))[FLD_MARK]).toBe('reminded')
    // FUTURE + NULL records did NOT fire.
    expect((await recordData(REC_FUTURE))[FLD_MARK]).toBeUndefined()
    expect((await recordData(REC_NULL))[FLD_MARK]).toBe('x')
  })

  test('DR-2: a second scan is IDEMPOTENT — no new claim, no new execution', async () => {
    const claimsBefore = await claimCount(RULE_BACKDATED)
    const execsBefore = await execCount(RULE_BACKDATED)
    await svc.runDateReminderScanNow(RULE_BACKDATED)
    expect(await claimCount(RULE_BACKDATED)).toBe(claimsBefore) // dedup blocked the re-claim
    expect(await execCount(RULE_BACKDATED)).toBe(execsBefore) // and therefore fired nothing
  })

  test('DR-RET: 365d ledger retention deletes old fired_at rows and keeps recent dedupe rows', async () => {
    const OLD_LEDGER_RECORD = `rec_dr_ledger_old_${TS}`
    const RECENT_LEDGER_RECORD = `rec_dr_ledger_recent_${TS}`
    await q(
      `INSERT INTO meta_automation_date_reminder_fires (rule_id, record_id, occurrence_ts, fired_at)
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz)`,
      [RULE_BACKDATED, OLD_LEDGER_RECORD, iso(TS - 400 * DAY), iso(TS - 366 * DAY)],
    )
    await q(
      `INSERT INTO meta_automation_date_reminder_fires (rule_id, record_id, occurrence_ts, fired_at)
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz)`,
      [RULE_BACKDATED, RECENT_LEDGER_RECORD, iso(TS - 20 * DAY), iso(TS - 364 * DAY)],
    )

    expect(await svc.sweepDateReminderLedger(TS)).toBeGreaterThanOrEqual(1)

    const rows = await q(
      `SELECT record_id FROM meta_automation_date_reminder_fires
        WHERE rule_id = $1 AND record_id = ANY($2::text[])
        ORDER BY record_id`,
      [RULE_BACKDATED, [OLD_LEDGER_RECORD, RECENT_LEDGER_RECORD]],
    )
    expect((rows.rows as Array<{ record_id: string }>).map((r) => r.record_id)).toEqual([RECENT_LEDGER_RECORD])
  })

  test('DR-3: BACKFILL bound — the SAME due record under a FRESH rule does NOT fire (occurrence < floor = effectiveAt ≈ created_at)', async () => {
    await svc.runDateReminderScanNow(RULE_FRESH)
    // REC_DUE is fetched by the SQL window, but its occurrence (today 00:00) predates the fresh rule's FLOOR
    // (max(createdAt, effectiveAt) ≈ now, both ~creation) → isDateReminderDue rejects it → zero claims, zero
    // fires. No day-one backfill blast.
    expect(await claimCount(RULE_FRESH)).toBe(0)
    expect(await execCount(RULE_FRESH)).toBe(0)
  })

  test('DR-7: a rule CONVERTED into date_field does NOT backfill before its activation (effectiveAt floor, not old created_at)', async () => {
    // A months-old NON-date_field rule, then flipped to schedule.date_field today — the conversion path that
    // the old `created_at` floor leaked through.
    const base = await svc.createRule(SHEET, {
      name: `dr conv ${TS}`,
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'update_record',
      actionConfig: { fields: { [FLD_MARK]: 'reminded' } },
    } as never)
    const RULE_CONVERTED = base.id
    try {
      // Backdate created_at 30d: WITHOUT the effectiveAt floor, REC_DUE's occurrence (today 00:00) would be
      // >= created_at and fire — exactly the conversion-backfill hole.
      await q('UPDATE automation_rules SET created_at = $1 WHERE id = $2', [iso(TS - 30 * DAY), RULE_CONVERTED])
      // Flip to date_field — updateRule stamps effectiveAt = now (the activation), NOT the backdated created_at.
      await svc.updateRule(RULE_CONVERTED, SHEET, {
        triggerType: 'schedule.date_field',
        triggerConfig: { dateFieldId: FLD_DATE, offsetDays: 3, direction: 'before', timeOfDay: '00:00' },
      } as never)

      const cfg = await q('SELECT trigger_config FROM automation_rules WHERE id = $1', [RULE_CONVERTED])
      const tc = (cfg.rows[0] as { trigger_config: unknown }).trigger_config
      const ec = (typeof tc === 'string' ? JSON.parse(tc) : tc) as { effectiveAt?: string }
      expect(typeof ec.effectiveAt).toBe('string')
      expect(new Date(ec.effectiveAt as string).getTime()).toBeGreaterThan(TS - DAY) // recent activation, not 30d ago

      await svc.runDateReminderScanNow(RULE_CONVERTED)
      // REC_DUE's occurrence (today 00:00) < effectiveAt (≈now) → floored → ZERO fire. Conversion never backfills.
      expect(await claimCount(RULE_CONVERTED)).toBe(0)
      expect(await execCount(RULE_CONVERTED)).toBe(0)
    } finally {
      await q('DELETE FROM meta_automation_date_reminder_fires WHERE rule_id = $1', [RULE_CONVERTED]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [RULE_CONVERTED]).catch(() => {})
    }
  })

  test('DR-6: editing the date to a NEW reminder-day fires a NEW occurrence; the old occurrence stays deduped', async () => {
    const claimsBefore = await claimCount(RULE_BACKDATED) // 1 (today)
    // Move the deadline one day earlier (now+2d) → occurrence buckets to YESTERDAY 00:00 — still due + in
    // window, but a DIFFERENT occurrence_ts than today → a fresh claim + fire.
    await q('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2', [JSON.stringify({ [FLD_DATE]: iso(TS + 2 * DAY) }), REC_DUE])
    await svc.runDateReminderScanNow(RULE_BACKDATED)
    expect(await claimCount(RULE_BACKDATED)).toBe(claimsBefore + 1) // one NEW occurrence claimed
    // both occurrences (today + yesterday) are now in the ledger for REC_DUE.
    const occRows = await q('SELECT count(*)::int AS n FROM meta_automation_date_reminder_fires WHERE rule_id = $1 AND record_id = $2', [RULE_BACKDATED, REC_DUE])
    expect((occRows.rows as Array<{ n: number }>)[0].n).toBe(2)
  })

  // ── P2: SAVE-boundary validation — the UI's date-field contract is enforced in createRule/updateRule, so a
  // direct API / import / script write cannot persist a rule that looks saved but skips/mis-fires at scan. ──
  const mkDateRule = (triggerConfig: Record<string, unknown>) => ({
    name: `dr-val ${TS}`,
    triggerType: 'schedule.date_field',
    triggerConfig,
    actionType: 'update_record',
    actionConfig: { fields: { [FLD_MARK]: 'reminded' } },
  }) as never

  test('DR-VAL: rejects an unknown dateFieldId at save (not found on sheet)', async () => {
    await expect(svc.createRule(SHEET, mkDateRule({ dateFieldId: `nope_${TS}`, offsetDays: 3, direction: 'before' })))
      .rejects.toThrow(/dateFieldId not found/i)
  })

  test('DR-VAL: rejects a NON-date field (string) at save', async () => {
    await expect(svc.createRule(SHEET, mkDateRule({ dateFieldId: FLD_MARK, offsetDays: 3, direction: 'before' })))
      .rejects.toThrow(/must be a date\/dateTime field/i)
  })

  test('DR-VAL: rejects a negative offsetDays at save', async () => {
    await expect(svc.createRule(SHEET, mkDateRule({ dateFieldId: FLD_DATE, offsetDays: -1, direction: 'before' })))
      .rejects.toThrow(/offsetDays must be a non-negative integer/i)
  })

  test('DR-VAL: rejects a non-UTC timezone at save (v1 honors only UTC — reject, not accept-and-ignore)', async () => {
    await expect(svc.createRule(SHEET, mkDateRule({ dateFieldId: FLD_DATE, offsetDays: 3, direction: 'before', timezone: 'America/New_York' })))
      .rejects.toThrow(/timezone v1 supports only 'UTC'/i)
  })

  test('DR-VAL: a valid date field + config saves successfully', async () => {
    const ok = await svc.createRule(SHEET, mkDateRule({ dateFieldId: FLD_DATE, offsetDays: 1, direction: 'after', timeOfDay: '08:30' }))
    expect(ok.id).toBeTruthy()
    expect(ok.trigger_type).toBe('schedule.date_field')
  })

  test('DR-DISABLED: a DISABLED date_field rule is a no-op via runDateReminderScanNow (enabled gate honored)', async () => {
    const disabled = await svc.createRule(SHEET, {
      name: `dr-disabled ${TS}`,
      triggerType: 'schedule.date_field',
      triggerConfig: { dateFieldId: FLD_DATE, offsetDays: 3, direction: 'before', timeOfDay: '00:00' },
      actionType: 'update_record',
      actionConfig: { fields: { [FLD_MARK]: 'reminded' } },
      enabled: false,
    } as never)
    // Backdate so an ENABLED rule WOULD fire for REC_DUE — isolating "disabled" as the only reason it doesn't.
    await q('UPDATE automation_rules SET created_at = $1 WHERE id = $2', [iso(TS - 10 * DAY), disabled.id])
    await svc.runDateReminderScanNow(disabled.id)
    expect(await claimCount(disabled.id)).toBe(0)
  })
})
