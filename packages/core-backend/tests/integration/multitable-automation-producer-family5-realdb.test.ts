/**
 * P2 durable-delivery P1#2d — producer family 5 (univer-meta routes ×4) goldens, real DB.
 *
 * Every mutation is driven through the REAL Express routes (`univerMetaRouter()` on a real app, real
 * `poolManager` pool — same harness as the sibling undelete/reset/d1c suites), so these goldens exercise the
 * actual route-layer txn + enqueue wiring, not a re-implementation:
 *
 *   site 1  `multitable.record.created`  — was revert-execute UNDELETE (resurrect); under exact-anchor the
 *            kernel categorically refuses resurrection (INBOUND_UNPROVABLE) — site 1 now pins the
 *            fail-closed / no-write / no-token / no-event contract
 *   site 2  `multitable.record.updated`  — reset-execute bulk per-row revert path (N rows ⇒ N events)
 *   site 3  `multitable.record.deleted`  — reset-execute delete path
 *   site 4  `multitable.form.submitted`  — form submit (CREATE and EDIT branches; its flag-ON golden's
 *            consumer-key assertion is the END-TO-END proof of the manifest fix that routes this event —
 *            an unrouted event would make the fail-closed expand THROW inside the txn, 500ing the route)
 *
 * Per family-wired site that still mutates: flag ON ⇒ same-txn outbox row + exact manifest v1 consumer
 * fan-out, legacy bus SUPPRESSED (REPLACE); flag OFF ⇒ legacy post-commit emit with the byte-identical
 * payload shape + ZERO outbox rows. Rows are asserted by this suite's own record ids / outbox ids and
 * cleaned up — never drained — so it never claims a sibling suite's rows on the shared CI DB. Three
 * ISOLATED sheets (form/undelete/reset) keep each scenario's integrity precheck and delete-set blind
 * to the others' records.
 *
 * Exact-anchor migration (W0 L8): free wall-clock `asOf` is refused. Reset is driven by a sealed
 * `anchorOperationId` + token-only execute under the trust pair (writer fence + contiguity-strict).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { eventBus } from '../../src/integration/events/event-bus'
import {
  prepareExactAnchorHistoryFixture,
  pruneSealedHistoryOperations,
  type ExactAnchorHistoryFixture,
} from '../utils/exact-anchor-history-fixture'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_f5_${TS}`
const FORM_SHEET = `sheet_f5_form_${TS}`, UNDEL_SHEET = `sheet_f5_undel_${TS}`, RESET_SHEET = `sheet_f5_reset_${TS}`
const FORM_VIEW = `view_f5_form_${TS}`
const FLD_FORM = `fld_f5_form_${TS}`, FLD_UNDEL = `fld_f5_undel_${TS}`, FLD_RESET = `fld_f5_reset_${TS}`
const MEMBER = `u_f5_member_${TS}`, ADMIN = `u_f5_admin_${TS}`
// Seeded record ids are PER-TEST unique (seedSeq) — outboxRowsFor keys on payload.recordId, so reusing an id
// across the flag-ON and flag-OFF tests would let one test see the other's (intentionally durable) rows.
let seedSeq = 0
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const DURABLE_FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
const asMember = (): void => { currentUser = { id: MEMBER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] } }
const asAdmin = (): void => { currentUser = { id: ADMIN, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] } }

const seededOutboxIds: string[] = []
const fixtures = new Map<string, ExactAnchorHistoryFixture>()

/** All outbox rows for (eventType, payload.recordId) — this suite's record ids are unique, so this is
 *  assert-by-own-row, never a drain. Ids are tracked for cleanup. */
async function outboxRowsFor(eventType: string, recordId: string): Promise<Array<{ id: string; event_id: string; payload: Record<string, unknown> }>> {
  const { rows } = await q(
    `SELECT id, event_id, payload FROM meta_automation_outbox WHERE event_type = $1 AND payload->>'recordId' = $2 ORDER BY id`,
    [eventType, recordId],
  )
  const typed = rows as Array<{ id: string; event_id: string; payload: Record<string, unknown> }>
  for (const r of typed) if (!seededOutboxIds.includes(r.id)) seededOutboxIds.push(r.id)
  return typed
}
async function consumersOf(outboxId: string): Promise<string[]> {
  const { rows } = await q('SELECT consumer_key FROM meta_automation_outbox_consumer WHERE outbox_id = $1 ORDER BY 1', [outboxId])
  return (rows as Array<{ consumer_key: string }>).map((r) => r.consumer_key)
}
/** The legacy-bus calls of one event type observed by the spy (realtime uses `publish`, so `emit` is clean). */
function emitsOf(spy: ReturnType<typeof vi.spyOn>, eventType: string): Array<Record<string, unknown>> {
  return (spy.mock.calls as Array<[string, unknown]>).filter((c) => c[0] === eventType).map((c) => c[1] as Record<string, unknown>)
}

async function cleanSheet(sheetId: string): Promise<void> {
  await pruneSealedHistoryOperations(sheetId).catch(() => {})
  await q('DELETE FROM meta_history_baselines WHERE sheet_id = $1', [sheetId]).catch(() => {})
  await q('DELETE FROM meta_history_trust_checkpoints WHERE sheet_id = $1', [sheetId]).catch(() => {})
  await q('DELETE FROM meta_recovery_token_burns WHERE sheet_id = $1', [sheetId]).catch(() => {})
  await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId])
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId])
  fixtures.delete(sheetId)
}

async function prepareSheetFixture(sheetId: string): Promise<ExactAnchorHistoryFixture> {
  await cleanSheet(sheetId)
  const fixture = await prepareExactAnchorHistoryFixture(sheetId)
  fixtures.set(sheetId, fixture)
  return fixture
}

/** U: created at anchor, deleted after, NO live row → exact-anchor discloses a resurrect candidate
 *  but categorically refuses an executable plan (site 1 fail-closed contract). */
async function seedUndelete(): Promise<{ u: string; fixture: ExactAnchorHistoryFixture }> {
  const fixture = await prepareSheetFixture(UNDEL_SHEET)
  const u = `rec_f5_u_${TS}_${++seedSeq}`
  await fixture.insertRevision({
    recordId: u,
    version: 1,
    action: 'create',
    snapshot: { [FLD_UNDEL]: 'u-at-anchor' },
    createdAt: T0,
    phase: 'anchor',
    changedFieldIds: [FLD_UNDEL],
  })
  await fixture.insertRevision({
    recordId: u,
    version: 1,
    action: 'delete',
    snapshot: { [FLD_UNDEL]: 'u-at-anchor' },
    createdAt: T2,
    phase: 'after',
    changedFieldIds: [FLD_UNDEL],
  })
  return { u, fixture }
}
/** a/b: old@anchor → new@after (reset reverts both — the per-row N=2 case); d: created@after (reset deletes it). */
async function seedReset(): Promise<{ a: string; b: string; d: string; fixture: ExactAnchorHistoryFixture }> {
  const fixture = await prepareSheetFixture(RESET_SHEET)
  const a = `rec_f5_a_${TS}_${++seedSeq}`, b = `rec_f5_b_${TS}_${++seedSeq}`, d = `rec_f5_d_${TS}_${++seedSeq}`
  for (const [idx, id] of [a, b].entries()) {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, RESET_SHEET, JSON.stringify({ [FLD_RESET]: 'new' })])
    await fixture.insertRevision({
      recordId: id,
      version: 1,
      action: 'create',
      snapshot: { [FLD_RESET]: 'old' },
      createdAt: T0,
      phase: idx === 0 ? 'anchor' : 'before',
      changedFieldIds: [FLD_RESET],
    })
    await fixture.insertRevision({
      recordId: id,
      version: 2,
      action: 'update',
      snapshot: { [FLD_RESET]: 'new' },
      createdAt: T2,
      phase: 'after',
      changedFieldIds: [FLD_RESET],
    })
  }
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [d, RESET_SHEET, JSON.stringify({ [FLD_RESET]: 'newbie' })])
  await fixture.insertRevision({
    recordId: d,
    version: 1,
    action: 'create',
    snapshot: { [FLD_RESET]: 'newbie' },
    createdAt: T2,
    phase: 'after',
    changedFieldIds: [FLD_RESET],
  })
  return { a, b, d, fixture }
}

/** Site 1: exact-anchor resurrect is fail-closed — disclose candidate, mint no token, write nothing, emit nothing. */
async function assertUndeleteFailClosed(u: string, fixture: ExactAnchorHistoryFixture): Promise<void> {
  asAdmin()
  const beforeLive = (await q('SELECT 1 FROM meta_records WHERE id = $1', [u])).rows.length
  const beforeTrash = (await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [u])).rows.length
  const beforeOutbox = await outboxRowsFor('multitable.record.created', u)
  const pv = await request(app).post(`/api/multitable/sheets/${UNDEL_SHEET}/revert-preview`).send({ anchorOperationId: fixture.anchorOperationId() })
  expect(pv.status).toBe(200)
  expect(pv.body?.data?.undeleteRecordIds).toEqual([u])
  expect(pv.body?.data?.undeleteSupported).toBe(false)
  expect(pv.body?.data?.undeleteBlockedReason).toBe('INBOUND_UNPROVABLE')
  expect(pv.body?.data?.executable).toBe(false)
  expect(pv.body?.data?.previewIdentity).toBeNull()
  // No executable token ⇒ no durable write path; sheet state + outbox unchanged.
  expect((await q('SELECT 1 FROM meta_records WHERE id = $1', [u])).rows.length).toBe(beforeLive)
  expect((await q('SELECT 1 FROM meta_records_trash WHERE record_id = $1', [u])).rows.length).toBe(beforeTrash)
  expect(await outboxRowsFor('multitable.record.created', u)).toHaveLength(beforeOutbox.length)
}
async function resetExecute(d: string, fixture: ExactAnchorHistoryFixture): Promise<void> {
  asAdmin()
  const pv = await request(app).post(`/api/multitable/sheets/${RESET_SHEET}/reset-preview`).send({ anchorOperationId: fixture.anchorOperationId() })
  expect(pv.status).toBe(200)
  expect(pv.body?.data?.executable).toBe(true)
  const token = pv.body?.data?.previewIdentity as string
  expect(token).toBeTruthy()
  const x = await request(app).post(`/api/multitable/sheets/${RESET_SHEET}/reset-execute`)
    .send({ previewIdentity: token, confirm: 'reset' })
  expect(x.status).toBe(200)
  expect(x.body?.data?.revertedCount).toBe(2)
  expect(x.body?.data?.deletedRecordIds).toEqual([d])
}
async function formSubmitCreate(name: string): Promise<string> {
  asMember()
  const res = await request(app).post(`/api/multitable/views/${FORM_VIEW}/submit`).send({ data: { [FLD_FORM]: name } })
  expect(res.status).toBe(200)
  expect(res.body?.data?.mode).toBe('create')
  return String(res.body?.data?.record?.id)
}

describeIfDatabase('P1#2d producer family 5 (univer-meta routes) — durable REPLACE goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { if (currentUser) (req as unknown as { user?: unknown }).user = currentUser; next() })
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'F5 Base'])
    for (const [sheet, fld] of [[FORM_SHEET, FLD_FORM], [UNDEL_SHEET, FLD_UNDEL], [RESET_SHEET, FLD_RESET]] as const) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheet, BASE, sheet])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fld, sheet, 'Name', 'string', '{}', 1])
    }
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)', [FORM_VIEW, FORM_SHEET, 'Form', 'form', '{}'])
    for (const u of [MEMBER, ADMIN]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    if (seededOutboxIds.length) {
      await q('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [seededOutboxIds]).catch(() => {}) // consumer rows CASCADE
    }
    for (const sheet of [FORM_SHEET, UNDEL_SHEET, RESET_SHEET]) {
      await cleanSheet(sheet).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[MEMBER, ADMIN]]).catch(() => {})
  })
  afterEach(() => {
    delete process.env[DURABLE_FLAG]
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
    vi.restoreAllMocks()
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('site 4 CREATE, flag ON: form submit → same-txn outbox row routed [automation-record-trigger] (manifest-fix E2E) + legacy bus SUPPRESSED', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    const recId = await formSubmitCreate('f5-on-create')
    const rows = await outboxRowsFor('multitable.form.submitted', recId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event_id).toBe(rows[0]!.payload._eventId) // event identity = the payload's own _eventId
    expect(rows[0]!.payload).toEqual({ sheetId: FORM_SHEET, recordId: recId, actorId: MEMBER, mode: 'create', _eventId: rows[0]!.event_id })
    // THE manifest-fix expansion assertion: multitable.form.submitted routes (post-fix) → exactly this set.
    expect(await consumersOf(rows[0]!.id)).toEqual(['automation-record-trigger'])
    expect(emitsOf(emitSpy, 'multitable.form.submitted')).toHaveLength(0) // REPLACE: legacy emit suppressed
  })

  test('site 4 EDIT, flag ON: form-submit EDIT branch → its own outbox row (mode=update) + suppressed legacy', async () => {
    const recId = await formSubmitCreate('f5-edit-base') // created with flag OFF → no outbox row for the create
    expect(await outboxRowsFor('multitable.form.submitted', recId)).toHaveLength(0)
    process.env[DURABLE_FLAG] = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    asMember()
    const res = await request(app).post(`/api/multitable/views/${FORM_VIEW}/submit`)
      .send({ recordId: recId, expectedVersion: 1, data: { [FLD_FORM]: 'f5-edit-v2' } })
    expect(res.status).toBe(200)
    expect(res.body?.data?.mode).toBe('update')
    const rows = await outboxRowsFor('multitable.form.submitted', recId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toEqual({ sheetId: FORM_SHEET, recordId: recId, actorId: MEMBER, mode: 'update', _eventId: rows[0]!.event_id })
    expect(await consumersOf(rows[0]!.id)).toEqual(['automation-record-trigger'])
    expect(emitsOf(emitSpy, 'multitable.form.submitted')).toHaveLength(0)
  })

  test('site 4, flag OFF: legacy emit fires with the byte-identical payload shape + ZERO outbox rows', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit')
    const recId = await formSubmitCreate('f5-off-create')
    const emits = emitsOf(emitSpy, 'multitable.form.submitted')
    expect(emits).toHaveLength(1)
    expect(emits[0]).toEqual({ sheetId: FORM_SHEET, recordId: recId, actorId: MEMBER, mode: 'create', _eventId: expect.any(String) })
    expect(await outboxRowsFor('multitable.form.submitted', recId)).toHaveLength(0)
  })

  test('site 1, flag ON: exact-anchor resurrect is fail-closed (INBOUND_UNPROVABLE) — no token, no write, no outbox, no legacy emit', async () => {
    const { u, fixture } = await seedUndelete()
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    process.env[DURABLE_FLAG] = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    await assertUndeleteFailClosed(u, fixture)
    expect(emitsOf(emitSpy, 'multitable.record.created')).toHaveLength(0)
    expect(await outboxRowsFor('multitable.record.created', u)).toHaveLength(0)
  })

  test('site 1, flag OFF (durable): exact-anchor resurrect still fail-closed — no legacy emit and ZERO outbox rows', async () => {
    const { u, fixture } = await seedUndelete()
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    await assertUndeleteFailClosed(u, fixture)
    expect(emitsOf(emitSpy, 'multitable.record.created')).toHaveLength(0)
    expect(await outboxRowsFor('multitable.record.created', u)).toHaveLength(0)
  })

  test('sites 2+3, flag ON: reset → PER-ROW outbox rows (2× record.updated for 2 rows, distinct _eventIds) + 1× record.deleted, full fan-out, suppressed legacy', async () => {
    const { a, b, d, fixture } = await seedReset()
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    process.env[DURABLE_FLAG] = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    await resetExecute(d, fixture)
    const rowsA = await outboxRowsFor('multitable.record.updated', a)
    const rowsB = await outboxRowsFor('multitable.record.updated', b)
    expect(rowsA).toHaveLength(1) // per-row, 1:1 with the legacy per-row emits — N rows ⇒ N events
    expect(rowsB).toHaveLength(1)
    expect(rowsA[0]!.event_id).not.toBe(rowsB[0]!.event_id) // each row carries its OWN event identity
    expect(rowsA[0]!.payload).toEqual({ sheetId: RESET_SHEET, recordId: a, changes: { [FLD_RESET]: 'old' }, actorId: ADMIN, _eventId: rowsA[0]!.event_id })
    expect(rowsB[0]!.payload).toEqual({ sheetId: RESET_SHEET, recordId: b, changes: { [FLD_RESET]: 'old' }, actorId: ADMIN, _eventId: rowsB[0]!.event_id })
    expect(await consumersOf(rowsA[0]!.id)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    expect(await consumersOf(rowsB[0]!.id)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    const rowsD = await outboxRowsFor('multitable.record.deleted', d)
    expect(rowsD).toHaveLength(1)
    expect(rowsD[0]!.payload).toEqual({ sheetId: RESET_SHEET, recordId: d, actorId: ADMIN, _eventId: rowsD[0]!.event_id })
    expect(await consumersOf(rowsD[0]!.id)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    expect(emitsOf(emitSpy, 'multitable.record.updated')).toHaveLength(0)
    expect(emitsOf(emitSpy, 'multitable.record.deleted')).toHaveLength(0)
  })

  test('sites 2+3, flag OFF: reset → per-row legacy emits (2 updated + 1 deleted, byte-identical shapes) + ZERO outbox rows', async () => {
    const { a, b, d, fixture } = await seedReset()
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    const emitSpy = vi.spyOn(eventBus, 'emit')
    await resetExecute(d, fixture)
    const updated = emitsOf(emitSpy, 'multitable.record.updated')
    expect(updated).toHaveLength(2)
    expect(updated.map((p) => p.recordId).sort()).toEqual([a, b].sort())
    for (const p of updated) {
      expect(p).toEqual({ sheetId: RESET_SHEET, recordId: p.recordId, changes: { [FLD_RESET]: 'old' }, actorId: ADMIN, _eventId: expect.any(String) })
    }
    const deleted = emitsOf(emitSpy, 'multitable.record.deleted')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toEqual({ sheetId: RESET_SHEET, recordId: d, actorId: ADMIN, _eventId: expect.any(String) })
    for (const id of [a, b]) expect(await outboxRowsFor('multitable.record.updated', id)).toHaveLength(0)
    expect(await outboxRowsFor('multitable.record.deleted', d)).toHaveLength(0)
  })
})
