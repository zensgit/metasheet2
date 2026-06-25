/**
 * T8-1: Point-in-Time Revert-to-T (non-destructive sheet rollback) — real DB. Goldens: preview classifies
 * revert vs KEEP-post-T-created; preview is write-free; execute reverts to T-state with FORWARD revisions and
 * KEEPS post-T-created records; identity drift → 409 (PIT-1); atomicity (a forced revision-insert failure leaves
 * the record UNCHANGED); reveal never composes (PIT-7, source-grep). Undelete-execute is deferred (codebase-wide
 * undelete slice); LOCK-3 row-deny is enforced via the SAME loadDeniedRecordIds seam the batch-execute test pins.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_rv_${TS}`, SHEET = `sheet_rv_${TS}`
const NAME = `fld_rv_name_${TS}`, SALARY = `fld_rv_salary_${TS}`
const A = `rec_rv_a_${TS}`, B = `rec_rv_b_${TS}`, D = `rec_rv_d_${TS}`, ACTOR = `user_rv_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curRoles = ['member']
const revertPreview = (asOf: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf })
const revertExecute = (asOf: string, previewIdentity: string) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send({ asOf, previewIdentity })
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const rev = (id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5,$6]::text[],'{}'::jsonb,$7::jsonb,$8)`, [SHEET, id, version, action, NAME, SALARY, JSON.stringify(snap), at])

async function seed(): Promise<void> {
  for (const id of [A, B]) { // existed at T1 with old values; changed at T2 → live=new. Revert to T1 = old.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'new', [SALARY]: 200 })])
    await rev(id, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0)
    await rev(id, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  }
  // D created AFTER T1 (first revision at T2) → revert-to-T1 must KEEP it.
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [D, SHEET, JSON.stringify({ [NAME]: 'newbie', [SALARY]: 500 })])
  await rev(D, 1, 'create', { [NAME]: 'newbie', [SALARY]: 500 }, T2)
}

describeIfDatabase('multitable T8-1 Revert-to-T (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: curRoles, perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RV Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RV Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    for (const t of ['meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    curRoles = ['member']
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('preview classifies: revert A+B, KEEP D (created after T) — write-free', async () => {
    const before = await recordRow(A)
    const res = await revertPreview(T1)
    expect(res.status).toBe(200)
    expect(res.body?.data?.summary?.visibleRevertCount).toBe(2)
    expect(res.body?.data?.summary?.keptCreatedAfterTCount).toBe(1) // D kept
    expect(res.body?.data?.previewIdentity).toBeTruthy()
    expect(await recordRow(A)).toEqual(before) // PIT-1: preview wrote nothing
  })

  test('execute reverts A+B to the T-state via FORWARD revisions; D (post-T-created) is KEPT untouched', async () => {
    const pv = await revertPreview(T1)
    const res = await revertExecute(T1, pv.body?.data?.previewIdentity)
    expect(res.status).toBe(200)
    expect(res.body?.data?.revertedCount).toBe(2)
    for (const id of [A, B]) {
      const r = await recordRow(id)
      expect(r?.data?.[NAME]).toBe('old') // reverted to the T1 value
      expect(r?.data?.[SALARY]).toBe(100)
      expect(r?.version).toBe(3) // forward (v2 → v3), never a destructive rewind
    }
    const d = await recordRow(D)
    expect(d?.data?.[NAME]).toBe('newbie') // KEPT — non-destructive
    expect(d?.version).toBe(1) // untouched
  })

  test('PIT-1 drift: a record edited between preview and execute → execute 409 (re-preview)', async () => {
    const pv = await revertPreview(T1)
    await q('UPDATE meta_records SET data = $2::jsonb, version = 3 WHERE id = $1', [A, JSON.stringify({ [NAME]: 'drifted', [SALARY]: 999 })])
    const res = await revertExecute(T1, pv.body?.data?.previewIdentity)
    expect(res.status).toBe(409) // the revert set re-hashes → identity rejected
  })

  test('atomicity: a forced revision-insert failure leaves the record UNCHANGED (no half-write)', async () => {
    const pv = await revertPreview(T1)
    await q(`CREATE OR REPLACE FUNCTION _rv_fail() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'rv injected'; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _rv_fail_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _rv_fail()', [])
    try { await revertExecute(T1, pv.body?.data?.previewIdentity) } finally {
      await q('DROP TRIGGER IF EXISTS _rv_fail_trg ON meta_record_revisions', [])
      await q('DROP FUNCTION IF EXISTS _rv_fail()', [])
    }
    const r = await recordRow(A)
    expect(r?.data?.[NAME]).toBe('new') // UNCHANGED — the write + revision rolled back together
    expect(r?.version).toBe(2)
  })

  test('PIT-7: the revert path composes NO reveal grant (source-grep)', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8')
    const start = src.indexOf('T8-1: Point-in-Time Revert')
    const end = src.indexOf("records/:recordId/subscriptions'", start)
    const block = src.slice(start, end)
    expect(block.length).toBeGreaterThan(0)
    expect(block).not.toMatch(/resolveActiveRevealGrant|loadRevealedFieldIds|loadActiveReveal/) // reveal never composes into the write
  })
})
