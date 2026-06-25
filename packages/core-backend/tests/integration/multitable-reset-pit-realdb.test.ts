/**
 * T8-2: Point-in-Time Reset-to-T (DESTRUCTIVE sheet rollback) — real DB. Reset = Revert (surviving records → their
 * T-state) + SOFT-DELETE the records created after T. Goldens: (a) flag-off → inert 403; (b) flag-on → post-T-created
 * SOFT-DELETED (to recycle-bin trash) + survivors reverted (source=restore); (c) PIT-2 all-or-nothing — a LOCKED
 * delete-target → 409 RESET_BLOCKED with ZERO writes (mutation-proven: drop the not-locked preflight check → D is
 * deleted → this golden fails); (d) row-deny added after preview → 409 RESET_BLOCKED with ZERO writes and no blocker
 * details; (e) ceiling → 413; (f) typed confirm:'reset' required → 400; (g) delete-set divergence — a record created
 * or edited between preview/execute → 409, NOTHING deleted; (h) single-transaction atomicity — a forced DELETE-revision
 * failure rolls back the already-started A/B reverts too; (i) PIT-7 reveal-non-composition; (j) D2 sheet-admin gate.
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
const BASE = `base_rs_${TS}`, SHEET = `sheet_rs_${TS}`
const NAME = `fld_rs_name_${TS}`, SALARY = `fld_rs_salary_${TS}`
const A = `rec_rs_a_${TS}`, B = `rec_rs_b_${TS}`, D = `rec_rs_d_${TS}`, ACTOR = `user_rs_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curRoles = ['member']
let curPerms = ['multitable:read', 'multitable:write', 'multitable:share'] // share → canManageSheetAccess (D2)
const resetPreview = () => request(app).post(`/api/multitable/sheets/${SHEET}/reset-preview`).send({ asOf: T1 })
const resetExecute = (body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/reset-execute`).send(body)
const recordRow = async (id: string) => (await q('SELECT data, version FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; version: number } | undefined
const inTrash = async (id: string) => (await q('SELECT record_id FROM meta_records_trash WHERE record_id = $1', [id])).rows.length > 0
const rev = (id: string, version: number, action: string, snap: Record<string, unknown>, at: string) =>
  q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5,$6]::text[],'{}'::jsonb,$7::jsonb,$8)`, [SHEET, id, version, action, NAME, SALARY, JSON.stringify(snap), at])

async function seed(): Promise<void> {
  for (const id of [A, B]) { // existed at T1 (old), changed at T2 (new) → reset-to-T1 reverts them to old.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [id, SHEET, JSON.stringify({ [NAME]: 'new', [SALARY]: 200 })])
    await rev(id, 1, 'create', { [NAME]: 'old', [SALARY]: 100 }, T0)
    await rev(id, 2, 'update', { [NAME]: 'new', [SALARY]: 200 }, T2)
  }
  // D created AFTER T1 → reset-to-T1 DELETES it (Revert keeps it).
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [D, SHEET, JSON.stringify({ [NAME]: 'newbie', [SALARY]: 500 })])
  await rev(D, 1, 'create', { [NAME]: 'newbie', [SALARY]: 500 }, T2)
}

describeIfDatabase('multitable T8-2 Reset-to-T (DESTRUCTIVE, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: curRoles, perms: curPerms }; next() })
    process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS = '10'
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'RS Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'RS Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
  })
  afterAll(async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    for (const t of ['meta_records_trash', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
  })
  beforeEach(async () => {
    curRoles = ['member']
    curPerms = ['multitable:read', 'multitable:write', 'multitable:share']
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true' // flag ON for most tests; (a) turns it off
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [SHEET])
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) flag OFF → Reset is inert (403 RESET_DISABLED) on preview AND execute', async () => {
    delete process.env.MULTITABLE_ENABLE_PIT_RESET
    const pv = await resetPreview()
    expect(pv.status).toBe(403); expect(pv.body?.error?.code).toBe('RESET_DISABLED')
    const ex = await resetExecute({ asOf: T1, previewIdentity: 'x', confirm: 'reset' })
    expect(ex.status).toBe(403); expect(ex.body?.error?.code).toBe('RESET_DISABLED')
  })

  test('(b) flag ON whole-sheet reset → post-T-created SOFT-DELETED (to trash) + survivors reverted (source=restore)', async () => {
    const pv = await resetPreview()
    expect(pv.status).toBe(200)
    expect(pv.body?.data?.summary?.visibleRevertCount).toBe(2) // A, B
    expect(pv.body?.data?.summary?.deleteCount).toBe(1) // D
    expect(pv.body?.data?.deleteRecordIds).toEqual([D])
    const ex = await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' })
    expect(ex.status).toBe(200)
    expect(ex.body?.data?.revertedCount).toBe(2)
    expect(ex.body?.data?.deletedCount).toBe(1)
    for (const id of [A, B]) { const r = await recordRow(id); expect(r?.data?.[NAME]).toBe('old'); expect(r?.version).toBe(3) } // reverted forward
    expect(await recordRow(D)).toBeUndefined() // D soft-deleted — gone from live
    expect(await inTrash(D)).toBe(true) // ...recoverable in the recycle bin (NOT hard-deleted)
    const restoreRevs = (await q(`SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }
    expect(restoreRevs.c).toBeGreaterThanOrEqual(2) // the reverts wrote source=restore forward revisions
  })

  test('(c) PIT-2 all-or-nothing: a LOCKED post-T-created target → 409 RESET_BLOCKED, ZERO writes', async () => {
    await q('UPDATE meta_records SET locked = true, locked_by = $2 WHERE id = $1', [D, `other_${TS}`]) // locked by someone else
    const pv = await resetPreview()
    const ex = await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' })
    expect(ex.status).toBe(409); expect(ex.body?.error?.code).toBe('RESET_BLOCKED')
    expect(ex.body?.error?.blockers).toBeUndefined() // no target id/count oracle on the destructive path
    // ZERO writes — the all-or-nothing preflight rejected BEFORE any revert or delete
    for (const id of [A, B]) { const r = await recordRow(id); expect(r?.data?.[NAME]).toBe('new'); expect(r?.version).toBe(2) } // NOT reverted
    expect(await recordRow(D)).toBeTruthy() // NOT deleted
  })

  test('(d) PIT-2 all-or-nothing: row-deny added after preview → RESET_BLOCKED, ZERO writes, no blocker oracle', async () => {
    const pv = await resetPreview()
    await q("UPDATE meta_sheets SET row_level_read_permissions_enabled = true, conditional_read_rules = $2::jsonb WHERE id = $1", [SHEET, JSON.stringify([{ id: 'r1', fieldId: NAME, operator: 'eq', value: 'newbie', effect: 'deny_read' }])])
    const ex = await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('RESET_BLOCKED')
    expect(ex.body?.error?.blockers).toBeUndefined() // no denied-row id/count oracle on the destructive path
    for (const id of [A, B]) { const r = await recordRow(id); expect(r?.data?.[NAME]).toBe('new'); expect(r?.version).toBe(2) }
    expect(await recordRow(D)).toBeTruthy()
    expect(await inTrash(D)).toBe(false)
    const restoreRevs = (await q(`SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND source = 'restore'`, [SHEET])).rows[0] as { c: number }
    expect(restoreRevs.c).toBe(0)
  })

  test('(e) ceiling: a sheet above SHEET_REVERT_MAX_RECORDS → 413', async () => {
    for (let i = 0; i < 8; i++) await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_rs_big_${TS}_${i}`, SHEET, JSON.stringify({ [NAME]: 'x' })])
    expect((await resetPreview()).status).toBe(413)
  })

  test('(f) D4 typed confirm: execute WITHOUT confirm:"reset" → 400 (no stray-call trigger)', async () => {
    const pv = await resetPreview()
    expect((await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity })).status).toBe(400) // confirm absent
    expect((await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'revert' })).status).toBe(400) // wrong confirm
  })

  test('(g1) delete-set divergence: a record created AFTER the preview → execute 409, NOTHING deleted', async () => {
    const pv = await resetPreview() // delete-set bound = {D}
    const E = `rec_rs_e_${TS}`
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [E, SHEET, JSON.stringify({ [NAME]: 'sneaked-in' })]) // now post-T-created too
    const ex = await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' })
    expect(ex.status).toBe(409); expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID') // deleteScopeHash diverged
    expect(await recordRow(D)).toBeTruthy() // D NOT deleted
    expect(await recordRow(E)).toBeTruthy() // E (never in the preview) NOT deleted — the load-bearing safety property
  })

  test('(g2) delete-set version drift: a post-T-created record edited after preview → execute 409, NOTHING deleted', async () => {
    const pv = await resetPreview() // D bound at version 1
    await q('UPDATE meta_records SET data = $2::jsonb, version = version + 1 WHERE id = $1', [D, JSON.stringify({ [NAME]: 'edited-after-preview', [SALARY]: 501 })])
    const ex = await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' })
    expect(ex.status).toBe(409); expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    expect((await recordRow(D))?.data?.[NAME]).toBe('edited-after-preview')
    for (const id of [A, B]) { const r = await recordRow(id); expect(r?.data?.[NAME]).toBe('new'); expect(r?.version).toBe(2) }
  })

  test('(h) single-transaction atomicity: DELETE-revision failure rolls back prior A/B reverts AND D delete', async () => {
    const pv = await resetPreview()
    await q(`CREATE OR REPLACE FUNCTION _rs_fail() RETURNS trigger AS $f$ BEGIN IF NEW.action = 'delete' THEN RAISE EXCEPTION 'rs injected'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`, [])
    await q('CREATE TRIGGER _rs_fail_trg BEFORE INSERT ON meta_record_revisions FOR EACH ROW EXECUTE FUNCTION _rs_fail()', [])
    try { await resetExecute({ asOf: T1, previewIdentity: pv.body?.data?.previewIdentity, confirm: 'reset' }) } finally {
      await q('DROP TRIGGER IF EXISTS _rs_fail_trg ON meta_record_revisions', [])
      await q('DROP FUNCTION IF EXISTS _rs_fail()', [])
    }
    for (const id of [A, B]) { const r = await recordRow(id); expect(r?.data?.[NAME]).toBe('new'); expect(r?.version).toBe(2) } // A/B updates rolled back
    expect(await recordRow(D)).toBeTruthy()
    expect(await inTrash(D)).toBe(false)
  })

  test('(i) PIT-7: the reset path composes NO reveal grant (source-grep)', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8')
    const start = src.indexOf('T8-2 Reset-to-T (DESTRUCTIVE PIT restore)')
    const end = src.indexOf("records/:recordId/subscriptions'", start)
    const block = src.slice(start, end)
    expect(block.length).toBeGreaterThan(0)
    expect(block).not.toMatch(/resolveActiveRevealGrant|loadRevealedFieldIds|loadActiveReveal/) // reveal never composes into the destructive write
  })

  test('(j) D2: a normal record editor (write but NOT sheet-admin) is FORBIDDEN reset', async () => {
    curPerms = ['multitable:read', 'multitable:write'] // no share → no canManageSheetAccess
    expect((await resetPreview()).status).toBe(403)
    expect((await resetExecute({ asOf: T1, previewIdentity: 'x', confirm: 'reset' })).status).toBe(403)
  })
})
