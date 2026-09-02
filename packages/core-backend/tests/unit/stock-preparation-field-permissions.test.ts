/**
 * 备料按部门列写权限 — unit witnesses for `StockPreparationFieldPermissionsService`.
 *
 * Runs WITHOUT a database: the pool/transaction seam is faked (same posture as
 * `tests/unit/multitable-permission-service.test.ts`'s mocked QueryFn).
 *
 * Four witnesses, in ascending order of load-bearingness:
 *  1. SHAPE           — one upsert per entry, `subject_type='role'`, read-only, provenance-stamped.
 *  2. READ-SAFETY     — STRUCTURAL: no input can make this port hide a column, plus a source-text
 *                       guard so a later edit cannot turn the hardcoded literal into a parameter.
 *  3. FAIL-CLOSED     — unknown sheet / field-not-on-sheet / unknown role each abort with the named
 *                       reason and write NOTHING.
 *  4. ENFORCEMENT CHAIN — the rows this port writes, fed through the REAL
 *                       `loadFieldPermissionScopeMap` → REAL `deriveFieldPermissions` → REAL
 *                       `isFieldWriteForbidden`, actually DENY the cross-department write and
 *                       actually KEEP the read. This is the one that proves the port is wired to
 *                       the enforcement chain rather than to a table nobody reads.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  deriveFieldPermissions,
  isFieldWriteForbidden,
  type FieldLike,
  type FieldPermissionScope,
} from '../../src/multitable/permission-derivation'
import { loadFieldPermissionScopeMap, type QueryFn } from '../../src/multitable/permission-service'
import {
  StockPreparationFieldPermissionsError,
  StockPreparationFieldPermissionsService,
  STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
  STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES,
  type StockPreparationFieldPermissionsPool,
} from '../../src/services/stock-preparation-field-permissions'

// ── The 备料 scenario (the real column shape this port exists for) ────────────────────────────────
const SHEET = 'sheet_beiliao'

/** 生产 band — what tells 采购 WHAT to buy / BY WHEN and 仓库 what to prepare. MUST stay readable. */
const F_MATERIAL_TYPE = 'fld_material_type' // 材料类型
const F_BLANK_TYPE = 'fld_blank_type' // 毛胚类型
const F_NEED_DATE = 'fld_need_date' // 需求日期
const F_LEAD_TIME = 'fld_lead_time' // 提前周期
const PRODUCTION_BAND = [F_MATERIAL_TYPE, F_BLANK_TYPE, F_NEED_DATE, F_LEAD_TIME]

/** 采购 response columns. */
const F_PURCHASE_REPLY = 'fld_purchase_reply' // 采购回复
const F_PURCHASE_ETA = 'fld_purchase_eta' // 采购到货日期
const PURCHASING_OWNED = [F_PURCHASE_REPLY, F_PURCHASE_ETA]

/** 仓库 response columns. */
const F_WAREHOUSE_STATUS = 'fld_warehouse_status' // 仓库备料状态
const F_WAREHOUSE_DATE = 'fld_warehouse_date' // 仓库备料日期
const WAREHOUSE_OWNED = [F_WAREHOUSE_STATUS, F_WAREHOUSE_DATE]

const ALL_FIELDS = [...PRODUCTION_BAND, ...PURCHASING_OWNED, ...WAREHOUSE_OWNED]

const ROLE_PURCHASING = 'role_beiliao_purchasing'
const ROLE_WAREHOUSE = 'role_beiliao_warehouse'
const ROLE_PRODUCTION = 'role_beiliao_production' // declared nowhere — the "unaffected" control
const ALL_ROLES = [ROLE_PURCHASING, ROLE_WAREHOUSE, ROLE_PRODUCTION]

/**
 * The declaration a 备料 install would submit: each department may not write the OTHER department's
 * response columns, and neither may write the 生产 band. Read is untouched throughout — that is the
 * point of the whole port.
 */
const SCENARIO_ENTRIES = [
  ...PURCHASING_OWNED.map((fieldId) => ({ fieldId, roleId: ROLE_WAREHOUSE })),
  ...WAREHOUSE_OWNED.map((fieldId) => ({ fieldId, roleId: ROLE_PURCHASING })),
  ...PRODUCTION_BAND.flatMap((fieldId) => [
    { fieldId, roleId: ROLE_PURCHASING },
    { fieldId, roleId: ROLE_WAREHOUSE },
  ]),
]

// ── The fake pool seam ───────────────────────────────────────────────────────────────────────────

type Captured = { sql: string; params: unknown[] }

interface FakePoolOptions {
  sheetIds?: string[]
  fieldIdsBySheet?: Record<string, string[]>
  roleIds?: string[]
}

function createFakePool(options: FakePoolOptions = {}): {
  pool: StockPreparationFieldPermissionsPool
  calls: Captured[]
  inserts: Captured[]
  transactions: number
} {
  const sheetIds = new Set(options.sheetIds ?? [SHEET])
  const fieldIdsBySheet = options.fieldIdsBySheet ?? { [SHEET]: ALL_FIELDS }
  const roleIds = new Set(options.roleIds ?? ALL_ROLES)
  const calls: Captured[] = []
  const state = { transactions: 0 }

  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('FROM meta_sheets')) {
      const id = String(params[0])
      return { rows: sheetIds.has(id) ? [{ id }] : [] }
    }
    if (sql.includes('FROM meta_fields')) {
      const sheetId = String(params[0])
      const requested = (params[1] as string[]) ?? []
      const known = new Set(fieldIdsBySheet[sheetId] ?? [])
      return { rows: requested.filter((id) => known.has(id)).map((id) => ({ id })) }
    }
    if (sql.includes('FROM roles')) {
      const requested = (params[0] as string[]) ?? []
      return { rows: requested.filter((id) => roleIds.has(id)).map((id) => ({ id })) }
    }
    if (sql.includes('INSERT INTO field_permissions')) return { rows: [], rowCount: 1 }
    throw new Error(`fake pool: unexpected SQL ${sql}`)
  }

  const pool: StockPreparationFieldPermissionsPool = {
    async transaction(handler) {
      state.transactions += 1
      return handler({ query })
    },
  }

  return {
    pool,
    calls,
    get inserts() {
      return calls.filter((c) => c.sql.includes('INSERT INTO field_permissions'))
    },
    get transactions() {
      return state.transactions
    },
  }
}

/** The rows the fake pool "persisted", in `field_permissions` column order. */
function rowsWrittenBy(inserts: Captured[]): Array<{
  sheet_id: string
  field_id: string
  subject_type: string
  subject_id: string
  visible: boolean
  read_only: boolean
  created_by: string
}> {
  return inserts.map((insert) => ({
    sheet_id: String(insert.params[0]),
    field_id: String(insert.params[1]),
    // subject_type / visible / read_only are SQL LITERALS, never bind parameters — that is the whole
    // structural guarantee. Reading them back out of the statement text (not the params) is therefore
    // the honest reconstruction of what the database will actually store.
    subject_type: /VALUES\s*\(\$1,\s*\$2,\s*'role'/.test(insert.sql) ? 'role' : 'UNEXPECTED',
    subject_id: String(insert.params[2]),
    visible: /VALUES\s*\(\$1,\s*\$2,\s*'role',\s*\$3,\s*true,/.test(insert.sql),
    read_only: /VALUES\s*\(\$1,\s*\$2,\s*'role',\s*\$3,\s*true,\s*true,/.test(insert.sql),
    created_by: String(insert.params[3]),
  }))
}

const SERVICE_SOURCE_PATH = join(
  __dirname,
  '../../src/services/stock-preparation-field-permissions.ts',
)

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. SHAPE
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('applyRoleWriteScopes — writes one role-scoped, read-only, provenance-stamped row per entry', () => {
  it('writes visible=true, read_only=true, subject_type=role for every entry, in ONE transaction', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: SCENARIO_ENTRIES })

    expect(result.applied).toBe(SCENARIO_ENTRIES.length)
    expect(result.entries).toEqual(SCENARIO_ENTRIES)
    expect(fake.transactions).toBe(1)
    expect(fake.inserts).toHaveLength(SCENARIO_ENTRIES.length)

    const rows = rowsWrittenBy(fake.inserts)
    for (const row of rows) {
      expect(row.sheet_id).toBe(SHEET)
      expect(row.subject_type).toBe('role')
      expect(row.visible).toBe(true)
      expect(row.read_only).toBe(true)
      expect(row.created_by).toBe(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY)
    }
    expect(rows.map((r) => ({ fieldId: r.field_id, roleId: r.subject_id }))).toEqual(SCENARIO_ENTRIES)
  })

  it('provenance marker is exactly the plugin-scoped constant (an operator census key)', () => {
    expect(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY).toBe(
      'plugin:plugin-integration-core/stock-preparation',
    )
  })

  it('upserts idempotently (ON CONFLICT on the unique key) rather than duplicating rows', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE }],
    })
    expect(fake.inserts[0].sql).toContain(
      'ON CONFLICT (sheet_id, field_id, subject_type, subject_id)',
    )
    expect(fake.inserts[0].sql).toContain('DO UPDATE SET visible = true, read_only = true')
  })

  it('de-duplicates repeated (fieldId, roleId) pairs — applied always equals entries.length', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    const result = await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [
        { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
        { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
        { fieldId: F_PURCHASE_ETA, roleId: ROLE_WAREHOUSE },
      ],
    })
    expect(result.applied).toBe(2)
    expect(result.entries).toHaveLength(2)
    expect(fake.inserts).toHaveLength(2)
  })

  it('takes the meta_sheets FOR UPDATE row lock before writing (serializes against a revert)', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE }],
    })
    expect(fake.calls[0].sql).toBe('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE')
  })

  it('an empty entry list is a documented no-op — no transaction, no write', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: [] })
    expect(result).toEqual({ applied: 0, entries: [] })
    expect(fake.transactions).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. READ-SAFETY — the structural witness
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('STRUCTURAL read-safety: this port can never produce a read restriction', () => {
  it('no input — however varied — yields a row whose read dimension is anything but shared', async () => {
    // Deliberately hostile / varied inputs: extra keys that look like a hide switch, unicode ids,
    // long ids, single and bulk. If ANY of them could flip the read dimension, this reds.
    const hostile: Array<{ sheetId: string; entries: any[] }> = [
      { sheetId: SHEET, entries: SCENARIO_ENTRIES },
      { sheetId: SHEET, entries: [{ fieldId: F_NEED_DATE, roleId: ROLE_PURCHASING }] },
      {
        sheetId: SHEET,
        entries: [
          { fieldId: F_BLANK_TYPE, roleId: ROLE_WAREHOUSE, visible: false },
          { fieldId: F_LEAD_TIME, roleId: ROLE_WAREHOUSE, hidden: true },
          { fieldId: F_MATERIAL_TYPE, roleId: ROLE_WAREHOUSE, readOnly: false },
        ],
      },
      {
        sheetId: SHEET,
        entries: ALL_FIELDS.flatMap((fieldId) =>
          ALL_ROLES.map((roleId) => ({ fieldId, roleId })),
        ),
      },
    ]

    for (const input of hostile) {
      const fake = createFakePool()
      const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
      await service.applyRoleWriteScopes(input as any)
      expect(fake.inserts.length).toBeGreaterThan(0)
      for (const row of rowsWrittenBy(fake.inserts)) {
        expect(row.visible).toBe(true)
        expect(row.read_only).toBe(true)
      }
      // …and the read dimension is not even reachable from the parameter list: exactly four binds
      // (sheet_id, field_id, subject_id, created_by), all strings, no booleans anywhere.
      for (const insert of fake.inserts) {
        expect(insert.params).toHaveLength(4)
        for (const param of insert.params) expect(typeof param).toBe('string')
      }
    }
  })

  it('SOURCE GUARD: the service file never parameterises or negates the read dimension', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')

    // The literal upsert this port is allowed to emit — both the VALUES literal and the DO UPDATE.
    expect(src).toContain("VALUES ($1, $2, 'role', $3, true, true, $4)")
    expect(src).toContain('DO UPDATE SET visible = true, read_only = true, created_by = EXCLUDED.created_by')

    // Every assignment to the read column in this file must be the literal `true`. This catches
    // `visible = <the negation>`, `visible = $5`, and `visible = EXCLUDED.visible` alike.
    const assignments = [...src.matchAll(/visible\s*=\s*([A-Za-z0-9_.$]+)/g)].map((m) => m[1])
    expect(assignments.length).toBeGreaterThan(0)
    expect(assignments.every((value) => value === 'true')).toBe(true)

    // The read column is never bound to a placeholder on any line that mentions it.
    const boundLines = src.split('\n').filter((line) => /visible/.test(line) && /\$\d/.test(line))
    expect(boundLines).toEqual([])

    // No `visible` key is ever read off the caller's input.
    expect(src).not.toMatch(/input\.[A-Za-z.]*visible/)
    expect(src).not.toMatch(/entry\.visible/)
  })

  it('the public surface is exactly one method (no hide/revoke sibling can be called by mistake)', () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    ).filter((name) => name !== 'constructor' && typeof (service as any)[name] === 'function')
    expect(methods).toEqual(['applyRoleWriteScopes'])
  })

  it('SOURCE GUARD: purely additive — the port emits no DELETE/revoke statement', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')
    expect(src).not.toMatch(/DELETE\s+FROM\s+field_permissions/i)
    expect(src).not.toMatch(/UPDATE\s+field_permissions\s+SET/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. FAIL-CLOSED VALIDATION
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('fail-closed validation — a single bad entry aborts the whole call with nothing written', () => {
  const expectReason = async (
    run: () => Promise<unknown>,
    reason: string,
  ): Promise<StockPreparationFieldPermissionsError> => {
    let caught: unknown
    try {
      await run()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StockPreparationFieldPermissionsError)
    expect((caught as StockPreparationFieldPermissionsError).reason).toBe(reason)
    return caught as StockPreparationFieldPermissionsError
  }

  it('SHEET_NOT_FOUND — unknown sheet aborts; zero INSERTs', async () => {
    const fake = createFakePool({ sheetIds: [SHEET] })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await expectReason(
      () =>
        service.applyRoleWriteScopes({
          sheetId: 'sheet_does_not_exist',
          entries: [{ fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE }],
        }),
      'SHEET_NOT_FOUND',
    )
    expect(fake.inserts).toHaveLength(0)
  })

  it('FIELD_NOT_ON_SHEET — a field belonging to ANOTHER sheet aborts; zero INSERTs', async () => {
    const fake = createFakePool({
      sheetIds: [SHEET, 'sheet_other'],
      fieldIdsBySheet: { [SHEET]: ALL_FIELDS, sheet_other: ['fld_elsewhere'] },
    })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    const err = await expectReason(
      () =>
        service.applyRoleWriteScopes({
          sheetId: SHEET,
          entries: [
            { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE }, // valid
            { fieldId: 'fld_elsewhere', roleId: ROLE_WAREHOUSE }, // on a DIFFERENT sheet
          ],
        }),
      'FIELD_NOT_ON_SHEET',
    )
    expect(err.offending).toEqual(['fld_elsewhere'])
    // The VALID entry must NOT have been written either — all-or-nothing.
    expect(fake.inserts).toHaveLength(0)
  })

  it('ROLE_NOT_FOUND — unknown role aborts; zero INSERTs', async () => {
    const fake = createFakePool({ roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    const err = await expectReason(
      () =>
        service.applyRoleWriteScopes({
          sheetId: SHEET,
          entries: [
            { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
            { fieldId: F_PURCHASE_ETA, roleId: 'role_typo' },
          ],
        }),
      'ROLE_NOT_FOUND',
    )
    expect(err.offending).toEqual(['role_typo'])
    expect(fake.inserts).toHaveLength(0)
  })

  it('ENTRIES_INVALID — non-string / empty ids and a bad sheetId are rejected before any DB call', async () => {
    const bad: Array<unknown> = [
      { sheetId: '', entries: [{ fieldId: F_NEED_DATE, roleId: ROLE_WAREHOUSE }] },
      { sheetId: SHEET, entries: [{ fieldId: '', roleId: ROLE_WAREHOUSE }] },
      { sheetId: SHEET, entries: [{ fieldId: F_NEED_DATE, roleId: '   ' }] },
      { sheetId: SHEET, entries: [{ fieldId: 42, roleId: ROLE_WAREHOUSE }] },
      { sheetId: SHEET, entries: [{ fieldId: F_NEED_DATE, roleId: null }] },
      { sheetId: SHEET, entries: [null] },
      { sheetId: SHEET, entries: 'not-an-array' },
      { sheetId: 7, entries: [] },
    ]
    for (const input of bad) {
      const fake = createFakePool()
      const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
      await expectReason(() => service.applyRoleWriteScopes(input as any), 'ENTRIES_INVALID')
      expect(fake.transactions).toBe(0)
      expect(fake.calls).toHaveLength(0)
    }
  })

  it('ENTRIES_INVALID — the entry cap is enforced before any DB call', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    const tooMany = Array.from(
      { length: STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES + 1 },
      (_, i) => ({ fieldId: `fld_${i}`, roleId: ROLE_WAREHOUSE }),
    )
    await expectReason(
      () => service.applyRoleWriteScopes({ sheetId: SHEET, entries: tooMany }),
      'ENTRIES_INVALID',
    )
    expect(fake.transactions).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. THE ENFORCEMENT-CHAIN WITNESS
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A QueryFn that answers `loadFieldPermissionScopeMap`'s exact SELECT from the rows the port wrote. */
function fieldPermissionQueryFn(
  rows: ReturnType<typeof rowsWrittenBy>,
  userRolesByUserId: Record<string, string[]>,
): QueryFn {
  return async (sql: string, params: unknown[] = []) => {
    expect(sql).toContain('FROM field_permissions fp')
    const [userId, sheetId] = params as [string, string]
    const roles = new Set(userRolesByUserId[userId] ?? [])
    const matched = rows.filter(
      (row) =>
        row.sheet_id === sheetId && row.subject_type === 'role' && roles.has(row.subject_id),
    )
    return {
      rows: matched.map((row) => ({
        field_id: row.field_id,
        visible: row.visible,
        read_only: row.read_only,
      })),
    }
  }
}

const FIELDS: FieldLike[] = ALL_FIELDS.map((id) => ({ id, type: 'string', property: {} }))
const CAPABILITIES = { canEditRecord: true, canCreateRecord: true }

describe('ENFORCEMENT CHAIN — port rows → real loadFieldPermissionScopeMap → real deriveFieldPermissions → real isFieldWriteForbidden', () => {
  const USER_PURCHASING = 'user_caigou'
  const USER_WAREHOUSE = 'user_cangku'
  const USER_PRODUCTION = 'user_shengchan'
  const USER_ROLES: Record<string, string[]> = {
    [USER_PURCHASING]: [ROLE_PURCHASING],
    [USER_WAREHOUSE]: [ROLE_WAREHOUSE],
    [USER_PRODUCTION]: [ROLE_PRODUCTION],
  }

  /** Run the port, then resolve the real permission chain for one principal. */
  async function permissionsFor(userId: string) {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: SCENARIO_ENTRIES })
    const rows = rowsWrittenBy(fake.inserts)

    const scopeMap: Map<string, FieldPermissionScope> = await loadFieldPermissionScopeMap(
      fieldPermissionQueryFn(rows, USER_ROLES),
      SHEET,
      userId,
    )
    return deriveFieldPermissions(FIELDS, CAPABILITIES, { fieldScopeMap: scopeMap })
  }

  it('DENY — a 仓库 principal is REFUSED writing a 采购-owned column', async () => {
    const perms = await permissionsFor(USER_WAREHOUSE)
    for (const fieldId of PURCHASING_OWNED) {
      expect(isFieldWriteForbidden(perms[fieldId]), `warehouse must not write ${fieldId}`).toBe(true)
    }
  })

  it('DENY (reverse) — a 采购 principal is REFUSED writing a 仓库-owned column', async () => {
    const perms = await permissionsFor(USER_PURCHASING)
    for (const fieldId of WAREHOUSE_OWNED) {
      expect(isFieldWriteForbidden(perms[fieldId]), `purchasing must not write ${fieldId}`).toBe(true)
    }
  })

  it('OWN COLUMNS still writable — the scope is a fence, not a lockout', async () => {
    const warehouse = await permissionsFor(USER_WAREHOUSE)
    for (const fieldId of WAREHOUSE_OWNED) {
      expect(isFieldWriteForbidden(warehouse[fieldId]), `warehouse must write ${fieldId}`).toBe(false)
    }
    const purchasing = await permissionsFor(USER_PURCHASING)
    for (const fieldId of PURCHASING_OWNED) {
      expect(isFieldWriteForbidden(purchasing[fieldId]), `purchasing must write ${fieldId}`).toBe(false)
    }
  })

  it('READ IS SHARED — both roles still SEE every column: the 生产 band and each other’s responses', async () => {
    for (const userId of [USER_PURCHASING, USER_WAREHOUSE]) {
      const perms = await permissionsFor(userId)
      for (const fieldId of ALL_FIELDS) {
        // `visible !== false` is exactly the predicate the read-path mask and `isFieldWriteForbidden`
        // both key on. If this port could ever hide a column, THIS is the assertion that would red.
        expect(perms[fieldId].visible, `${userId} must still see ${fieldId}`).not.toBe(false)
      }
      // Spelled out for the two things the business flow actually depends on.
      for (const fieldId of PRODUCTION_BAND) expect(perms[fieldId].visible).toBe(true)
      expect(perms[F_PURCHASE_REPLY].visible).toBe(true)
      expect(perms[F_WAREHOUSE_STATUS].visible).toBe(true)
    }
  })

  it('the 生产 band is read-shared but not writable by either department', async () => {
    for (const userId of [USER_PURCHASING, USER_WAREHOUSE]) {
      const perms = await permissionsFor(userId)
      for (const fieldId of PRODUCTION_BAND) {
        expect(perms[fieldId].visible).toBe(true)
        expect(isFieldWriteForbidden(perms[fieldId])).toBe(true)
      }
    }
  })

  it('CONTROL — a principal in an UNDECLARED role is completely unaffected (every field writable)', async () => {
    const perms = await permissionsFor(USER_PRODUCTION)
    for (const fieldId of ALL_FIELDS) {
      expect(perms[fieldId].visible, `${fieldId} visible`).toBe(true)
      expect(isFieldWriteForbidden(perms[fieldId]), `${fieldId} writable`).toBe(false)
    }
  })
})
