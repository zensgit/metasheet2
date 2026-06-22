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
    `SELECT version, action, source, changed_field_ids, patch, snapshot
     FROM meta_record_revisions WHERE record_id = $1 ORDER BY version DESC, created_at DESC LIMIT 1`,
    [recordId],
  )
  return res.rows[0] as { version: number; action: string; source: string; changed_field_ids: string[]; patch: Record<string, unknown> | null; snapshot: Record<string, unknown> | null }
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
    // USER_RO cannot SEE FLD_B (visible=false) — used by the per-field response-code-leak test.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_B, 'user', USER_RO, false, false])
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

  test('T17: fieldIds selecting an unchanged/unknown field is a no-op (nothing in the gated subset)', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b2' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } }],
    )
    // B is unchanged between v1 and current; selecting only B → empty diff → no-op
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_B] })
    expect(res.status).toBe(200)
    expect(res.body.data.noop).toBe(true)
    expect((await liveData(rid))[FLD_A]).toBe('a2') // A unchanged (not selected)
  })

  // ---- Adversarial-review fixes ----
  test('T18 (review fix): per-field restore of an available field is NOT blocked by a non-requested drifted field; full restore still SCHEMA_DRIFTs', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', ghost_gone_field: 'x' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    // full restore → still rejects (the ghost field can't be reproduced). No mutation.
    const full = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(full.status).toBe(422)
    expect(full.body.error.code).toBe('SCHEMA_DRIFT')
    // probe closed (run BEFORE the mutating restore — these are no-ops at version 2): requesting the
    // DELETED field that IS in the snapshot must give the SAME 200 no-op as a never-existed field — no
    // 422-vs-200 split that would reveal it existed here.
    const probeDeleted = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: ['ghost_gone_field'] })
    expect(probeDeleted.status).toBe(200)
    expect(probeDeleted.body.data.noop).toBe(true)
    const probeNever = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [`never_${TS}`] })
    expect(probeNever.status).toBe(200)
    expect(probeNever.body.data.noop).toBe(true)
    // per-field [A] → succeeds; the non-requested ghost field is not checked (mutates to version 3)
    const partial = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_A] })
    expect(partial.status).toBe(200)
    expect((await liveData(rid))[FLD_A]).toBe('a1')
  })

  test('T19 (review fix): requesting an invisible field gives the SAME 200 no-op as requesting an unknown field (no 403 existence/change leak)', async () => {
    // current B='b2' differs from v1 B='b1'; USER_RO cannot SEE FLD_B (visible=false).
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b1' } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } }],
    )
    testUserId = USER_RO
    // probe the invisible-but-CHANGED field → must be a 200 no-op, not 403 (leak closed)
    const hidden = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_B] })
    expect(hidden.status).toBe(200)
    expect(hidden.body.data.noop).toBe(true)
    // an unknown field → also 200 no-op → indistinguishable from the hidden-field probe
    const unknown = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [`ghost_${TS}`] })
    expect(unknown.status).toBe(200)
    expect(unknown.body.data.noop).toBe(true)
    // a visible+writable field still restores normally for the same actor
    const visible = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_A] })
    expect(visible.status).toBe(200)
    expect(visible.body.data.restoredFieldIds).toEqual([FLD_A])
  })

  test('T21 (review hardening): deleted-in-snapshot, never-existed, and hidden-changed per-field probes return a BYTE-IDENTICAL 200 no-op body (full A≡B≡C lock)', async () => {
    // One fixture, one actor (USER_RO). Under this actor the three per-field probes are:
    //   A = ghost_gone_field : present in the v1 snapshot, DELETED from the schema since
    //   B = never_<ts>       : NEVER existed
    //   C = FLD_B            : exists, CHANGED v1→current, but INVISIBLE to USER_RO (visible=false)
    // All three must be indistinguishable: identical status AND identical response body. Locking the
    // FULL body (not just status+noop, as T18/T19 do) closes the regression where a dropped/unknown/
    // hidden requested id is echoed back in restoredFieldIds or skippedFieldIds — which would reopen the
    // field-existence probe without tripping the status/noop assertions.
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_B]: 'b2' },
      2,
      [
        { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_B]: 'b1', ghost_gone_field: 'x' } },
        { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_B]: 'b2' } },
      ],
    )
    testUserId = USER_RO
    const a = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: ['ghost_gone_field'] }) // deleted-in-snapshot
    const b = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [`never_${TS}`] })       // never-existed
    const c = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2, fieldIds: [FLD_B] })               // hidden + changed
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(c.status).toBe(200)
    // FULL body equality across all three — the probe-closing invariant
    expect(a.body.data).toEqual(b.body.data)
    expect(b.body.data).toEqual(c.body.data)
    // and the exact no-op shape: nothing restored, nothing echoed back, version unmoved
    expect(a.body.data.noop).toBe(true)
    expect(a.body.data.restoredFieldIds).toEqual([])
    expect(a.body.data.skippedFieldIds).toEqual([])
    // none of the probes mutated the record (still at version 2, original values intact)
    const live = await liveData(rid)
    expect(live[FLD_A]).toBe('a2')
    expect(live[FLD_B]).toBe('b2')
  })

  test('T20 (review fix): a pure link reorder is a no-op (no spurious version bump) — meta_links is an unordered set', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC, FOREIGN_REC2] },
      2,
      [
        { version: 1, action: 'create', snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC2, FOREIGN_REC] } }, // same set, reordered
        { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC, FOREIGN_REC2] } },
      ],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_r1_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_r2_${recordSeq}`, FLD_LK, rid, FOREIGN_REC2])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.noop).toBe(true) // reorder-only → no diff → no version bump
    const ver = await q('SELECT version FROM meta_records WHERE id = $1', [rid])
    expect(Number((ver.rows[0] as { version: number }).version)).toBe(2) // unchanged
  })

  // ===========================================================================================
  // Retrospective coverage M1–M4 (lands on top of merged #2677). These cover FULL-restore /
  // retention paths that #2677's per-field additions (T18–T21: hidden/unknown/deleted selection,
  // link reorder) do not touch, so they are consistent with #2677's canonical semantics.
  // ===========================================================================================

  // M1 — pure-unset isolation. Distinct from T1 (which has a set AND an unset in the same diff):
  // here A is byte-identical between v1 and current, and B was ADDED after v1. So the full restore
  // to v1 produces a diff of EXACTLY ONE unset (B), nothing else. This pins the `applied += 1`
  // unset accounting (record-write-service.ts:667) and the revision serialization that marks a
  // removed key with the explicit `null` sentinel in `patch` (record-write-service.ts:784-788),
  // while `changed_field_ids` carries only the removed id.
  test('T22 (M1): unset-only restore — A unchanged, B added-after-v1 → diff is purely unset B; patch[B]===null, changed=[B]', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'shared', [FLD_B]: 'extra' }, // current v2
      2,
      [
        { version: 1, action: 'create', snapshot: { [FLD_A]: 'shared' } }, // A identical; B absent (added after v1)
        { version: 2, snapshot: { [FLD_A]: 'shared', [FLD_B]: 'extra' } },
      ],
    )
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.noop).toBe(false)
    expect(res.body.data.newVersion).toBe(3) // version bumped
    // ONLY B is restored (unset); A is unchanged so it is NOT in the diff.
    expect(res.body.data.restoredFieldIds).toEqual([FLD_B])

    // live row drops B; A retained.
    const data = await liveData(rid)
    expect(data[FLD_A]).toBe('shared')
    expect(Object.prototype.hasOwnProperty.call(data, FLD_B)).toBe(false)

    // a NEW source='restore' revision: changed_field_ids = [B], patch[B] = null sentinel, B absent from after-image.
    const rev = await latestRevision(rid)
    expect(rev.version).toBe(3)
    expect(rev.source).toBe('restore')
    expect(rev.action).toBe('update')
    expect(rev.changed_field_ids).toEqual([FLD_B]) // ONLY the removed id — proves A is not in the diff
    expect(rev.patch).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(rev.patch ?? {}, FLD_B)).toBe(true)
    expect((rev.patch ?? {})[FLD_B]).toBeNull() // explicit null sentinel for the removal
    // A must NOT appear in the patch (it was identical → never applied).
    expect(Object.prototype.hasOwnProperty.call(rev.patch ?? {}, FLD_A)).toBe(false)
    expect(rev.snapshot && Object.prototype.hasOwnProperty.call(rev.snapshot, FLD_B)).toBe(false) // B dropped from after-image
    expect(rev.snapshot?.[FLD_A]).toBe('shared')
  })

  // M2 — keep-days retention DELETE branch (meta-revision-retention.ts:96-113). T13/T14 only cover
  // keep-last-n and the disabled no-op; the keep-days age-window branch is otherwise unexercised.
  // Two records prove BOTH guards independently:
  //   recAged : ALL its revisions (incl. the latest) are older than the window → proves the rn=1
  //             INVARIANT (NOT recency) is what retains the latest. This is the non-vacuous case.
  //   recMixed: a mix of aged + recent non-latest rows + a recent latest → proves only aged
  //             NON-latest rows are deleted.
  test('T23 (M2): keep-days deletes only aged non-latest revisions; the latest is ALWAYS retained even when it too is aged', async () => {
    const ageDays = async (recordId: string, version: number, days: number) =>
      q(`UPDATE meta_record_revisions SET created_at = now() - ($1::int * interval '1 day') WHERE record_id = $2 AND version = $3`, [days, recordId, version])

    // recAged: versions 1..3, the LATEST (v3) is also aged (60d > 30d window). Only rn=1 protects it.
    const recAged = await seedRecord({ [FLD_A]: 'a3' }, 3, [
      { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } },
      { version: 2, snapshot: { [FLD_A]: 'a2' } },
      { version: 3, snapshot: { [FLD_A]: 'a3' } },
    ])
    await ageDays(recAged, 1, 90)
    await ageDays(recAged, 2, 60)
    await ageDays(recAged, 3, 50) // latest is ALSO older than 30d — recency would NOT keep it; rn=1 must.

    // recMixed: v1 aged (90d), v2 aged (45d), v3 recent latest (0d).
    const recMixed = await seedRecord({ [FLD_A]: 'm3' }, 3, [
      { version: 1, action: 'create', snapshot: { [FLD_A]: 'm1' } },
      { version: 2, snapshot: { [FLD_A]: 'm2' } },
      { version: 3, snapshot: { [FLD_A]: 'm3' } },
    ])
    await ageDays(recMixed, 1, 90)
    await ageDays(recMixed, 2, 45)
    // v3 stays recent (created_at = now()).

    const versionsOf = async (recordId: string): Promise<number[]> => {
      const r = await q('SELECT version FROM meta_record_revisions WHERE record_id = $1 ORDER BY version', [recordId])
      return (r.rows as Array<{ version: number }>).map((x) => Number(x.version))
    }

    const deleted = await sweepMetaRevisionRetention(q, { enabled: true, policy: 'keep-days', keepN: 200, retentionDays: 30, batchSize: 5000 })
    // recAged loses v1,v2 (aged non-latest); recMixed loses v1,v2 (aged non-latest) → ≥4 from our two records
    // (bounded ≥; other suites' rows may also age out, but our two records' deletions are exact below).
    expect(deleted).toBeGreaterThanOrEqual(4)

    // recAged: ONLY the latest (v3) survives even though it too is aged → rn=1 INVARIANT, not recency.
    expect(await versionsOf(recAged)).toEqual([3])
    // recMixed: aged non-latest (v1,v2) deleted; recent latest (v3) retained.
    expect(await versionsOf(recMixed)).toEqual([3])

    // Non-vacuity check: a FRESH record whose rows are ALL recent loses NOTHING under the same policy.
    const recFresh = await seedRecord({ [FLD_A]: 'f2' }, 2, [
      { version: 1, action: 'create', snapshot: { [FLD_A]: 'f1' } },
      { version: 2, snapshot: { [FLD_A]: 'f2' } },
    ])
    const deleted2 = await sweepMetaRevisionRetention(q, { enabled: true, policy: 'keep-days', keepN: 200, retentionDays: 30, batchSize: 5000 })
    expect(await versionsOf(recFresh)).toEqual([1, 2]) // both recent → both kept
    void deleted2 // (other suites' aged rows may still drain; recFresh is the controlled assertion)
  })

  // M3 — FULL-restore static read_only / hidden rejection + no-leak. T4 already proves the atomic
  // 403 + no-id-leak shape via a LAYER-3 (field_permissions row) read_only difference. What M3 adds
  // is the STATIC schema-property gate INPUT: a field whose `property.readOnly:true` (resp.
  // `property.hidden:true`) feeds isFieldAlwaysReadOnly / isFieldPermissionHidden → guard.readOnly /
  // guard.hidden → staticOk=false at the route gate, independent of any field_permissions row.
  // (isFieldAlwaysReadOnly also feeds perm.readOnly via deriveFieldPermissions, so this is the
  // static-property branch, not staticOk in isolation.) Full restore (no fieldIds) as a FULL-PERMS
  // writer must atomic-403 and never echo the forbidden id.
  test('T24 (M3): full restore atomic-403s on a statically read_only OR hidden field that differs; nothing written, id not leaked', async () => {
    const FLD_STATIC_RO = `fld_rstr_sro_${TS}`
    const FLD_STATIC_HID = `fld_rstr_shid_${TS}`
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATIC_RO, SHEET_ID, 'StaticRO', 'string', JSON.stringify({ readOnly: true }), 20])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_STATIC_HID, SHEET_ID, 'StaticHidden', 'string', JSON.stringify({ hidden: true }), 21])
    try {
      // --- read_only variant: FLD_STATIC_RO differs v1→current ---
      const ridRo = await seedRecord(
        { [FLD_A]: 'a2', [FLD_STATIC_RO]: 'ro_now' },
        2,
        [
          { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_STATIC_RO]: 'ro_old' } },
          { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_STATIC_RO]: 'ro_now' } },
        ],
      )
      // testUserId = USER_W (full perms, default per beforeEach) — the rejection is from the STATIC property, not a row.
      const resRo = await restoreReq(ridRo, { targetVersion: 1, expectedVersion: 2 })
      expect(resRo.status).toBe(403)
      expect(resRo.body.error.code).toBe('RESTORE_FORBIDDEN')
      expect(JSON.stringify(resRo.body)).not.toContain(FLD_STATIC_RO) // forbidden id ABSENT from the body
      // atomic: nothing written (the writable A would otherwise have restored to 'a1').
      const dataRo = await liveData(ridRo)
      expect(dataRo[FLD_A]).toBe('a2')
      expect(dataRo[FLD_STATIC_RO]).toBe('ro_now')
      const verRo = await q('SELECT version FROM meta_records WHERE id = $1', [ridRo])
      expect(Number((verRo.rows[0] as { version: number }).version)).toBe(2) // unchanged

      // --- hidden variant: FLD_STATIC_HID differs v1→current ---
      const ridHid = await seedRecord(
        { [FLD_A]: 'a2', [FLD_STATIC_HID]: 'hid_now' },
        2,
        [
          { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_STATIC_HID]: 'hid_old' } },
          { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_STATIC_HID]: 'hid_now' } },
        ],
      )
      const resHid = await restoreReq(ridHid, { targetVersion: 1, expectedVersion: 2 })
      expect(resHid.status).toBe(403)
      expect(resHid.body.error.code).toBe('RESTORE_FORBIDDEN')
      expect(JSON.stringify(resHid.body)).not.toContain(FLD_STATIC_HID)
      const dataHid = await liveData(ridHid)
      expect(dataHid[FLD_A]).toBe('a2') // atomic — A not restored
      const verHid = await q('SELECT version FROM meta_records WHERE id = $1', [ridHid])
      expect(Number((verHid.rows[0] as { version: number }).version)).toBe(2)

      // Non-vacuity: with the forbidden field set to the SAME value in both versions (no diff), the
      // very same full restore succeeds — proving the 403 above is driven by the changed forbidden
      // field, not by the field merely existing.
      const ridOk = await seedRecord(
        { [FLD_A]: 'a2', [FLD_STATIC_RO]: 'ro_same' },
        2,
        [
          { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_STATIC_RO]: 'ro_same' } },
          { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_STATIC_RO]: 'ro_same' } },
        ],
      )
      const resOk = await restoreReq(ridOk, { targetVersion: 1, expectedVersion: 2 })
      expect(resOk.status).toBe(200)
      expect((await liveData(ridOk))[FLD_A]).toBe('a1') // A restored; RO field unchanged → not in diff
    } finally {
      await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [[FLD_STATIC_RO, FLD_STATIC_HID]]).catch(() => {})
    }
  })

  // M4 — link-field FULL-restore negative permission (layer-3). The T6 family covers link restore
  // HAPPY paths; none gate a link restore on a field_permissions read_only row. Here USER_RO is
  // read_only on the LINK field and the link value differs across versions → full restore must
  // atomic-403, leave meta_links untouched, and echo no link/foreign id.
  test('T25 (M4): full restore is 403 when the actor is read_only on a CHANGED link field; meta_links unchanged, no foreign id leaked', async () => {
    // Seed the negative permission LOCAL to this test so it cannot perturb T1–T24's link assertions.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_LK, 'user', USER_RO, true, true])
    try {
      const rid = await seedRecord(
        { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] }, // current → FOREIGN_REC
        2,
        [
          { version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: [FOREIGN_REC2] } }, // v1 → FOREIGN_REC2 (differs)
          { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } },
        ],
      )
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_m4_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])

      testUserId = USER_RO // read_only on the LINK field
      const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('RESTORE_FORBIDDEN')
      // no link/foreign id echoed in the error
      expect(JSON.stringify(res.body)).not.toContain(FLD_LK)
      expect(JSON.stringify(res.body)).not.toContain(FOREIGN_REC2)
      // atomic: meta_links untouched (still the current edge), data unchanged.
      const links = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [FLD_LK, rid])
      expect((links.rows as Array<{ foreign_record_id: string }>).map((x) => x.foreign_record_id)).toEqual([FOREIGN_REC])
      const data = await liveData(rid)
      expect((data[FLD_LK] as string[])).toEqual([FOREIGN_REC])

      // Non-vacuity: a FULL-perms writer (USER_W) CAN do the same restore → proves the 403 is the
      // negative permission, not a structural block on link restore.
      testUserId = USER_W
      const ok = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
      expect(ok.status).toBe(200)
      expect(ok.body.data.restoredFieldIds).toContain(FLD_LK)
      const linksAfter = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2 ORDER BY foreign_record_id', [FLD_LK, rid])
      expect((linksAfter.rows as Array<{ foreign_record_id: string }>).map((x) => x.foreign_record_id)).toEqual([FOREIGN_REC2]) // edge re-pointed to v1
    } finally {
      await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3', [SHEET_ID, FLD_LK, USER_RO]).catch(() => {})
    }
  })

  // SR-2 row-deny — legacy-bypass closure (owner review of #3023). The /restore route now applies the SAME
  // row-level read-deny seam as the history surfaces + restore-execute: a sheet editor row-read-denied on a
  // record cannot restore (write) it. Denied → 404 (no-oracle), no write. The gate is INERT when the per-sheet
  // flag is off (so every other golden above is unaffected); this test toggles it on and resets it in `finally`.
  test('row-deny: a row-read-denied record cannot be restored via /restore (404, no write)', async () => {
    const rid = await seedRecord({ [FLD_A]: 'secret' }, 2, [
      { version: 1, action: 'create', snapshot: { [FLD_A]: 'old' } },
      { version: 2, snapshot: { [FLD_A]: 'secret' } },
    ])
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET_ID, JSON.stringify([{ id: 'rd1', fieldId: FLD_A, operator: 'eq', value: 'secret', effect: 'deny_read' }])])
    try {
      testUserId = USER_W // a writer, but row-read-denied on THIS record by the rule (read-deny ⟂ write capability)
      const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
      expect(res.status).toBe(404) // denied → not-found shape, before any write
      expect((await liveData(rid))[FLD_A]).toBe('secret') // unchanged — the legacy route no longer bypasses row-deny
    } finally {
      await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = '[]'::jsonb WHERE id = $1", [SHEET_ID])
    }
  })
})
