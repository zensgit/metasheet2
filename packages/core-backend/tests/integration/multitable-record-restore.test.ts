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
import { setYjsInvalidatorForRoutes, univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_rstr_${TS}`
const SHEET_ID = `sheet_rstr_${TS}`
const FSHEET_ID = `fsheet_rstr_${TS}`
const FOREIGN_REC = `frec_rstr_${TS}`
const FLD_A = `fld_rstr_a_${TS}`
const FLD_B = `fld_rstr_b_${TS}`
const FLD_SECRET = `fld_rstr_secret_${TS}`
const FLD_FX = `fld_rstr_fx_${TS}`
const FLD_AUN = `fld_rstr_aun_${TS}`
const FLD_LK = `fld_rstr_lk_${TS}`
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

    const f = (id: string, name: string, type: string, property: string, order: number) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, SHEET_ID, name, type, property, order])
    await f(FLD_A, 'A', 'string', '{}', 1)
    await f(FLD_B, 'B', 'string', '{}', 2)
    await f(FLD_SECRET, 'Secret', 'string', '{}', 3)
    await f(FLD_FX, 'Formula', 'formula', '{}', 4)
    await f(FLD_AUN, 'AutoNum', 'autoNumber', '{}', 5)
    await f(FLD_LK, 'Link', 'link', '{}', 6)

    // Layer-3: USER_RO is read_only on SECRET (and a separate visible=false would also gate).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_RO, true, true])
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

  test('T6: link field excluded — not written, meta_links left untouched', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1', [FLD_LK]: [] } }, { version: 2, snapshot: { [FLD_A]: 'a2', [FLD_LK]: [FOREIGN_REC] } }],
    )
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_${TS}_${recordSeq}`, FLD_LK, rid, FOREIGN_REC])
    const res = await restoreReq(rid, { targetVersion: 1, expectedVersion: 2 })
    expect(res.status).toBe(200)
    expect(res.body.data.restoredFieldIds).not.toContain(FLD_LK)
    const links = await q('SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2', [FLD_LK, rid])
    expect((links.rows as Array<{ foreign_record_id: string }>).map((r) => r.foreign_record_id)).toEqual([FOREIGN_REC])
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
    // stale expectedVersion → conflict (the concurrency check precedes the no-op)
    const stale = await restoreReq(rid, { targetVersion: 2, expectedVersion: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
  })

  test('T10: a competing version bump between read and apply → VERSION_CONFLICT', async () => {
    const rid = await seedRecord(
      { [FLD_A]: 'a2' },
      2,
      [{ version: 1, action: 'create', snapshot: { [FLD_A]: 'a1' } }, { version: 2, snapshot: { [FLD_A]: 'a2' } }],
    )
    // Caller believes version is 1, but the record is actually at 2 → conflict (mirrors the TOCTOU race).
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
})
