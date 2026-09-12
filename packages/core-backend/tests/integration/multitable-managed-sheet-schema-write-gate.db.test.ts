/**
 * Managed-sheet SCHEMA-WRITE gate — real Postgres, real express app, real `univerMetaRouter`, real
 * permission service. Nothing about capabilities is mocked: the actor's authority comes from
 * `spreadsheet_permissions` rows and `plugin_multitable_object_registry` rows that this file seeds,
 * and every verdict below is the one the shipped routes produce.
 *
 * WHAT IS UNDER TEST. A sheet-scoped FULL-WRITE grant lifts `canManageFields`
 * (`applyContextSheetSchemaWriteGrant`, src/multitable/permission-service.ts) — so before this gate,
 * the operator who legitimately writes DATA on a plugin-provisioned sheet could also add, retype and
 * drop that sheet's COLUMNS, which the plugin's provisioning owns
 * (`ON CONFLICT (id) DO NOTHING` + no `(sheet_id, name)` uniqueness ⇒ a same-named hand-made column
 * lands beside the template's own column and no pipeline ever fills it). The fence forces
 * `canManageFields` to false for a NON-admin on a sheet registered in
 * `plugin_multitable_object_registry` (src/multitable/managed-sheet-schema-write-guard.ts).
 *
 * THE DENIED CELLS ASSERT ZERO LANDING BY ROW COUNT, not by "the name I tried is absent": the
 * `meta_fields` count for the sheet is captured immediately before the request and compared for
 * EQUALITY immediately after, so a write that landed under any other name/id still reds the cell.
 *
 * POSITIVE CONTROLS (the gate must not be a blanket refusal):
 *   - the SAME actor on an UNREGISTERED sheet still creates a field (201, +1 row);
 *   - an ADMIN on the MANAGED sheet still creates a field (201, +1 row) — the repair path;
 *   - the SAME actor still writes RECORDS on the MANAGED sheet (the data plane is untouched).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Anti-skip-green sentinel for the dedicated evidence lane
// (.github/workflows/managed-sheet-schema-write-gate-realdb.yml sets EXPECT_DB=1): in THAT lane a
// missing DATABASE_URL is a RED run, never a silently skipped file. Deliberately OUTSIDE
// describeIfDatabase — it is the one assertion that must be able to fire when the goldens skip.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const TS = Date.now()
const BASE_ID = `base_mgw_${TS}`
/** Plugin-provisioned: carries a `plugin_multitable_object_registry` row. */
const MANAGED_SHEET_ID = `sheet_mgw_managed_${TS}`
/** An ordinary sheet: no registry row. Same actor, same grant — the only difference is the registry. */
const PLAIN_SHEET_ID = `sheet_mgw_plain_${TS}`
const MANAGED_FIELD_ID = `fld_mgw_managed_${TS}`
const PLAIN_FIELD_ID = `fld_mgw_plain_${TS}`

/**
 * The shop-floor operator: NO global multitable permission at all — its entire authority is the
 * sheet-scoped `spreadsheet:write` grant seeded below, which is exactly the tier that
 * `applyContextSheetSchemaWriteGrant` promotes to schema authority on an ordinary sheet.
 */
const WRITER_USER = `u_mgw_writer_${TS}`
/** Platform admin (roles: ['admin'] ⇒ isAdminRole without any DB row) — the repair path. */
const ADMIN_USER = `u_mgw_admin_${TS}`

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

function appFor(user: { id: string; roles: string[]; perms: string[] }): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { user: unknown }).user = { id: user.id, roles: user.roles, perms: user.perms }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const writerApp = () => appFor({ id: WRITER_USER, roles: ['member'], perms: [] })
const adminApp = () => appFor({ id: ADMIN_USER, roles: ['admin'], perms: [] })

const fieldCount = async (sheetId: string): Promise<number> => {
  const res = await q('SELECT COUNT(*)::int AS n FROM meta_fields WHERE sheet_id = $1', [sheetId])
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? -1)
}

const recordCount = async (sheetId: string): Promise<number> => {
  const res = await q('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
  return Number((res.rows[0] as { n?: number } | undefined)?.n ?? -1)
}

const fieldRow = async (fieldId: string): Promise<{ name: string; type: string } | null> => {
  const res = await q('SELECT name, type FROM meta_fields WHERE id = $1', [fieldId])
  const row = res.rows[0] as { name?: unknown; type?: unknown } | undefined
  return row ? { name: String(row.name ?? ''), type: String(row.type ?? '') } : null
}

describeIfDatabase('managed-sheet schema-write gate (real DB, real routes)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Managed-gate base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MANAGED_SHEET_ID, BASE_ID, 'Plugin target'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [PLAIN_SHEET_ID, BASE_ID, 'Ordinary sheet'])
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1,$2,$3,'string','{}'::jsonb,0)`,
      [MANAGED_FIELD_ID, MANAGED_SHEET_ID, 'Template column'],
    )
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1,$2,$3,'string','{}'::jsonb,0)`,
      [PLAIN_FIELD_ID, PLAIN_SHEET_ID, 'Ordinary column'],
    )
    // THE managed-sheet signal — the same table the sheet-delete refusal reads
    // (src/multitable/sheet-delete-guard.ts). Server-minted in the provisioning transaction; seeded
    // directly here because this file tests the READER of that row, not the provisioning that writes it.
    await q(
      `INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name)
       VALUES ($1,$2,$3,$4)`,
      [MANAGED_SHEET_ID, `proj_mgw_${TS}`, `obj_mgw_${TS}`, 'plugin-managed-gate-test'],
    )
    // The operator's ONLY authority: sheet-scoped full write on BOTH sheets (subject_id carries no FK,
    // mirroring the B1/B3 permission-matrix fixtures — no `users` row is required).
    for (const sheetId of [MANAGED_SHEET_ID, PLAIN_SHEET_ID]) {
      await q(
        'INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)',
        [sheetId, 'user', WRITER_USER, 'spreadsheet:write'],
      )
    }
  })

  afterAll(async () => {
    for (const sheetId of [MANAGED_SHEET_ID, PLAIN_SHEET_ID]) {
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
    }
    await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [MANAGED_SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MANAGED_SHEET_ID, PLAIN_SHEET_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── DENIED: the exposure the gate closes ──────────────────────────────────────
  test('sheet-scoped writer × MANAGED sheet — POST /fields is 403 and meta_fields row count is unchanged', async () => {
    const before = await fieldCount(MANAGED_SHEET_ID)
    const res = await request(writerApp())
      .post('/api/multitable/fields')
      .send({ sheetId: MANAGED_SHEET_ID, name: `New column ${TS}`, type: 'string' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    // Row COUNT equality, not name absence: a write that landed under any other name still reds this.
    expect(await fieldCount(MANAGED_SHEET_ID)).toBe(before)
  })

  test('sheet-scoped writer × MANAGED sheet — the import-shaped repeat (an id the caller chooses) is also 403, still zero landing', async () => {
    const before = await fieldCount(MANAGED_SHEET_ID)
    const res = await request(writerApp())
      .post('/api/multitable/fields')
      .send({ id: `fld_mgw_caller_${TS}`, sheetId: MANAGED_SHEET_ID, name: 'Template column', type: 'string' })
    expect(res.status).toBe(403)
    expect(await fieldCount(MANAGED_SHEET_ID)).toBe(before)
    // The name collides with the seeded template column on purpose: `meta_fields` has no
    // (sheet_id, name) uniqueness, so WITHOUT the gate this request lands a second, permanently
    // unfilled column of the same display name — the failure mode this PR exists to prevent.
    const dupes = await q('SELECT COUNT(*)::int AS n FROM meta_fields WHERE sheet_id = $1 AND name = $2', [MANAGED_SHEET_ID, 'Template column'])
    expect(Number((dupes.rows[0] as { n?: number } | undefined)?.n ?? -1)).toBe(1)
  })

  test('sheet-scoped writer × MANAGED sheet — PATCH /fields/:fieldId is 403 and the field definition is unchanged', async () => {
    const before = await fieldRow(MANAGED_FIELD_ID)
    const res = await request(writerApp())
      .patch(`/api/multitable/fields/${MANAGED_FIELD_ID}`)
      .send({ name: `Renamed ${TS}`, type: 'number' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(await fieldRow(MANAGED_FIELD_ID)).toEqual(before)
  })

  test('sheet-scoped writer × MANAGED sheet — DELETE /fields/:fieldId is 403 and the field is still there', async () => {
    const before = await fieldCount(MANAGED_SHEET_ID)
    const res = await request(writerApp()).delete(`/api/multitable/fields/${MANAGED_FIELD_ID}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual(FORBIDDEN_BODY)
    expect(await fieldCount(MANAGED_SHEET_ID)).toBe(before)
    expect(await fieldRow(MANAGED_FIELD_ID)).not.toBeNull()
  })

  // ── ALLOWED: the gate is scoped to managed sheets and to the schema plane ─────
  test('sheet-scoped writer × ORDINARY sheet — POST /fields still succeeds and adds exactly one row', async () => {
    const before = await fieldCount(PLAIN_SHEET_ID)
    const res = await request(writerApp())
      .post('/api/multitable/fields')
      .send({ sheetId: PLAIN_SHEET_ID, name: `Writer column ${TS}`, type: 'string' })
    expect(res.status).toBe(201)
    expect(res.body?.ok).toBe(true)
    expect(await fieldCount(PLAIN_SHEET_ID)).toBe(before + 1)
  })

  test('ADMIN × MANAGED sheet — POST /fields still succeeds and adds exactly one row (the repair path stays open)', async () => {
    const before = await fieldCount(MANAGED_SHEET_ID)
    const res = await request(adminApp())
      .post('/api/multitable/fields')
      .send({ sheetId: MANAGED_SHEET_ID, name: `Admin column ${TS}`, type: 'string' })
    expect(res.status).toBe(201)
    expect(res.body?.ok).toBe(true)
    expect(await fieldCount(MANAGED_SHEET_ID)).toBe(before + 1)
  })

  test('sheet-scoped writer × MANAGED sheet — the DATA plane is untouched: POST /records still lands a row', async () => {
    const before = await recordCount(MANAGED_SHEET_ID)
    const res = await request(writerApp())
      .post('/api/multitable/records')
      .send({ sheetId: MANAGED_SHEET_ID, data: { [MANAGED_FIELD_ID]: 'operator value' } })
    // POST /records answers `res.json(...)` (200), not 201 — univer-meta.ts's record-create route.
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(await recordCount(MANAGED_SHEET_ID)).toBe(before + 1)
  })
})
