/**
 * T8-1: PIT Revert UNDELETE-execute (resurrect records that existed at T but are deleted now) — real DB.
 * Behind default-OFF MULTITABLE_ENABLE_PIT_UNDELETE, ON TOP of canManageSheetAccess (D2), with the undelete-specific
 * floor canDeleteRecord (NEVER canEditRecord) + a typed confirm:'undelete'. The resurrect set is bound into the
 * pit-revert identity (resurrectScopeHash, re-enumerated at execute → 409 on drift). Resurrect = INSERT the FULL
 * server-side T-snapshot under the ORIGINAL id (id-collision → 409, no overwrite), rebuild OUTBOUND meta_links from
 * the snapshot, NO inbound (design-lock L4 A), in ONE transaction (all-or-nothing). Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_un_${TS}`, SHEET = `sheet_un_${TS}`
const NAME = `fld_un_name_${TS}`, LINK = `fld_un_link_${TS}`
const U = `rec_un_u_${TS}`        // existed at T1 (create), deleted at T2, no live row → undelete target
const L = `rec_un_l_${TS}`        // a LIVE record whose data links to U (inbound edge was dropped on U's delete)
const ACTOR = `user_un_${TS}`
const FLAG = 'MULTITABLE_ENABLE_PIT_UNDELETE'
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'
const SNAP = { [NAME]: 'u-at-T1', [LINK]: [L] } // U's T-snapshot links OUTBOUND to L → rebuilt on undelete (proves the rebuild ran)

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share'] // write→canDeleteRecord, share→canManageSheetAccess
const preview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
const execute = (asOf: string, previewIdentity: string, confirm?: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send({ asOf, previewIdentity, confirm })
const liveRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const revCount = async (id: string) => Number(((await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE record_id = $1', [id])).rows[0] as { c: number }).c)
const inboundEdges = async (id: string) => Number(((await q('SELECT count(*)::int AS c FROM meta_links WHERE foreign_record_id = $1', [id])).rows[0] as { c: number }).c)
const outboundEdges = async (id: string) => Number(((await q('SELECT count(*)::int AS c FROM meta_links WHERE record_id = $1', [id])).rows[0] as { c: number }).c)
const rev = (id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5]::text[],'{}'::jsonb,$6::jsonb,$7)`, [SHEET, id, version, action, NAME, JSON.stringify(snap), at])

async function seed(): Promise<void> {
  // U: created at T0, deleted at T2, NO live row → "existed at T1, gone now" → undelete target.
  await rev(U, 1, 'create', SNAP, T0)
  await rev(U, 2, 'delete', SNAP, T2) // delete revision stores the pre-delete snapshot
  // L: a LIVE record that links to U. U's delete dropped BOTH directions, so L's inbound edge to U is gone, but L's
  // DATA still references U → inbound (A) re-appears only when L is re-saved, NOT by the undelete.
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [L, SHEET, JSON.stringify({ [NAME]: 'L', [LINK]: [U] })])
}

describeIfDatabase('multitable T8-1 PIT undelete-execute (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: curPerms }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'UN Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'UN Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINK, SHEET, 'Link', 'link', JSON.stringify({ foreignSheetId: SHEET }), 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]).catch(() => {}) // meta_links has no sheet_id col
    for (const t of ['meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    await q('DELETE FROM meta_links WHERE field_id IN (SELECT id FROM meta_fields WHERE sheet_id = $1)', [SHEET]) // meta_links has no sheet_id col
    for (const t of ['meta_record_revisions', 'meta_records']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET])
    await seed()
  })
  afterEach(() => { delete process.env[FLAG] })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) preview classifies U as an undelete; undeleteSupported follows the flag', async () => {
    delete process.env[FLAG]
    const off = await preview(T1)
    expect(off.status).toBe(200)
    expect(off.body?.data?.summary?.visibleUndeleteCount).toBe(1)
    expect(off.body?.data?.undeleteRecordIds).toEqual([U])
    expect(off.body?.data?.undeleteSupported).toBe(false)
    process.env[FLAG] = 'true'
    expect((await preview(T1)).body?.data?.undeleteSupported).toBe(true)
  })

  test('(b) flag OFF → execute 403 UNDELETE_DISABLED, U stays deleted', async () => {
    delete process.env[FLAG]
    const pv = await preview(T1)
    const x = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('UNDELETE_DISABLED')
    expect(await liveRow(U)).toBeUndefined()
  })

  test('(c) canDeleteRecord floor: share-but-not-write actor (D2 ok) → 403, never canEditRecord-only', async () => {
    process.env[FLAG] = 'true'
    curPerms = ['multitable:read', 'multitable:share'] // canManageSheetAccess yes, canDeleteRecord NO
    const pv = await preview(T1)
    const x = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FORBIDDEN')
    expect(await liveRow(U)).toBeUndefined()
  })

  test('(d) typed confirm required: no confirm → 400; confirm:"undelete" → resurrects', async () => {
    process.env[FLAG] = 'true'
    const pv = await preview(T1)
    const noConfirm = await execute(T1, pv.body?.data?.previewIdentity)
    expect(noConfirm.status).toBe(400)
    expect(noConfirm.body?.error?.code).toBe('CONFIRM_REQUIRED')
    expect(await liveRow(U)).toBeUndefined() // nothing written
    const ok = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.resurrectedCount).toBe(1)
  })

  test('(e) happy resurrect: U re-inserted under its ORIGINAL id with the FULL T-snapshot + a create revision', async () => {
    process.env[FLAG] = 'true'
    const pv = await preview(T1)
    const x = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
    expect(x.status).toBe(200)
    expect(x.body?.data?.undeleteRecordIds).toEqual([U])
    const live = await liveRow(U)
    expect(live?.data?.[NAME]).toBe('u-at-T1')   // full T-snapshot, not delete-time/trash state
    expect(live?.version).toBe(1)
    expect(await revCount(U)).toBeGreaterThanOrEqual(3) // create + delete + the new resurrect 'create'
  })

  test('(f) inbound (A): undelete REBUILDS outbound (U→L) but writes NO inbound edge (→U), even though L\'s data references U', async () => {
    process.env[FLAG] = 'true'
    expect(await inboundEdges(U)).toBe(0) // baseline: U's delete dropped the L→U edge (L's data still references U)
    const pv = await preview(T1)
    expect((await execute(T1, pv.body?.data?.previewIdentity, 'undelete')).status).toBe(200)
    // OUTBOUND rebuilt from U's snapshot → proves the link-rebuild code actually ran (not a vacuous assertion):
    expect(await outboundEdges(U)).toBe(1)
    // INBOUND stays absent: a naive impl that scanned L's data and re-materialized L→U would make this 1 and FAIL.
    expect(await inboundEdges(U)).toBe(0) // design-lock L4 (A)
    const l = await liveRow(L)
    expect(l?.data?.[LINK]).toEqual([U]) // L's data still references U — the edge re-materializes only on L's next save
  })

  test('(g) id occupied between preview and execute → 409, no overwrite (via re-enumeration drift; the in-txn FOR UPDATE is the TOCTOU backstop)', async () => {
    process.env[FLAG] = 'true'
    const pv = await preview(T1)
    // A concurrent create takes U's id after preview. At execute, computeSheetRevert re-enumerates: U is now LIVE, so
    // it reclassifies as a revert (not a resurrect) → resurrectScopeHash mismatch → 409 BEFORE the in-txn collision
    // check. (The FOR UPDATE / unique-violation→409 guard is the deeper TOCTOU backstop, not reached here.) Either way:
    // 409 and the squatter is never overwritten.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,7)', [U, SHEET, JSON.stringify({ [NAME]: 'squatter' })])
    const x = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
    expect([409, 410]).toContain(x.status)
    const live = await liveRow(U)
    expect(live?.data?.[NAME]).toBe('squatter') // never overwritten
    expect(live?.version).toBe(7)
  })

  test('(h) drift: re-executing the same identity after U is live → resurrect-set changed → 409', async () => {
    process.env[FLAG] = 'true'
    const pv = await preview(T1)
    expect((await execute(T1, pv.body?.data?.previewIdentity, 'undelete')).status).toBe(200) // U now live
    const again = await execute(T1, pv.body?.data?.previewIdentity, 'undelete') // resurrect-set now empty → hash mismatch
    expect([409, 410]).toContain(again.status)
  })

  // ── pre-rollout review fixes ──────────────────────────────────────────────────────────────────────────────
  test('(i) fix#3 source: the resurrect revision is source=restore (Time Machine), not a plain rest create', async () => {
    process.env[FLAG] = 'true'
    const pv = await preview(T1)
    expect((await execute(T1, pv.body?.data?.previewIdentity, 'undelete')).status).toBe(200)
    const row = (await q('SELECT source FROM meta_record_revisions WHERE record_id=$1 AND action=$2 ORDER BY created_at DESC LIMIT 1', [U, 'create'])).rows[0] as { source: string } | undefined
    expect(row?.source).toBe('restore')
  })

  test('(j) fix#2 schema-drift: a resurrect target whose T-snapshot has a removed field is NOT resurrected', async () => {
    process.env[FLAG] = 'true'
    const U2 = `rec_un_drift_${TS}`
    await rev(U2, 1, 'create', { [`fld_gone_${TS}`]: 'x', [NAME]: 'd' }, T0) // a field id that is not in the sheet schema
    const pv = await preview(T1)
    expect(pv.body?.data?.undeleteRecordIds).toEqual([U]) // U2 excluded as schema-drift; only U is resurrectable
    expect((await execute(T1, pv.body?.data?.previewIdentity, 'undelete')).status).toBe(200)
    expect(await liveRow(U2)).toBeUndefined() // never resurrected (would have written the stale field key)
  })

  test('(k) fix#1 unified cap: live count passes the early ceiling but reverts+resurrects exceeds it → 413', async () => {
    process.env[FLAG] = 'true'
    const prev = process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '1' // live = 1 (L) passes early; U + U3 = 2 resurrects exceed
    try {
      await rev(`rec_un_cap_${TS}`, 1, 'create', { [NAME]: 'c' }, T0) // a 2nd undelete candidate
      const res = await preview(T1)
      expect(res.status).toBe(413)
      expect(res.body?.error?.code).toBe('SHEET_TOO_LARGE')
    } finally {
      if (prev === undefined) delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
      else process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = prev
    }
  })

  test('(l) fix#4 no partial: an undelete failure aborts BEFORE the field-reverts (reorder) — a revert candidate stays unreverted', async () => {
    process.env[FLAG] = 'true'
    const R = `rec_un_revert_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [R, SHEET, JSON.stringify({ [NAME]: 'B' })]) // live revert candidate: T1=A, now=B
    await rev(R, 1, 'create', { [NAME]: 'A' }, T0)
    await rev(R, 2, 'update', { [NAME]: 'B' }, T2)
    const pv = await preview(T1)
    const FN = `un_fail_${TS}`, TRG = `un_fail_trg_${TS}`
    await q(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'forced undelete insert failure'; END; $fn$`, [])
    await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_records`, [])
    await q(`CREATE TRIGGER ${TRG} BEFORE INSERT ON meta_records FOR EACH ROW WHEN (NEW.id = '${U}') EXECUTE FUNCTION ${FN}()`, [])
    try {
      const x = await execute(T1, pv.body?.data?.previewIdentity, 'undelete')
      expect(x.status).toBeGreaterThanOrEqual(409) // undelete failed (409 conflict or 500) — request fails
      expect(await liveRow(U)).toBeUndefined() // U not resurrected (txn rolled back)
      const r = await liveRow(R)
      expect(r?.data?.[NAME]).toBe('B') // R NOT reverted — the field-reverts run AFTER the (failed) undelete, so never executed
      expect(r?.version).toBe(2)
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${TRG} ON meta_records`, []).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${FN}()`, []).catch(() => {})
    }
  })
})
