/**
 * ②a wall — §2a.4-c sheet-create TOCTOU close, SECOND sink (`GET /view?seed=true`, real DB).
 *
 * `createSeededSheet` has TWO callers, not one:
 *   - POST /sheets (univer-meta.ts ~6832) — route-guarded by `validateSheetCreateNoRetroactiveCrossBaseLink`.
 *   - GET /view?seed=true (univer-meta.ts ~7377) — was UNGUARDED (the review BLOCKER on #2576).
 *
 * The GET /view seed branch takes the caller-chosen `sheetId` verbatim (`resolveMetaSheetId`) and lets
 * `createSeededSheet` insert it at the LEGACY base (`ensureLegacyBase` = base_legacy). So a plain
 * `multitable:write` member whose source sheet sits in a NON-legacy base, plus a link field pointing at a
 * not-yet-existent FUTURE_ID, could materialize a silently-cross-base link from the other side:
 *
 *   GET /api/multitable/view?seed=true&sheetId=FUTURE_ID
 *     → before the fix: 200, FUTURE_ID created at base_legacy ≠ source base → existing link now cross-base.
 *
 * The fix CENTRALIZES the TOCTOU guard inside `createSeededSheet` itself (keyed to a genuinely-new sheet
 * insert, validated against the base the sheet is ACTUALLY created at = base_legacy for this path), so
 * BOTH callers and any future caller are covered by construction. The GET /view catch maps the resulting
 * `CrossBaseLinkError` → 400 VALIDATION_ERROR (mirrors POST /sheets).
 *
 * Auth models the review's PROBE2: a plain NON-admin member with multitable:read/write (no base owner
 * needed — the FUTURE sheet does not exist yet so it carries no record-permission scope; base capability
 * `canRead` from `multitable:read` clears the :7373 gate). Confirms the bypass is not admin-only.
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/fields-style SQL seed + the real
 * GET /api/multitable/view wire (not hand-built helper calls — see the wire-vs-fixture rule).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_seedtoctou_${TS}`

const BASE_A = `base_seedtoctou_a_${TS}` // non-legacy source base
const SHEET_A = `sheet_seedtoctou_a_${TS}` // source sheet, BASE_A

// Future (not-yet-existent) foreign target ids referenced by link fields created BEFORE the sheet exists.
const FUTURE_CROSS = `sheet_seedtoctou_future_cross_${TS}` // seed path creates at base_legacy → cross-base vs BASE_A
const FUTURE_CLEAN = `sheet_seedtoctou_future_clean_${TS}` // no link points at it → legit same-/legacy-base seed

const FLD_CROSS = `fld_seedtoctou_cross_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Plain NON-admin member with multitable read/write (no admin role, no base ownership). Mirrors PROBE2.
function buildMemberApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = {
      id: userId,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
      isAdmin: false,
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

const sheetBaseId = async (sheetId: string): Promise<string | null | undefined> => {
  const r = await q('SELECT base_id FROM meta_sheets WHERE id = $1', [sheetId])
  const rows = r.rows as Array<{ base_id: string | null }>
  if (rows.length === 0) return undefined // not created
  return rows[0].base_id
}

describeIfDatabase('②a wall — GET /view?seed=true sheet-create TOCTOU close (§2a.4-c second sink, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'Seed TOCTOU Base A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Seed Source A'])

    // Link field whose foreignSheetId points at a sheet that does NOT exist yet — models the deferred-
    // binding hole (the §2a.2 wall no-ops when the foreign sheet is absent), same methodology as the
    // POST /sheets TOCTOU test's beforeAll.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CROSS, SHEET_A, 'Link Future Cross', 'link', JSON.stringify({ foreignSheetId: FUTURE_CROSS }), 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_A, FUTURE_CLEAN]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_A, FUTURE_CROSS, FUTURE_CLEAN]]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [[SHEET_A, FUTURE_CROSS, FUTURE_CLEAN]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_A, FUTURE_CROSS, FUTURE_CLEAN]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_A]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // BLOCKER reproduction: GET /view?seed=true&sheetId=FUTURE_CROSS materializes FUTURE_CROSS at the
  // LEGACY base, which differs from BASE_A (FLD_CROSS's source base) → the existing link would become
  // silently cross-base. After the centralized guard: 4xx VALIDATION_ERROR and FUTURE_CROSS NOT created.
  test('TOCTOU (GET /view seed): seeding a future sheet that retroactively crosses an existing link is rejected (4xx), not created', async () => {
    const res = await request(buildMemberApp(USER))
      .get('/api/multitable/view')
      .query({ seed: 'true', sheetId: FUTURE_CROSS })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // The sheet must NOT have been created — base_after must be undefined (no row), not the legacy base.
    expect(await sheetBaseId(FUTURE_CROSS)).toBeUndefined()
  })

  // No-false-positive: GET /view?seed=true on a fresh id that NO link points at → the guard finds zero
  // rows → 200 + the sheet is created (at the legacy base). The legit seed path must not be over-rejected.
  test('TOCTOU (GET /view seed) no-false-positive: seeding a clean future id (no inbound link) succeeds (200) and is created', async () => {
    const res = await request(buildMemberApp(USER))
      .get('/api/multitable/view')
      .query({ seed: 'true', sheetId: FUTURE_CLEAN })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // Created at the legacy base (createSeededSheet's ensureLegacyBase) — present, not undefined.
    expect(await sheetBaseId(FUTURE_CLEAN)).toBe('base_legacy')
  })
})
