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
  /** Rows the census SELECT should return, as `field_permissions` rows this port previously wrote. */
  existingScopeRows?: Array<{ field_id: string; subject_id: string }>
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
    if (sql.includes('FROM field_permissions')) {
      return { rows: options.existingScopeRows ?? [] }
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
    // `removed: []` and NOT null: the empty-entry path is a TOTAL no-op that runs no delete, which
    // is a different (and stronger) statement than "a reconcile ran and retired nothing".
    expect(result).toEqual({ applied: 0, entries: [], removed: [] })
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

  it('the public surface is one MUTATING method plus two read-only siblings — nothing else', () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    ).filter((name) => name !== 'constructor' && typeof (service as any)[name] === 'function')
    // The roster is asserted EXACTLY (not "contains"), so a hide/revoke sibling cannot be added
    // without moving this line. `listRoleWriteScopes` / `findMissingRoleIds` are SELECT-only; the
    // source guard below is what actually holds them to that.
    expect(methods.slice().sort()).toEqual([
      'applyRoleWriteScopes',
      'findMissingRoleIds',
      'listRoleWriteScopes',
    ])
  })

  it('SOURCE GUARD: the ONE delete carries all four narrowings, in the statement itself', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')
    // Exactly one delete may exist in this file, and it must be the reconcile.
    const deletes = src.match(/DELETE\s+FROM\s+field_permissions/gi) ?? []
    expect(deletes).toHaveLength(1)

    // Its WHERE clause is the safety property, so it is asserted CLAUSE BY CLAUSE rather than by a
    // whole-statement digest that would have to move for a comment. Dropping any one of these is
    // what turns a scoped reconcile into a revoke channel:
    const statement = src.slice(src.search(/DELETE\s+FROM\s+field_permissions/i))
    const where = statement.slice(0, statement.indexOf('RETURNING'))
    //  1. this port's own rows only — never an operator's
    expect(where).toMatch(/AND\s+created_by\s*=\s*\$2/)
    //  2. actual denials only — never a row an operator relaxed
    expect(where).toMatch(/AND\s+read_only\s*=\s*true/)
    //  3. inside the caller's declared region only, on BOTH axes
    expect(where).toMatch(/AND\s+field_id\s*=\s*ANY\(\$3::text\[\]\)/)
    expect(where).toMatch(/AND\s+subject_id\s*=\s*ANY\(\$4::text\[\]\)/)
    //  4. never a row this same call just wrote
    expect(where).toMatch(/AND\s+NOT\s+EXISTS\s*\(/)
    expect(where).toMatch(/unnest\(\$5::text\[\],\s*\$6::text\[\]\)/)
    // and it stays role-scoped like everything else this port writes.
    expect(where).toMatch(/subject_type\s*=\s*'role'/)

    // The delete can only ever WIDEN access, so it must not mention the read dimension at all.
    expect(where).not.toMatch(/visible/)

    // A blanket revoke must not be expressible: no delete may exist that is keyed on the sheet
    // alone. (Guarded by the four clauses above being on the only DELETE in the file.)
    expect(src).not.toMatch(/UPDATE\s+field_permissions\s+SET/i)
  })

  it('SOURCE GUARD: exactly TWO mutating statements in the whole file — the read methods only SELECT', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')
    // Adding a read method must never smuggle in a write. One INSERT, one (scoped) DELETE, and
    // nothing else that can change a row.
    expect((src.match(/INSERT\s+INTO/gi) ?? []).length).toBe(1)
    expect((src.match(/\bDELETE\s+FROM\b/gi) ?? []).length).toBe(1)
    expect(src).not.toMatch(/\bTRUNCATE\b/i)
    // `DO UPDATE SET` (the ON CONFLICT arm of that single INSERT) is the only `UPDATE` allowed.
    const updates = [...src.matchAll(/\bUPDATE\b/gi)]
    const standaloneUpdates = updates.filter((match) => {
      const before = src.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0)
      return !/DO\s+$/i.test(before) && !/FOR\s+$/i.test(before)
    })
    expect(standaloneUpdates).toHaveLength(0)
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. THE READ SEAM — the census + the role pre-flight question
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('listRoleWriteScopes — the provenance census, scoped to what THIS port wrote', () => {
  it('returns the (column, role) pairs as entries, and reads only — no INSERT anywhere', async () => {
    const fake = createFakePool({
      existingScopeRows: [
        { field_id: F_PURCHASE_ETA, subject_id: ROLE_WAREHOUSE },
        { field_id: F_WAREHOUSE_DATE, subject_id: ROLE_PURCHASING },
      ],
    })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.listRoleWriteScopes({ sheetId: SHEET })

    expect(result.sheetId).toBe(SHEET)
    expect(result.entries).toEqual([
      { fieldId: F_PURCHASE_ETA, roleId: ROLE_WAREHOUSE },
      { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING },
    ])
    expect(fake.inserts).toHaveLength(0)
  })

  it('the census predicate is sheet + role-subject + read_only + THIS port\'s provenance marker', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.listRoleWriteScopes({ sheetId: SHEET })

    const select = fake.calls.find((call) => call.sql.includes('FROM field_permissions'))
    expect(select).toBeDefined()
    expect(select!.sql).toContain('sheet_id = $1')
    expect(select!.sql).toContain("subject_type = 'role'")
    expect(select!.sql).toContain('read_only = true')
    expect(select!.sql).toContain('created_by = $2')
    // Operator-authored rows are OUT of scope by construction: the marker is bound, not omitted.
    expect(select!.params[1]).toBe(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY)
    // It must never take the write path's row lock — this is a read.
    expect(select!.sql).not.toMatch(/FOR\s+UPDATE/i)
  })

  it('an empty sheet censuses to an empty list (not an error)', async () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    await expect(service.listRoleWriteScopes({ sheetId: SHEET })).resolves.toEqual({
      sheetId: SHEET,
      entries: [],
    })
  })

  it('rejects a bad sheetId with ENTRIES_INVALID and touches no database', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await expect(service.listRoleWriteScopes({ sheetId: '' })).rejects.toMatchObject({
      name: 'StockPreparationFieldPermissionsError',
      reason: 'ENTRIES_INVALID',
    })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('findMissingRoleIds — the pre-flight question a caller asks BEFORE it writes schema', () => {
  it('names exactly the ids that are not rows in `roles`, sorted', async () => {
    const fake = createFakePool({ roleIds: [ROLE_PURCHASING] })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.findMissingRoleIds({
      roleIds: [ROLE_WAREHOUSE, ROLE_PURCHASING, ROLE_PRODUCTION],
    })

    expect(result.missing).toEqual([ROLE_PRODUCTION, ROLE_WAREHOUSE].sort())
    expect(fake.inserts).toHaveLength(0)
  })

  it('every id existing yields an empty list', async () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    await expect(service.findMissingRoleIds({ roleIds: ALL_ROLES })).resolves.toEqual({ missing: [] })
  })

  it('de-duplicates its input and short-circuits an empty one without a query', async () => {
    const fake = createFakePool({ roleIds: [ROLE_PURCHASING] })
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await service.findMissingRoleIds({ roleIds: [ROLE_WAREHOUSE, ROLE_WAREHOUSE] })
    const roleQuery = fake.calls.find((call) => call.sql.includes('FROM roles'))
    expect(roleQuery!.params[0]).toEqual([ROLE_WAREHOUSE])

    const empty = createFakePool()
    const service2 = new StockPreparationFieldPermissionsService({ pool: empty.pool })
    await expect(service2.findMissingRoleIds({ roleIds: [] })).resolves.toEqual({ missing: [] })
    expect(empty.calls).toHaveLength(0)
  })

  it('rejects a malformed input with ENTRIES_INVALID and touches no database', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await expect(
      service.findMissingRoleIds({ roleIds: ['ok', ''] as string[] }),
    ).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })
    await expect(
      service.findMissingRoleIds({ roleIds: undefined as unknown as string[] }),
    ).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })
    expect(fake.calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. THE SCOPED RECONCILE — a pack revision that MOVES a column's owner
//
// Upsert-only has one silent failure and this section is it. v1 says "采购 may not write 仓库备料
// 日期"; v2 moves that column TO 仓库's counterpart. Without a reconcile v1's row survives beside
// v2's, and `loadFieldPermissionScopeMap` ORs `read_only` across a user's rows — so the column
// becomes unwritable by EVERY declared role while the install reports success.
//
// The rows here are modelled as a real table (provenance column included) rather than as canned
// SELECT results, because the load-bearing claim is about WHICH rows survive. The tie between this
// executable model and the actual SQL is the clause-by-clause SOURCE GUARD in section 2 plus the
// real-Postgres suite tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const OPERATOR_MARKER = 'operator:univer-meta-authoring-route'

interface TableRow {
  sheet_id: string
  field_id: string
  subject_type: string
  subject_id: string
  visible: boolean
  read_only: boolean
  created_by: string
}

/**
 * A pool whose `field_permissions` is an actual mutable set of rows. The three statements are
 * applied SEMANTICALLY from their bound parameters (this is a model of the statement, not a SQL
 * parser) — but the model implements every clause the source guard pins, so a statement that lost
 * one would be caught there rather than silently passed here.
 */
function createTablePool(seed: TableRow[] = []): {
  pool: StockPreparationFieldPermissionsPool
  rows: TableRow[]
  deletes: Captured[]
} {
  const rows: TableRow[] = seed.map((row) => ({ ...row }))
  const deletes: Captured[] = []

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM meta_sheets')) return { rows: [{ id: String(params[0]) }] }
    if (sql.includes('FROM meta_fields')) {
      return { rows: ((params[1] as string[]) ?? []).map((id) => ({ id })) }
    }
    if (sql.includes('FROM roles')) {
      return { rows: ((params[0] as string[]) ?? []).map((id) => ({ id })) }
    }
    if (sql.includes('INSERT INTO field_permissions')) {
      const [sheetId, fieldId, subjectId, createdBy] = params as string[]
      const existing = rows.find((row) => row.sheet_id === sheetId
        && row.field_id === fieldId && row.subject_type === 'role' && row.subject_id === subjectId)
      if (existing) {
        existing.visible = true
        existing.read_only = true
        existing.created_by = createdBy
      } else {
        rows.push({
          sheet_id: sheetId,
          field_id: fieldId,
          subject_type: 'role',
          subject_id: subjectId,
          visible: true,
          read_only: true,
          created_by: createdBy,
        })
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('DELETE FROM field_permissions')) {
      deletes.push({ sql, params })
      const [sheetId, createdBy, regionFields, regionRoles, desiredFields, desiredRoles] =
        params as [string, string, string[], string[], string[], string[]]
      const desired = new Set(desiredFields.map((fieldId, i) => `${fieldId} ${desiredRoles[i]}`))
      const removed: TableRow[] = []
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (row.sheet_id !== sheetId) continue
        if (row.subject_type !== 'role') continue
        if (row.created_by !== createdBy) continue
        if (row.read_only !== true) continue
        if (!regionFields.includes(row.field_id)) continue
        if (!regionRoles.includes(row.subject_id)) continue
        if (desired.has(`${row.field_id} ${row.subject_id}`)) continue
        removed.push(row)
        rows.splice(i, 1)
      }
      return { rows: removed.map((row) => ({ field_id: row.field_id, subject_id: row.subject_id })) }
    }
    if (sql.includes('FROM field_permissions')) {
      const [sheetId, createdBy] = params as string[]
      return {
        rows: rows
          .filter((row) => row.sheet_id === sheetId && row.subject_type === 'role'
            && row.read_only === true && row.created_by === createdBy)
          .map((row) => ({ field_id: row.field_id, subject_id: row.subject_id })),
      }
    }
    throw new Error(`fake pool: unexpected SQL ${sql}`)
  }

  return {
    pool: { async transaction(handler) { return handler({ query }) } },
    rows,
    deletes,
  }
}

const pluginRow = (fieldId: string, roleId: string): TableRow => ({
  sheet_id: SHEET,
  field_id: fieldId,
  subject_type: 'role',
  subject_id: roleId,
  visible: true,
  read_only: true,
  created_by: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
})

const keyOf = (row: { field_id: string; subject_id: string }) => `${row.field_id} ${row.subject_id}`

describe('5. the scoped reconcile — a revision that moves a column between departments', () => {
  // v1: 仓库 owns its 备料日期 column, so 采购 is denied it.
  const V1_ENTRIES = [
    { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING },
    { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
  ]
  // v2: that column changes hands — the denial flips to the other department.
  const V2_ENTRIES = [
    { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE },
    { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
  ]
  const REGION = {
    fieldIds: [F_WAREHOUSE_DATE, F_PURCHASE_REPLY],
    roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE],
  }

  it('v1 then v2: the stale v1 row is the ONLY row deleted, and it is reported back', async () => {
    const fake = createTablePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const v1 = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES, reconcile: REGION })
    expect(v1.removed).toEqual([])
    expect(fake.rows.map(keyOf).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_WAREHOUSE}`,
      `${F_WAREHOUSE_DATE} ${ROLE_PURCHASING}`,
    ].sort())

    const v2 = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })

    // THE HEADLINE: the column that changed hands is denied to exactly ONE role afterwards.
    expect(fake.rows.map(keyOf).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_WAREHOUSE}`,
      `${F_WAREHOUSE_DATE} ${ROLE_WAREHOUSE}`,
    ].sort())
    expect(v2.removed).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
    expect(v2.applied).toBe(2)

    // Idempotent: a converged re-run deletes nothing.
    const again = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })
    expect(again.removed).toEqual([])
    expect(fake.rows).toHaveLength(2)
  })

  it('an OPERATOR row on the very same sheet, column and role is NEVER deleted', async () => {
    // Positioned to fail every way except provenance: same sheet, a column inside the region, a
    // role inside the region, read_only, and absent from the desired set. Only `created_by` differs.
    const operatorRow: TableRow = {
      ...pluginRow(F_PURCHASE_REPLY, ROLE_PURCHASING),
      created_by: OPERATOR_MARKER,
    }
    const fake = createTablePool([operatorRow, pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING)])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })

    expect(result.removed).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
    const survivor = fake.rows.find((row) => row.created_by === OPERATOR_MARKER)
    expect(survivor).toBeDefined()
    expect(survivor).toMatchObject({ field_id: F_PURCHASE_REPLY, subject_id: ROLE_PURCHASING, read_only: true })
  })

  it('rows OUTSIDE the declared region survive, on either axis', async () => {
    const OUTSIDE_ROLE = ROLE_PRODUCTION // this port's own row, for a role the caller does not govern
    const OUTSIDE_FIELD = F_MATERIAL_TYPE // this port's own row, on a column the caller does not govern
    const fake = createTablePool([
      pluginRow(F_WAREHOUSE_DATE, OUTSIDE_ROLE),
      pluginRow(OUTSIDE_FIELD, ROLE_PURCHASING),
      pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING), // inside on both axes → the one that goes
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })

    expect(result.removed).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
    expect(fake.rows.map(keyOf).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_WAREHOUSE}`,
      `${F_WAREHOUSE_DATE} ${OUTSIDE_ROLE}`,
      `${F_WAREHOUSE_DATE} ${ROLE_WAREHOUSE}`,
      `${OUTSIDE_FIELD} ${ROLE_PURCHASING}`,
    ].sort())
  })

  it('a row this port wrote but an operator RELAXED (read_only=false) is left alone', async () => {
    const relaxed: TableRow = { ...pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING), read_only: false }
    const fake = createTablePool([relaxed])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })

    // Not deleted — an operator decided it is no longer a denial, and that decision stands.
    expect(result.removed).toEqual([])
    expect(fake.rows.find((row) => keyOf(row) === `${F_WAREHOUSE_DATE} ${ROLE_PURCHASING}`))
      .toMatchObject({ read_only: false })
  })

  it('WITHOUT a reconcile region no DELETE is executed at all, and `removed` is empty', async () => {
    const fake = createTablePool([pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING)])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES })

    expect(fake.deletes).toHaveLength(0)
    expect(result.removed).toEqual([])
    // The old hazard, intact for any caller that does not opt in: BOTH roles now deny the column.
    expect(fake.rows.map(keyOf)).toContain(`${F_WAREHOUSE_DATE} ${ROLE_PURCHASING}`)
    expect(fake.rows.map(keyOf)).toContain(`${F_WAREHOUSE_DATE} ${ROLE_WAREHOUSE}`)
  })

  it('a region that does not contain every written entry is refused, and nothing is written', async () => {
    // The containment rule is what makes the delete provably no wider than the caller's own
    // re-declaration. A caller writing outside its region must widen the region, not the delete.
    const fake = createTablePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: V2_ENTRIES,
      reconcile: { fieldIds: [F_PURCHASE_REPLY], roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] },
    })).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })

    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: V2_ENTRIES,
      reconcile: { fieldIds: REGION.fieldIds, roleIds: [ROLE_PURCHASING] },
    })).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })

    // Shape violations are refused the same way, before any connection is taken.
    for (const bad of [{ fieldIds: [], roleIds: REGION.roleIds }, { fieldIds: REGION.fieldIds, roleIds: [] }]) {
      await expect(service.applyRoleWriteScopes({
        sheetId: SHEET, entries: V2_ENTRIES, reconcile: bad,
      })).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })
    }

    expect(fake.rows).toHaveLength(0)
    expect(fake.deletes).toHaveLength(0)
  })

  it('the delete is bound to THIS sheet: an identical row on another sheet is untouched', async () => {
    const otherSheetRow: TableRow = { ...pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING), sheet_id: 'sheet_other' }
    const fake = createTablePool([otherSheetRow, pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING)])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION })

    expect(fake.rows.filter((row) => row.sheet_id === 'sheet_other')).toHaveLength(1)
  })
})
