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
 * THIRD BLOCK (2026-09-11) — 特征化 golden「网格红 / 插件绿」: the same column, denied to EVERY role in
 * its fixture, is 403 through the grid and WRITABLE through the production plugin SDK. That green is a
 * CHARACTERIZATION of today's behaviour, never an endorsement — see that block's own header for what to
 * do when it changes colour.
 *
 * WHERE THIS RUNS. Nowhere without a database — by construction, and on purpose: this file is in
 * `packages/core-backend/vitest.config.ts`'s `exclude:` list, so the no-DB default job cannot collect it
 * and skip-green it, and it is named WHOLE-FILE in the `multitable-real-db-integration` step of
 * `.github/workflows/plugin-tests.yml` (the step that sets DATABASE_URL and METASHEET_REAL_DB_TEST_STEP).
 * Both halves of that wiring are asserted, not just described, by the `wiring:` test in
 * `tests/unit/multitable-w13-write-path-layer3-gate.guard.test.ts` — so losing either one reds a unit
 * test that DOES run on every PR, instead of silently turning this file into decoration.
 * Corollary worth stating plainly: on a developer machine with no PostgreSQL this whole file reports
 * `skipped`, and a green local run says NOTHING about the legs below.
 *
 * Runs only with DATABASE_URL. The fail-not-skip sentinel is TOP-LEVEL (outside describeIfDatabase)
 * and scoped to the real-DB allowlist step via METASHEET_REAL_DB_TEST_STEP, which is the pattern
 * that actually holds: a sentinel INSIDE describeIfDatabase skips together with the goldens it is
 * supposed to be guarding, so a step that lost DATABASE_URL would read green. See
 * multitable-exact-anchor-recovery-realdb.test.ts for the same wiring.
 */
import { createRequire } from 'node:module'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

import { poolManager } from '../../src/integration/db/connection-pool'
// 特征化 golden 的腿 2 用它取到生产插件 SDK(createCoreAPI),而不是手搓 query 直连 records.ts。
import { MetaSheetServer } from '../../src/index'
import { buildXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'
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
/** The HUMAN who edits a permission through the real authoring route. R1's actor. */
const RC_U_OPERATOR = `u_bliao_rc_operator_${TS}`
const RC_USERS = [RC_U_PURCHASING, RC_U_WAREHOUSE, RC_U_OPERATOR]

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
  // The authoring PUT is gated on canManageFields, which needs manage-schema perms AND a sheet-level
  // grant — so the operator actor is a different principal from the two department users.
  let rcPerms: string[] = ['multitable:read', 'multitable:write']

  const rcPatch = (userId: string, roles: string[], fieldId: string, value: unknown) => {
    rcUser = userId
    rcRoles = roles
    rcPerms = ['multitable:read', 'multitable:write']
    return request(rcApp)
      .post('/api/multitable/patch')
      .send({ sheetId: RC_SHEET, changes: [{ recordId: RC_REC, fieldId, value }] })
  }

  /**
   * THE REAL OPERATOR-FACING AUTHORING ROUTE — `PUT .../field-permissions/:fieldId/role/:roleId`.
   *
   * Driven end-to-end rather than simulated. Every operator fixture in this branch until now
   * FABRICATED the row with a hardcoded `created_by` literal, so nothing anywhere executed the
   * statement that actually stamps it (round-3 P1). This is the only place the two halves of R1 meet.
   */
  const rcPutFieldPermission = (
    fieldId: string,
    roleId: string,
    body: { visible?: boolean; readOnly?: boolean; remove?: boolean },
  ) => {
    rcUser = RC_U_OPERATOR
    rcRoles = []
    rcPerms = ['multitable:read', 'multitable:write', 'multitable:manage', 'multitable:manage-schema']
    return request(rcApp)
      .put(`/api/multitable/sheets/${RC_SHEET}/field-permissions/${fieldId}/role/${roleId}`)
      .send(body)
  }

  /** One row, both dimensions and its provenance — what the classifier reads. */
  const rcRow = async (fieldId: string, roleId: string) => (await q(
    `SELECT visible, read_only, created_by FROM field_permissions
      WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'role' AND subject_id = $3`,
    [RC_SHEET, fieldId, roleId],
  )).rows[0] as { visible: boolean; read_only: boolean; created_by: string | null } | undefined

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
        perms: rcPerms,
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
    // THE OPERATOR: no department role, but sheet-admin on this sheet, which is what
    // `canManageFields` resolves from. Without the grant the authoring PUT answers 403 and the R1
    // witness below would pass vacuously.
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [RC_U_OPERATOR, `${RC_U_OPERATOR}@t.local`, JSON.stringify(['multitable:read', 'multitable:write'])],
    )
    await q(
      `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
       VALUES ($1,'user',$2,'spreadsheet:admin') ON CONFLICT DO NOTHING`,
      [RC_SHEET, RC_U_OPERATOR],
    )
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
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [RC_SHEET]).catch(() => {})
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
   * ═══ C0 AGAINST REAL POSTGRES: THE UPSERT'S OWNERSHIP GUARD, BOTH BRANCHES. ═══
   *
   * The guard is a `CASE WHEN created_by = ANY($5::text[])` inside an `ON CONFLICT DO UPDATE`, and
   * its whole behaviour is Postgres semantics no in-memory model can settle: whether the ELSE branch
   * really leaves the row's own `visible`/`read_only`/`created_by` bytes alone, and whether the
   * marker set really excludes the bare legacy marker when adoption was not proven.
   *
   * TWO rows are seeded, both carrying this plugin's BARE marker with an operator's pre-stamping
   * decision layered on top, because the two shapes have DIFFERENT consequences at the write gate
   * and conflating them is how "no protection is lost" was asserted without being true:
   *   · RC_MOVING — `visible = true, read_only = false`: the operator RELAXED the denial. This is
   *     the ONE shape where the conservative fix gives something up: the denial this install
   *     declares does NOT come into force and the column stays writable (asserted below: 200).
   *   · RC_STABLE — `visible = false, read_only = false`: the operator HID the column. Hidden is
   *     itself unwritable at the gate (`isFieldWriteForbidden`: `!perm || visible === false ||
   *     readOnly === true`), so the patch is 403 either way. What this fix protects THERE is the
   *     operator's two dimensions and the row's provenance — not its writability.
   *
   * Before this fix the bare marker was bound to the guard unconditionally, so an entries-only
   * install put both dimensions back to true and re-stamped both rows with its own pack id —
   * un-hiding a column a human hid, reverting a relaxation, counting both in `applied`, and
   * reporting them in nothing at all.
   */
  test('C0 real-DB: an ADDITIVE install leaves an unclaimable pack-less row byte-identical', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,true,false,$5), ($1,$4,'role',$3,false,false,$5)`,
      [
        RC_SHEET, RC_MOVING, RC_PURCHASING, RC_STABLE,
        STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
      ],
    )

    // NO REGION, NO PROOF — the additive path, which classifies nothing and therefore has only the
    // upsert's guard between it and the operator's row.
    const result = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET,
      entries: [
        { fieldId: RC_MOVING, roleId: RC_PURCHASING },
        { fieldId: RC_STABLE, roleId: RC_PURCHASING },
      ],
      packId: RC_PACK,
    })
    expect(result.removed).toEqual([])

    // ALL THREE COLUMNS TOOK THE ELSE BRANCH, in the database rather than in a model of it.
    expect(await rcRow(RC_MOVING, RC_PURCHASING)).toEqual({
      visible: true,
      read_only: false,
      created_by: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
    })
    expect(await rcRow(RC_STABLE, RC_PURCHASING)).toEqual({
      visible: false,
      read_only: false,
      created_by: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
    })

    // ═══ THE COST, NAMED — this is the fail-open direction and it is not free. ═══
    // Neither declaration came into force, so neither is counted in `applied`, and both pairs come
    // back so the installer can say exactly which (column, role) it declared and did not get.
    expect(result.skippedUnattributed).toEqual([
      { fieldId: RC_MOVING, roleId: RC_PURCHASING, packId: null },
      { fieldId: RC_STABLE, roleId: RC_PURCHASING, packId: null },
    ])
    expect(result.applied).toBe(0)

    // 采购 really can still write the RELAXED column — the declared denial did not land. Before the
    // fix this was a 403, and that protection is exactly what the conservative reading gives up.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'still-relaxed')).status)
      .toBe(200)
    // The HIDDEN column is refused — because it is hidden, which is the host's own rule and not
    // something this install asserted. The bytes checked above are what the fix preserved there.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_STABLE, 'hidden-is-not-writable')).status)
      .toBe(403)

    // WITH THE PROOF the same call adopts both rows — the fix narrows WHEN, it does not remove the
    // capability. `visible` comes back up (this port can only ever widen read) and the denial is
    // re-asserted under this pack's marker.
    const adopted = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET,
      entries: [
        { fieldId: RC_MOVING, roleId: RC_PURCHASING },
        { fieldId: RC_STABLE, roleId: RC_PURCHASING },
      ],
      packId: RC_PACK,
      legacyAdoptable: true,
    })
    expect(adopted.skippedUnattributed).toEqual([])
    expect(adopted.applied).toBe(2)
    for (const fieldId of [RC_MOVING, RC_STABLE]) {
      expect(await rcRow(fieldId, RC_PURCHASING)).toEqual({
        visible: true,
        read_only: true,
        created_by: `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_PACK}`,
      })
    }
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'now-denied')).status)
      .toBe(403)
  })

  /**
   * THE OTHER TWO SHAPES THE GUARD MUST REFUSE, against real Postgres: `created_by` NULL (what every
   * operator row in the field carries) and a SIBLING pack's marker. `NULL = ANY(...)` is NULL, not
   * true — the ELSE branch — and that is load-bearing rather than incidental: a `NOT IN`-shaped
   * guard would make the same row take the THEN branch.
   */
  test('C0 real-DB: a NULL-provenance row and a sibling pack\'s row both take the ELSE branch', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    await q(
      `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
       VALUES ($1,$2,'role',$3,false,false,NULL), ($1,$4,'role',$3,false,false,$5)`,
      [
        RC_SHEET, RC_MOVING, RC_PURCHASING, RC_STABLE,
        `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`,
      ],
    )

    const result = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET,
      entries: [
        { fieldId: RC_MOVING, roleId: RC_PURCHASING },
        { fieldId: RC_STABLE, roleId: RC_PURCHASING },
      ],
      packId: RC_PACK,
      // Even WITH the proof: adoption covers the pack-less marker, never a human's row and never a
      // sibling pack's.
      legacyAdoptable: true,
    })

    // BOTH ARE REPORTED, AND THE SIBLING IS REPORTED BY NAME — `packId` is decoded from the marker
    // Postgres actually returned, so the owner in the report is the owner in the row rather than a
    // guess made from the request. Neither declaration is counted as applied.
    expect(result.skippedUnattributed).toEqual([
      { fieldId: RC_MOVING, roleId: RC_PURCHASING, packId: null },
      { fieldId: RC_STABLE, roleId: RC_PURCHASING, packId: RC_OTHER_PACK },
    ])
    expect(result.applied).toBe(0)

    expect(await rcRow(RC_MOVING, RC_PURCHASING)).toEqual({
      visible: false, read_only: false, created_by: null,
    })
    expect(await rcRow(RC_STABLE, RC_PURCHASING)).toEqual({
      visible: false,
      read_only: false,
      created_by: `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_OTHER_PACK}`,
    })
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

  /**
   * ═══ R1, END TO END, THROUGH THE REAL AUTHORING ROUTE. ═══
   *
   * The one witness that was missing entirely (round-3 P1). Every operator fixture on this branch
   * fabricated its row with a hardcoded `created_by` literal, so nothing anywhere executed the
   * statement that actually stamps one — the whole of R1 could be deleted and CI stayed green.
   *
   * The chain this drives is the real one: a HUMAN edits a permission on a pair a customer pack
   * already owns, through `PUT .../field-permissions/...`, and that write must TAKE OVER the
   * provenance. `created_by = EXCLUDED.created_by` on the DO UPDATE is the token that does it, and
   * everything downstream depends on it — without the flip the row keeps the PACK's marker and the
   * next revision's reconcile deletes the human's decision (round-2 findings 12 and 17).
   */
  test('R1 real-DB: an operator edit takes over a PACK-marked row, and the next revisions honour it', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])
    const service = new StockPreparationFieldPermissionsService()

    // v1 — the pack denies 采购 the moving column. The row is unambiguously THIS PACK's.
    await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V1, packId: RC_PACK, reconcile: RC_REGION,
    })
    expect((await rcRow(RC_MOVING, RC_PURCHASING))?.created_by)
      .toBe(`${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${RC_PACK}`)

    // ── THE OPERATOR EDITS IT, through the route a human actually uses ────────────────────────────
    // They HIDE the column as well as denying the write — a read decision this port is structurally
    // incapable of making, which is exactly why it must survive everything below.
    const put = await rcPutFieldPermission(RC_MOVING, RC_PURCHASING, { visible: false, readOnly: true })
    expect(put.status).toBe(200)

    // THE FLIP. This single assertion is the whole of R1: the row is no longer attributable to the
    // pack, and `parseStockPreparationFieldPermissionCreatedBy` now reads it as somebody else's.
    const edited = await rcRow(RC_MOVING, RC_PURCHASING)
    expect(edited?.created_by).toBe(`operator:${RC_U_OPERATOR}`)
    expect(edited?.visible).toBe(false)
    expect(edited?.read_only).toBe(true)

    // ── CONSEQUENCE 1: a revision that STILL DECLARES the pair defers to the human ────────────────
    // The upsert is skipped for that pair, so the operator's HIDE survives an install that would
    // otherwise have re-asserted `visible = true`, and the pair is named rather than silently kept.
    const again = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V1, packId: RC_PACK, reconcile: RC_REGION,
    })
    expect(again.operatorHeld).toEqual([{ fieldId: RC_MOVING, roleId: RC_PURCHASING, packId: null }])
    expect(again.removed).toEqual([])
    const afterRedeclare = await rcRow(RC_MOVING, RC_PURCHASING)
    expect(afterRedeclare).toMatchObject({
      visible: false, read_only: true, created_by: `operator:${RC_U_OPERATOR}`,
    })

    // ── CONSEQUENCE 2: a revision that DROPS the pair does not retire it ──────────────────────────
    // This is round-2 findings 12/17 as an executable regression. Before R1 this row still carried
    // the pack's marker, so v2's reconcile deleted the operator's decision and reported it as its own
    // history. It must now survive untouched.
    const v2 = await service.applyRoleWriteScopes({
      sheetId: RC_SHEET, entries: RC_V2, packId: RC_PACK, reconcile: RC_REGION,
    })
    expect(v2.removed).toEqual([])
    const survived = await rcRow(RC_MOVING, RC_PURCHASING)
    expect(survived).toMatchObject({
      visible: false, read_only: true, created_by: `operator:${RC_U_OPERATOR}`,
    })

    // …and the census still refuses to claim it: an operator's row is never this plugin's.
    const census = await service.listRoleWriteScopes({ sheetId: RC_SHEET })
    expect(census.entries.map((entry) => `${entry.fieldId}|${entry.roleId}`))
      .not.toContain(`${RC_MOVING}|${RC_PURCHASING}`)
    expect(census.foreignEntries).toContainEqual({
      fieldId: RC_MOVING, roleId: RC_PURCHASING, createdBy: `operator:${RC_U_OPERATOR}`,
    })

    // THE GATE agrees with the human: 采购 is still refused the column the operator locked, even
    // though the pack's v2 declaration says nothing about that pair any more.
    expect((await rcPatch(RC_U_PURCHASING, [RC_PURCHASING], RC_MOVING, 'operator-said-no')).status).toBe(403)
  })

  /**
   * The de-escalation restore path stamps too — the SECOND write site the source guard pins. It is
   * reached by the permission-revert flow rather than by this route, so it is exercised here through
   * the same helper's `remove` arm plus a re-grant, which is the shape that path replays.
   */
  test('R1 real-DB: removing and re-granting through the route leaves an attributable row', async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [RC_SHEET])

    expect((await rcPutFieldPermission(RC_STABLE, RC_WAREHOUSE, { visible: true, readOnly: true })).status).toBe(200)
    expect((await rcRow(RC_STABLE, RC_WAREHOUSE))?.created_by).toBe(`operator:${RC_U_OPERATOR}`)

    expect((await rcPutFieldPermission(RC_STABLE, RC_WAREHOUSE, { remove: true })).status).toBe(200)
    expect(await rcRow(RC_STABLE, RC_WAREHOUSE)).toBeUndefined()

    // Re-granting goes through the DO UPDATE arm on a fresh INSERT — still stamped, never NULL.
    expect((await rcPutFieldPermission(RC_STABLE, RC_WAREHOUSE, { visible: true, readOnly: false })).status).toBe(200)
    const regranted = await rcRow(RC_STABLE, RC_WAREHOUSE)
    expect(regranted?.created_by).toBe(`operator:${RC_U_OPERATOR}`)
    expect(regranted?.read_only).toBe(false)
  })

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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 特征化 GOLDEN — 列权限墙不在插件写路径上(网格红 / 插件绿)
//
// 这不是背书。这是把一个"已经成立但没有任何可执行断言"的事实钉成一条会变红的测试。
//
// 同一张表、同一行、同一列、同一个值,两条腿并排跑:
//   腿 1(网格/HTTP):`POST /api/multitable/patch` —— 该列对本 fixture 里的每一个角色都是 read_only,
//                     所以 403,`meta_records.data` 一个字节都没动。这条腿与本文件上方的既有 403 腿
//                     同形,是"墙确实存在于网格路径上"的证据。
//   腿 2(插件 SDK):生产环境的 `MetaSheetServer.createCoreAPI().multitable.records.patchRecord`
//                     —— 同一列写入成功。插件通道自始至终不带 actor,所以根本没有任何一行
//                     `field_permissions` 会被读到(见
//                     tests/unit/multitable-w13-write-path-layer3-gate.guard.test.ts 的
//                     `records.ts.patchRecord` 端口与它的 characterization 断言)。
//
// 如果腿 2 哪天变红:说明有人给插件写路径加了列级权限门。那是行为变更,不是测试坏了 —— 请回到这里
// 改断言,并同步 docs/development/takeover-beiliao-20260821/stock-preparation-overall-plan-20260902.md
// §10 的那一条结论,以及上面那支 unit 守卫里 `UNGATED_CHARACTERIZED` 的措辞。
//
// 反之如果腿 1 变红(插件绿而网格也绿),说明列权限墙整个塌了 —— 那是 P0。
//
// 自带 base / sheet / fields / roles / user / express app,不碰上面两个 block 的夹具。
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const PG_BASE = `base_bliao_pg_${TS}`
const PG_SHEET = `sheet_bliao_pg_${TS}`
const PG_REC = `rec_bliao_pg_${TS}`

/** 被"对所有角色"置为 read_only 的那一列 —— 两条腿写的都是它。 */
const PG_LOCKED = `fld_bliao_pg_locked_${TS}`
/** 没有任何策略的对照列 —— 用来证明 403 是因为这一列,而不是夹具整体坏掉。 */
const PG_FREE = `fld_bliao_pg_free_${TS}`
const PG_FIELDS = [PG_LOCKED, PG_FREE]

const PG_ROLE_A = `role_bliao_pg_a_${TS}`
const PG_ROLE_B = `role_bliao_pg_b_${TS}`
/** 本 fixture 宇宙里存在的全部角色 —— "对所有角色 read_only" 就是对这个集合而言。 */
const PG_ROLES = [PG_ROLE_A, PG_ROLE_B]
const PG_USER = `u_bliao_pg_${TS}`

/** 两条腿写同一个值 —— 触发量与边界量必须同量,否则"网格红/插件绿"的对照就不成立。 */
const PG_PROBE_VALUE = 'wall-probe-same-column-same-value'

/** 生产插件 SDK 的真实入口:`index.ts` 注入 IoC 容器的那个对象,不是手搓的 query 直连 records.ts。
 *  与 multitable-d1c-plugin-revision-realdb.test.ts 的 realSdk() 同技法 —— 只有走这里,
 *  "插件真的能写"才是关于生产接线的陈述。 */
type PluginRecordsSdk = {
  patchRecord: (input: {
    sheetId: string
    recordId: string
    changes: Record<string, unknown>
    expectedVersion?: number
  }) => Promise<{ id: string; sheetId: string; version: number; data: Record<string, unknown> }>
}
function realPluginRecordsSdk(): PluginRecordsSdk {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const coreApi = (server as unknown as {
    createCoreAPI: () => { multitable: { records: PluginRecordsSdk } }
  }).createCoreAPI()
  return coreApi.multitable.records
}

describeIfDatabase('备料 列权限墙不在插件写路径上 — 特征化 golden(网格红 / 插件绿)', () => {
  let pgApp: Express
  let sdk: PluginRecordsSdk

  const pgGridPatch = (fieldId: string, value: unknown) =>
    request(pgApp)
      .post('/api/multitable/patch')
      .send({ sheetId: PG_SHEET, changes: [{ recordId: PG_REC, fieldId, value }] })

  const pgCell = async (fieldId: string): Promise<unknown> => {
    const r = await q('SELECT data FROM meta_records WHERE id = $1', [PG_REC])
    return (r.rows[0] as { data?: Record<string, unknown> } | undefined)?.data?.[fieldId]
  }

  beforeAll(async () => {
    pgApp = express()
    pgApp.use(express.json())
    pgApp.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = {
        id: PG_USER,
        roles: PG_ROLES, // 这个人持有本 fixture 里的每一个角色
        perms: ['multitable:read', 'multitable:write'],
      }
      next()
    })
    pgApp.use('/api/multitable', univerMetaRouter())
    sdk = realPluginRecordsSdk()

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [PG_BASE, '备料 Plugin-Path Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [PG_SHEET, PG_BASE, '备料 Plugin-Path Sheet'])
    for (const [index, fieldId] of PG_FIELDS.entries()) {
      await q(
        'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fieldId, PG_SHEET, fieldId, 'string', '{}', index + 1],
      )
    }
    for (const roleId of PG_ROLES) {
      await q('INSERT INTO roles (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [roleId, roleId])
    }
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$1,'x','member',$3::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [PG_USER, `${PG_USER}@t.local`, JSON.stringify(['multitable:read', 'multitable:write'])],
    )
    for (const roleId of PG_ROLES) {
      await q('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [PG_USER, roleId])
    }

    // 真端口、真表:把 PG_LOCKED 对本 fixture 的每一个角色置 read_only。
    const applied = await new StockPreparationFieldPermissionsService().applyRoleWriteScopes({
      sheetId: PG_SHEET,
      entries: PG_ROLES.map((roleId) => ({ fieldId: PG_LOCKED, roleId })),
    })
    expect(applied.applied).toBe(PG_ROLES.length)
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [PG_SHEET]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [PG_SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [PG_SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [PG_SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [PG_SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [PG_BASE]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = $1', [PG_USER]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [PG_USER]).catch(() => {})
    await q('DELETE FROM roles WHERE id = ANY($1::text[])', [PG_ROLES]).catch(() => {})
  })

  beforeEach(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [PG_SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      PG_REC,
      PG_SHEET,
      JSON.stringify(Object.fromEntries(PG_FIELDS.map((fieldId) => [fieldId, seedValue(fieldId)]))),
    ])
  })

  // ── 反空转:先证明"墙真的立着",否则下面的"插件绿"什么也不说明 ────────────────────────────────
  test('前置:该列对本 fixture 的每一个角色都有 read_only 行(否则整条对照是空转)', async () => {
    const rows = (await q(
      `SELECT subject_id, read_only, visible FROM field_permissions
        WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'role' ORDER BY subject_id`,
      [PG_SHEET, PG_LOCKED],
    )).rows as Array<{ subject_id: string; read_only: boolean; visible: boolean }>
    expect(rows.map((r) => r.subject_id)).toEqual([...PG_ROLES].sort())
    for (const row of rows) {
      expect(row.read_only).toBe(true)
      expect(row.visible).toBe(true) // 只收窄写,不动读
    }
  })

  // ── 腿 1:网格路径 —— 墙在这里 ─────────────────────────────────────────────────────────────────
  test('腿 1(既有腿,确认仍绿):网格 HTTP 写这一列 → 403,值没动', async () => {
    const res = await pgGridPatch(PG_LOCKED, PG_PROBE_VALUE)
    expect(res.status).toBe(403)
    expect(await pgCell(PG_LOCKED)).toBe(seedValue(PG_LOCKED))
  })

  test('腿 1 的对照:同一个人、同一行、没有策略的那一列 → 200,值落地(403 是列的事,不是夹具坏了)', async () => {
    const res = await pgGridPatch(PG_FREE, PG_PROBE_VALUE)
    expect(res.status).toBe(200)
    expect(await pgCell(PG_FREE)).toBe(PG_PROBE_VALUE)
  })

  // ── 腿 2:插件 SDK —— 墙不在这里(特征化,不是背书) ──────────────────────────────────────────
  test('腿 2(特征化当前行为):插件 SDK patchRecord 写同一列 → 成功;这条绿代表列权限墙不在插件路径上', async () => {
    // 同一列、同一值、同一行 —— 与腿 1 逐项同量。
    //
    // M1(行为级变异断言,不是文本代理):如果有人在插件写路径上加了列权限门,已知的表现有三种 ——
    // ① patchRecord 抛(门 throw/403);② 不抛,但悄悄把这一列从 payload 里滤掉;③ 返回值带着新值、
    // 库里却没变(写在下游被吞)。三种都必须让这条腿变红,而且红出来要说人话,不能只留一个
    // "expected undefined to be …"。下面依次是:try/catch 接 ①、紧随的返回值断言接 ②、回库读接 ③。
    // 这是“已知三种”,不是穷举:一个既不抛、又改写返回值、又同步改写库里那一列的门(等于把写改成别的
    // 值)会骗过 ①②③ 中的前两条,但仍会被 ③ 的等值断言接住;真正逃逸需要门把库里也写成同一个探针值,
    // 那已经不是“门”了。
    let patched: Awaited<ReturnType<PluginRecordsSdk['patchRecord']>>
    try {
      patched = await sdk.patchRecord({
        sheetId: PG_SHEET,
        recordId: PG_REC,
        changes: { [PG_LOCKED]: PG_PROBE_VALUE },
      })
    } catch (err) {
      throw new Error(
        'M1 行为变更:插件 SDK patchRecord 在写这一列时抛了 —— 说明列权限门已经出现在插件写路径上(或者这条' +
          '路径上多了别的拒绝)。这不是测试坏了,是本 golden 特征化的那句话("墙不在插件上")不再成立。' +
          '请同步改写本 describe、守卫里 records.ts.patchRecord / records.ts.createRecord 的 ' +
          'UNGATED_CHARACTERIZED 措辞,以及 ' +
          'docs/development/takeover-beiliao-20260821/stock-preparation-overall-plan-20260902.md §10。' +
          `原始错误:${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      )
    }

    expect(
      patched.data[PG_LOCKED],
      'M1 行为变更:插件 SDK patchRecord 没有抛,但这一列的值没进去 —— 说明插件路径上出现了一个"只过滤不' +
        '报错"的列权限门。处理方式与抛错分支相同(改写本 golden + 守卫措辞 + 设计文档 §10)。',
    ).toBe(PG_PROBE_VALUE)
    // 版本必须前进(证明真的发生了一次写),但不钉死成 2:任何 post-commit 钩子(自动编号/派生回写/
    // 自动化)再 bump 一次版本都不该让这条特征化 golden 变红 —— 它要断言的是"写成功了",不是版本算术。
    expect(patched.version).toBeGreaterThan(1)
    // 真的落到了库里 —— 不是 SDK 返回值自说自话。第三种"门"的形态:SDK 回了成功但库里没变。
    expect(
      await pgCell(PG_LOCKED),
      'M1 行为变更:插件 SDK 报成功、返回值也带着新值,但 meta_records.data 里这一列没变 —— 写被下游吞了。' +
        '同样按"墙出现在插件路径上"处理。',
    ).toBe(PG_PROBE_VALUE)

    // 而且策略行此刻仍然在原地:插件不是"因为门被拆了"才写进去的,是因为这条路上压根没有门。
    const still = (await q(
      `SELECT count(*)::int AS c FROM field_permissions
        WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'role' AND read_only = TRUE`,
      [PG_SHEET, PG_LOCKED],
    )).rows[0] as { c: number }
    expect(still.c).toBe(PG_ROLES.length)

    // 同一条策略、同一列,网格此刻依然 403 —— 两条腿在同一个世界状态下给出不同答案,这正是本 golden
    // 要钉住的那句话:"墙在网格上,不在插件上"。
    const gridAgain = await pgGridPatch(PG_LOCKED, 'grid-still-refused')
    expect(gridAgain.status).toBe(403)
    expect(await pgCell(PG_LOCKED)).toBe(PG_PROBE_VALUE) // 插件写的值仍在,网格没能覆盖它
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 备料 OPTION B (awaiting the owner's A/B/C ruling) — 项目备料表的 PLM 列:对人只读,对插件可写(real DB)
//
// The production path end to end, nothing mocked between the plugin and PostgreSQL:
//   * the REAL plugin create path (`provisionProjectSheet`, stock-preparation-project-targets.cjs) through the
//     PRODUCTION plugin context (`MetaSheetServer.createPluginContext` — the plugin-scoped multitable API index.ts
//     hands plugin-integration-core) provisions a project sheet and marks its plm_system columns
//     `humanWriteLock: 'plm_system'`, and no human_preserved column;
//   * the REAL apply writer (`applyStockPreparationPlan`) writes ADD + UPDATE rows through that context's records
//     SDK AFTER the marking — the plugin path keeps writing the locked columns;
//   * people, through the mounted `univerMetaRouter()` (the routes the grid uses), are refused on those columns
//     with FIELD_READONLY_PLM_SYSTEM — single PATCH, bulk /patch (range paste / fill), POST /records — a platform
//     administrator included; human_preserved columns stay writable; GET /view reports the columns read-only;
//   * a person can neither clear the lock through PATCH /fields nor set one through POST /fields;
//   * THE ROLLOUT: a sheet shaped like the demo's A/B (created before the lock: markers absent) is editable by
//     people, the repair marking locks it, a second run writes nothing, and no row changes;
//   * 人工补充行 B3 (PB-05b, ADR adr-stock-prep-manual-rows-20261030 §3.1): on a project sheet that is also REGISTERED
//     in the plugin's own registry (migration 087), generic create (POST /records — session and mst_ token requests —
//     and the xlsx import) is refused by the manual-rows state before any row, in every state; A / B stay only
//     provisioned and keep PB-05's answers.
// Synthetic identifiers only; everything it creates is deleted in afterAll.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const pbRequire = createRequire(import.meta.url)
type PbProvisioned = {
  sheetId: string
  objectId: string
  fieldIdMap: Record<string, string>
  plmColumnLock: { fieldCount: number; marked: number; alreadyMarked: number; missing: number; readBeforeWrite: boolean }
}
const pbProjectTargets = pbRequire('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs') as {
  provisionProjectSheet: (input: Record<string, unknown>) => Promise<PbProvisioned>
  markProjectSheetPlmSystemColumns: (input: Record<string, unknown>) => Promise<PbProvisioned['plmColumnLock']>
  PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS: string[]
}
const pbApplyWriter = pbRequire('../../../../plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs') as {
  applyStockPreparationPlan: (input: Record<string, unknown>) => Promise<{
    ok: boolean
    status: string
    counts: Record<string, number>
    results: Array<{ status: string; recordId?: string }>
    errors: unknown[]
  }>
}
const pbTemplates = pbRequire('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs') as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { fields: Array<{ id: string; ownership: string }> }
}

const PB_TENANT = `plmro_t_${TS}`
const PB_STAGING = `${PB_TENANT}:integration-core`
const PB_PROJECT_A = `PB-A-${TS}`
const PB_PROJECT_B = `PB-B-${TS}`
// PB-05b (人工补充行 B3): a third project sheet, REGISTERED in the plugin's own registry (migration 087).
const PB_PROJECT_C = `PB-C-${TS}`
const PB_SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const PB_TARGET_TABLE = 'integration_stock_prep_project_target'
type PbTargetRegistry = {
  create: (input: Record<string, unknown>) => Promise<unknown>
  archive: (input: Record<string, unknown>) => Promise<unknown>
  restore: (input: Record<string, unknown>) => Promise<unknown>
}
const pbTargetStore = pbRequire('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-target-store.cjs') as {
  createStockPreparationProjectTargetStore: (input: { db: unknown }) => PbTargetRegistry
}
const pbDb = pbRequire('../../../../plugins/plugin-integration-core/lib/db.cjs') as { createDb: (input: { database: unknown }) => unknown }
const pbXlsx = await import('xlsx') as unknown as XlsxModule
const PB_FRONTLINE = `u_plmro_front_${TS}`
const PB_ADMIN = `u_plmro_admin_${TS}`
const PB_PLM_IDS = pbTemplates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((f) => f.ownership === 'plm_system').map((f) => f.id)
const PB_HUMAN_IDS = pbTemplates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.filter((f) => f.ownership === 'human_preserved').map((f) => f.id)
// The identity columns a range fill would corrupt first, plus a quantity — the 403 legs walk these.
const PB_PROBE_PLM_IDS = ['projectNo', 'idempotencyKey', 'componentSourceId', 'path', 'componentCode', 'totalQuantity']

function pbProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'plm-lock-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-plm-column-lock',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

describeIfDatabase('备料 option B — PLM columns of a project sheet: read-only for people, written by the plugin (real DB)', () => {
  let pbApp: Express
  let ctx: PluginContext
  let a: PbProvisioned
  let b: PbProvisioned
  let c: PbProvisioned
  let pbUser: { id: string; roles: string[] } = { id: PB_FRONTLINE, roles: [] }
  const rowIds: string[] = []

  const asUser = (id: string, roles: string[] = []) => { pbUser = { id, roles } }
  const phys = (sheet: PbProvisioned, logical: string) => {
    const id = sheet.fieldIdMap[logical]
    expect(id, `physical id for ${logical}`).toBeTruthy()
    return id
  }
  const rowData = async (recordId: string) =>
    ((await q('SELECT data FROM meta_records WHERE id = $1', [recordId])).rows[0] as { data: Record<string, unknown> }).data
  const sheetData = async (sheetId: string) =>
    (await q('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows
  const lockedPhysicalIds = async (sheetId: string) =>
    ((await q("SELECT id FROM meta_fields WHERE sheet_id = $1 AND property->>'humanWriteLock' = 'plm_system' ORDER BY id", [sheetId])).rows as Array<{ id: string }>).map((r) => r.id)
  const recordsApi = () => (ctx.api.multitable as unknown as { records: unknown }).records
  const provisioningApi = () => (ctx.api.multitable as unknown as { provisioning: unknown }).provisioning
  const target = (sheet: PbProvisioned) => ({ sheetId: sheet.sheetId, objectId: sheet.objectId, keyField: 'idempotencyKey', fieldIdMap: sheet.fieldIdMap })
  const addDecision = (projectNo: string, i: number) => ({
    decision: 'add',
    idempotencyKey: `${projectNo}:K${i}`,
    record: {
      projectNo,
      idempotencyKey: `${projectNo}:K${i}`,
      componentSourceId: `SRC-${i}`,
      path: `/root/P${i}`,
      componentCode: `CODE-${i}`,
      componentName: `Part ${i}`,
      totalQuantity: i * 2,
      active: true,
      lastPlmRefreshDecision: 'add',
    },
  })

  beforeAll(async () => {
    pbApp = express()
    pbApp.use(express.json())
    pbApp.use((req, _res, next) => {
      ;(req as { user?: unknown }).user = { id: pbUser.id, roles: pbUser.roles, perms: ['multitable:read', 'multitable:write'] }
      next()
    })
    pbApp.use('/api/multitable', univerMetaRouter())
    for (const [userId, isAdmin] of [[PB_FRONTLINE, false], [PB_ADMIN, true]] as Array<[string, boolean]>) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x',$4,$3::jsonb, TRUE, $5)
         ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
        [userId, `${userId}@t.local`, JSON.stringify(['multitable:read', 'multitable:write']), isAdmin ? 'admin' : 'member', isAdmin],
      )
    }
    ctx = pbProductionPluginContext()
    a = await pbProjectTargets.provisionProjectSheet({ context: ctx, projectId: PB_STAGING, tenantId: PB_TENANT, projectNo: PB_PROJECT_A, env: process.env })
    b = await pbProjectTargets.provisionProjectSheet({ context: ctx, projectId: PB_STAGING, tenantId: PB_TENANT, projectNo: PB_PROJECT_B, env: process.env })
  })

  afterAll(async () => {
    // PB-05b's plugin registry rows (and any audit row its store transitions wrote) — this tenant only.
    await q(`DELETE FROM ${PB_TARGET_TABLE} WHERE tenant_id = $1`, [PB_TENANT]).catch(() => {})
    await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [PB_TENANT]).catch(() => {})
    const sheets = [a?.sheetId, b?.sheetId, c?.sheetId].filter(Boolean) as string[]
    if (sheets.length) {
      const bases = ((await q('SELECT DISTINCT base_id FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => ({ rows: [] }))).rows as Array<{ base_id: string | null }>)
        .map((r) => r.base_id).filter((id): id is string => typeof id === 'string' && id.startsWith('base_integration-core_sp_'))
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
      // The own base is per TENANT (synthetic here), so nothing else lives in it.
      for (const baseId of bases) {
        const others = (await q('SELECT count(*)::int AS n FROM meta_sheets WHERE base_id = $1', [baseId]).catch(() => ({ rows: [{ n: 1 }] }))).rows[0] as { n: number }
        if (others.n === 0) await q('DELETE FROM meta_bases WHERE id = $1', [baseId]).catch(() => {})
      }
    }
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[PB_FRONTLINE, PB_ADMIN]]).catch(() => {})
  })

  test('PB-01 create marks EVERY plm_system column and no human_preserved column (real host property)', async () => {
    expect(PB_PLM_IDS.length).toBe(pbProjectTargets.PROJECT_SHEET_PLM_SYSTEM_FIELD_IDS.length)
    expect(a.plmColumnLock).toEqual({ fieldCount: PB_PLM_IDS.length, marked: PB_PLM_IDS.length, alreadyMarked: 0, missing: 0, readBeforeWrite: true, markedFieldIds: PB_PLM_IDS })
    expect(await lockedPhysicalIds(a.sheetId)).toEqual(PB_PLM_IDS.map((id) => phys(a, id)).sort())
    for (const id of PB_HUMAN_IDS) {
      expect((await lockedPhysicalIds(a.sheetId)).includes(phys(a, id)), `${id} must stay editable`).toBe(false)
    }
  })

  test('PB-02 the plugin apply (ADD then UPDATE) still writes the locked PLM columns after the marking', async () => {
    const added = await pbApplyWriter.applyStockPreparationPlan({
      permission: 'admin',
      plan: { decisions: [addDecision(PB_PROJECT_A, 1), addDecision(PB_PROJECT_A, 2)] },
      target: target(a),
      recordsApi: recordsApi(),
    })
    expect(added.errors).toEqual([])
    expect(added.counts.created).toBe(2)
    for (const result of added.results) if (result.recordId) rowIds.push(result.recordId)
    expect(rowIds).toHaveLength(2)
    const first = await rowData(rowIds[0])
    expect(first[phys(a, 'idempotencyKey')]).toBe(`${PB_PROJECT_A}:K1`)
    expect(first[phys(a, 'componentCode')]).toBe('CODE-1')

    const updated = await pbApplyWriter.applyStockPreparationPlan({
      permission: 'admin',
      plan: { decisions: [{ decision: 'update', idempotencyKey: `${PB_PROJECT_A}:K1`, patch: { totalQuantity: 99, componentCode: 'CODE-1R', lastPlmRefreshDecision: 'update' } }] },
      target: target(a),
      recordsApi: recordsApi(),
    })
    expect(updated.errors).toEqual([])
    expect(updated.counts.updated).toBe(1)
    const after = await rowData(rowIds[0])
    expect(after[phys(a, 'totalQuantity')]).toBe(99)
    expect(after[phys(a, 'componentCode')]).toBe('CODE-1R')
    expect(await lockedPhysicalIds(a.sheetId)).toHaveLength(PB_PLM_IDS.length) // the write did not lift the lock
  })

  test('PB-03 single-record PATCH: every probed PLM column → 403 FIELD_READONLY_PLM_SYSTEM (frontline AND admin), value untouched; human_preserved → 200', async () => {
    const recordId = rowIds[0]
    for (const [userId, roles] of [[PB_FRONTLINE, []], [PB_ADMIN, ['admin']]] as Array<[string, string[]]>) {
      asUser(userId, roles)
      for (const logical of PB_PROBE_PLM_IDS) {
        const fieldId = phys(a, logical)
        const before = (await rowData(recordId))[fieldId]
        const res = await request(pbApp).patch(`/api/multitable/records/${recordId}`).send({ sheetId: a.sheetId, data: { [fieldId]: logical === 'totalQuantity' ? 1 : 'HACK' } })
        expect(res.status, `${userId} ${logical}: ${JSON.stringify(res.body)}`).toBe(403)
        expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
        expect(res.body.error.fieldIds).toEqual([fieldId])
        expect((await rowData(recordId))[fieldId]).toEqual(before)
      }
    }
    asUser(PB_FRONTLINE)
    const notes = phys(a, 'notes')
    const ok = await request(pbApp).patch(`/api/multitable/records/${recordId}`).send({ sheetId: a.sheetId, data: { [notes]: 'frontline note' } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await rowData(recordId))[notes]).toBe('frontline note')
  })

  test('PB-04 bulk /patch (the range paste / fill route): a batch touching a PLM column is refused WHOLE; a human-only batch lands', async () => {
    asUser(PB_FRONTLINE)
    const notes = phys(a, 'notes')
    const key = phys(a, 'idempotencyKey')
    const before = await sheetData(a.sheetId)
    const mixed = await request(pbApp).post('/api/multitable/patch').send({
      sheetId: a.sheetId,
      changes: rowIds.flatMap((recordId) => [
        { recordId, fieldId: notes, value: 'fill' },
        { recordId, fieldId: key, value: 'FILLED-KEY' },
      ]),
    })
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(403)
    expect(mixed.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect(mixed.body.error.fieldIds).toEqual([key])
    expect(await sheetData(a.sheetId)).toEqual(before) // atomic: not even the human column moved

    const humanOnly = await request(pbApp).post('/api/multitable/patch').send({
      sheetId: a.sheetId,
      changes: rowIds.map((recordId) => ({ recordId, fieldId: notes, value: 'filled note' })),
    })
    expect(humanOnly.status, JSON.stringify(humanOnly.body)).toBe(200)
    for (const recordId of rowIds) expect((await rowData(recordId))[notes]).toBe('filled note')
  })

  test('PB-05 POST /records (and so xlsx import, which shares RecordService.createRecord): seeding a PLM column → 403 FIELD_READONLY_PLM_SYSTEM, no row', async () => {
    asUser(PB_FRONTLINE)
    const countBefore = (await sheetData(a.sheetId)).length
    const res = await request(pbApp).post('/api/multitable/records').send({ sheetId: a.sheetId, data: { [phys(a, 'idempotencyKey')]: 'FAKE-KEY', [phys(a, 'notes')]: 'x' } })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect((await sheetData(a.sheetId)).length).toBe(countBefore)
    // A cost of option B, stated in the PR: six plm_system columns are template-`required`, so a hand-made row
    // without them is refused by the host's ordinary required-field validation. This sheet is only PROVISIONED — it has
    // no plugin registry row (migration 087), so it is not a registered project sheet (P_reg, ADR
    // adr-stock-prep-manual-rows-20261030 §3.0) and keeps exactly these answers. On a REGISTERED project sheet people
    // add rows through 「新增人工补充行」 (人工补充行, POST /sheets/:sheetId/manual-rows) and the generic create is refused
    // earlier, by the manual-rows state — PB-05b below.
    const humanOnly = await request(pbApp).post('/api/multitable/records').send({ sheetId: a.sheetId, data: { [phys(a, 'notes')]: 'x' } })
    expect(humanOnly.status, JSON.stringify(humanOnly.body).slice(0, 200)).toBe(422)
    expect((await sheetData(a.sheetId)).length).toBe(countBefore)
  })

  test('PB-05b a REGISTERED project sheet (P_reg: the plugin registry row of migration 087): generic create — POST /records (session and mst_ token) and the xlsx import — is refused by the manual-rows state before any row, in every state of ADR adr-stock-prep-manual-rows-20261030 §3.1', async () => {
    const switchBefore = process.env[PB_SWITCH]
    process.env[PB_SWITCH] = 'true'
    // c: provisioned exactly like a (the PLM lock included), then registered through the plugin's own registry store.
    c = await pbProjectTargets.provisionProjectSheet({ context: ctx, projectId: PB_STAGING, tenantId: PB_TENANT, projectNo: PB_PROJECT_C, env: process.env })
    const registry = pbTargetStore.createStockPreparationProjectTargetStore({ db: pbDb.createDb({ database: (ctx.api as unknown as { database: unknown }).database }) })
    await registry.create({ tenantId: PB_TENANT, projectNo: PB_PROJECT_C, sheetId: c.sheetId, objectId: c.objectId, createdBy: 'syn' })
    const provisioning = provisioningApi() as { patchObjectFieldProperty: (input: Record<string, unknown>) => Promise<unknown> }
    const setSwitch = (value: unknown) =>
      provisioning.patchObjectFieldProperty({ projectId: PB_STAGING, objectId: c.objectId, fieldId: 'idempotencyKey', propertyPatch: { stockPreparationManualRows: value } })
    const xlsxBuffer = buildXlsxBuffer(pbXlsx, { sheetName: 'Rows', headers: ['plmro-pb05b-header'], rows: [['x']] })
    asUser(PB_FRONTLINE)

    const expectRefused = async (label: string, status: number, code: string, details: Record<string, string>) => {
      const before = (await sheetData(c.sheetId)).length
      // A human-only body and one that names locked columns: the state decides before any field check.
      for (const data of [{ [phys(c, 'notes')]: 'x' }, { [phys(c, 'componentName')]: 'SYN', [phys(c, 'totalQuantity')]: 1 }]) {
        const res = await request(pbApp).post('/api/multitable/records').send({ sheetId: c.sheetId, data })
        expect(res.status, `${label} POST /records: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(status)
        expect(res.body.error.code, label).toBe(code)
        expect(res.body.error.details, label).toEqual(details)
      }
      const imported = await request(pbApp).post(`/api/multitable/sheets/${c.sheetId}/import-xlsx`).attach('file', xlsxBuffer, 'rows.xlsx')
      expect(imported.status, `${label} import-xlsx: ${JSON.stringify(imported.body).slice(0, 300)}`).toBe(status)
      expect(imported.body.error.code, label).toBe(code)
      expect(imported.body.error.details, label).toEqual(details)
      expect((await sheetData(c.sheetId)).length, `${label}: nothing written`).toBe(before)
    }
    const UNAVAILABLE = 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE'

    try {
      // allowed — the one state that points at 「新增人工补充行」.
      await expectRefused('allowed', 409, 'STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW', { state: 'allowed' })
      const allowedRes = await request(pbApp).post('/api/multitable/records').send({ sheetId: c.sheetId, data: { [phys(c, 'notes')]: 'x' } })
      expect(allowedRes.body.error.message).toContain('新增人工补充行')
      // An `mst_` API token request lands in the SAME POST /records handler and is refused the same way, before any row.
      {
        const { ApiTokenService } = await import('../../src/multitable/api-token-service')
        const { db: tokenDb } = await import('../../src/db/db')
        const minted = await new ApiTokenService(tokenDb).createToken(PB_FRONTLINE, { name: 'pb05b-token', scopes: ['records:write'] })
        try {
          const before = (await sheetData(c.sheetId)).length
          const viaToken = await request(pbApp)
            .post('/api/multitable/records')
            .set('Authorization', `Bearer ${minted.plainTextToken}`)
            .send({ sheetId: c.sheetId, data: { [phys(c, 'notes')]: 'x' } })
          expect(viaToken.status, `mst_ token POST /records: ${JSON.stringify(viaToken.body).slice(0, 300)}`).toBe(409)
          expect(viaToken.body.error.code).toBe('STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW')
          expect(viaToken.body.error.details).toEqual({ state: 'allowed' })
          expect((await sheetData(c.sheetId)).length, 'mst_ token: nothing written').toBe(before)
        } finally {
          await q('DELETE FROM oapi_write_audit WHERE token_id = $1', [minted.token.id]).catch(() => {})
          await q('DELETE FROM multitable_api_tokens WHERE id = $1', [minted.token.id]).catch(() => {})
        }
      }

      // disabled — the switch written through the plugin's own provisioning port (a junk value reads as disabled).
      await setSwitch('nope')
      try {
        await expectRefused('disabled', 409, 'STOCK_PREP_MANUAL_ROWS_DISABLED', { state: 'disabled', reason: 'disabled' })
      } finally {
        await setSwitch('allowed')
      }

      // lock_missing — 项目号 lost its lock (a sheet the repair has not reached yet).
      const projectNoId = phys(c, 'projectNo')
      const projectNoProperty = ((await q('SELECT property FROM meta_fields WHERE sheet_id = $1 AND id = $2', [c.sheetId, projectNoId])).rows[0] as { property: Record<string, unknown> }).property
      await q("UPDATE meta_fields SET property = property - 'humanWriteLock' WHERE sheet_id = $1 AND id = $2", [c.sheetId, projectNoId])
      try {
        await expectRefused('lock_missing', 409, UNAVAILABLE, { state: 'unavailable', reason: 'lock_missing' })
      } finally {
        await q('UPDATE meta_fields SET property = $3::jsonb WHERE sheet_id = $1 AND id = $2', [c.sheetId, projectNoId, JSON.stringify(projectNoProperty)])
      }

      // project_archived — the store's own transition, then restored.
      await registry.archive({ tenantId: PB_TENANT, projectNo: PB_PROJECT_C, actorId: 'syn' })
      try {
        await expectRefused('project_archived', 409, UNAVAILABLE, { state: 'unavailable', reason: 'project_archived' })
      } finally {
        await registry.restore({ tenantId: PB_TENANT, projectNo: PB_PROJECT_C, actorId: 'syn' })
      }

      // project_sheets_off — the deployment switch is not exactly 'true'.
      process.env[PB_SWITCH] = 'TRUE'
      try {
        await expectRefused('project_sheets_off', 409, UNAVAILABLE, { state: 'unavailable', reason: 'project_sheets_off' })
      } finally {
        process.env[PB_SWITCH] = 'true'
      }

      // contract_mismatch — the plugin registry row names another object than the host registry row.
      await q(`UPDATE ${PB_TARGET_TABLE} SET object_id = $2 WHERE sheet_id = $1`, [c.sheetId, `${c.objectId}_pb05b_other`])
      try {
        await expectRefused('contract_mismatch', 409, UNAVAILABLE, { state: 'unavailable', reason: 'contract_mismatch' })
      } finally {
        await q(`UPDATE ${PB_TARGET_TABLE} SET object_id = $2 WHERE sheet_id = $1`, [c.sheetId, c.objectId])
      }

      // registry_unreadable — a column the fixed statement reads is missing (42703): 503, fail closed.
      await q(`ALTER TABLE ${PB_TARGET_TABLE} RENAME COLUMN tenant_id TO tenant_id_pb05b_probe`)
      try {
        await expectRefused('registry_unreadable', 503, UNAVAILABLE, { state: 'unavailable', reason: 'registry_unreadable' })
      } finally {
        await q(`ALTER TABLE ${PB_TARGET_TABLE} RENAME COLUMN tenant_id_pb05b_probe TO tenant_id`)
      }

      // 42P01 — the registry table is not there: NOT registered, so PB-05's old answers come back (403 / 422).
      await q(`ALTER TABLE ${PB_TARGET_TABLE} RENAME TO ${PB_TARGET_TABLE}_pb05b_probe`)
      try {
        const locked = await request(pbApp).post('/api/multitable/records').send({ sheetId: c.sheetId, data: { [phys(c, 'idempotencyKey')]: 'FAKE-KEY', [phys(c, 'notes')]: 'x' } })
        expect(locked.status, JSON.stringify(locked.body).slice(0, 300)).toBe(403)
        expect(locked.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
        const humanOnly = await request(pbApp).post('/api/multitable/records').send({ sheetId: c.sheetId, data: { [phys(c, 'notes')]: 'x' } })
        expect(humanOnly.status, JSON.stringify(humanOnly.body).slice(0, 300)).toBe(422)
      } finally {
        await q(`ALTER TABLE ${PB_TARGET_TABLE}_pb05b_probe RENAME TO ${PB_TARGET_TABLE}`)
      }

      // And the refusal is back once the registry reads again.
      await expectRefused('allowed again', 409, 'STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW', { state: 'allowed' })
      // The manual-row route itself creates on this sheet (the generic door closed, the manual one open).
      const manual = await request(pbApp).post(`/api/multitable/sheets/${c.sheetId}/manual-rows`).send({ data: { [phys(c, 'componentName')]: 'Synthetic manual part', [phys(c, 'totalQuantity')]: 2 } })
      expect(manual.status, JSON.stringify(manual.body).slice(0, 300)).toBe(200)
    } finally {
      if (switchBefore === undefined) delete process.env[PB_SWITCH]
      else process.env[PB_SWITCH] = switchBefore
    }
  })

  test('PB-06 GET /view reports every PLM column read-only and every human_preserved column writable (what the grid renders)', async () => {
    asUser(PB_FRONTLINE)
    const res = await request(pbApp).get('/api/multitable/view').query({ sheetId: a.sheetId })
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200)
    const perms = res.body.data.meta.permissions.fieldPermissions as Record<string, { visible: boolean; readOnly: boolean }>
    for (const id of PB_PLM_IDS) expect(perms[phys(a, id)], id).toEqual({ visible: true, readOnly: true })
    for (const id of PB_HUMAN_IDS) expect(perms[phys(a, id)], id).toEqual({ visible: true, readOnly: false })
    const fields = res.body.data.fields as Array<{ id: string; property?: Record<string, unknown> }>
    expect(fields.find((f) => f.id === phys(a, 'componentCode'))?.property?.humanWriteLock).toBe('plm_system')
  })

  test('PB-07 no override through the field routes: PATCH /fields cannot clear the lock; POST /fields cannot set one', async () => {
    asUser(PB_ADMIN, ['admin'])
    const fieldId = phys(a, 'componentName')
    // The field-manager PATCH is ACCEPTED (an administrator may still edit the column's other settings) — and the
    // body that tries to clear the lock simply does not: the stored value is carried over (carryHumanWriteLock).
    const cleared = await request(pbApp).patch(`/api/multitable/fields/${fieldId}`).send({ property: {} })
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
    expect(cleared.body.data.field.property.humanWriteLock).toBe('plm_system')
    const stored = (await q('SELECT property FROM meta_fields WHERE id = $1', [fieldId])).rows[0] as { property: Record<string, unknown> }
    expect(stored.property.humanWriteLock).toBe('plm_system')
    // ...and the column is still refused to people after that edit.
    asUser(PB_FRONTLINE)
    const stillRefused = await request(pbApp).patch(`/api/multitable/records/${rowIds[1]}`).send({ sheetId: a.sheetId, data: { [fieldId]: 'HACK' } })
    expect(stillRefused.status).toBe(403)
    expect(stillRefused.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')

    // A person creating a column cannot mint a lock (only plugin provisioning writes it).
    asUser(PB_ADMIN, ['admin'])
    const created = await request(pbApp).post('/api/multitable/fields').send({ sheetId: a.sheetId, name: `plmro-extra-${TS}`, type: 'string', property: { humanWriteLock: 'plm_system' } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const newId = String(created.body.data.field.id)
    expect('humanWriteLock' in (created.body.data.field.property ?? {})).toBe(false)
    const row = (await q('SELECT property FROM meta_fields WHERE id = $1', [newId])).rows[0] as { property: Record<string, unknown> }
    expect('humanWriteLock' in row.property).toBe(false)
  })

  test('PB-09 a form on the project sheet (POST /views/:viewId/submit — its own field guard, direct SQL write): a PLM column is refused (edit and create)', async () => {
    const viewId = `view_plmro_form_${TS}`
    await q('INSERT INTO meta_views (id, sheet_id, name, type, config) VALUES ($1,$2,$3,$4,$5::jsonb)', [viewId, a.sheetId, 'PLM lock form', 'form', '{}'])
    asUser(PB_FRONTLINE)
    const recordId = rowIds[1]
    const code = phys(a, 'componentCode')
    const before = (await rowData(recordId))[code]
    const edit = await request(pbApp).post(`/api/multitable/views/${viewId}/submit`).send({ recordId, data: { [code]: 'FORM-HACK' } })
    expect(edit.status, JSON.stringify(edit.body)).toBe(403)
    expect(edit.body.error.code).toBe('FIELD_READONLY')
    expect(edit.body.error.fieldErrors).toEqual({ [code]: 'Field is readonly' })
    expect((await rowData(recordId))[code]).toEqual(before)

    const countBefore = (await sheetData(a.sheetId)).length
    const create = await request(pbApp).post(`/api/multitable/views/${viewId}/submit`).send({ data: { [phys(a, 'idempotencyKey')]: 'FORM-FAKE-KEY' } })
    expect(create.status, JSON.stringify(create.body)).toBe(403)
    expect(create.body.error.code).toBe('FIELD_READONLY')
    expect((await sheetData(a.sheetId)).length).toBe(countBefore)
    // NOTE (a cost of option B, stated in the PR): the form route validates `required` over the SUBMITTED data,
    // and six plm_system columns are template-`required`, so a form submission on a project sheet can no longer
    // pass at all once people cannot send those columns. The grid / bulk / single-record paths are unaffected.
  })

  test('PB-10 the lock survives the route read serializer even for a closed-allowlist type (person): reported read-only, refused', async () => {
    // No PLM column is a person column; this pins the cross-cutting sanitizer rule in routes/univer-meta.ts —
    // the serializer every person write route reads fields through — for the one branch there that rebuilds
    // `property` from scratch. A lock that a branch dropped would fail OPEN.
    const personFieldId = `fld_plmro_person_${TS}`
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [personFieldId, a.sheetId, 'Locked person', 'person', JSON.stringify({ humanWriteLock: 'plm_system', limitSingleRecord: true }), 900],
    )
    asUser(PB_FRONTLINE)
    const res = await request(pbApp).get('/api/multitable/view').query({ sheetId: a.sheetId })
    expect(res.status).toBe(200)
    const field = (res.body.data.fields as Array<{ id: string; property?: Record<string, unknown> }>).find((f) => f.id === personFieldId)
    expect(field?.property?.humanWriteLock).toBe('plm_system')
    expect(res.body.data.meta.permissions.fieldPermissions[personFieldId]).toEqual({ visible: true, readOnly: true })
    const patch = await request(pbApp).post('/api/multitable/patch').send({ sheetId: a.sheetId, changes: [{ recordId: rowIds[0], fieldId: personFieldId, value: [PB_FRONTLINE] }] })
    expect(patch.status, JSON.stringify(patch.body)).toBe(403)
    expect(patch.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
  })

  test('PB-08 THE ROLLOUT on a pre-lock sheet (the demo A/B shape): editable before, the repair marks it once, idempotent, rows untouched, plugin still writes', async () => {
    // B was created by the same path; strip its markers to reproduce a sheet created BEFORE this change.
    await q("UPDATE meta_fields SET property = property - 'humanWriteLock' WHERE sheet_id = $1", [b.sheetId])
    expect(await lockedPhysicalIds(b.sheetId)).toEqual([])
    const added = await pbApplyWriter.applyStockPreparationPlan({
      permission: 'admin', plan: { decisions: [addDecision(PB_PROJECT_B, 1)] }, target: target(b), recordsApi: recordsApi(),
    })
    expect(added.counts.created).toBe(1)
    const recordId = String(added.results[0].recordId)

    asUser(PB_FRONTLINE)
    const code = phys(b, 'componentCode')
    const exposed = await request(pbApp).patch(`/api/multitable/records/${recordId}`).send({ sheetId: b.sheetId, data: { [code]: 'EDITED-BEFORE-ROLLOUT' } })
    expect(exposed.status, 'the pre-lock sheet is exactly the exposure field review found').toBe(200)

    const dataBefore = await sheetData(b.sheetId)
    const first = await pbProjectTargets.markProjectSheetPlmSystemColumns({ provisioning: provisioningApi(), projectId: PB_STAGING, objectId: b.objectId })
    expect(first).toMatchObject({ fieldCount: PB_PLM_IDS.length, marked: PB_PLM_IDS.length, alreadyMarked: 0, missing: 0, readBeforeWrite: true })
    const second = await pbProjectTargets.markProjectSheetPlmSystemColumns({ provisioning: provisioningApi(), projectId: PB_STAGING, objectId: b.objectId })
    expect(second).toMatchObject({ marked: 0, alreadyMarked: PB_PLM_IDS.length, missing: 0 })
    expect(await lockedPhysicalIds(b.sheetId)).toEqual(PB_PLM_IDS.map((id) => phys(b, id)).sort())
    expect(await sheetData(b.sheetId)).toEqual(dataBefore) // metadata only — no row changed

    const refused = await request(pbApp).patch(`/api/multitable/records/${recordId}`).send({ sheetId: b.sheetId, data: { [code]: 'EDITED-AFTER-ROLLOUT' } })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')

    const repaired = await pbApplyWriter.applyStockPreparationPlan({
      permission: 'admin',
      plan: { decisions: [{ decision: 'update', idempotencyKey: `${PB_PROJECT_B}:K1`, patch: { componentCode: 'CODE-1', lastPlmRefreshDecision: 'update' } }] },
      target: target(b),
      recordsApi: recordsApi(),
    })
    expect(repaired.counts.updated).toBe(1)
    expect((await rowData(recordId))[code]).toBe('CODE-1') // the next pull restores the PLM value; people cannot move it again
  })
})
