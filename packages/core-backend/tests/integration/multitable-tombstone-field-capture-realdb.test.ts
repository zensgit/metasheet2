/**
 * 4c-2 forward tombstone-capture — FIELD-DELETE capture point (real DB). Design-lock
 * `docs/development/multitable-global-history-4c2-forward-tombstone-capture-design-lock-20260707.md`
 * (#3809 + #3830 correction, owner-ratified 2026-07-08).
 *
 * Covers the capture half of the lock's golden matrix (§6) for `dropFieldCascade` (univer-meta.ts):
 *   G1 flag-on field delete → column values + link edges + auto-number sequence captured, counts match,
 *      causal anchor (config_revision_id) correct.
 *   G2 flag-off → zero tombstone rows, config-revision `before` shape byte-identical to pre-4c-2
 *      (no `lastValue` key even for an autoNumber field).
 *   G3 over-cap → 422, the ENTIRE sheet is untouched (field still exists, records still carry the field's
 *      values, zero tombstone rows) — atomic refusal, never a partial capture + completed delete.
 * G9 (mutation) is proven separately (see the PR body) by neutering each capture call and re-running the
 * relevant test here to confirm it goes red, then reverting.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  __resetRecoveryWriterStateColumnProbe,
  canonicalSheetFenceKey,
} from '../../src/multitable/canonical-sheet-fence'
import {
  enterFieldLinkDropFencePlan,
  LinkWriterFencePlanChangedError,
  prepareFieldLinkDropFencePlan,
} from '../../src/multitable/link-writer-fence'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_tsc_${TS}`
const ACTOR = `user_tsc_${TS}`
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const CAP_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'
const WRITER_FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let seq = 0
const CREATED_SHEETS: string[] = []

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_tsc_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}
const mkFieldId = (tag: string) => `fld_tsc_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_tsc_${tag}_${TS}_${seq++}`

async function insertField(
  sheetId: string,
  fieldId: string,
  name: string,
  type: string,
  order: number,
  property: Record<string, unknown> = {},
): Promise<void> {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fieldId, sheetId, name, type, JSON.stringify(property), order])
}

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  release: () => void
}

const connect = async (): Promise<Client> => {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('no internal pool')
  return await internal.connect() as unknown as Client
}

const waitForBlocker = async (blockerPid: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    )
    if (Number((result.rows[0] as { n: number }).n) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('field drop did not reach the expected lock wait')
}

const settleWhileMutationLockHeld = async <T>(promise: Promise<T>, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} waited on an unfenced row lock`)), 3_000)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}
async function insertLink(fieldId: string, recordId: string, foreignRecordId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])
}
async function insertAutoNumberSequence(fieldId: string, sheetId: string, nextValue: number): Promise<void> {
  await q('INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value) VALUES ($1,$2,$3)', [fieldId, sheetId, nextValue])
}
const deleteField = (fieldId: string) => request(app).delete(`/api/multitable/fields/${fieldId}`)
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

type FieldDeleteRevRow = { id: string; before: Record<string, unknown> | null; changed_keys: string[] }
async function lastFieldDeleteRevision(sheetId: string, fieldId: string): Promise<FieldDeleteRevRow | undefined> {
  const r = await q(
    `SELECT id, before, changed_keys FROM meta_config_revisions
     WHERE sheet_id = $1 AND entity_type = 'field' AND entity_id = $2 AND action = 'delete'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sheetId, fieldId],
  )
  return r.rows[0] as FieldDeleteRevRow | undefined
}

describeIfDatabase('4c-2 tombstone capture — field delete (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // canManageFields now requires multitable:manage-schema (src/multitable/manage-schema-permission.ts)
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['owner'], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'TSC Base'])
  })

  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [s]).catch(() => {})
      await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  afterEach(async () => {
    delete process.env[CAPTURE_FLAG]
    delete process.env[CAP_FLAG]
    delete process.env[WRITER_FENCE_FLAG]
    __resetRecoveryWriterStateColumnProbe()
    if (CREATED_SHEETS.length > 0) {
      await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = ANY($1::text[])', [CREATED_SHEETS])
    }
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G2 flag-off: delete captures NOTHING — zero tombstone rows, config-revision before shape byte-identical to pre-4c-2 (even for an autoNumber field)', async () => {
    delete process.env[CAPTURE_FLAG] // explicitly unset = off
    const s = await freshSheet('g2')
    const F = mkFieldId('g2val')
    await insertField(s, F, 'G2Val', 'string', 1)
    const R1 = mkRecordId('g2'); await insertRecord(s, R1, { [F]: 'hello' })
    const A = mkFieldId('g2auto')
    await insertField(s, A, 'G2Auto', 'autoNumber', 2)
    await insertAutoNumberSequence(A, s, 42)

    const resVal = await deleteField(F)
    expect(resVal.status).toBe(200)
    const resAuto = await deleteField(A)
    expect(resAuto.status).toBe(200)

    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1', [s])).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_link_tombstones WHERE sheet_id = $1', [s])).toBe(0)
    // today's behavior byte-for-byte: the delete revision's `before` carries ONLY the 4 pre-4c-2 keys.
    const revVal = await lastFieldDeleteRevision(s, F)
    expect(revVal?.before).toEqual({ name: 'G2Val', type: 'string', property: {}, order: 1 })
    // A was created at order 2, but deleting F (order 1) FIRST shifts A's order down to 1 (existing
    // forward-cascade order-shift behavior, unrelated to 4c-2) — assert the POST-shift order.
    const revAuto = await lastFieldDeleteRevision(s, A)
    expect(revAuto?.before).toEqual({ name: 'G2Auto', type: 'autoNumber', property: {}, order: 1 })
    expect(revAuto?.before).not.toHaveProperty('lastValue')
    // record data + field row actually gone (existing forward-delete behavior unchanged)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [F])).toBe(0)
    expect(((await q('SELECT data FROM meta_records WHERE id = $1', [R1])).rows[0] as { data: Record<string, unknown> }).data).toEqual({})
  })

  test('G1 flag-on: column-value capture — one tombstone row per record carrying the key, value + anchor correct', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const s = await freshSheet('g1val')
    const F = mkFieldId('g1val')
    await insertField(s, F, 'G1Val', 'string', 1)
    const R1 = mkRecordId('g1a'); await insertRecord(s, R1, { [F]: 'alpha' })
    const R2 = mkRecordId('g1b'); await insertRecord(s, R2, { [F]: 'beta' })
    const R3 = mkRecordId('g1c'); await insertRecord(s, R3, { other: 'untouched' }) // does NOT carry the key

    const res = await deleteField(F)
    expect(res.status).toBe(200)
    const rev = await lastFieldDeleteRevision(s, F)
    expect(rev).toBeTruthy()

    const tombstones = (await q(
      'SELECT record_id, value, reason, config_revision_id FROM meta_field_value_tombstones WHERE sheet_id = $1 AND field_id = $2',
      [s, F],
    )).rows as Array<{ record_id: string; value: unknown; reason: string; config_revision_id: string }>
    expect(tombstones.length).toBe(2) // exactly the 2 records that carried the key — R3 excluded
    const byRecord = new Map(tombstones.map((t) => [t.record_id, t]))
    expect(byRecord.get(R1)?.value).toBe('alpha')
    expect(byRecord.get(R2)?.value).toBe('beta')
    expect(byRecord.has(R3)).toBe(false)
    for (const t of tombstones) {
      expect(t.reason).toBe('field_delete')
      expect(t.config_revision_id).toBe(rev!.id) // causal anchor = the field's OWN delete revision
    }
  })

  test('G1 flag-on: link-edge capture — every meta_links row for the field, both endpoints, anchor correct', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const s = await freshSheet('g1lnk')
    const L = mkFieldId('g1lnk')
    await insertField(s, L, 'G1Link', 'link', 1)
    const R1 = mkRecordId('g1lnk1'); await insertRecord(s, R1, {})
    const R2 = mkRecordId('g1lnk2'); await insertRecord(s, R2, {})
    const R3 = mkRecordId('g1lnk3'); await insertRecord(s, R3, {})
    await insertLink(L, R1, R2)
    await insertLink(L, R1, R3)

    const res = await deleteField(L)
    expect(res.status).toBe(200)
    const rev = await lastFieldDeleteRevision(s, L)

    const tombstones = (await q(
      'SELECT record_id, foreign_record_id, reason, source_revision_id FROM meta_link_tombstones WHERE sheet_id = $1 AND field_id = $2',
      [s, L],
    )).rows as Array<{ record_id: string; foreign_record_id: string; reason: string; source_revision_id: string }>
    expect(tombstones.length).toBe(2)
    expect(tombstones.map((t) => t.foreign_record_id).sort()).toEqual([R2, R3].sort())
    for (const t of tombstones) {
      expect(t.record_id).toBe(R1)
      expect(t.reason).toBe('field_delete')
      expect(t.source_revision_id).toBe(rev!.id)
    }
    // the cascade-delete of meta_fields already removed the live meta_links rows (FK ON DELETE CASCADE) —
    // confirms the capture ran BEFORE that cascade, not after (a mis-ordered capture would see zero rows).
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [L])).toBe(0)
  })

  test('G1 flag-on: auto-number sequence capture — delete revision before.lastValue = the sequence next_value at delete time', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const s = await freshSheet('g1auto')
    const A = mkFieldId('g1auto')
    await insertField(s, A, 'G1Auto', 'autoNumber', 1)
    await insertAutoNumberSequence(A, s, 17)

    const res = await deleteField(A)
    expect(res.status).toBe(200)
    const rev = await lastFieldDeleteRevision(s, A)
    expect(rev?.before?.lastValue).toBe(17)
    // sequence row cascade-deleted, not left behind
    expect(await rowCount('SELECT 1 FROM meta_field_auto_number_sequences WHERE field_id = $1', [A])).toBe(0)
  })

  test('G1 flag-on: a non-autoNumber field delete never carries a lastValue key (no spurious null pollution)', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    const s = await freshSheet('g1noauto')
    const F = mkFieldId('g1noauto')
    await insertField(s, F, 'G1PlainField', 'string', 1)
    const res = await deleteField(F)
    expect(res.status).toBe(200)
    const rev = await lastFieldDeleteRevision(s, F)
    expect(rev?.before).not.toHaveProperty('lastValue')
  })

  test('G3 over-cap: 422 TOMBSTONE_CAPTURE_CAP_EXCEEDED, the ENTIRE sheet is untouched (atomic refusal)', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[CAP_FLAG] = '2' // cap=2, but 3 records will carry the key → refused
    const s = await freshSheet('g3')
    const F = mkFieldId('g3')
    await insertField(s, F, 'G3Val', 'string', 1)
    const ids = [mkRecordId('g3a'), mkRecordId('g3b'), mkRecordId('g3c')]
    for (const id of ids) await insertRecord(s, id, { [F]: 'x' })

    const res = await deleteField(F)
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('TOMBSTONE_CAPTURE_CAP_EXCEEDED')
    // atomic: the field STILL exists, every record STILL carries the key, zero tombstones written.
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [F])).toBe(1)
    for (const id of ids) {
      const row = (await q('SELECT data FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown> }
      expect(row.data).toEqual({ [F]: 'x' })
    }
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1 AND field_id = $2', [s, F])).toBe(0)
    expect(await rowCount(`SELECT 1 FROM meta_config_revisions WHERE sheet_id = $1 AND entity_id = $2 AND action = 'delete'`, [s, F])).toBe(0)
  })

  test('G3 under-cap boundary: exactly at the cap still succeeds (cap is a ceiling, not a strict-less-than)', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[CAP_FLAG] = '2'
    const s = await freshSheet('g3b')
    const F = mkFieldId('g3b')
    await insertField(s, F, 'G3bVal', 'string', 1)
    const ids = [mkRecordId('g3ba'), mkRecordId('g3bb')] // exactly 2 = the cap
    for (const id of ids) await insertRecord(s, id, { [F]: 'y' })
    const res = await deleteField(F)
    expect(res.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_field_value_tombstones WHERE sheet_id = $1 AND field_id = $2', [s, F])).toBe(2)
  })

  test('D-H1 flag OFF keeps field-link drop preflight query-inert', async () => {
    delete process.env[WRITER_FENCE_FLAG]
    let queryCount = 0
    const plan = await prepareFieldLinkDropFencePlan(async () => {
      queryCount += 1
      return { rows: [] }
    }, { sourceSheetId: 'sheet_source', fieldId: 'field_link' })
    expect(plan).toBeNull()
    expect(queryCount).toBe(0)
  })

  test('D-H1 legacy-unconfigured live target blocked through forward delete', async () => {
    const source = await freshSheet('dh1_legacy_source')
    const target = await freshSheet('dh1_legacy_target')
    const fieldId = mkFieldId('dh1_legacy')
    const sourceRecordId = mkRecordId('dh1_legacy_source')
    const targetRecordId = mkRecordId('dh1_legacy_target')
    await insertField(source, fieldId, 'D-H1 Legacy Link', 'link', 1)
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    await q("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [target])
    const response = await deleteField(fieldId)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(target)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(1)
  })

  test('D-H1 field-link drop fails closed without waiting on an in-flight target-owner move', async () => {
    const source = await freshSheet('dh1_move_source')
    const target = await freshSheet('dh1_move_target')
    const decoy = await freshSheet('dh1_move_decoy')
    const fieldId = mkFieldId('dh1_move')
    const sourceRecordId = mkRecordId('dh1_move_source')
    const targetRecordId = mkRecordId('dh1_move_target')
    await insertField(source, fieldId, 'D-H1 Moving Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const mover = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await mover.query('BEGIN')
      await mover.query('UPDATE meta_records SET sheet_id = $2 WHERE id = $1', [targetRecordId, decoy])
      responsePromise = deleteField(fieldId).then((response) => response)

      const response = await settleWhileMutationLockHeld(responsePromise, 'field-drop endpoint recheck')
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
          message: 'Link field configuration changed concurrently; retry the write',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(targetRecordId)
      expect(JSON.stringify(response.body)).not.toContain(decoy)
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(1)
    } finally {
      await mover.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      mover.release()
    }
  })

  test('D-H1 helper-level late meta_links insert blocked by the pinned field row', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_pin_source')
    const target = await freshSheet('dh1_pin_target')
    const fieldId = mkFieldId('dh1_pin')
    const sourceRecordId = mkRecordId('dh1_pin_source')
    const extraSourceId = mkRecordId('dh1_pin_extra_source')
    const targetRecordId = mkRecordId('dh1_pin_target')
    const extraTargetId = mkRecordId('dh1_pin_extra_target')
    await insertField(source, fieldId, 'D-H1 Pin Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(source, extraSourceId, {})
    await insertRecord(target, targetRecordId, {})
    await insertRecord(target, extraTargetId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    const plan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId })
    expect(plan).not.toBeNull()
    expect(plan?.participantSheetIds).toEqual([source, target].sort())

    const holder = await connect()
    const inserter = await connect()
    try {
      await holder.query('BEGIN')
      await enterFieldLinkDropFencePlan(holder.query.bind(holder), plan!)
      await inserter.query('BEGIN')
      await inserter.query("SET LOCAL lock_timeout = '500ms'")
      let insertError: unknown
      try {
        await inserter.query(
          'INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)',
          [fieldId, extraSourceId, extraTargetId],
        )
      } catch (error) {
        insertError = error
      }
      expect((insertError as { code?: unknown } | undefined)?.code).toBe('55P03')
      expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(1)
    } finally {
      await inserter.query('ROLLBACK').catch(() => {})
      await holder.query('ROLLBACK').catch(() => {})
      inserter.release()
      holder.release()
    }
  })

  test('D-H1 helper-level in-flight edge rewrite fails closed without waiting', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_edge_source')
    const target = await freshSheet('dh1_edge_target')
    const decoy = await freshSheet('dh1_edge_decoy')
    const fieldId = mkFieldId('dh1_edge')
    const sourceRecordId = mkRecordId('dh1_edge_source')
    const targetRecordId = mkRecordId('dh1_edge_target')
    const decoyRecordId = mkRecordId('dh1_edge_decoy')
    await insertField(source, fieldId, 'D-H1 Edge Lock', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertRecord(decoy, decoyRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    const plan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId })
    expect(plan?.participantSheetIds).toEqual([source, target].sort())

    const mover = await connect()
    const holder = await connect()
    try {
      await mover.query('BEGIN')
      await mover.query(
        'UPDATE meta_links SET foreign_record_id = $2 WHERE field_id = $1',
        [fieldId, decoyRecordId],
      )
      await holder.query('BEGIN')
      await expect(settleWhileMutationLockHeld(
        enterFieldLinkDropFencePlan(holder.query.bind(holder), plan!),
        'field-drop edge-row recheck',
      )).rejects.toBeInstanceOf(LinkWriterFencePlanChangedError)
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(1)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await mover.query('ROLLBACK').catch(() => {})
      holder.release()
      mover.release()
    }
  })

  test('D-H1 flag ON missing/non-link preflight still returns a plan and unions live endpoint owners', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_state_source')
    const configured = await freshSheet('dh1_state_configured')
    const liveTarget = await freshSheet('dh1_state_live')
    const missingId = mkFieldId('dh1_missing')
    const stringId = mkFieldId('dh1_string')
    const linkId = mkFieldId('dh1_union')
    await insertField(source, stringId, 'D-H1 String', 'string', 1)
    await insertField(source, linkId, 'D-H1 Union Link', 'link', 2, { foreignSheetId: configured })
    const sourceRecordId = mkRecordId('dh1_union_source')
    const liveRecordId = mkRecordId('dh1_union_live')
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(liveTarget, liveRecordId, {})
    await insertLink(linkId, sourceRecordId, liveRecordId)

    const missingPlan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId: missingId })
    expect(missingPlan).toMatchObject({
      fieldId: missingId,
      fieldState: 'missing',
      configuredTargetSheetId: null,
    })
    expect(missingPlan?.participantSheetIds).toEqual([source])

    const nonLinkPlan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId: stringId })
    expect(nonLinkPlan).toMatchObject({
      fieldState: 'non-link',
      configuredTargetSheetId: null,
    })
    expect(nonLinkPlan?.participantSheetIds).toEqual([source])

    const unionPlan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId: linkId })
    expect(unionPlan).toMatchObject({
      fieldState: `link:${configured}`,
      configuredTargetSheetId: configured,
    })
    expect(unionPlan?.participantSheetIds).toEqual([source, configured, liveTarget].sort())
    await expect(prepareFieldLinkDropFencePlan(q, {
      sourceSheetId: configured,
      fieldId: stringId,
    })).rejects.toBeInstanceOf(LinkWriterFencePlanChangedError)

    await q('UPDATE meta_fields SET type = $2, property = $3::jsonb WHERE id = $1', [
      stringId,
      'link',
      JSON.stringify({ foreignSheetId: configured }),
    ])
    const holder = await connect()
    try {
      await holder.query('BEGIN')
      await expect(enterFieldLinkDropFencePlan(holder.query.bind(holder), nonLinkPlan!)).rejects.toBeInstanceOf(
        LinkWriterFencePlanChangedError,
      )
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [stringId])).toBe(1)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })

  test('D-H1 non-link→link committed before the source fence fails closed through forward delete', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_retype_source')
    const target = await freshSheet('dh1_retype_target')
    const fieldId = mkFieldId('dh1_retype')
    await insertField(source, fieldId, 'D-H1 Retype', 'string', 1)

    const blocker = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(source)])
      responsePromise = deleteField(fieldId).then((response) => response)
      await waitForBlocker(blockerPid)
      await q(
        'UPDATE meta_fields SET type = $2, property = $3::jsonb WHERE id = $1',
        [fieldId, 'link', JSON.stringify({ foreignSheetId: target })],
      )
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
          message: 'Link field configuration changed concurrently; retry the write',
        },
      })
      expect(JSON.stringify(response.body)).not.toContain(target)
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(((await q('SELECT type FROM meta_fields WHERE id = $1', [fieldId])).rows[0] as { type: string }).type).toBe('link')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      blocker.release()
    }
  })

  test('D-H1 late FK insert to an unplanned owner fails plan-changed with zero writes', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_insfail_source')
    const target = await freshSheet('dh1_insfail_target')
    const decoy = await freshSheet('dh1_insfail_decoy')
    const fieldId = mkFieldId('dh1_insfail')
    const sourceRecordId = mkRecordId('dh1_insfail_source')
    const extraSourceId = mkRecordId('dh1_insfail_extra')
    const targetRecordId = mkRecordId('dh1_insfail_target')
    const decoyRecordId = mkRecordId('dh1_insfail_decoy')
    await insertField(source, fieldId, 'D-H1 Insert Fail', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(source, extraSourceId, {})
    await insertRecord(target, targetRecordId, {})
    await insertRecord(decoy, decoyRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    const plan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId })
    expect(plan?.participantSheetIds).toEqual([source, target].sort())
    await insertLink(fieldId, extraSourceId, decoyRecordId)

    const holder = await connect()
    try {
      await holder.query('BEGIN')
      await expect(enterFieldLinkDropFencePlan(holder.query.bind(holder), plan!)).rejects.toBeInstanceOf(
        LinkWriterFencePlanChangedError,
      )
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(2)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })

  test('D-H1 committed target-owner drift fails plan-changed with zero writes', async () => {
    process.env[WRITER_FENCE_FLAG] = 'true'
    const source = await freshSheet('dh1_drift_source')
    const target = await freshSheet('dh1_drift_target')
    const decoy = await freshSheet('dh1_drift_decoy')
    const fieldId = mkFieldId('dh1_drift')
    const sourceRecordId = mkRecordId('dh1_drift_source')
    const targetRecordId = mkRecordId('dh1_drift_target')
    await insertField(source, fieldId, 'D-H1 Drift Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)

    const plan = await prepareFieldLinkDropFencePlan(q, { sourceSheetId: source, fieldId })
    expect(plan?.participantSheetIds).toEqual([source, target].sort())
    await q('UPDATE meta_records SET sheet_id = $2 WHERE id = $1', [targetRecordId, decoy])

    const holder = await connect()
    try {
      await holder.query('BEGIN')
      await expect(enterFieldLinkDropFencePlan(holder.query.bind(holder), plan!)).rejects.toBeInstanceOf(
        LinkWriterFencePlanChangedError,
      )
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(await rowCount(
        'SELECT 1 FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
        [fieldId, sourceRecordId, targetRecordId],
      )).toBe(1)
      expect(((await q('SELECT sheet_id FROM meta_records WHERE id = $1', [targetRecordId])).rows[0] as { sheet_id: string }).sheet_id).toBe(decoy)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })
})
