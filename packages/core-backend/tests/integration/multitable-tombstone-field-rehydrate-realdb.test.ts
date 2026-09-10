/**
 * 4c-2 forward tombstone-capture — R1 rehydration on field UNDELETE (real DB). Design-lock
 * `docs/development/multitable-global-history-4c2-forward-tombstone-capture-design-lock-20260707.md`
 * (#3809 + #3830 correction, owner-ratified 2026-07-08), §4 R1.
 *
 * `recreateFieldFromConfig` (univer-meta.ts, reached via POST /sheets/:id/config-restore-execute,
 * confirm='undelete', behind MULTITABLE_ENABLE_CONFIG_UNDELETE) recreates a deleted field's DEFINITION
 * (name/type/property/order — unaffected by 4c-2). When a tombstone set exists for that specific delete
 * revision, it ALSO rehydrates:
 *   G4 values (only into records that don't already carry the key — never clobber a value written since),
 *      link edges (only between two currently-alive records), the auto-number sequence's next_value, and
 *      the EXISTING field_permissions masking still applies to the rehydrated value unchanged (C4 — no
 *      new read path, no new masking code; this proves the old one wasn't bypassed).
 *   G5 with NO tombstone (data destroyed before the capture flag ever existed) the recreate stays
 *      DEFINITION-ONLY — unchanged from the pre-4c-2 contract, and the restore-preview's note keeps its
 *      original "gone and are NOT restored" wording (no dishonest/leftover tombstoneAvailable claim).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  __resetRecoveryWriterStateColumnProbe,
} from '../../src/multitable/canonical-sheet-fence'
import { prepareFieldLinkRestoreFencePlan } from '../../src/multitable/link-writer-fence'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_tsr_${TS}`
const UNDELETE_FLAG = 'MULTITABLE_ENABLE_CONFIG_UNDELETE'
const CAPTURE_FLAG = 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'
const WRITER_FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'

type Actor = { id: string; roles: string[]; perms: string[] }
// canManageFields now requires multitable:manage-schema (src/multitable/manage-schema-permission.ts)
const MANAGER: Actor = { id: `u_tsr_mgr_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] }
const VIEWER: Actor = { id: `u_tsr_viewer_${TS}`, roles: ['member'], perms: ['multitable:read'] } // masked subject

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: Actor = MANAGER
let seq = 0
const CREATED_SHEETS: string[] = []

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
  release: () => void
}

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_tsr_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}
const mkFieldId = (tag: string) => `fld_tsr_${tag}_${TS}_${seq++}`
const mkRecordId = (tag: string) => `rec_tsr_${tag}_${TS}_${seq++}`

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
async function insertRecord(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
}
async function insertLink(fieldId: string, recordId: string, foreignRecordId: string): Promise<void> {
  await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [fieldId, recordId, foreignRecordId])
}
async function insertAutoNumberSequence(fieldId: string, sheetId: string, nextValue: number): Promise<void> {
  await q('INSERT INTO meta_field_auto_number_sequences (field_id, sheet_id, next_value) VALUES ($1,$2,$3)', [fieldId, sheetId, nextValue])
}
async function denyFieldForUser(sheetId: string, fieldId: string, userId: string): Promise<void> {
  await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,\'user\',$3,false,false)', [sheetId, fieldId, userId])
}
const deleteField = (fieldId: string) => request(app).delete(`/api/multitable/fields/${fieldId}`)
const preview = (sheetId: string, revisionId: string, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-preview`).send({ revisionId }) }
const execute = (sheetId: string, body: Record<string, unknown>, as: Actor = MANAGER) => { actor = as; return request(app).post(`/api/multitable/sheets/${sheetId}/config-restore-execute`).send(body) }
const getRecord = (recordId: string, as: Actor = MANAGER) => { actor = as; return request(app).get(`/api/multitable/records/${recordId}`) }
const rowCount = async (sql: string, params: unknown[]): Promise<number> => (await q(sql, params)).rows.length

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
  throw new Error('field undelete did not reach the expected lock wait')
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

async function lastFieldDeleteRevisionId(sheetId: string, fieldId: string): Promise<string> {
  const r = await q(
    `SELECT id FROM meta_config_revisions WHERE sheet_id = $1 AND entity_type = 'field' AND entity_id = $2 AND action = 'delete'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sheetId, fieldId],
  )
  return (r.rows[0] as { id: string }).id
}
/** Seed a bare `delete` revision directly (no live capture) — simulates data destroyed BEFORE the capture
 * flag ever existed: a delete revision exists, but zero tombstone rows back it. */
async function insertBareFieldDeleteRev(sheetId: string, fieldId: string, before: { name: string; type: string; property: unknown; order: number }): Promise<string> {
  const r = await q(
    `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, batch_id, actor_id, source)
     VALUES ($1,'field',$2,'delete',$3::jsonb,NULL,$4::text[],gen_random_uuid(),$5,'mutation') RETURNING id`,
    [sheetId, fieldId, JSON.stringify(before), ['name', 'type', 'property', 'order'], MANAGER.id],
  )
  return (r.rows[0] as { id: string }).id
}

describeIfDatabase('4c-2 R1 rehydration — field undelete (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: Actor }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'TSR Base'])
  })

  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_link_tombstones WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [s]).catch(() => {})
      await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  afterEach(async () => {
    delete process.env[UNDELETE_FLAG]
    delete process.env[CAPTURE_FLAG]
    delete process.env[WRITER_FENCE_FLAG]
    __resetRecoveryWriterStateColumnProbe()
    if (CREATED_SHEETS.length > 0) {
      await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = ANY($1::text[])', [CREATED_SHEETS])
    }
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('G4 happy rehydration: values + links (alive endpoints only) + auto-number sequence all restored, masking parity holds, new-value not clobbered', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const s = await freshSheet('g4')

    // ---- value field, masked for VIEWER ----
    const F = mkFieldId('g4val')
    await insertField(s, F, 'G4Val', 'string', 1)
    const R_KEEP = mkRecordId('g4keep'); await insertRecord(s, R_KEEP, { [F]: 'original' })
    const R_NEWVAL = mkRecordId('g4newval'); await insertRecord(s, R_NEWVAL, {}) // will get a NEW value post-delete
    await denyFieldForUser(s, F, VIEWER.id) // masking grant set BEFORE delete — field_permissions has no FK to
    // meta_fields, so it survives the delete/recreate cycle untouched (proven implicitly by this golden).

    // ---- link field ----
    const L = mkFieldId('g4lnk')
    await insertField(s, L, 'G4Link', 'link', 2)
    const R_SRC = mkRecordId('g4src'); await insertRecord(s, R_SRC, {})
    const R_ALIVE = mkRecordId('g4alive'); await insertRecord(s, R_ALIVE, {})
    const R_DIES = mkRecordId('g4dies'); await insertRecord(s, R_DIES, {}) // will be hard-deleted before undelete
    await insertLink(L, R_SRC, R_ALIVE)
    await insertLink(L, R_SRC, R_DIES)

    // ---- auto-number field ----
    const A = mkFieldId('g4auto')
    await insertField(s, A, 'G4Auto', 'autoNumber', 3)
    await insertAutoNumberSequence(A, s, 99)

    // Delete all three (flag ON — captures fire).
    expect((await deleteField(F)).status).toBe(200)
    expect((await deleteField(L)).status).toBe(200)
    expect((await deleteField(A)).status).toBe(200)
    const revF = await lastFieldDeleteRevisionId(s, F)
    const revL = await lastFieldDeleteRevisionId(s, L)
    const revA = await lastFieldDeleteRevisionId(s, A)

    // Between delete and undelete: a NEW value is written directly (simulating any path that could write
    // to the key while the field id is free) — R1's guard must NOT clobber it with the tombstoned value.
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [R_NEWVAL, JSON.stringify({ [F]: 'written-after-delete' })])
    // R_DIES is hard-deleted before the undelete — its tombstoned edge must NOT be replayed (dead endpoint).
    await q('DELETE FROM meta_records WHERE id = $1', [R_DIES])

    // Preview must be HONEST: a tombstone exists for revF → says so (boolean only, no counts).
    const pF = await preview(s, revF); expect(pF.status).toBe(200)
    expect(pF.body?.data?.undelete?.tombstoneAvailable).toBe(true)
    expect(String(pF.body?.data?.undelete?.note)).toMatch(/restored/i)

    // Undelete all three.
    const okF = await execute(s, { revisionId: revF, previewToken: pF.body.data.previewToken, confirm: 'undelete' })
    expect(okF.status).toBe(200)
    const pL = await preview(s, revL); const okL = await execute(s, { revisionId: revL, previewToken: pL.body.data.previewToken, confirm: 'undelete' })
    expect(okL.status).toBe(200)
    const pA = await preview(s, revA); const okA = await execute(s, { revisionId: revA, previewToken: pA.body.data.previewToken, confirm: 'undelete' })
    expect(okA.status).toBe(200)

    // Value rehydrated for the untouched record...
    const keepData = ((await q('SELECT data FROM meta_records WHERE id = $1', [R_KEEP])).rows[0] as { data: Record<string, unknown> }).data
    expect(keepData[F]).toBe('original')
    // ...but the record with a NEW value since delete keeps ITS value, not the tombstoned one.
    const newValData = ((await q('SELECT data FROM meta_records WHERE id = $1', [R_NEWVAL])).rows[0] as { data: Record<string, unknown> }).data
    expect(newValData[F]).toBe('written-after-delete')

    // Link restored for the alive endpoint, NOT for the dead one.
    const links = (await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1', [L])).rows as Array<{ foreign_record_id: string }>
    expect(links.map((r) => r.foreign_record_id)).toEqual([R_ALIVE])

    // Auto-number sequence restored.
    const seqRow = (await q('SELECT next_value FROM meta_field_auto_number_sequences WHERE field_id = $1', [A])).rows[0] as { next_value: number } | undefined
    expect(Number(seqRow?.next_value)).toBe(99)

    // Masking parity (C4): the EXISTING field_permissions grant (set before delete, survived across the
    // recreate) still hides the rehydrated value for VIEWER, while an unmasked reader sees it plainly.
    // The value is masked STRICTLY per this specific field — R_KEEP's OTHER data is unaffected (surgical).
    const asViewer = await getRecord(R_KEEP, VIEWER)
    expect(asViewer.status).toBe(200)
    expect(asViewer.body?.data?.record?.data?.[F]).toBeUndefined()
    const asManager = await getRecord(R_KEEP, MANAGER)
    expect(asManager.status).toBe(200)
    expect(asManager.body?.data?.record?.data?.[F]).toBe('original')
  })

  test('G5 no-tombstone: undelete stays DEFINITION-ONLY (pre-4c-2 contract unchanged), preview keeps the honest "not restored" note', async () => {
    process.env[UNDELETE_FLAG] = 'true'
    // capture flag deliberately left OFF/unset for the delete below — but even if it *were* on, a bare
    // hand-seeded revision (no capture ever ran) has no tombstone rows either way; this pins the case of
    // "a delete revision exists (e.g. predates the capture flag) but no tombstone backs it".
    const s = await freshSheet('g5')
    const F = mkFieldId('g5')
    const rev = await insertBareFieldDeleteRev(s, F, { name: 'G5Field', type: 'string', property: {}, order: 1 })
    const R = mkRecordId('g5'); await insertRecord(s, R, { keep: 'unrelated' }) // no record carries F's key at all

    const p = await preview(s, rev)
    expect(p.status).toBe(200)
    expect(p.body?.data?.undelete?.tombstoneAvailable).toBeUndefined() // omitted-when-false (shape-preserving)
    expect(String(p.body?.data?.undelete?.note)).toMatch(/gone and are NOT restored/)

    const ok = await execute(s, { revisionId: rev, previewToken: p.body.data.previewToken, confirm: 'undelete' })
    expect(ok.status).toBe(200)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [F])).toBe(1) // definition recreated
    expect(await rowCount('SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data ? $2', [s, F])).toBe(0) // no values
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [F])).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_field_auto_number_sequences WHERE field_id = $1', [F])).toBe(0)
  })

  test('D-H1 flag OFF keeps field-link restore preflight query-inert', async () => {
    delete process.env[WRITER_FENCE_FLAG]
    let queryCount = 0
    const plan = await prepareFieldLinkRestoreFencePlan(async () => {
      queryCount += 1
      return { rows: [] }
    }, {
      sourceSheetId: 'sheet_source',
      fieldId: 'field_link',
      before: { type: 'link', property: { foreignSheetId: 'sheet_target' } },
      deleteRevisionId: 'revision_delete',
    })
    expect(plan).toBeNull()
    expect(queryCount).toBe(0)
  })

  test('D-H1 field-link undelete fences the configured target and restores its live edge', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const source = await freshSheet('dh1_positive_source')
    const target = await freshSheet('dh1_positive_target')
    const fieldId = mkFieldId('dh1_positive')
    const sourceRecordId = mkRecordId('dh1_positive_source')
    const targetRecordId = mkRecordId('dh1_positive_target')
    await insertField(source, fieldId, 'D-H1 Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const p = await preview(source, revisionId)
    const response = await execute(source, {
      revisionId,
      previewToken: p.body.data.previewToken,
      confirm: 'undelete',
    })

    expect(response.status).toBe(200)
    expect(await rowCount(
      'SELECT 1 FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
      [fieldId, sourceRecordId, targetRecordId],
    )).toBe(1)
  })

  test('D-H1 field-link undelete preserves legacy unconfigured edges by fencing their live target owners', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const source = await freshSheet('dh1_legacy_source')
    const target = await freshSheet('dh1_legacy_target')
    const fieldId = mkFieldId('dh1_legacy')
    const sourceRecordId = mkRecordId('dh1_legacy_source')
    const targetRecordId = mkRecordId('dh1_legacy_target')
    await insertField(source, fieldId, 'D-H1 Legacy Link', 'link', 1)
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const p = await preview(source, revisionId)
    const response = await execute(source, {
      revisionId,
      previewToken: p.body.data.previewToken,
      confirm: 'undelete',
    })

    expect(response.status).toBe(200)
    expect(await rowCount(
      'SELECT 1 FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
      [fieldId, sourceRecordId, targetRecordId],
    )).toBe(1)
  })

  test('D-H1 field-link undelete returns the existing values-free 409 when its target sheet is blocked', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const source = await freshSheet('dh1_block_source')
    const target = await freshSheet('dh1_block_target')
    const fieldId = mkFieldId('dh1_block')
    const sourceRecordId = mkRecordId('dh1_block_source')
    const targetRecordId = mkRecordId('dh1_block_target')
    await insertField(source, fieldId, 'D-H1 Blocked Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)
    const p = await preview(source, revisionId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    await q("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [target])
    const response = await execute(source, {
      revisionId,
      previewToken: p.body.data.previewToken,
      confirm: 'undelete',
    })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(target)
    expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(0)
    expect(await rowCount('SELECT 1 FROM meta_links WHERE field_id = $1', [fieldId])).toBe(0)
  })

  test('D-H1 field-link undelete fails closed without waiting on an in-flight target-owner move', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
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
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)
    const p = await preview(source, revisionId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const mover = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await mover.query('BEGIN')
      await mover.query('UPDATE meta_records SET sheet_id = $2 WHERE id = $1', [targetRecordId, decoy])
      responsePromise = execute(source, {
        revisionId,
        previewToken: p.body.data.previewToken,
        confirm: 'undelete',
      }).then((response) => response)

      const response = await settleWhileMutationLockHeld(responsePromise, 'field-link endpoint recheck')
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
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(0)
    } finally {
      await mover.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      mover.release()
    }
  })

  test('D-H1 field-link undelete never replays a target resurrected on an unfenced sheet after plan entry', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const source = await freshSheet('dh1_late_source')
    const target = await freshSheet('dh1_late_target')
    const decoy = await freshSheet('dh1_late_decoy')
    const fieldId = mkFieldId('dh1_late')
    const sourceRecordId = mkRecordId('dh1_late_source')
    const targetRecordId = mkRecordId('dh1_late_target')
    await insertField(source, fieldId, 'D-H1 Late Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)
    await q('DELETE FROM meta_records WHERE id = $1', [targetRecordId])
    const p = await preview(source, revisionId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const blocker = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('LOCK TABLE meta_fields IN SHARE MODE')
      responsePromise = execute(source, {
        revisionId,
        previewToken: p.body.data.previewToken,
        confirm: 'undelete',
      }).then((response) => response)
      await waitForBlocker(blockerPid)
      await insertRecord(decoy, targetRecordId, {})
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(await rowCount('SELECT 1 FROM meta_fields WHERE id = $1', [fieldId])).toBe(1)
      expect(await rowCount(
        'SELECT 1 FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
        [fieldId, sourceRecordId, targetRecordId],
      )).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      blocker.release()
    }
  })

  test('D-H1 field-link undelete pins its capture against a concurrent retention delete', async () => {
    process.env[CAPTURE_FLAG] = 'true'
    process.env[UNDELETE_FLAG] = 'true'
    const source = await freshSheet('dh1_prune_source')
    const target = await freshSheet('dh1_prune_target')
    const fieldId = mkFieldId('dh1_prune')
    const sourceRecordId = mkRecordId('dh1_prune_source')
    const targetRecordId = mkRecordId('dh1_prune_target')
    await insertField(source, fieldId, 'D-H1 Prune Link', 'link', 1, { foreignSheetId: target })
    await insertRecord(source, sourceRecordId, {})
    await insertRecord(target, targetRecordId, {})
    await insertLink(fieldId, sourceRecordId, targetRecordId)
    expect((await deleteField(fieldId)).status).toBe(200)
    const revisionId = await lastFieldDeleteRevisionId(source, fieldId)
    const p = await preview(source, revisionId)

    process.env[WRITER_FENCE_FLAG] = 'true'
    const blocker = await connect()
    const retention = await connect()
    let responsePromise: Promise<request.Response> | undefined
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('LOCK TABLE meta_fields IN SHARE MODE')
      responsePromise = execute(source, {
        revisionId,
        previewToken: p.body.data.previewToken,
        confirm: 'undelete',
      }).then((response) => response)
      await waitForBlocker(blockerPid)

      await retention.query('BEGIN')
      await retention.query("SELECT set_config('metasheet.mrho_retention', 'on', true)")
      await retention.query("SET LOCAL lock_timeout = '500ms'")
      let pruneError: unknown
      try {
        await retention.query(
          "DELETE FROM meta_link_tombstones WHERE source_revision_id = $1 AND field_id = $2 AND reason = 'field_delete'",
          [revisionId, fieldId],
        )
      } catch (error) {
        pruneError = error
      }
      expect((pruneError as { code?: unknown } | undefined)?.code).toBe('55P03')
      await retention.query('ROLLBACK')
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(200)
      expect(await rowCount(
        'SELECT 1 FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = $3',
        [fieldId, sourceRecordId, targetRecordId],
      )).toBe(1)
    } finally {
      await retention.query('ROLLBACK').catch(() => {})
      await blocker.query('ROLLBACK').catch(() => {})
      await responsePromise?.catch(() => {})
      retention.release()
      blocker.release()
    }
  })
})
