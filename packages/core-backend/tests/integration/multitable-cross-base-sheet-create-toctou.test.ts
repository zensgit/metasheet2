/**
 * ②a wall — §2a.4-c sheet-create TOCTOU close (real DB).
 *
 * The §2a.2 wall (`validateLinkFieldConfig`) only compares bases when BOTH sheets exist. When a link
 * field is created pointing at a foreign sheet id that does NOT exist yet, the wall returns null (the
 * Lane-1 review flagged this deferred-binding hole, `validateLinkFieldConfig` line ~1061). An attacker
 * can then materialize the silently-cross-base link from the OTHER side:
 *
 *   1. POST /fields a link in SHEET_A (base A) whose foreignSheetId = a not-yet-existent sheet id → 201
 *      (the wall no-ops: foreign sheet absent).
 *   2. POST /sheets with that exact caller-chosen id but baseId = base B → the link is now cross-base,
 *      and it never hit the wall.
 *
 * This lane closes the second step: POST /sheets (the caller-chosen-id + caller-chosen-baseId route,
 * univer-meta.ts ~6682) rejects (4xx) when creating this sheet would retroactively make an EXISTING
 * link field cross-base — i.e. some live link field's foreignSheetId equals the new sheet's id while
 * that field's source sheet is in a DIFFERENT base than the new sheet's baseId. Symmetric to the wall,
 * applied at sheet-create. Mirrors the wall's null-aware base compare (strict !==, null-vs-set counts)
 * and alias coverage (foreignSheetId / foreignDatasheetId / datasheetId via parseLinkFieldConfig).
 *
 * Status code mirrors the wall = 400 VALIDATION_ERROR (NOT the route's ValidationError→403 path).
 *
 * Real DB (describeIfDatabase). Drives the actual POST /api/multitable/fields + POST /api/multitable/sheets
 * wires (not hand-built helper calls — see the wire-vs-fixture rule).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const USER = `u_toctou_${TS}`

const BASE_A = `base_toctou_a_${TS}`
const BASE_B = `base_toctou_b_${TS}`
const SHEET_A = `sheet_toctou_a_${TS}` // source sheet, BASE_A

// Future (not-yet-existent) foreign target ids referenced by link fields created BEFORE the sheet exists.
const FUTURE_CROSS = `sheet_toctou_future_cross_${TS}` // will be created in BASE_B → cross-base
const FUTURE_SAME = `sheet_toctou_future_same_${TS}` // will be created in BASE_A → same-base
const FUTURE_NULL = `sheet_toctou_future_null_${TS}` // created with null base → cross-base vs set-base source
const FUTURE_ALIAS = `sheet_toctou_future_alias_${TS}` // referenced via the datasheetId alias
const FUTURE_SEED_SAME = `sheet_toctou_future_seed_same_${TS}` // POST /sheets + seed:true, SAME base as source
const FUTURE_LOCKED_CROSS = `sheet_toctou_future_locked_cross_${TS}` // used by the advisory-lock serialization test
const FUTURE_LOCKED_FIELD = `sheet_toctou_future_locked_field_${TS}` // route-created link points here while lock is held

const FLD_CROSS = `fld_toctou_cross_${TS}`
const FLD_SAME = `fld_toctou_same_${TS}`
const FLD_NULL = `fld_toctou_null_${TS}`
const FLD_ALIAS = `fld_toctou_alias_${TS}`
const FLD_SEED_SAME = `fld_toctou_seed_same_${TS}`
const FLD_LOCKED_CROSS = `fld_toctou_locked_cross_${TS}`
const FLD_LOCKED_CREATE = `fld_toctou_locked_create_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as { user?: unknown }).user = {
      id: userId,
      roles: ['member', 'admin'],
      perms: ['multitable:read', 'multitable:write'],
      permissions: ['multitable:read', 'multitable:write'],
      isAdmin: true,
    }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}

const sheetExists = async (sheetId: string): Promise<boolean> => {
  const r = await q('SELECT id FROM meta_sheets WHERE id = $1', [sheetId])
  return (r.rows as unknown[]).length > 0
}

const linkTargetMaterializationLockKey = (sheetId: string): string => `multitable:link-target:${sheetId}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function runWhileAdvisoryLockHeld<T>(sheetId: string, start: () => Promise<T>): Promise<T> {
  const client = await poolManager.get().getInternalPool().connect()
  const lockKey = linkTargetMaterializationLockKey(sheetId)
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey])
  let settled = false
  const requestPromise = start().then(
    (value) => {
      settled = true
      return value
    },
    (error) => {
      settled = true
      throw error
    },
  )
  try {
    await sleep(100)
    const settledWhileLocked = settled
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
    const result = await requestPromise
    expect(settledWhileLocked).toBe(false)
    return result
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {})
    client.release()
  }
}

describeIfDatabase('②a wall — sheet-create TOCTOU close (§2a.4-c, real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_A, 'TOCTOU Base A'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_B, 'TOCTOU Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_A, BASE_A, 'Source A'])

    // Seed link fields whose foreignSheetId points at sheets that do NOT exist yet. These are created
    // directly via SQL: they model links written through the deferred-binding hole (the wall no-ops when
    // the foreign sheet is absent, so even via the route these would be accepted at 201).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_CROSS, SHEET_A, 'Link Future Cross', 'link', JSON.stringify({ foreignSheetId: FUTURE_CROSS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SAME, SHEET_A, 'Link Future Same', 'link', JSON.stringify({ foreignSheetId: FUTURE_SAME }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_NULL, SHEET_A, 'Link Future Null', 'link', JSON.stringify({ foreignSheetId: FUTURE_NULL }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_ALIAS, SHEET_A, 'Link Future Alias', 'link', JSON.stringify({ datasheetId: FUTURE_ALIAS }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_SEED_SAME, SHEET_A, 'Link Future Seed Same', 'link', JSON.stringify({ foreignSheetId: FUTURE_SEED_SAME }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_LOCKED_CROSS, SHEET_A, 'Link Future Locked Cross', 'link', JSON.stringify({ foreignSheetId: FUTURE_LOCKED_CROSS }), 6])
  })

  afterAll(async () => {
    const allSheets = [
      SHEET_A,
      FUTURE_CROSS,
      FUTURE_SAME,
      FUTURE_NULL,
      FUTURE_ALIAS,
      FUTURE_SEED_SAME,
      FUTURE_LOCKED_CROSS,
      FUTURE_LOCKED_FIELD,
    ]
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [allSheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // §2a.4-c (core): creating the future sheet in a DIFFERENT base than the existing link's source sheet
  // would materialize a silently-cross-base link → 4xx, sheet NOT created.
  test('TOCTOU: create future sheet in a DIFFERENT base (retroactive cross-base link) is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_CROSS,
      baseId: BASE_B,
      name: 'Retroactive Cross Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_CROSS)).toBe(false)
  })

  // §2a.4-c (omitted-baseId / legacy base): POST /sheets never assigns base_id = NULL — an omitted
  // baseId resolves to the fixed legacy base (ensureLegacyBase, DEFAULT_BASE_ID), which differs from
  // BASE_A. So FLD_NULL's source (BASE_A) vs the new sheet's legacy base = cross-base → reject. (The
  // pure null-base detection is covered in the helper unit test, since the wire can't create a
  // null-base sheet.)
  test('TOCTOU (omitted baseId → legacy base): retroactive cross-base via legacy base is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_NULL,
      // No baseId → ensureLegacyBase assigns the legacy base, which is NOT BASE_A → cross-base for FLD_NULL.
      name: 'Legacy Base Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_NULL)).toBe(false)
  })

  // §2a.4-c (alias): the guard must also fire when the existing link stored its target under an alias
  // (datasheetId / foreignDatasheetId) — a foreignSheetId-only scan would be trivially bypassable.
  test('TOCTOU (alias): create future sheet that retroactively crosses an aliased link is rejected (4xx)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_ALIAS,
      baseId: BASE_B,
      name: 'Aliased Cross Target',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_ALIAS)).toBe(false)
  })

  // §2a.4-c (compat): creating the future sheet in the SAME base as the link's source sheet is fine —
  // the guard must not over-reject a legitimate same-base deferred binding.
  test('TOCTOU compat: create future sheet in the SAME base succeeds (200)', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_SAME,
      baseId: BASE_A,
      name: 'Same Base Target',
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(await sheetExists(FUTURE_SAME)).toBe(true)
  })

  // §2a.4-c (centralized-chokepoint no-false-positive): POST /sheets with seed:true SAME base. The route
  // inserts the sheet at BASE_A (caller-chosen) BEFORE calling createSeededSheet within the same txn, so
  // the centralized guard's existence check sees the row → isGenuinelyNew=false → it skips (it must NOT
  // re-reject against the LEGACY base, which would false-positive this legit caller-chosen-base seed).
  // This is the only test that turns RED if the chokepoint gate regresses to running against base_legacy.
  test('TOCTOU compat (seed:true SAME base): POST /sheets + seed does NOT false-positive — 200, created at the caller base', async () => {
    const res = await request(buildApp(USER)).post('/api/multitable/sheets').send({
      id: FUTURE_SEED_SAME,
      baseId: BASE_A,
      name: 'Same Base Seed Target',
      seed: true,
    })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.sheet.seeded).toBe(true)
    // Created at the caller-chosen BASE_A (route insert), NOT rejected and NOT relocated to the legacy base.
    const r = await q('SELECT base_id FROM meta_sheets WHERE id = $1', [FUTURE_SEED_SAME])
    const rows = r.rows as Array<{ base_id: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0].base_id).toBe(BASE_A)
  })

  // §2a.4-d (concurrency): POST /sheets must take the same per-target advisory lock used by link field
  // writes before it scans for existing link fields. Holding the session-level version of that lock makes
  // the real HTTP route wait; if this regresses, the request settles while the lock is still held.
  test('TOCTOU concurrency: sheet create waits on the target materialization advisory lock before validating retroactive links', async () => {
    const res = await runWhileAdvisoryLockHeld(FUTURE_LOCKED_CROSS, () =>
      request(buildApp(USER))
        .post('/api/multitable/sheets')
        .send({
          id: FUTURE_LOCKED_CROSS,
          baseId: BASE_B,
          name: 'Locked Retroactive Cross Target',
        })
        .timeout({ deadline: 5000 }),
    )

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(await sheetExists(FUTURE_LOCKED_CROSS)).toBe(false)
  })

  // §2a.4-d (concurrency): POST /fields must take the same per-target advisory lock before validating or
  // inserting a link to a not-yet-existent target. This is the symmetric half of the materialization race:
  // link writes and target-sheet creation now serialize on `multitable:link-target:<sheetId>`.
  test('TOCTOU concurrency: link field create waits on the target materialization advisory lock', async () => {
    const res = await runWhileAdvisoryLockHeld(FUTURE_LOCKED_FIELD, () =>
      request(buildApp(USER))
        .post('/api/multitable/fields')
        .send({
          id: FLD_LOCKED_CREATE,
          sheetId: SHEET_A,
          name: 'Locked Future Link',
          type: 'link',
          property: { foreignSheetId: FUTURE_LOCKED_FIELD },
        })
        .timeout({ deadline: 5000 }),
    )

    expect(res.status).toBe(201)
    expect(res.body.ok).toBe(true)
    const fieldRes = await q('SELECT property FROM meta_fields WHERE id = $1', [FLD_LOCKED_CREATE])
    expect((fieldRes.rows as Array<{ property: { foreignSheetId?: string } }>)[0]?.property?.foreignSheetId).toBe(
      FUTURE_LOCKED_FIELD,
    )
  })
})
