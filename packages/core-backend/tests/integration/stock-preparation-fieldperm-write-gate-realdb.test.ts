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
const RC_FIELDS = [RC_MOVING, RC_STABLE, RC_UNGOVERNED]

const RC_PURCHASING = `role_bliao_rc_purchasing_${TS}`
const RC_WAREHOUSE = `role_bliao_rc_warehouse_${TS}`
const RC_ROLES = [RC_PURCHASING, RC_WAREHOUSE]

const RC_U_PURCHASING = `u_bliao_rc_purchasing_${TS}`
const RC_U_WAREHOUSE = `u_bliao_rc_warehouse_${TS}`
const RC_USERS = [RC_U_PURCHASING, RC_U_WAREHOUSE]

const OPERATOR_CREATED_BY = 'operator:univer-meta-authoring-route'

// The (columns × roles) rectangle the pack re-declares in full. RC_UNGOVERNED is deliberately NOT
// in it.
const RC_REGION = { fieldIds: [RC_MOVING, RC_STABLE], roleIds: RC_ROLES }
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
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [RC_SHEET]).catch(() => {})
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
    const v1 = await service.applyRoleWriteScopes({ sheetId: RC_SHEET, entries: RC_V1, reconcile: RC_REGION })
    expect(v1.applied).toBe(2)
    expect(v1.removed).toEqual([])

    // Two rows an OPERATOR authored, and one this port wrote for a column outside the region. All
    // three are positioned to be deleted if any of the four narrowings were missing.
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

    // Under v1, 采购 may NOT write the moving column — that is what v2 is about to change.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'v1-should-be-refused')).status).toBe(403)

    // ── v2 ────────────────────────────────────────────────────────────────────────────────────────
    const v2 = await service.applyRoleWriteScopes({ sheetId: RC_SHEET, entries: RC_V2, reconcile: RC_REGION })
    expect(v2.applied).toBe(2)
    expect(v2.removed).toEqual([{ fieldId: RC_MOVING, roleId: RC_PURCHASING }])

    // THE TABLE: exactly the rows that should be there, and the two untouchable ones still are.
    const rows = await scopeRows()
    expect(rows.map(key).sort()).toEqual([
      `${RC_MOVING}|${RC_WAREHOUSE}`,
      `${RC_STABLE}|${RC_PURCHASING}`, // the OPERATOR's row — same sheet, in-region column AND role
      `${RC_STABLE}|${RC_WAREHOUSE}`,
      `${RC_UNGOVERNED}|${RC_PURCHASING}`, // this port's row, on a column outside the region
    ].sort())
    expect(rows.find((r) => key(r) === `${RC_STABLE}|${RC_PURCHASING}`)!.created_by).toBe(OPERATOR_CREATED_BY)

    // THE GATE — the whole point. 采购 now OWNS the moving column and the write goes through …
    const allowed = await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'purchasing-owns-it-now')
    expect(allowed.status).toBe(200)
    const after = await q('SELECT data FROM meta_records WHERE id = $1', [RC_REC])
    expect((after.rows[0] as { data: Record<string, unknown> }).data[RC_MOVING]).toBe('purchasing-owns-it-now')

    // … while 仓库, which no longer owns it, is refused.
    expect((await rcPatch(RC_U_WAREHOUSE, [RC_WAREHOUSE], RC_MOVING, 'nope')).status).toBe(403)
  })
})
