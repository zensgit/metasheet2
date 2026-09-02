/**
 * 备料按部门列写权限 — END-TO-END proof (real DB) that `StockPreparationFieldPermissionsService`
 * is wired to the platform's REAL write gate, and that it scopes WRITE ONLY.
 *
 * The unit suite (tests/unit/stock-preparation-field-permissions.test.ts) proves the port's shape
 * and drives the enforcement chain in-process with mocked rows. THIS suite closes the loop with no
 * mocks anywhere between the port and the HTTP refusal:
 *
 *   port.applyRoleWriteScopes(...)  →  real `field_permissions` rows in Postgres
 *                                   →  real `POST /api/multitable/patch` on a mounted
 *                                      `univerMetaRouter()` (the same route the grid uses)
 *                                   →  403 for a cross-department write, 200 for an own-column write
 *
 * and, in the same run, proves the property the 备料 business flow depends on: READ IS NOT
 * RESTRICTED. 采购 and 仓库 each still SEE the 生产 band (材料类型 / 毛胚类型 / 需求日期 / 提前周期)
 * — which is what tells them WHAT to buy / prepare and BY WHEN — and each other's response columns.
 * A port that hid columns would break the flow and be worse than the status quo; this suite is the
 * assertion that would go red if it ever did.
 *
 * Runs only with DATABASE_URL. The fail-not-skip sentinel is TOP-LEVEL (outside describeIfDatabase)
 * and scoped to the real-DB allowlist step via METASHEET_REAL_DB_TEST_STEP, which is the pattern
 * that actually holds: a sentinel INSIDE describeIfDatabase skips together with the goldens it is
 * supposed to be guarding, so a step that lost DATABASE_URL would read green. See
 * multitable-exact-anchor-recovery-realdb.test.ts for the same wiring.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import {
  StockPreparationFieldPermissionsError,
  StockPreparationFieldPermissionsService,
  STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
} from '../../src/services/stock-preparation-field-permissions'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const BASE_ID = `base_bliao_${TS}`
const SHEET_ID = `sheet_bliao_${TS}`
const REC = `rec_bliao_${TS}`

// 生产 band — shared READ, written by neither department.
const F_MATERIAL_TYPE = `fld_bliao_material_${TS}` // 材料类型
const F_BLANK_TYPE = `fld_bliao_blank_${TS}` // 毛胚类型
const F_NEED_DATE = `fld_bliao_needdate_${TS}` // 需求日期
const F_LEAD_TIME = `fld_bliao_leadtime_${TS}` // 提前周期
const PRODUCTION_BAND = [F_MATERIAL_TYPE, F_BLANK_TYPE, F_NEED_DATE, F_LEAD_TIME]

// 采购 response columns.
const F_PURCHASE_REPLY = `fld_bliao_purchreply_${TS}` // 采购回复
const F_PURCHASE_ETA = `fld_bliao_purcheta_${TS}` // 采购到货日期
const PURCHASING_OWNED = [F_PURCHASE_REPLY, F_PURCHASE_ETA]

// 仓库 response columns.
const F_WAREHOUSE_STATUS = `fld_bliao_whstatus_${TS}` // 仓库备料状态
const F_WAREHOUSE_DATE = `fld_bliao_whdate_${TS}` // 仓库备料日期
const WAREHOUSE_OWNED = [F_WAREHOUSE_STATUS, F_WAREHOUSE_DATE]

const ALL_FIELDS = [...PRODUCTION_BAND, ...PURCHASING_OWNED, ...WAREHOUSE_OWNED]

const R_PURCHASING = `role_bliao_purchasing_${TS}`
const R_WAREHOUSE = `role_bliao_warehouse_${TS}`
const R_UNDECLARED = `role_bliao_undeclared_${TS}` // the control: no scope row anywhere
const ALL_ROLES = [R_PURCHASING, R_WAREHOUSE, R_UNDECLARED]

const U_PURCHASING = `u_bliao_purchasing_${TS}`
const U_WAREHOUSE = `u_bliao_warehouse_${TS}`
const U_UNDECLARED = `u_bliao_undeclared_${TS}`
const ALL_USERS = [U_PURCHASING, U_WAREHOUSE, U_UNDECLARED]

/** Exactly what a 备料 install declares: each department may not write the OTHER's response columns,
 *  and neither may write the 生产 band. Nothing here says anything about READ — by construction. */
const SCENARIO_ENTRIES = [
  ...PURCHASING_OWNED.map((fieldId) => ({ fieldId, roleId: R_WAREHOUSE })),
  ...WAREHOUSE_OWNED.map((fieldId) => ({ fieldId, roleId: R_PURCHASING })),
  ...PRODUCTION_BAND.flatMap((fieldId) => [
    { fieldId, roleId: R_PURCHASING },
    { fieldId, roleId: R_WAREHOUSE },
  ]),
]

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
let app: Express
// Mutable "current session actor" the fake session-auth middleware reads PER REQUEST — same pattern
// as multitable-fieldperm-write-gate-patch-realdb.test.ts / the W1-3 single-record realdb suite.
let currentUserId = U_PURCHASING
let currentRoles: string[] = [R_PURCHASING]

const patchAs = (
  userId: string,
  roles: string[],
  changes: Array<{ recordId: string; fieldId: string; value: unknown }>,
) => {
  currentUserId = userId
  currentRoles = roles
  return request(app).post('/api/multitable/patch').send({ sheetId: SHEET_ID, changes })
}

const readAs = (userId: string, roles: string[]) => {
  currentUserId = userId
  currentRoles = roles
  return request(app).get(`/api/multitable/records/${REC}`).query({ sheetId: SHEET_ID })
}

const cellValue = async (fieldId: string): Promise<unknown> => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [REC])
  return (r.rows[0] as { data?: Record<string, unknown> } | undefined)?.data?.[fieldId]
}

const seedValue = (fieldId: string) => `orig-${fieldId}`

// TOP-LEVEL (deliberately NOT inside describeIfDatabase) so the real-DB allowlist step FAILS — not
// silently skips — if it ever runs this file without a DB. This is the ONLY assertion in the file
// that can fire when the goldens are skipped, which is exactly why it cannot live inside the block
// they are in. Scoped to that step via METASHEET_REAL_DB_TEST_STEP (set by plugin-tests.yml's
// `multitable-real-db-integration` step alongside DATABASE_URL) so the normal no-DB core-backend
// job's collection of this file stays green.
test('sentinel: the real-DB allowlist step must have DATABASE_URL (fail-not-skip, scoped to that step)', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('real-DB allowlist step is missing DATABASE_URL — the harness is broken, not legitimately skippable')
  }
  expect(true).toBe(true)
})

describeIfDatabase('备料 per-department column WRITE scope, end to end (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = {
        id: currentUserId,
        roles: currentRoles,
        perms: ['multitable:read', 'multitable:write'],
      }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, '备料 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, '备料 Sheet'])
    for (const [index, fieldId] of ALL_FIELDS.entries()) {
      await q(
        'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fieldId, SHEET_ID, fieldId, 'string', '{}', index + 1],
      )
    }

    for (const roleId of ALL_ROLES) {
      await q('INSERT INTO roles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [roleId, roleId])
    }
    for (const [userId, roleId] of [
      [U_PURCHASING, R_PURCHASING],
      [U_WAREHOUSE, R_WAREHOUSE],
      [U_UNDECLARED, R_UNDECLARED],
    ] as Array<[string, string]>) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [userId, `${userId}@t.local`, JSON.stringify(['multitable:read', 'multitable:write'])],
      )
      await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, roleId])
    }

    // THE PORT — the real service against the real pool (no injected seam): exactly what
    // createPluginContext hands plugin-integration-core.
    const service = new StockPreparationFieldPermissionsService()
    const result = await service.applyRoleWriteScopes({ sheetId: SHEET_ID, entries: SCENARIO_ENTRIES })
    expect(result.applied).toBe(SCENARIO_ENTRIES.length)
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [ALL_USERS]).catch(() => {})
    await q('DELETE FROM roles WHERE id = ANY($1::text[])', [ALL_ROLES]).catch(() => {})
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      REC,
      SHEET_ID,
      JSON.stringify(Object.fromEntries(ALL_FIELDS.map((fieldId) => [fieldId, seedValue(fieldId)]))),
    ])
  })

  test('DATABASE_URL is set for this run (the goldens below are really executing)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── What the port actually persisted ───────────────────────────────────────────────────────────
  test('the port wrote role-scoped, read-only, SHARED-READ rows, stamped with its provenance marker', async () => {
    const rows = (
      await q(
        `SELECT field_id, subject_type, subject_id, visible, read_only, created_by
         FROM field_permissions WHERE sheet_id = $1 ORDER BY field_id, subject_id`,
        [SHEET_ID],
      )
    ).rows as Array<{
      field_id: string
      subject_type: string
      subject_id: string
      visible: boolean
      read_only: boolean
      created_by: string | null
    }>

    expect(rows).toHaveLength(SCENARIO_ENTRIES.length)
    for (const row of rows) {
      expect(row.subject_type).toBe('role')
      expect(row.read_only).toBe(true)
      // THE LOAD-BEARING PROPERTY, asserted against what is actually in Postgres.
      expect(row.visible).toBe(true)
      expect(row.created_by).toBe(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY)
    }
    // No row was written for the control role.
    expect(rows.some((row) => row.subject_id === R_UNDECLARED)).toBe(false)
  })

  test('the port is idempotent — re-applying the same declaration writes no extra rows', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]))
      .rows[0] as { n: number }
    await new StockPreparationFieldPermissionsService().applyRoleWriteScopes({
      sheetId: SHEET_ID,
      entries: SCENARIO_ENTRIES,
    })
    const after = (await q('SELECT count(*)::int AS n FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]))
      .rows[0] as { n: number }
    expect(after.n).toBe(before.n)
  })

  test('fail-closed against the real schema — an unknown role aborts with nothing written', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]))
      .rows[0] as { n: number }
    await expect(
      new StockPreparationFieldPermissionsService().applyRoleWriteScopes({
        sheetId: SHEET_ID,
        entries: [{ fieldId: F_PURCHASE_REPLY, roleId: `role_absent_${TS}` }],
      }),
    ).rejects.toBeInstanceOf(StockPreparationFieldPermissionsError)
    const after = (await q('SELECT count(*)::int AS n FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]))
      .rows[0] as { n: number }
    expect(after.n).toBe(before.n)
  })

  // ── WRITE is scoped ────────────────────────────────────────────────────────────────────────────
  test('仓库 user writing a 采购-owned column → 403, nothing written', async () => {
    for (const fieldId of PURCHASING_OWNED) {
      const res = await patchAs(U_WAREHOUSE, [R_WAREHOUSE], [{ recordId: REC, fieldId, value: 'warehouse-overwrote-purchasing' }])
      expect(res.status).toBe(403)
      expect(await cellValue(fieldId)).toBe(seedValue(fieldId))
    }
  })

  test('采购 user writing a 仓库-owned column → 403, nothing written (the reverse)', async () => {
    for (const fieldId of WAREHOUSE_OWNED) {
      const res = await patchAs(U_PURCHASING, [R_PURCHASING], [{ recordId: REC, fieldId, value: 'purchasing-overwrote-warehouse' }])
      expect(res.status).toBe(403)
      expect(await cellValue(fieldId)).toBe(seedValue(fieldId))
    }
  })

  test('each department writing ITS OWN column → 200, the write lands', async () => {
    for (const fieldId of PURCHASING_OWNED) {
      const res = await patchAs(U_PURCHASING, [R_PURCHASING], [{ recordId: REC, fieldId, value: `purchasing-wrote-${fieldId}` }])
      expect(res.status).toBe(200)
      expect(await cellValue(fieldId)).toBe(`purchasing-wrote-${fieldId}`)
    }
    for (const fieldId of WAREHOUSE_OWNED) {
      const res = await patchAs(U_WAREHOUSE, [R_WAREHOUSE], [{ recordId: REC, fieldId, value: `warehouse-wrote-${fieldId}` }])
      expect(res.status).toBe(200)
      expect(await cellValue(fieldId)).toBe(`warehouse-wrote-${fieldId}`)
    }
  })

  test('the 生产 band is not writable by either department → 403', async () => {
    for (const [userId, roleId] of [
      [U_PURCHASING, R_PURCHASING],
      [U_WAREHOUSE, R_WAREHOUSE],
    ] as Array<[string, string]>) {
      for (const fieldId of PRODUCTION_BAND) {
        const res = await patchAs(userId, [roleId], [{ recordId: REC, fieldId, value: 'department-edited-production' }])
        expect(res.status).toBe(403)
        expect(await cellValue(fieldId)).toBe(seedValue(fieldId))
      }
    }
  })

  test('a mixed request (own column + the other department’s) is rejected ATOMICALLY', async () => {
    const res = await patchAs(U_WAREHOUSE, [R_WAREHOUSE], [
      { recordId: REC, fieldId: F_WAREHOUSE_STATUS, value: 'should-not-persist' },
      { recordId: REC, fieldId: F_PURCHASE_REPLY, value: 'hacked' },
    ])
    expect(res.status).toBe(403)
    expect(await cellValue(F_WAREHOUSE_STATUS)).toBe(seedValue(F_WAREHOUSE_STATUS))
    expect(await cellValue(F_PURCHASE_REPLY)).toBe(seedValue(F_PURCHASE_REPLY))
  })

  // ── READ is NOT scoped — the owner's explicit constraint ────────────────────────────────────────
  test('READ IS SHARED — both departments still see the 生产 band AND the other department’s columns', async () => {
    for (const [userId, roleId] of [
      [U_PURCHASING, R_PURCHASING],
      [U_WAREHOUSE, R_WAREHOUSE],
    ] as Array<[string, string]>) {
      const res = await readAs(userId, [roleId])
      expect(res.status).toBe(200)
      const data = res.body?.data?.record?.data as Record<string, unknown>
      const fieldPermissions = res.body?.data?.fieldPermissions as Record<
        string,
        { visible: boolean; readOnly: boolean }
      >

      for (const fieldId of ALL_FIELDS) {
        // The VALUE survives the read-path field mask (which drops any field whose derived
        // permission has visible === false) …
        expect(data[fieldId], `${userId} must still read ${fieldId}`).toBe(seedValue(fieldId))
        // … and the derived permission itself says visible.
        expect(fieldPermissions[fieldId].visible, `${userId} must still see ${fieldId}`).toBe(true)
      }

      // Spelled out for the two things the 备料 flow actually depends on: the production band
      // (WHAT to buy / prepare and BY WHEN) and the other department's response.
      for (const fieldId of PRODUCTION_BAND) expect(fieldPermissions[fieldId].visible).toBe(true)
      expect(fieldPermissions[F_PURCHASE_REPLY].visible).toBe(true)
      expect(fieldPermissions[F_WAREHOUSE_STATUS].visible).toBe(true)

      // …while the WRITE dimension is exactly where the scope lives.
      const foreign = userId === U_PURCHASING ? WAREHOUSE_OWNED : PURCHASING_OWNED
      const own = userId === U_PURCHASING ? PURCHASING_OWNED : WAREHOUSE_OWNED
      for (const fieldId of foreign) expect(fieldPermissions[fieldId].readOnly).toBe(true)
      for (const fieldId of own) expect(fieldPermissions[fieldId].readOnly).toBe(false)
      for (const fieldId of PRODUCTION_BAND) expect(fieldPermissions[fieldId].readOnly).toBe(true)
    }
  })

  // ── The control ────────────────────────────────────────────────────────────────────────────────
  test('a user in an UNDECLARED role is completely unaffected — writes every column', async () => {
    const res = await patchAs(
      U_UNDECLARED,
      [R_UNDECLARED],
      ALL_FIELDS.map((fieldId) => ({ recordId: REC, fieldId, value: `undeclared-wrote-${fieldId}` })),
    )
    expect(res.status).toBe(200)
    for (const fieldId of ALL_FIELDS) {
      expect(await cellValue(fieldId)).toBe(`undeclared-wrote-${fieldId}`)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE SCOPED RECONCILE, AT THE GATE — a pack revision that MOVES a column between departments.
//
// The unit suite proves which ROWS survive the reconcile. This proves the thing that actually
// matters to the business: after the move, the department that now OWNS the column can WRITE it.
// Without the reconcile, v1's denial for the old owner survives beside v2's for the new one and
// `deriveFieldPermissions` ORs `read_only` across a user's rows — so BOTH departments get a 403 on
// a column the current declaration says one of them owns, and the install still reports success.
//
// Fully self-contained (its own base / sheet / fields / roles / users / express app) so it cannot
// disturb the goldens above, which share one seeded permission set across their tests.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const RC_BASE = `base_bliao_rc_${TS}`
const RC_SHEET = `sheet_bliao_rc_${TS}`
const RC_REC = `rec_bliao_rc_${TS}`

/** The column that changes hands between v1 and v2. */
const RC_MOVING = `fld_bliao_rc_moving_${TS}` // 实际到货日期
/** A second governed column that does NOT move — the "unchanged declaration" control. */
const RC_STABLE = `fld_bliao_rc_stable_${TS}` // 采购回复
/** Governed by no policy at all — the out-of-region control on the COLUMN axis. */
const RC_UNGOVERNED = `fld_bliao_rc_ungoverned_${TS}`
/** IN the rectangle but declared by NEITHER revision — where a SIBLING pack's live row sits. */
const RC_SHARED = `fld_bliao_rc_shared_${TS}`
const RC_FIELDS = [RC_MOVING, RC_STABLE, RC_UNGOVERNED, RC_SHARED]

const RC_PURCHASING = `role_bliao_rc_purchasing_${TS}`
const RC_WAREHOUSE = `role_bliao_rc_warehouse_${TS}`
const RC_ROLES = [RC_PURCHASING, RC_WAREHOUSE]

const RC_U_PURCHASING = `u_bliao_rc_purchasing_${TS}`
const RC_U_WAREHOUSE = `u_bliao_rc_warehouse_${TS}`
const RC_USERS = [RC_U_PURCHASING, RC_U_WAREHOUSE]

const OPERATOR_CREATED_BY = 'operator:univer-meta-authoring-route'
/** The pack under test, and a SIBLING pack that legitimately shares this canonical sheet. */
const RC_PACK = 'rc-pack-alpha'
const RC_OTHER_PACK = 'rc-pack-beta'
/** A second sheet carrying an IDENTICAL (field, role) pair — the sheet-axis control. */
const RC_TWIN_SHEET = `sheet_bliao_rc_twin_${TS}`

// The (columns × roles) rectangle the pack re-declares in full. RC_UNGOVERNED is deliberately NOT
// in it.
const RC_REGION = { fieldIds: [RC_MOVING, RC_STABLE, RC_SHARED], roleIds: RC_ROLES }
// v1: 仓库 owns the moving column, so 采购 is denied it. 采购 owns the stable column.
const RC_V1 = [
  { fieldId: RC_MOVING, roleId: RC_PURCHASING },
  { fieldId: RC_STABLE, roleId: RC_WAREHOUSE },
]
// v2: the moving column changes hands to 采购. Nothing else changes.
const RC_V2 = [
  { fieldId: RC_MOVING, roleId: RC_WAREHOUSE },
  { fieldId: RC_STABLE, roleId: RC_WAREHOUSE },
]

describeIfDatabase('备料 write scope — the scoped reconcile of a revision that moves a column', () => {
  let rcApp: Express
  let rcUser = RC_U_PURCHASING
  let rcRoles: string[] = [RC_PURCHASING]

  const rcPatch = (userId: string, roles: string[], fieldId: string, value: unknown) => {
    rcUser = userId
    rcRoles = roles
    return request(rcApp)
      .post('/api/multitable/patch')
      .send({ sheetId: RC_SHEET, changes: [{ recordId: RC_REC, fieldId, value }] })
  }

  const scopeRows = async () => (
    await q(
      `SELECT field_id, subject_id, read_only, created_by FROM field_permissions
        WHERE sheet_id = $1 ORDER BY field_id, subject_id`,
      [RC_SHEET],
    )
  ).rows as Array<{ field_id: string; subject_id: string; read_only: boolean; created_by: string }>

  const key = (row: { field_id: string; subject_id: string }) => `${row.field_id}|${row.subject_id}`

  beforeAll(async () => {
    rcApp = express()
    rcApp.use(express.json())
    rcApp.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = {
        id: rcUser,
        roles: rcRoles,
        perms: ['multitable:read', 'multitable:write'],
      }
      next()
    })
    rcApp.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [RC_BASE, '备料 Reconcile Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [RC_SHEET, RC_BASE, '备料 Reconcile Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [RC_TWIN_SHEET, RC_BASE, '备料 Reconcile Twin'])
    for (const [index, fieldId] of RC_FIELDS.entries()) {
      await q(
        'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fieldId, RC_SHEET, fieldId, 'string', '{}', index + 1],
      )
    }
    for (const roleId of RC_ROLES) {
      await q('INSERT INTO roles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [roleId, roleId])
    }
    for (const [userId, roleId] of [
      [RC_U_PURCHASING, RC_PURCHASING],
      [RC_U_WAREHOUSE, RC_WAREHOUSE],
    ] as Array<[string, string]>) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [userId, `${userId}@t.local`, JSON.stringify(['multitable:read', 'multitable:write'])],
      )
      await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, roleId])
    }
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[RC_SHEET, RC_TWIN_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[RC_SHEET, RC_TWIN_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [RC_BASE]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [RC_USERS]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [RC_USERS]).catch(() => {})
    await q('DELETE FROM roles WHERE id = ANY($1::text[])', [RC_ROLES]).catch(() => {})
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [RC_SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      RC_REC,
      RC_SHEET,
      JSON.stringify(Object.fromEntries(RC_FIELDS.map((fieldId) => [fieldId, seedValue(fieldId)]))),
    ])
  })

  test('v1 → v2: the old owner’s denial is deleted, and the new owner can actually WRITE the column', async () => {
    const service = new StockPreparationFieldPermissionsService()

    // ── v1 ────────────────────────────────────────────────────────────────────────────────────────
    const v1 = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V1, packId: RC_PACK, reconcile: RC_REGION,
    })
    expect(v1.applied).toBe(2)
    expect(v1.removed).toEqual([])

    // FOUR rows positioned to be deleted if any one narrowing were missing. Each fails exactly one:
    //   (a) an OPERATOR's row — same sheet, in-region column AND role; only `created_by` differs.
    //   (b) this plugin's row on a column OUTSIDE the region.
    //   (c) ANOTHER PACK's row — same sheet, IN-REGION column AND role, plugin family; only the
    //       pack id inside the marker differs, and neither revision DECLARES the pair. This is the
    //       two-packs-one-sheet case that must coexist rather than refuse (a DECLARED overlap is a
    //       422 instead, witnessed in its own test below).
    //   (e) an OPERATOR EDIT on a pair v2 DOES declare, in the shape the authoring route wrote
    //       before it started stamping: `created_by` NULL, hidden, writable.
    //   (d) an identical (field, role) pair on ANOTHER SHEET. Only `sheet_id = $1` saves it, and
    //       `field_permissions` has no tenant or project column, so that clause is the entire
    //       project/tenant bound of the statement.
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_SHEET, RC_STABLE, RC_PURCHASING, OPERATOR_CREATED_BY],
    )
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_SHEET, RC_UNGOVERNED, RC_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
    )
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_SHEET, RC_SHARED, RC_WAREHOUSE, `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`],
    )
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_TWIN_SHEET, RC_MOVING, RC_PURCHASING, `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_PACK}`],
    )
    // (e) AN OPERATOR EDIT ON A PAIR v2 DECLARES, in the shape the authoring route wrote before it
    //     started stamping: `created_by` NULL, the column HIDDEN, and writable. This is the case the
    //     first revision silently destroyed — its unconditional `visible = true, read_only = true`
    //     un-hid the column and imposed a denial the reconcile could then never retire (round-2
    //     findings 3, 9 and 15). v2 must SKIP the pair entirely and leave all three columns alone.
    await q(
      `UPDATE field_permissions SET visible = false, read_only = false, created_by = NULL
        WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'role' AND subject_id = $3`,
      [RC_SHEET, RC_STABLE, RC_WAREHOUSE],
    )

    // Under v1, 采购 may NOT write the moving column — that is what v2 is about to change.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'v1-should-be-refused')).status).toBe(403)

    // ── v2 ────────────────────────────────────────────────────────────────────────────────────────
    const v2 = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V2, packId: RC_PACK, reconcile: RC_REGION,
    })
    // ONE row written, not two: the operator holds `RC_STABLE|RC_WAREHOUSE`, so the upsert SKIPPED
    // that pair entirely rather than rewriting a human's decision.
    expect(v2.applied).toBe(1)
    expect(v2.removed).toEqual([{ fieldId: RC_MOVING, roleId: RC_PURCHASING }])
    expect(v2.operatorHeld).toEqual([{ fieldId: RC_STABLE, roleId: RC_WAREHOUSE, packId: null }])
    expect(v2.governedByOtherPacks)
      .toEqual([{ fieldId: RC_SHARED, roleId: RC_WAREHOUSE, packId: RC_OTHER_PACK }])

    // THE TABLE: exactly the rows that should be there, and the untouchable ones still are.
    const rows = await scopeRows()
    expect(rows.map(key).sort()).toEqual([
      `${RC_MOVING}|${RC_WAREHOUSE}`,
      `${RC_SHARED}|${RC_WAREHOUSE}`, // the SIBLING PACK's row — in-region, declared by neither
      `${RC_STABLE}|${RC_PURCHASING}`, // the OPERATOR's row — same sheet, in-region column AND role
      `${RC_STABLE}|${RC_WAREHOUSE}`,
      `${RC_UNGOVERNED}|${RC_PURCHASING}`, // this port's row, on a column outside the region
    ].sort())
    expect(rows.find((r) => key(r) === `${RC_STABLE}|${RC_PURCHASING}`)!.created_by).toBe(OPERATOR_CREATED_BY)
    // ═══ THE OPERATOR'S EDIT SURVIVED INTACT, IN REAL POSTGRES. ═══
    // All three columns are exactly as the human left them: still hidden, still writable, still
    // unattributed. The previous revision's unconditional `visible = true, read_only = true` un-hid
    // the column and created a denial the reconcile could never retire.
    const operatorEdited = await q(
      `SELECT visible, read_only, created_by FROM field_permissions
        WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'role' AND subject_id = $3`,
      [RC_SHEET, RC_STABLE, RC_WAREHOUSE],
    )
    expect(operatorEdited.rows[0]).toMatchObject({ visible: false, read_only: false, created_by: null })
    // The sibling pack's row was neither deleted nor re-stamped — its provenance is not this pack's
    // to take, and the pair is not one this pack declares.
    expect(rows.find((r) => key(r) === `${RC_SHARED}|${RC_WAREHOUSE}`)!.created_by)
      .toBe(`${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`)
    // The re-declared row on the moving column belongs to THIS pack.
    expect(rows.find((r) => key(r) === `${RC_MOVING}|${RC_WAREHOUSE}`)!.created_by)
      .toBe(`${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_PACK}`)
    // THE SHEET AXIS: the identical pair on the twin sheet is untouched.
    const twin = await q(
      'SELECT field_id, subject_id FROM field_permissions WHERE sheet_id = $1',
      [RC_TWIN_SHEET],
    )
    expect(twin.rows).toHaveLength(1)

    // THE CENSUS attributes every row, and never claims one it did not write.
    const census = await service.listRoleWriteScopes({ sheetId: RC_SHEET })
    expect(census.entries.map((entry) => `${entry.fieldId}|${entry.roleId}|${entry.packId}`).sort()).toEqual([
      `${RC_MOVING}|${RC_WAREHOUSE}|${RC_PACK}`,
      `${RC_SHARED}|${RC_WAREHOUSE}|${RC_OTHER_PACK}`,
      `${RC_UNGOVERNED}|${RC_PURCHASING}|null`,
    ].sort())
    // The operator's HIDDEN-but-writable row is in NEITHER list: it is not a write denial at all
    // (`read_only = false`), which is exactly why the census cannot see it and the CLASSIFICATION
    // must — the classifier reads both dimensions, the census only denials.
    expect(census.foreignEntries).toEqual([
      { fieldId: RC_STABLE, roleId: RC_PURCHASING, createdBy: OPERATOR_CREATED_BY },
    ])

    // THE GATE — the whole point. 采购 now OWNS the moving column and the write goes through …
    const allowed = await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'purchasing-owns-it-now')
    expect(allowed.status).toBe(200)
    const after = await q('SELECT data FROM meta_records WHERE id = $1', [RC_REC])
    expect((after.rows[0] as { data: Record<string, unknown> }).data[RC_MOVING]).toBe('purchasing-owns-it-now')

    // … while 仓库, which no longer owns it, is refused.
    expect((await rcPatch(RC_U_WAREHOUSE, [RC_WAREHOUSE], RC_MOVING, 'nope')).status).toBe(403)
  })

  /**
   * ═══ RC1 AGAINST REAL POSTGRES: a region with NO entries at all. ═══
   *
   * A revision that hands every governed column to every declared role derives ZERO denials, so an
   * entries-empty call is exactly how "this rectangle should now hold no denial" is expressed. It is
   * an RC-headline behaviour of the port and it was executed in CI only against the in-memory
   * decoding pool and the plugin's fake port (round-2 finding 21). Here it runs the real statements,
   * and the proof is at the GATE: both departments can write the column afterwards.
   */
  test('RC1 real-DB: an entries-EMPTY reconcile clears the rectangle and both roles can write', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V1, packId: RC_PACK, reconcile: RC_REGION,
    })
    // Under v1 each department is refused the other's column.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'v1-refused')).status).toBe(403)
    expect((await rcPatch(RC_U_WAREHOUSE, [RC_WAREHOUSE], RC_STABLE, 'v1-refused')).status).toBe(403)

    // v3: SHARED CUSTODY. Every declared role owns every governed column, so the declaration derives
    // no denial — and the rectangle must end up empty rather than frozen at v1.
    const v3 = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: [], packId: RC_PACK, reconcile: RC_REGION,
    })
    expect(v3.applied).toBe(0)
    expect(v3.removed).toEqual([
      { fieldId: RC_MOVING, roleId: RC_PURCHASING },
      { fieldId: RC_STABLE, roleId: RC_WAREHOUSE },
    ])
    expect(await scopeRows()).toEqual([])

    // THE GATE: both departments now write both columns.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'shared-1')).status).toBe(200)
    expect((await rcPatch(RC_U_WAREHOUSE, [RC_WAREHOUSE], RC_STABLE, 'shared-2')).status).toBe(200)
  })

  /**
   * ═══ THE LEGACY ARM OF `created_by = ANY($2)`, AGAINST REAL POSTGRES. ═══
   *
   * The second element of that array — the pack-LESS marker — is the arm the P0 was about, and it
   * had never been executed against Postgres (round-2 finding 21). Both directions are exercised
   * here, because the two are one decision: WITHOUT the caller's proof the call REFUSES and writes
   * nothing; WITH it, the row is adopted and retired.
   */
  test('RC2 real-DB: a pack-less legacy row refuses without proof and is retired with it', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    // A row exactly as every host in the field carries it today: this plugin's marker, no pack id.
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_SHEET, RC_MOVING, RC_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
    )

    // WITHOUT PROOF: refused, and — the load-bearing half — nothing was written or deleted.
    await expect(service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V2, packId: RC_PACK, reconcile: RC_REGION,
    })).rejects.toMatchObject({ reason: 'LEGACY_UNATTRIBUTED' })
    const untouched = await scopeRows()
    expect(untouched).toHaveLength(1)
    expect(untouched[0].created_by).toBe(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY)

    // WITH PROOF (the install ledger showed this pack is the sheet's only pack): the same call
    // adopts the row's rectangle and retires it, because v2 no longer declares that pair.
    const adopted = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V2, packId: RC_PACK, reconcile: RC_REGION, legacyAdoptable: true,
    })
    expect(adopted.removed).toEqual([{ fieldId: RC_MOVING, roleId: RC_PURCHASING }])
    const after = await scopeRows()
    expect(after.map(key).sort()).toEqual([
      `${RC_MOVING}|${RC_WAREHOUSE}`,
      `${RC_STABLE}|${RC_WAREHOUSE}`,
    ].sort())
    // And 采购, whose legacy denial has just been retired, can really write the column.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'legacy-retired')).status).toBe(200)
  })

  /**
   * ═══ THE CROSS-PACK REFUSAL, INSIDE THE WRITE'S OWN TRANSACTION. ═══
   *
   * The installer refuses this in its pre-flight, over an untouched sheet. The port refuses it AGAIN
   * inside `applyRoleWriteScopes`' transaction under the `meta_sheets` row lock, which is the half
   * that survives concurrency: two installs that each passed their own pre-flight cannot both write
   * (round-2 finding 18). Only real Postgres can witness the transaction actually rolling back.
   */
  test('RC2 real-DB: another pack on a DECLARED pair refuses inside the transaction, writing nothing', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    // The sibling pack holds a pair THIS pack is about to declare.
    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,true,$4)`,
      [RC_SHEET, RC_MOVING, RC_WAREHOUSE, `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`],
    )

    await expect(service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V2, packId: RC_PACK, reconcile: RC_REGION,
    })).rejects.toMatchObject({
      reason: 'PACK_CONFLICT',
      pairs: [{ fieldId: RC_MOVING, roleId: RC_WAREHOUSE, packId: RC_OTHER_PACK }],
    })

    // THE TRANSACTION ROLLED BACK: the sibling's row is byte-identical and the OTHER entry this call
    // would have written (RC_STABLE|RC_WAREHOUSE) does not exist. A refusal that left half the
    // upserts behind would be worse than no refusal.
    const rows = await scopeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      field_id: RC_MOVING,
      subject_id: RC_WAREHOUSE,
      created_by: `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`,
    })
  })

  /**
   * ═══ THE PRE-FLIGHT'S FIELD AXIS, AGAINST THE REAL `meta_fields`. ═══
   *
   * `findMissingFieldIds` is the question the installer asks before it creates a single column, and
   * it is answered by the same statement `applyRoleWriteScopes` runs inside its transaction — so
   * "the pre-flight said yes" and "the write agreed" cannot come apart on the shape of the question.
   */
  test('findMissingFieldIds names exactly the columns this sheet does not have', async () => {
    const service = new StockPreparationFieldPermissionsService()
    const absent = `fld_bliao_rc_absent_${TS}`
    expect(await service.findMissingFieldIds({ sheetId: RC_SHEET, fieldIds: RC_FIELDS }))
      .toEqual({ missing: [] })
    expect(await service.findMissingFieldIds({ sheetId: RC_SHEET, fieldIds: [RC_MOVING, absent] }))
      .toEqual({ missing: [absent] })
    // Scoped to THIS sheet: a real column belonging to the twin sheet is "missing" here, which is
    // the whole point — `field_permissions.field_id` must reference a field OF THIS SHEET.
    expect(await service.findMissingFieldIds({ sheetId: RC_TWIN_SHEET, fieldIds: [RC_MOVING] }))
      .toEqual({ missing: [RC_MOVING] })
  })
})
