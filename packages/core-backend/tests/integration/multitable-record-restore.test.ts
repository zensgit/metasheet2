/**
 * Real-DB integration test for Layer 1 — record-level version restore.
 * Design-lock: docs/development/multitable-record-restore-layer1-design-20260615.md
 *
 * POST /api/multitable/sheets/:sheetId/records/:recordId/restore
 *
 * Covers the locked matrix:
 *  T1  faithful set+unset (Lock A) — incl. removed key absent from the STORED revision snapshot
 *  T2  forward-change — new revision (action=update, source=restore), version bumped
 *  T3  undo a restore — restore to the PRE-restore version returns to it; re-restoring the restore rev is a no-op
 *  T4  layer-3 write-gate (Lock B) — read_only field difference → atomic RESTORE_FORBIDDEN
 *  T5  computed exclusion (Lock D) — differing formula field neither blocks nor is written
 *  T5b system/auto exclusion (Lock D) — differing autoNumber neither blocks nor is overwritten
 *  T6  link exclusion (Lock D) — differing link field not written; meta_links untouched
 *  T6b schema drift — snapshot field absent from current schema → SCHEMA_DRIFT
 *  T7  delete-resolution (Lock C) — delete-only version → RESTORE_UNSUPPORTED; update+delete → uses update; hard-deleted record → 404
 *  T8  null snapshot → SNAPSHOT_UNAVAILABLE
 *  T9  no-op + stale conflict — correct expectedVersion → noop; stale → VERSION_CONFLICT
 *  T10 concurrency — competing bump between read and apply → VERSION_CONFLICT
 *  T11 Yjs reconciliation — restore fires the invalidator for the record (source='restore' is not bridge-origin)
 *  T12 authz floor — non-writer rejected before any field logic
 */
import { randomUUID } from 'crypto'
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { sweepMetaRevisionRetention } from '../../src/multitable/meta-revision-retention'
import { setYjsInvalidatorForRoutes, univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_rstr_${TS}`
const SHEET_ID = `sheet_rstr_${TS}`
const FSHEET_ID = `fsheet_rstr_${TS}`
const FOREIGN_REC = `frec_rstr_${TS}`
const FOREIGN_REC2 = `frec2_rstr_${TS}`
const FLD_A = `fld_rstr_a_${TS}`
const FLD_B = `fld_rstr_b_${TS}`
const FLD_SECRET = `fld_rstr_secret_${TS}`
// #2672: a field USER_RO cannot SEE (layer-3 visible=false, NOT read_only). #2144's history mask redacts
// THIS field's change-timeline from USER_RO — so the per-field-restore oracle is the only recovery channel.
const FLD_HIDDEN = `fld_rstr_hidden_${TS}`
const FLD_FX = `fld_rstr_fx_${TS}`
const FLD_AUN = `fld_rstr_aun_${TS}`
const FLD_LK = `fld_rstr_lk_${TS}`
const FLD_BTN = `fld_rstr_btn_${TS}`
const FLD_SEL = `fld_rstr_sel_${TS}`
const FLD_LK_TW = `fld_rstr_lktw_${TS}` // twoWay link → FSHEET, mirrorFieldId = FLD_MIRROR
const FLD_MIRROR = `fld_rstr_mirror_${TS}` // mirror side on FSHEET
const USER_W = `u_rstr_writer_${TS}`
const USER_RO = `u_rstr_ro_${TS}`

let app: Express
let testUserId = USER_W
let testPerms: string[] = ['multitable:read', 'multitable:write']

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

type RevSeed = {
  version: number
  action?: 'create' | 'update' | 'delete'
  snapshot: Record<string, unknown> | null
  changedFieldIds?: string[]
}

let recordSeq = 0
async function seedRecord(
  currentData: Record<string, unknown>,
  currentVersion: number,
  revisions: RevSeed[],
): Promise<string> {
  const recordId = `rec_rstr_${TS}_${recordSeq++}`
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)', [
    recordId,
    SHEET_ID,
    JSON.stringify(currentData),
    currentVersion,
  ])
  for (const rev of revisions) {
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10::jsonb)`,
      [
        randomUUID(),
        SHEET_ID,
        recordId,
        rev.version,
        rev.action ?? 'update',
        'rest',
        USER_W,
        rev.changedFieldIds ?? Object.keys(rev.snapshot ?? {}),
        JSON.stringify(rev.snapshot ?? {}),
        rev.snapshot === null ? null : JSON.stringify(rev.snapshot),
      ],
    )
  }
  return recordId
}

const restoreReq = (recordId: string, body: Record<string, unknown>) =>
  request(app).post(`/api/multitable/sheets/${SHEET_ID}/records/${recordId}/restore`).send(body)

async function latestRevision(recordId: string) {
  const res = await q(
    `SELECT version, action, source, changed_field_ids, snapshot
     FROM meta_record_revisions WHERE record_id = $1 ORDER BY version DESC, created_at DESC LIMIT 1`,
    [recordId],
  )
  return res.rows[0] as { version: number; action: string; source: string; changed_field_ids: string[]; snapshot: Record<string, unknown> | null }
}
async function liveData(recordId: string): Promise<Record<string, unknown>> {
  const res = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  return (res.rows[0] as { data: Record<string, unknown> }).data
}

describeIfDatabase('Layer 1 record-level version restore (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Restore Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Restore Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FSHEET_ID, BASE_ID, 'Foreign Sheet'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FOREIGN_REC, FSHEET_ID, '{}'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FOREIGN_REC2, FSHEET_ID, '{}'])

    const f = (id: string, name: string, type: string, property: string, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, SHEET_ID, name, type, property, order])
    await f(FLD_A, 'A', 'string', '{}', 1)
    await f(FLD_B, 'B', 'string', '{}', 2)
    await f(FLD_SECRET, 'Secret', 'string', '{}', 3)
    await f(FLD_HIDDEN, 'Hidden', 'string', '{}', 10)
    await f(FLD_FX, 'Formula', 'formula', '{}', 4)
    await f(FLD_AUN, 'AutoNum', 'autoNumber', '{}', 5)
    await f(FLD_LK, 'Link', 'link', JSON.stringify({ foreignSheetId: FSHEET_ID }), 6)
    await f(FLD_BTN, 'Button', 'button', '{}', 7)
    await f(FLD_SEL, 'Select', 'select', JSON.stringify({ options: [{ value: 'x' }, { value: 'y' }] }), 8)
    await f(FLD_LK_TW, 'LinkTwoWay', 'link', JSON.stringify({ foreignSheetId: FSHEET_ID, twoWay: true, mirrorFieldId: FLD_MIRROR }), 9)
    // mirror side lives on the foreign sheet (derived single-edge projection — no materialized row)
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_MIRROR, FSHEET_ID, 'Mirror', 'link', JSON.stringify({ foreignSheetId: SHEET_ID, twoWay: true, mirrorFieldId: FLD_LK_TW, mirrorOf: FLD_LK_TW }), 1])

    // Layer-3: USER_RO is read_only on SECRET (and a separate visible=false would also gate).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_RO, true, true])
    // #2672: USER_RO is visible=false (but NOT read_only) on HIDDEN — i.e. CANNOT SEE it. This is the field
    // #2144's record-history mask redacts from USER_RO, so the per-field-restore response is the only path
    // by which its change-timeline could leak. read_only=false isolates the visible=false predicate branch.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_HIDDEN, 'user', USER_RO, false, false])
  })

  beforeEach(() => {
    testUserId = USER_W
    testPerms = ['multitable:read', 'multitable:write']
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = $1)', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, FSHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('T1: faithful set+unset; removed key absent from the stored after-image snapshot', async () => {
    // current v3 has A,B,SECRET(same as v1); v1 snapshot has only A → set A, unset B; SECRET unchanged.
    const rid = await seedRecord(
      { [FLD_A]: 'a3', [FLD_B]: 'b3', [FLD_SECRET]: 'sec' },
      3,
      [
        { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec' } },
        { version: 3, snapshot: { [FLD_A]: 'a3', [FLD_B]: 'b3', [FLD_SECRET]: 'sec' } },
      ],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data.noop).toBe(false)
    expect(res.body.data.newVersion).toBe(4)
    expect(res.body.data.restoredFieldIds.sort()).toEqual([FLD_A, FLD_B].sort())

    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('a1')
    expect(Object.prototype.hasOwnProperty.call(data, FLD_B)).toBe(false) // B removed from the live row
    expect(data[FLD_SECRET]).toBe('sec') // unchanged (equal in v1 snapshot)

    const rev = await latestRevision(rid)
    expect(rev.version).toBe(4)
    expect(rev.snapshot?.[FLD_A]).toBe('a1')
    // KEYSTONE: the removed key must be absent from the stored after-image, not merely the live row.
    expect(rev.snapshot && Object.prototype.hasOwnProperty.call(rev.snapshot, FLD_B)).toBe(false)
    expect(rev.changed_field_ids.sort()).toEqual([FLD_A, FLD_B].sort())
  })

  test('T2: forward-change — new revision is action=update, source=restore', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    const rev = await latestRevision(rid)
    expect(rev.action).toBe('update')
    expect(rev.source).toBe('restore')
    expect(rev.version).toBe(3)
    // prior versions remain in history
    const all = await q('SELECT DISTINCT version FROM meta_record_revisions WHERE record_id = $1 ORDER BY version', [rid])
    expect((all.rows as Array<{ version: number }>).map((r) => Number(r.version))).toEqual([1, 2, 3])
  })

  test('T3: undo a restore = restore to the pre-restore version; re-restoring the restore rev is a no-op', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    // restore to v1 → v3 (A='a1')
    const r1 = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(r1.status).toBe(200)
    expect((await liveData(rid))[FLD_A]).toBe('a1')
    // undo = restore to v2 (the pre-restore version) → v4 (A='a2')
    const undo = await restoreReq(rid, { targetVersion: 2, expectedVersion: 3 })
    expect(undo.status).toBe(200)
    expect((await liveData(rid))[FLD_A]).toBe('a2')
    // re-restoring the restore revision (v3, A='a1' after-image) from current(A='a2') is NOT a no-op (A differs);
    // but re-restoring to the CURRENT version (v4) is the no-op case.
    const redo = await restoreReq(rid, { targetVersion: 4, expectedVersion: 4 })
    expect(redo.status).toBe(200)
    expect(redo.body.data.noop).toBe(true)
  })

  test('T4: layer-3 read_only field difference → atomic RESTORE_FORBIDDEN, nothing written', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' } }],
    )
    testUserId = USER_RO // read_only on SECRET
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('RESTORE_FORBIDDEN')
    // P3: the error must NOT echo server-derived forbidden field ids (would leak hidden-field metadata).
    expect(JSON.stringify(res.body)).not.toContain(FLD_SECRET)
    // atomic: nothing written, version unchanged
    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('a2')
    expect(data[FLD_SECRET]).toBe('sec_now')
  })

  test('T5: differing formula field neither blocks restore nor is written verbatim', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_FX]: 'fx_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_FX]: 'fx_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_FX]: 'fx_now' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_A)
    expect(res.body.data.restoredFieldIds).not.toContain(FLD_FX)
    // formula value not overwritten with the old snapshot value
    expect((await liveData(rid))[FLD_FX]).not.toBe('fx_old')
  })

  test('T5b: differing autoNumber (system) is excluded — not blocked, not overwritten', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_AUN]: 2 },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_AUN]: 1 } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_AUN]: 2 } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).not.toContain(FLD_AUN)
    expect((await liveData(rid))[FLD_AUN]).toBe(2) // unchanged
  })

  const linksOf = async (recordId: string): Promise<string[]> => {
    const r = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [FLD_LK, recordId])
    return (r.rows as Array<{ foreign_record_id: string }>).map((x) => x.foreign_record_id)
  }

  test('T6 (Slice 2a): link field restored — meta_links cleared when the target version had no link', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: [] } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } }],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_a_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_LK)
    expect(await linksOf(rid)).toEqual([]) // re-synced to version 1 (no link)
  })

  test('T6e (Slice 2a): link field restored — meta_links re-pointed to the target version edges', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: [FOREIGN_REC2] } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } }],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_e_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_LK)
    expect(await linksOf(rid)).toEqual([FOREIGN_REC2]) // edge re-pointed
  })

  test('T6a (Slice 2a): a twoWay-configured link restores cleanly — the edge the mirror derives from is re-synced', async () => {
    const linksOfField = async (fid: string, recordId: string): Promise<string[]> => {
      const r = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [fid, recordId])
      return (r.rows as Array<{ foreign_record_id: string }>).map((x) => x.foreign_record_id)
    }
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK_TW]: [FOREIGN_REC] },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK_TW]: [FOREIGN_REC2] } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK_TW]: [FOREIGN_REC] } }],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_tw_${recordSeq}`, FLD_LK_TW, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_LK_TW)
    // The single edge (which BOTH the forward link and the foreign record's derived mirror resolve from)
    // is re-pointed to the version-1 target; the mirror projection on FOREIGN_REC2 derives from this.
    expect(await linksOfField(FLD_LK_TW, rid)).toEqual([FOREIGN_REC2])
  })

  test('T6f (Slice 2a): link to a now-deleted foreign record → VALIDATION_ERROR (fail-closed), nothing written', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: [`frec_gone_${TS}`] } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } }],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_f_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await linksOf(rid)).toEqual([FOREIGN_REC]) // atomic: unchanged
  })

  test('T6g (Slice 2a): legacy-shaped link snapshot (JSON-array string) is parsed by the canonical normalizer, not mis-read as one id', async () => {
    // The v1 snapshot stores the link as a legacy JSON-array STRING ('["frec2..."]') rather than an
    // array; current stores it as an array. A naive parser would treat the whole string as one foreign
    // id → spurious VALIDATION_ERROR. normalizeLinkIds parses it identically to the write path.
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] },
      2,
      [
        { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: JSON.stringify([FOREIGN_REC2]) } },
        { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } },
      ],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_g_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_LK)
    expect(await linksOf(rid)).toEqual([FOREIGN_REC2]) // legacy string parsed → edge re-pointed
  })

  test('T6b: snapshot field absent from current schema → SCHEMA_DRIFT', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', ghost_field_gone: 'x' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SCHEMA_DRIFT')
  })

  test('T6c: type-change fail-closed — old value invalid under the current field type → VALIDATION_ERROR, nothing written', async () => {
    // FLD_SEL is now a select with options [x,y]; the v1 snapshot holds a value that is no longer a
    // valid option (simulating a field whose type/constraints changed since capture).
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SEL]: 'x' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SEL]: 'no_longer_valid' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SEL]: 'x' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // atomic: nothing written (validation precedes the transaction)
    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('a2')
    expect(data[FLD_SEL]).toBe('x')
  })

  test('T6d: button (no-value trigger) excluded — a legacy button key neither blocks nor is written', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_BTN]: 'legacy_btn_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_BTN]: 'legacy_btn_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_BTN]: 'legacy_btn_now' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toContain(FLD_A)
    expect(res.body.data.restoredFieldIds).not.toContain(FLD_BTN)
    expect((await liveData(rid))[FLD_BTN]).toBe('legacy_btn_now') // untouched
  })

  test('T7: delete-only version → RESTORE_UNSUPPORTED; update+delete → uses update; hard-deleted record → 404', async () => {
    // delete-only at v2
    const ridDel = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, action: 'delete', snapshot: { [FLD_A]: 'a2' } }],
    )
    const delRes = await restoreReq(ridDel, { targetVersion: 2, expectedVersion: 2 })
    expect(delRes.status).toBe(422)
    expect(delRes.body.error.code).toBe('RESTORE_UNSUPPORTED')

    // version with BOTH update and delete → resolves to update
    const ridBoth = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [
        { version: 1, action: 'update', snapshot: { [FLD_A]: 'a1' } },
        { version: 1, action: 'delete', snapshot: { [FLD_A]: 'a1' } },
        { version: 2, snapshot: { [FLD_A]: 'a2' } },
      ],
    )
    const bothRes = await restoreReq(ridBoth, { targetVersion: 1, expectedVersion: 2 })
    expect(bothRes.status).toBe(200) // picked the update revision, not the delete

    // hard-deleted current record → 404 (undelete is Slice 2)
    const res404 = await restoreReq(`rec_rstr_missing_${TS}`, { targetVersion: 1, expectedVersion: 0 })
    expect(res404.status).toBe(404)
  })

  test('T8: null snapshot → SNAPSHOT_UNAVAILABLE', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: null }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('SNAPSHOT_UNAVAILABLE')
  })

  test('T9: empty diff → noop with correct version; stale expectedVersion → VERSION_CONFLICT even for a no-op', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    // restore to the current state = no-op
    const noop = await restoreReq(rid, { targetVersion: 2, expectedVersion: 2 })
    expect(noop.status).toBe(200)
    expect(noop.body.data.noop).toBe(true)
    expect(noop.body.data.newVersion).toBe(2)
    // The no-op touched nothing in the DB: version unchanged AND no new revision row.
    const verRes = await q('SELECT version FROM meta_records WHERE id = $1', [rid])
    expect(Number((verRes.rows[0] as { version: number }).version)).toBe(2)
    const cntRes = await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [rid])
    expect((cntRes.rows[0] as { n: number }).n).toBe(1)
    // stale expectedVersion → conflict (the concurrency check precedes the no-op)
    const stale = await restoreReq(rid, { targetVersion: 2, expectedVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
  })

  // NOTE: this exercises the route's step-2 concurrency PRE-CHECK (expectedVersion ≠ current).
  // The in-transaction anti-TOCTOU re-check (a write landing between the route read and the spine's
  // FOR UPDATE) is inherited unchanged from RecordWriteService.patchRecords and is covered by the
  // record-patch suite; it is not separately simulated here.
  test('T10: stale expectedVersion vs current → VERSION_CONFLICT (pre-check)', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    // Caller believes version is 1, but the record is actually at 2 → conflict.
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 1 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
  })

  test('T11: restore fires the Yjs invalidator for the record (source=restore is not bridge-origin)', async () => {
    const invalidated: string[] = []
    setYjsInvalidatorForRoutes((ids) => { invalidated.push(...ids) })
    try {
      const rid = await seedRecord(
        { [FLD_A]: 'a2' },
        2,
        [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
      )
      const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
      expect(res.status).toBe(200)
      expect(invalidated).toContain(rid)
    } finally {
      setYjsInvalidatorForRoutes(null)
    }
  })

  test('T12: a non-writer is rejected before any field logic', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    testPerms = ['multitable:read'] // read only, no write
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(403)
    expect((await liveData(rid))[FLD_A]).toBe('a2') // untouched
  })

  // ---- Retention (prune + VERSION_EXPIRED) ----
  const seedManyRevisions = async (count: number): Promise<string> => {
    const revs: RevSeed[] = Array.from({ length: count }, (_, i) => ({
      version: i + 1,
      action: i === 0 ? 'create' : 'update',
      snapshot: { [FLD_A]: `v${i + 1}` },
    }))
    return seedRecord({ [FLD_A]: `v${count}` }, count, revs)
  }

  test('T13: keep-last-N sweep prunes old versions (keeps the latest); restore to a pruned version → VERSION_EXPIRED', async () => {
    const rid = await seedManyRevisions(13) // versions 1..13, current = 13
    const deleted = await sweepMetaRevisionRetention(q, { enabled: true, policy: 'keep-last-n', keepN: 10, retentionDays: 365, batchSize: 5000 })
    expect(deleted).toBeGreaterThanOrEqual(3) // versions 1,2,3 pruned (may include other suites' rows; bounded)

    // this record retains exactly the latest 10 (versions 4..13); the latest (13) is always kept
    const rows = await q('SELECT version FROM meta_record_revisions WHERE record_id = $1 ORDER BY version', [rid])
    const versions = (rows.rows as Array<{ version: number }>).map((r) => Number(r.version))
    expect(versions).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])

    // restore to a pruned version → VERSION_EXPIRED (410), distinct from a never-existed VERSION_NOT_FOUND
    const expired = await restoreReq(rid, { targetVersion: 2, expectedVersion: 13 })
    expect(expired.status).toBe(410)
    expect(expired.body.error.code).toBe('VERSION_EXPIRED')

    // a surviving version still restores
    const ok = await restoreReq(rid, { targetVersion: 5, expectedVersion: 13 })
    expect(ok.status).toBe(200)
    expect((await liveData(rid))[FLD_A]).toBe('v5')
  })

  test('T14: retention disabled (default) is a no-op — deletes nothing', async () => {
    const rid = await seedManyRevisions(12)
    const before = await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [rid])
    const deleted = await sweepMetaRevisionRetention(q, { enabled: false, policy: 'keep-last-n', keepN: 10, retentionDays: 365, batchSize: 5000 })
    expect(deleted).toBe(0)
    const after = await q('SELECT count(*)::int AS n FROM meta_record_revisions WHERE record_id = $1', [rid])
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
  })

  // ---- Per-field (column-level) restore ----
  test('T15: fieldIds restores ONLY the selected fields; unselected fields are untouched', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b1' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } }],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_A] })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).toEqual([FLD_A])
    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('a1') // restored
    expect(data[FLD_B]).toBe('b2') // NOT selected → untouched
  })

  test('T16: per-field lets you restore the writable field you picked even when another diff field is forbidden', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' } }],
    )
    testUserId = USER_RO // read_only on SECRET
    // full restore would be RESTORE_FORBIDDEN (SECRET differs + is forbidden)…
    const full = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(full.status).toBe(403)
    // …but selecting only the writable field A succeeds (SECRET not in the gated subset)
    const partial = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_A] })
    expect(partial.status).toBe(200)
    expect(partial.body.data.restoredFieldIds).toEqual([FLD_A])
    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('a1') // restored
    expect(data[FLD_SECRET]).toBe('sec_now') // forbidden field untouched
  })

  test('T17: fieldIds selecting an unchanged WRITABLE field is a no-op (nothing in the gated subset)', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b2' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } }],
    )
    // B is a writable field, unchanged between v1 and current; selecting only B → empty diff → no-op.
    // (B is writable, so it passes the forbidden gate; only its absence from the diff makes this a no-op.)
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_B] })
    expect(res.status).toBe(200)
    expect(res.body.data.noop).toBe(true)
    expect((await liveData(rid))[FLD_A]).toBe('a2') // A unchanged (not selected)
  })

  // ---- #2672 follow-up: per-field restore must NOT be a change-timeline oracle for hidden columns ----
  //
  // The original per-field gate ran the forbidden check over `selectedDiff` (= caller selection ∩
  // fields-that-actually-changed). So selecting a forbidden field F returned 403 when F CHANGED between the
  // target version and current, vs. a 200 no-op when F was UNCHANGED — an exact per-field oracle for "did
  // this confidential column change at version N", defeating the #2144 record-history mask. T18 exercises a
  // visible=false (FLD_HIDDEN) field specifically because that is the column whose change-timeline #2144
  // actually redacts from USER_RO — so the per-field-restore response is the ONLY channel it could leak from
  // (a read_only-but-visible field like FLD_SECRET is already unmasked in the history endpoint).
  // Fix: the gate runs over the caller-SELECTED fieldIds, independent of the diff → constant 403.

  test('T18 (#2672 oracle): selecting a visible=false field returns an IDENTICAL response whether or not it changed', async () => {
    testUserId = USER_RO // visible=false (cannot see) on HIDDEN — #2144 masks its change-timeline in history

    // Record 1 — HIDDEN DIFFERS between v1 (h_old) and current (h_now).
    const ridDiff = await seedRecord(
      { [FLD_A]: 'a2', [FLD_HIDDEN]: 'h_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_HIDDEN]: 'h_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_HIDDEN]: 'h_now' } }],
    )
    // Record 2 — HIDDEN is UNCHANGED between v1 and current (same 'h_same').
    const ridSame = await seedRecord(
      { [FLD_A]: 'a2', [FLD_HIDDEN]: 'h_same' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_HIDDEN]: 'h_same' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_HIDDEN]: 'h_same' } }],
    )

    const resDiff = await restoreReq(ridDiff, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_HIDDEN] })
    const resSame = await restoreReq(ridSame, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_HIDDEN] })

    // KEYSTONE: the two responses must be IDENTICAL — same status AND same body. Under the old gate the
    // CHANGED case was 403 while the UNCHANGED case was a 200 no-op (the timeline oracle). They are now a
    // constant 403, so the response leaks nothing about whether HIDDEN changed at version 1 — restoring the
    // #2144 mask property (which redacts HIDDEN's change-timeline from USER_RO in the history endpoint).
    expect(resDiff.status).toBe(resSame.status)
    expect(resDiff.body).toEqual(resSame.body)

    // …and that constant is a generic 403 that names NO field id (neither in the message nor skippedFieldIds).
    expect(resDiff.status).toBe(403)
    expect(resDiff.body.error.code).toBe('RESTORE_FORBIDDEN')
    expect(JSON.stringify(resDiff.body)).not.toContain(FLD_HIDDEN)
    // No skippedFieldIds channel may re-leak the forbidden id (the 403 body carries no `data`).
    expect(resDiff.body.data?.skippedFieldIds ?? []).not.toContain(FLD_HIDDEN)

    // Atomic in BOTH cases: nothing written, no version bump.
    for (const rid of [ridDiff, ridSame]) {
      const data = await liveData(rid)
      expect(data[FLD_A]).toBe('a2')
      const ver = await q('SELECT version FROM meta_records WHERE id = $1', [rid])
      expect(Number((ver.rows[0] as { version: number }).version)).toBe(2)
    }
  })

  test('T19 (#2672 M2): selecting a field you cannot write is a clean 403, never a silent bypass', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' } }],
    )
    testUserId = USER_RO // read_only on SECRET → FLD_SECRET is forbidden
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_SECRET] })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('RESTORE_FORBIDDEN')
    // M2: selection must not bypass the gate — the forbidden value is never written, and the body must not
    // name the forbidden field anywhere (message or skippedFieldIds).
    expect(JSON.stringify(res.body)).not.toContain(FLD_SECRET)
    const data = await liveData(rid) // atomic: live data unchanged
    expect(data[FLD_A]).toBe('a2')
    expect(data[FLD_SECRET]).toBe('sec_now')
    const ver = await q('SELECT version FROM meta_records WHERE id = $1', [rid])
    expect(Number((ver.rows[0] as { version: number }).version)).toBe(2)
  })

  test('T20 (#2672 regression): a writable per-field restore still works; full-restore atomic-reject unchanged', async () => {
    // (i) a normal per-field restore of a WRITABLE field still applies (the fix only changes the gate SET).
    const ridW = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b1' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } }],
    )
    const okRes = await restoreReq(ridW, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_A] })
    expect(okRes.status).toBe(200)
    expect(okRes.body.data.restoredFieldIds).toEqual([FLD_A])
    const wData = await liveData(ridW)
    expect(wData[FLD_A]).toBe('a1') // restored
    expect(wData[FLD_B]).toBe('b2') // not selected → untouched

    // (ii) FULL restore (no fieldIds) keeps its atomic-reject: a CHANGED forbidden field still 403s, and an
    // UNCHANGED forbidden field still does NOT block (constraint (1) — full mode behavior is unchanged).
    testUserId = USER_RO // read_only on SECRET
    const ridFullForbidden = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec_old' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_now' } }],
    )
    const fullForbidden = await restoreReq(ridFullForbidden, { targetVersion: 1, expectedVersion: 2 })
    expect(fullForbidden.status).toBe(403) // SECRET changed + forbidden → atomic reject
    expect((await liveData(ridFullForbidden))[FLD_A]).toBe('a2') // nothing written

    const ridFullOk = await seedRecord(
      { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_same' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_SECRET]: 'sec_same' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_SECRET]: 'sec_same' } }],
    )
    const fullOk = await restoreReq(ridFullOk, { targetVersion: 1, expectedVersion: 2 })
    expect(fullOk.status).toBe(200) // SECRET unchanged → only writable A in the diff → restored
    expect((await liveData(ridFullOk))[FLD_A]).toBe('a1')
  })
})
