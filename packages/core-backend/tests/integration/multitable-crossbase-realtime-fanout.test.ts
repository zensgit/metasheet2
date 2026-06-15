/**
 * C1 — automation record writes fan out a real-time invalidation to the EFFECTIVE sheet's room.
 *
 * Before C1 the automation executor never called `publishMultitableSheetRealtime`, so automation
 * writes — including the new cross-base writes/deletes — were invisible to the real-time layer
 * (closeout §5: "Yjs 跨 base fan-out 缺席"). C1 wires each of executeUpdate/Create/DeleteRecord to
 * publish for the effective sheet (target for cross-base, trigger for same-base). The fan-out lands
 * on the shared-singleton eventBus topic `spreadsheet.cell.updated` — the SAME topic CollabService
 * subscribes to and emits to the gated `sheet:${id}` room. So this suite captures that singleton
 * topic (NOT the executor's injected deps.eventBus, which carries only chaining events).
 *
 * Security framing = relative invariance: routing to `sheet:${effectiveSheetId}` reaches exactly the
 * audience a REST write to that sheet already reaches; origin base does not change the target room's
 * membership. The one new datum a cross-base fan-out would add is the trigger actorId — which C1
 * OMITS for cross-base (asserted below) so a trigger-base principal is not surfaced to the target
 * base's subscribers.
 *
 * Real DB (describeIfDatabase) — drives the real AutomationExecutor end-to-end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { EventBus, eventBus as sharedEventBus } from '../../src/integration/events/event-bus'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_rt_owner_${TS}` // owns BASE_A (trigger) AND BASE_B (target) → base-write on both
const NO_WRITE = `u_rt_nowrite_${TS}` // owns nothing, no codes → NO base-write on BASE_B

const BASE_A = `base_rt_a_${TS}` // trigger base
const BASE_B = `base_rt_b_${TS}` // cross-base target base
const SHEET_A = `sheet_rt_a_${TS}` // trigger sheet (BASE_A)
const SHEET_B = `sheet_rt_b_${TS}` // cross-base target sheet (BASE_B)
const TRIG_REC = `rec_rt_trig_${TS}` // a record in SHEET_A (same-base update target)
const TGT_REC = `rec_rt_tgt_${TS}` // a record in SHEET_B (cross-base update/delete target)

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function makeExecutor(): AutomationExecutor {
  const deps = {
    eventBus: new EventBus(),
    queryFn: (sql: string, params?: unknown[]) => q(sql, params),
  } as unknown as AutomationDeps
  return new AutomationExecutor(deps)
}

function ruleWith(action: { type: string; config: Record<string, unknown> }, createdBy: string): AutomationRule {
  return {
    id: `axr_rt_${TS}_${Math.random().toString(36).slice(2, 8)}`,
    name: 'RT rule',
    sheetId: SHEET_A,
    trigger: { type: 'record.updated', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy,
    createdAt: new Date().toISOString(),
  } as unknown as AutomationRule
}

// Capture the shared-singleton realtime topic (what CollabService consumes).
type Fanout = { spreadsheetId?: string; recordId?: string; kind?: string; actorId?: unknown; source?: string }
let captured: Fanout[] = []
const onFanout = (payload: unknown) => { captured.push(payload as Fanout) }

describeIfDatabase('C1 — automation real-time fan-out to the effective sheet room (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'RT Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'RT Base B', OWNER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Trigger A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_B, BASE_B, 'Target B'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [TRIG_REC, SHEET_A, JSON.stringify({ v: 'trig' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [TGT_REC, SHEET_B, JSON.stringify({ v: 'tgt' })])
    sharedEventBus.subscribe('spreadsheet.cell.updated', onFanout)
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, SHEET_B]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  beforeEach(() => { captured = [] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // C1-1 KEYSTONE: a CROSS-BASE update fans out to the TARGET sheet's room, with NO actorId.
  // RED before C1 — the executor published nothing to the realtime topic.
  test('C1-1: cross-base update_record fans out to the target sheet (no actorId surfaced)', async () => {
    const rule = ruleWith(
      { type: 'update_record', config: { fields: { v: 'rt1' }, targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: TGT_REC } },
      OWNER,
    )
    const exec = await makeExecutor().execute(rule, { recordId: TRIG_REC, sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const fan = captured.find((c) => c.recordId === TGT_REC)
    expect(fan, 'cross-base update must fan out to the target sheet room').toBeTruthy()
    expect(fan?.spreadsheetId).toBe(SHEET_B)
    expect(fan?.kind).toBe('record-updated')
    expect(fan?.actorId).toBeUndefined() // OMITTED for cross-base (no base-A principal in base-B's room)
  })

  // C1-2: a SAME-BASE update fans out to the trigger sheet, WITH actorId (the uniform gap-close).
  test('C1-2: same-base update_record fans out to the trigger sheet, actorId present', async () => {
    const rule = ruleWith({ type: 'update_record', config: { fields: { v: 'rt2' } } }, OWNER)
    const exec = await makeExecutor().execute(rule, { recordId: TRIG_REC, sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const fan = captured.find((c) => c.recordId === TRIG_REC)
    expect(fan?.spreadsheetId).toBe(SHEET_A)
    expect(fan?.kind).toBe('record-updated')
    expect(fan?.actorId).toBe(OWNER) // same-base: actor belongs to the same base, pass it through
  })

  // C1-3: cross-base create fans out kind 'record-created' to the target sheet.
  test('C1-3: cross-base create_record fans out record-created to the target sheet', async () => {
    const rule = ruleWith({ type: 'create_record', config: { sheetId: SHEET_B, targetBaseId: BASE_B, data: { v: 'rt3' } } }, OWNER)
    const exec = await makeExecutor().execute(rule, { recordId: TRIG_REC, sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const fan = captured.find((c) => c.spreadsheetId === SHEET_B && c.kind === 'record-created')
    expect(fan, 'cross-base create must fan out record-created').toBeTruthy()
    expect(fan?.actorId).toBeUndefined()
  })

  // C1-4: cross-base delete fans out kind 'record-deleted' to the target sheet.
  test('C1-4: cross-base delete_record fans out record-deleted to the target sheet', async () => {
    // dedicated victim so the suite stays order-independent
    const victim = `rec_rt_victim_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [victim, SHEET_B, JSON.stringify({ v: 'victim' })])
    const rule = ruleWith(
      { type: 'delete_record', config: { targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: victim } },
      OWNER,
    )
    const exec = await makeExecutor().execute(rule, { recordId: TRIG_REC, sheetId: SHEET_A, actorId: OWNER, data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    const fan = captured.find((c) => c.recordId === victim && c.kind === 'record-deleted')
    expect(fan, 'cross-base delete must fan out record-deleted').toBeTruthy()
    expect(fan?.spreadsheetId).toBe(SHEET_B)
    expect(fan?.actorId).toBeUndefined()
  })

  // C1-5: a BLOCKED cross-base write (actor lacks target base-write) fans out NOTHING — no fan-out
  // for a write that did not happen.
  test('C1-5: a blocked cross-base write (no base-write) fans out nothing', async () => {
    const rule = ruleWith(
      { type: 'update_record', config: { fields: { v: 'rt5' }, targetBaseId: BASE_B, targetSheetId: SHEET_B, targetRecordId: TGT_REC } },
      NO_WRITE,
    )
    const exec = await makeExecutor().execute(rule, { recordId: TRIG_REC, sheetId: SHEET_A, actorId: NO_WRITE, data: {} })
    expect(exec.steps[0]?.status).toBe('failed') // gate denies (no base-write on BASE_B)
    expect(captured.find((c) => c.recordId === TGT_REC), 'a denied write must not fan out').toBeFalsy()
  })
})
