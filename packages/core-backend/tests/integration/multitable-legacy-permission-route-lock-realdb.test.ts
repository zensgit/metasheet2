/**
 * Legacy spreadsheet-permissions grant/revoke routes — concurrency lock (#3389 / #3402 follow-up) — real DB.
 *
 * #3402 made the three multitable forward permission routes take the same `meta_sheets … FOR UPDATE` the
 * permission-revert execute path holds, but explicitly DEFERRED the legacy `routes/spreadsheet-permissions.ts`
 * grant/revoke routes as the "remaining un-serialized writer". This closes that residual the SAME way (one lock
 * model): each write now runs in a txn that locks the owning sheet row first.
 *
 * The grant vs revoke asymmetry (stated precisely so the guarantee isn't overclaimed):
 *   - `spreadsheet_permissions.sheet_id REFERENCES meta_sheets(id)`, so a grant INSERT implicitly takes
 *     `FOR KEY SHARE` on the parent meta_sheets row. The revert holds `FOR UPDATE`, which CONFLICTS with
 *     FOR KEY SHARE — so a concurrent grant INSERT was ALREADY serialized against the revert. Locking grant is
 *     UNIFORMITY (one lock model), not a new closure.
 *   - A revoke DELETEs the CHILD row, which takes NO lock on the parent meta_sheets row → it was NOT FK-serialized
 *     against the revert and could interleave the revert's live-grant re-check and its apply. Revoke is the
 *     GENUINE residual closure.
 *
 * Discriminator (FK-aware, same as #3402's (m)): HOLD `FOR KEY SHARE` (NOT `FOR UPDATE`) on the sheet row in an
 * external txn, then fire the route. FOR KEY SHARE is COMPATIBLE with the FK key-share an unfixed grant INSERT needs
 * (and a plain revoke DELETE takes no meta_sheets lock at all) → the UNFIXED route sails (test RED). It CONFLICTS with
 * the `FOR UPDATE` the FIXED route now requests → the route parks until release (test GREEN). A plain `FOR UPDATE`
 * holder could not discriminate the grant case (the FK key-share alone would block the unfixed INSERT). Assertions are
 * two-sided (state unchanged WHILE held AND applied AFTER release), so a slow CI run cannot mask a missing lock.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { spreadsheetPermissionsRouter } from '../../src/routes/spreadsheet-permissions'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_legacy_lock_${TS}`
const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

let app: Express
const CREATED_SHEETS: string[] = []
let seq = 0
const mkSubject = (tag: string) => `subj_legacy_${tag}_${TS}_${seq++}`

async function freshSheet(tag: string): Promise<string> {
  const id = `sheet_legacy_${tag}_${TS}`
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [id, BASE, id])
  CREATED_SHEETS.push(id)
  return id
}

const grant = (s: string, userId: string, permission: string) =>
  request(app).post(`/api/spreadsheets/${s}/permissions/grant`).send({ userId, permission })
const revoke = (s: string, userId: string, permission: string) =>
  request(app).post(`/api/spreadsheets/${s}/permissions/revoke`).send({ userId, permission })

const codesFor = async (s: string, userId: string): Promise<string[]> =>
  ((await q(`SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id=$1 AND subject_type='user' AND user_id=$2 ORDER BY perm_code`, [s, userId])).rows as Array<{ perm_code: string }>).map((r) => r.perm_code)

describeIfDatabase('legacy spreadsheet-permissions grant/revoke — meta_sheets FOR UPDATE lock (#3402 follow-up, real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as unknown as { user?: unknown }).user = { id: `admin_legacy_${TS}`, role: 'admin' }; next() }) // rbacGuard global-admin bypass
    app.use(spreadsheetPermissionsRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Legacy Lock Base'])
  })
  afterAll(async () => {
    for (const s of CREATED_SHEETS) {
      await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [s]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [s]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) grant parks under a held FOR KEY SHARE on the sheet (proves the grant route now takes meta_sheets FOR UPDATE)', async () => {
    const s = await freshSheet('grant')
    const subj = mkSubject('grant')
    // hold FOR KEY SHARE, fire grant
    let releaseHold: () => void = () => {}
    const holdReleased = new Promise<void>((resolve) => { releaseHold = () => resolve() })
    let acquired: () => void = () => {}
    const lockAcquired = new Promise<void>((resolve) => { acquired = () => resolve() })
    const holder = poolManager.get().transaction(async ({ query }) => {
      await query('SELECT 1 FROM meta_sheets WHERE id = $1 FOR KEY SHARE', [s])
      acquired()
      await holdReleased
    })
    try {
      await lockAcquired
      let settled = false
      const fired = Promise.resolve(grant(s, subj, 'spreadsheet:admin').then((r) => { settled = true; return r }))
      await new Promise((resolve) => setTimeout(resolve, 300))
      // FIXED: parked on meta_sheets FOR UPDATE (conflicts with held FOR KEY SHARE) → not settled, no grant row.
      expect(settled).toBe(false)
      expect(await codesFor(s, subj)).toEqual([])
      releaseHold()
      await holder
      const res = await fired
      expect(res.status).toBe(200)
      expect(settled).toBe(true)
      expect(await codesFor(s, subj)).toEqual(['spreadsheet:admin']) // applied after release
    } finally {
      releaseHold()
      await holder.catch(() => {})
    }
  })

  test('(b) revoke parks under a held FOR KEY SHARE on the sheet (the GENUINE residual — a child DELETE has no parent lock)', async () => {
    const s = await freshSheet('revoke')
    const subj = mkSubject('revoke')
    await q(`INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,'user',$2,$3)`, [s, subj, 'spreadsheet:read'])
    let releaseHold: () => void = () => {}
    const holdReleased = new Promise<void>((resolve) => { releaseHold = () => resolve() })
    let acquired: () => void = () => {}
    const lockAcquired = new Promise<void>((resolve) => { acquired = () => resolve() })
    const holder = poolManager.get().transaction(async ({ query }) => {
      await query('SELECT 1 FROM meta_sheets WHERE id = $1 FOR KEY SHARE', [s])
      acquired()
      await holdReleased
    })
    try {
      await lockAcquired
      let settled = false
      const fired = Promise.resolve(revoke(s, subj, 'spreadsheet:read').then((r) => { settled = true; return r }))
      await new Promise((resolve) => setTimeout(resolve, 300))
      // FIXED: parked → not settled, grant row STILL present (a plain DELETE would have removed it by now → RED pre-fix).
      expect(settled).toBe(false)
      expect(await codesFor(s, subj)).toEqual(['spreadsheet:read'])
      releaseHold()
      await holder
      const res = await fired
      expect(res.status).toBe(200)
      expect(settled).toBe(true)
      expect(await codesFor(s, subj)).toEqual([]) // revoked after release
    } finally {
      releaseHold()
      await holder.catch(() => {})
    }
  })
})
