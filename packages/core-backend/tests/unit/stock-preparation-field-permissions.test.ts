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
import { getObjectSheetId } from '../../src/multitable/provisioning'
import {
  runWriteScopePackIdBackfill,
  selectSoleOwnerSheets,
} from '../../scripts/backfill-stock-preparation-write-scope-pack-ids'
import {
  StockPreparationFieldPermissionsError,
  StockPreparationFieldPermissionsService,
  STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
  STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES,
  FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY,
  classifyRoleWriteScopeRows,
  operatorFieldPermissionCreatedBy,
  stockPreparationFieldPermissionCreatedBy,
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
  /**
   * Rows the census SELECT should return. `created_by` defaults to the legacy plugin marker — the
   * census now reads provenance out of the row rather than filtering on it in SQL, so a row without
   * one would (correctly) be reported as somebody else's.
   */
  existingScopeRows?: Array<{
    field_id: string
    subject_id: string
    created_by?: string | null
    visible?: boolean
    read_only?: boolean
  }>
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
      // BOTH read shapes come through here: the census (`... AND read_only = true`) and the
      // classification snapshot (no read_only clause, and it projects both dimensions). The filter
      // is applied from the STATEMENT rather than assumed, so a snapshot query that silently
      // regained a `read_only = true` predicate — which would blind the classifier to an operator's
      // hidden-but-writable row — changes what this fake returns.
      const filterReadOnly = /read_only\s*=\s*true/.test(sql)
      return {
        rows: (options.existingScopeRows ?? [])
          .map((row) => ({
            field_id: row.field_id,
            subject_id: row.subject_id,
            created_by: row.created_by === undefined
              ? STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY
              : row.created_by,
            visible: row.visible === undefined ? true : row.visible,
            read_only: row.read_only === undefined ? true : row.read_only,
          }))
          .filter((row) => !filterReadOnly || row.read_only === true),
      }
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
    expect(fake.inserts[0].sql).toContain('DO UPDATE SET')
    // All three assigned columns are ownership-guarded; see the source guard in section 2.
    expect(fake.inserts[0].sql).toContain('visible = CASE WHEN field_permissions.created_by IN ($4, $5)')
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
    expect(result).toEqual({ applied: 0, entries: [], removed: [], operatorHeld: [], governedByOtherPacks: [] })
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
      // …and the read dimension is not even reachable from the parameter list: exactly five binds
      // (sheet_id, field_id, subject_id, created_by, legacy_marker), all strings, no booleans
      // anywhere. The fifth is the provenance the DO UPDATE is allowed to adopt — still a marker,
      // still a string, and still nothing a caller can turn into a read decision.
      for (const insert of fake.inserts) {
        expect(insert.params).toHaveLength(5)
        for (const param of insert.params) expect(typeof param).toBe('string')
      }
    }
  })

  it('SOURCE GUARD: the service file never parameterises or negates the read dimension', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')

    // The literal upsert this port is allowed to emit — the VALUES literal, and the three guarded
    // DO UPDATE columns. The guard is now part of the pin: all three share ONE ownership condition,
    // so "we never rewrite a row we do not own" is a single fact about a single expression rather
    // than three independent habits.
    expect(src).toContain("VALUES ($1, $2, 'role', $3, true, true, $4)")
    expect(src).toContain(
      'visible = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.visible END',
    )
    expect(src).toContain(
      'read_only = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.read_only END',
    )
    expect(src).toContain(
      'created_by = CASE WHEN field_permissions.created_by IN ($4, $5) THEN $4 ELSE field_permissions.created_by END',
    )

    // Every assignment to the read column in this file must land on the literal `true`, on the
    // row's OWN current value, or on the ONE pinned ownership CASE whose only two arms are exactly
    // those. This catches `visible = <the negation>`, `visible = $5`, and
    // `visible = EXCLUDED.visible` alike — the escaping-into-a-read-restriction shapes.
    const assignments = [...src.matchAll(/visible\s*=\s*([A-Za-z0-9_.$]+)/g)].map((m) => m[1])
    expect(assignments.length).toBeGreaterThan(0)
    expect(assignments.every((value) => value === 'true'
      || value === 'field_permissions.visible'
      || value === 'CASE')).toBe(true)
    // The CASE arms are enumerated so `CASE` cannot become a hiding place: exactly one CASE assigns
    // `visible`, and it yields the shared-read literal or the row's untouched current value.
    const visibleCases = [...src.matchAll(
      /visible = CASE WHEN ([^\n]+?) THEN ([A-Za-z0-9_.$]+) ELSE ([A-Za-z0-9_.$]+) END/g,
    )]
    expect(visibleCases).toHaveLength(1)
    expect(visibleCases[0][2]).toBe('true')
    expect(visibleCases[0][3]).toBe('field_permissions.visible')

    // The read column is never bound to a placeholder EXCEPT through the ownership guard, whose
    // placeholders are the two provenance markers ($4, $5) and nothing else. Any other `$n` on a
    // line mentioning `visible` would be a caller-supplied read decision.
    const boundLines = src.split('\n').filter((line) => /visible/.test(line) && /\$\d/.test(line))
    for (const line of boundLines) {
      expect(line).toContain('created_by IN ($4, $5)')
      expect([...line.matchAll(/\$\d+/g)].map((m) => m[0]).sort()).toEqual(['$4', '$5'])
    }

    // No `visible` key is ever read off the caller's input.
    expect(src).not.toMatch(/input\.[A-Za-z.]*visible/)
    expect(src).not.toMatch(/entry\.visible/)
  })

  it('the public surface is one MUTATING method plus four read-only siblings — nothing else', () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service) as object,
    ).filter((name) => name !== 'constructor' && typeof (service as any)[name] === 'function')
    // The roster is asserted EXACTLY (not "contains"), so a hide/revoke sibling cannot be added
    // without moving this line. The four siblings are SELECT-only; the source guard below is what
    // actually holds them to that.
    expect(methods.slice().sort()).toEqual([
      'applyRoleWriteScopes',
      'classifyRoleWriteScopeRegion',
      'findMissingFieldIds',
      'findMissingRoleIds',
      'listRoleWriteScopes',
    ])
  })

  /**
   * ═══ THE HOST↔PLUGIN CAPABILITY HANDSHAKE, WITNESSED ON THE REAL OBJECT. ═══
   *
   * The installer refuses (501) any port that does not declare `supportsWriteScopeReconcile === true`
   * and carry the methods it calls. Every other test in this repo asserts that gate against a FAKE
   * port, so re-wrapping or proxying the injected service — dropping a method, losing the marker
   * across a spread — would 501 every real install with the whole battery green (round-2 finding 8).
   * This asserts the predicate against the object `index.ts` actually constructs.
   */
  it('CAPABILITY HANDSHAKE: the real service satisfies the installer gate the plugin applies', () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    expect(service.supportsWriteScopeReconcile).toBe(true)
    for (const method of [
      'applyRoleWriteScopes',
      'classifyRoleWriteScopeRegion',
      'listRoleWriteScopes',
      'findMissingRoleIds',
      'findMissingFieldIds',
    ]) {
      expect(typeof (service as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    // The marker must survive the shapes a host might hand the plugin through: an own-property
    // spread is the one that silently drops a class field, and `supportsWriteScopeReconcile` is a
    // declared instance field precisely so it does not.
    expect({ ...service }.supportsWriteScopeReconcile).toBe(true)
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
    //  1. rows whose provenance this call is entitled to retire — bound as an ARRAY so the legacy
    //     arm can be present or absent per call (`legacyAdoptable`). A row an operator AUTHORED
    //     (marker or NULL) and a sibling pack's row are outside the array in every case.
    expect(where).toMatch(/AND\s+created_by\s*=\s*ANY\(\$2::text\[\]\)/)
    //  2. actual denials only — never a row an operator relaxed
    expect(where).toMatch(/AND\s+read_only\s*=\s*true/)
    //  3. inside the caller's declared region only, on BOTH axes
    expect(where).toMatch(/AND\s+field_id\s*=\s*ANY\(\$3::text\[\]\)/)
    expect(where).toMatch(/AND\s+subject_id\s*=\s*ANY\(\$4::text\[\]\)/)
    //  4. never a row this same call just wrote — AND THE CORRELATION IS PART OF THE CLAUSE.
    //     `unnest(...) AS desired(field_id, subject_id)` alone says nothing about which desired
    //     column is compared to which row column. Cross-wiring the two predicates
    //     (`desired.field_id = field_permissions.subject_id`) leaves the statement looking right
    //     while it deletes the rows the same call just wrote, and no test outside real Postgres
    //     could see it (round-2 finding 4). Both halves are pinned by name here, and the executable
    //     decoding model above parses them rather than assuming the obvious pairing.
    expect(where).toMatch(/AND\s+NOT\s+EXISTS\s*\(/)
    expect(where).toMatch(/unnest\(\$5::text\[\],\s*\$6::text\[\]\)/)
    expect(where).toMatch(/desired\.field_id\s*=\s*field_permissions\.field_id/)
    expect(where).toMatch(/desired\.subject_id\s*=\s*field_permissions\.subject_id/)
    // …and NOTHING ELSE is correlated: exactly those two predicates, so a third (or a duplicated,
    // self-cancelling one) cannot be slipped in beside them.
    expect([...where.matchAll(/desired\.(\w+)\s*=\s*field_permissions\.(\w+)/g)].map((m) => `${m[1]}=${m[2]}`))
      .toEqual(['field_id=field_id', 'subject_id=subject_id'])
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
      {
        fieldId: F_PURCHASE_ETA,
        roleId: ROLE_WAREHOUSE,
        createdBy: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
        packId: null,
      },
      {
        fieldId: F_WAREHOUSE_DATE,
        roleId: ROLE_PURCHASING,
        createdBy: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
        packId: null,
      },
    ])
    expect(result.foreignEntries).toEqual([])
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
    // Provenance is SELECTED and split in JS, not filtered away in SQL: a caller that cannot SEE an
    // operator's row cannot report it either, and both projections must come from one snapshot.
    expect(select!.sql).toContain('created_by')
    expect(select!.params).toEqual([SHEET])
    // It must never take the write path's row lock — this is a read.
    expect(select!.sql).not.toMatch(/FOR\s+UPDATE/i)
  })

  it('an empty sheet censuses to an empty list (not an error)', async () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    await expect(service.listRoleWriteScopes({ sheetId: SHEET })).resolves.toEqual({
      sheetId: SHEET,
      entries: [],
      foreignEntries: [],
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
// 6. THE SCOPED RECONCILE — a pack revision that MOVES a column's owner
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

/**
 * THE TWO REAL OPERATOR SHAPES, and only these two are real.
 *
 * `OPERATOR_MARKER` is what `routes/univer-meta.ts` stamps as of this change. `null` is what it
 * wrote before — and therefore what every operator row on every host in the field carries today.
 * Every operator fixture in the previous revision used a marker string the route never wrote, so the
 * classification's NULL arm was rehearsed nowhere (round-2 findings 14 and 16). Both are seeded
 * below, in every suite that has an operator row.
 */
const OPERATOR_MARKER = FIELD_PERMISSION_OPERATOR_ROUTE_CREATED_BY
const LEGACY_OPERATOR_CREATED_BY = null

interface TableRow {
  sheet_id: string
  field_id: string
  subject_type: string
  subject_id: string
  visible: boolean
  read_only: boolean
  /** NULL is a real, and today the DOMINANT, value: it is what the authoring route used to write. */
  created_by: string | null
}

/**
 * The section-6 model, now the SAME positional decoder section 7 defines: `$N` is resolved by
 * position out of the statement text and the `desired(...)` alias order decides which array is
 * compared against which column. The hand-rolled predecessor re-implemented the semantics from
 * destructured params, so it was structurally blind to a statement that dropped the sheet axis,
 * swapped a placeholder or renamed an alias — three mutations that stayed green under it.
 */
function createTablePool(seed: TableRow[] = []): {
  pool: StockPreparationFieldPermissionsPool
  rows: TableRow[]
  deletes: Captured[]
} {
  return createDecodingTablePool(seed)
}

/**
 * A row THIS pack owns — the post-#5455 (and post-backfill) shape, carrying the PER-PACK marker.
 *
 * The previous revision seeded the bare plugin marker here, which is a LEGACY row: adoptable only
 * when the caller can prove its pack is the sheet's only pack. Seeding it as the default quietly
 * rehearsed the adoption arm on every reconcile assertion in this section, which is how the
 * cross-pack legacy blind spot stayed invisible. The legacy shape now has its own, explicit fixtures
 * in section 7-RC2.
 */
const pluginRow = (
  fieldId: string,
  roleId: string,
  createdBy: string | null = markerFor(PACK_A),
): TableRow => ({
  sheet_id: SHEET,
  field_id: fieldId,
  subject_type: 'role',
  subject_id: roleId,
  visible: true,
  read_only: true,
  created_by: createdBy,
})

const keyOf = (row: { field_id: string; subject_id: string }) => `${row.field_id} ${row.subject_id}`

describe('6. the scoped reconcile — a revision that moves a column between departments', () => {
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

    const v1 = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES, reconcile: REGION, packId: PACK_A })
    expect(v1.removed).toEqual([])
    expect(fake.rows.map(keyOf).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_WAREHOUSE}`,
      `${F_WAREHOUSE_DATE} ${ROLE_PURCHASING}`,
    ].sort())

    const v2 = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })

    // THE HEADLINE: the column that changed hands is denied to exactly ONE role afterwards.
    expect(fake.rows.map(keyOf).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_WAREHOUSE}`,
      `${F_WAREHOUSE_DATE} ${ROLE_WAREHOUSE}`,
    ].sort())
    expect(v2.removed).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
    expect(v2.applied).toBe(2)

    // Idempotent: a converged re-run deletes nothing.
    const again = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })
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

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })

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

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })

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

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })

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

    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })

    expect(fake.rows.filter((row) => row.sheet_id === 'sheet_other')).toHaveLength(1)
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // THE OUTCOME THE BUSINESS ACTUALLY BUYS. Everything above is about which ROWS survive; this is
  // about who can WRITE the column afterwards, resolved through the REAL derivation chain rather
  // than by reading the table. Without the reconcile the two denials coexist, the chain ORs
  // `read_only` across a user's rows, and the moved column is refused to BOTH departments — the
  // silent breakage this whole section exists to retire.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  const RECONCILE_USER_ROLES: Record<string, string[]> = {
    user_caigou: [ROLE_PURCHASING],
    user_cangku: [ROLE_WAREHOUSE],
  }

  /** Resolve the real permission chain for one principal over the table as it now stands. */
  async function writabilityOver(rows: TableRow[], userId: string) {
    const scopeMap: Map<string, FieldPermissionScope> = await loadFieldPermissionScopeMap(
      fieldPermissionQueryFn(rows, RECONCILE_USER_ROLES),
      SHEET,
      userId,
    )
    return deriveFieldPermissions(FIELDS, CAPABILITIES, { fieldScopeMap: scopeMap })
  }

  it('after the move the column is writable by EXACTLY the new owner — real derivation chain', async () => {
    const fake = createTablePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    // v1: 仓库 owns the column (采购 is denied it).
    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES, reconcile: REGION, packId: PACK_A })
    const v1Purchasing = await writabilityOver(fake.rows, 'user_caigou')
    const v1Warehouse = await writabilityOver(fake.rows, 'user_cangku')
    expect(isFieldWriteForbidden(v1Purchasing[F_WAREHOUSE_DATE])).toBe(true)
    expect(isFieldWriteForbidden(v1Warehouse[F_WAREHOUSE_DATE])).toBe(false)

    // v2: the column changes hands — 采购 owns it now, 仓库 is denied it.
    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES, reconcile: REGION, packId: PACK_A })
    const purchasing = await writabilityOver(fake.rows, 'user_caigou')
    const warehouse = await writabilityOver(fake.rows, 'user_cangku')

    // THE HEADLINE, at the gate: exactly one department writes it, and it is the NEW owner.
    expect(isFieldWriteForbidden(purchasing[F_WAREHOUSE_DATE]), '采购 now owns it and must write it').toBe(false)
    expect(isFieldWriteForbidden(warehouse[F_WAREHOUSE_DATE]), '仓库 no longer owns it').toBe(true)
    // READ is untouched for both, which is the property the whole port is built around.
    expect(purchasing[F_WAREHOUSE_DATE].visible).not.toBe(false)
    expect(warehouse[F_WAREHOUSE_DATE].visible).not.toBe(false)
  })

  it('CONTROL — the SAME move without a reconcile leaves the column unwritable by BOTH', async () => {
    // The assertion above is not vacuous: this is byte-for-byte the same sequence with the region
    // omitted, and it reproduces the exact breakage the reconcile exists to fix.
    const fake = createTablePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES })
    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V2_ENTRIES })

    const purchasing = await writabilityOver(fake.rows, 'user_caigou')
    const warehouse = await writabilityOver(fake.rows, 'user_cangku')
    expect(isFieldWriteForbidden(purchasing[F_WAREHOUSE_DATE])).toBe(true)
    expect(isFieldWriteForbidden(warehouse[F_WAREHOUSE_DATE])).toBe(true)
    expect(fake.deletes).toHaveLength(0)
  })

  /**
   * ADDITIVE-PATH PIN — and it is a pin of the CURRENT additive path, not a transcription of
   * #5447's.
   *
   * The previous revision called this a "#5447 regression pin" and claimed the statements were
   * "transcribed from the pre-reconcile revision", which was not true and could not be: #5447's
   * upsert had an unconditional `DO UPDATE SET visible = true, read_only = true,
   * created_by = EXCLUDED.created_by` and bound FOUR parameters (round-2 finding 13). What is
   * actually preserved for a pre-#5455 caller is narrower, and is stated exactly:
   *   · the STATEMENT SEQUENCE is unchanged — one lock, two existence reads, one upsert per entry;
   *   · ZERO deletes and zero classification reads are issued;
   *   · `applied` / `entries` are unchanged.
   * What DELIBERATELY changed is named in the sibling test below rather than papered over: the DO
   * UPDATE gained an ownership guard on all three columns, a fifth bound parameter came with it,
   * and the result gained three keys.
   */
  it('ADDITIVE-PATH PIN: the exact statements, parameters and result an entry-only caller gets', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES })

    // (1) THE STATEMENTS. Whitespace-canonicalised (the upsert is a template literal, so its
    //     indentation is a formatting choice); every token that reaches the database is compared.
    //     A DELETE appearing here — or a fourth kind of read — reds this.
    const canonical = fake.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
    expect(canonical).toEqual([
      'SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE',
      'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
      'SELECT id FROM roles WHERE id = ANY($1::text[])',
      "INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)"
        + " VALUES ($1, $2, 'role', $3, true, true, $4)"
        + ' ON CONFLICT (sheet_id, field_id, subject_type, subject_id)'
        + ' DO UPDATE SET'
        + ' visible = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.visible END,'
        + ' read_only = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.read_only END,'
        + ' created_by = CASE WHEN field_permissions.created_by IN ($4, $5) THEN $4 ELSE field_permissions.created_by END',
      "INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)"
        + " VALUES ($1, $2, 'role', $3, true, true, $4)"
        + ' ON CONFLICT (sheet_id, field_id, subject_type, subject_id)'
        + ' DO UPDATE SET'
        + ' visible = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.visible END,'
        + ' read_only = CASE WHEN field_permissions.created_by IN ($4, $5) THEN true ELSE field_permissions.read_only END,'
        + ' created_by = CASE WHEN field_permissions.created_by IN ($4, $5) THEN $4 ELSE field_permissions.created_by END',
    ])
    // (2) THE BOUND PARAMETERS, in order.
    expect(fake.calls.map((call) => call.params)).toEqual([
      [SHEET],
      [SHEET, [F_WAREHOUSE_DATE, F_PURCHASE_REPLY]],
      [[ROLE_PURCHASING, ROLE_WAREHOUSE]],
      [
        SHEET, F_WAREHOUSE_DATE, ROLE_PURCHASING,
        STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
      ],
      [
        SHEET, F_PURCHASE_REPLY, ROLE_WAREHOUSE,
        STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
      ],
    ])
    expect(fake.transactions).toBe(1)

    // (3) THE RESULT. `applied` and `entries` are unchanged; THREE keys are new, all empty, because
    //     absent a region nothing was classified, no DELETE was issued and no pair was skipped.
    expect(Object.keys(result).sort()).toEqual([
      'applied', 'entries', 'governedByOtherPacks', 'operatorHeld', 'removed',
    ])
    expect({ applied: result.applied, entries: result.entries }).toEqual({
      applied: 2,
      entries: [
        { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING },
        { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
      ],
    })
    expect(result.removed).toEqual([])
    expect(result.operatorHeld).toEqual([])
    expect(result.governedByOtherPacks).toEqual([])
  })

  /**
   * THE DELTA AGAINST #5447, ASSERTED RATHER THAN ASSUMED. The pin above says what the additive path
   * emits today; this says what it no longer emits, so "byte-identical behaviour for every existing
   * caller" cannot be written again without one of these two tests moving.
   */
  it('ADDITIVE-PATH DELTA: the #5447 upsert clause and its 4-parameter bind are GONE', async () => {
    const fake = createFakePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({ sheetId: SHEET, entries: V1_ENTRIES })

    for (const insert of fake.inserts) {
      // #5447's clause, verbatim — an unconditional rewrite of the two permission columns.
      expect(insert.sql.replace(/\s+/g, ' '))
        .not.toContain('DO UPDATE SET visible = true, read_only = true')
      expect(insert.sql).not.toContain('created_by = EXCLUDED.created_by')
      // #5447 bound four parameters; the ownership guard needs the legacy marker as a fifth.
      expect(insert.params).toHaveLength(5)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 7. ADVERSARIAL REGRESSIONS (#5455 verification round)
//
// Every witness below reds on the code as it stood when the adversarial pass ran. They are grouped
// by ROOT CAUSE, not by symptom, because several attack lanes found the same defect from different
// directions and one fix has to answer all of them at once.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A table pool whose DELETE is decoded POSITIONALLY from the statement text, exactly the way
 * Postgres decodes it — `$1` means "the first bound parameter", wherever it appears, and the
 * `unnest(...) AS desired(a, b)` alias order decides which array is compared against which column.
 *
 * The previous model destructured `params` by hand and re-implemented the semantics, so it was
 * structurally blind to a statement that renamed an alias, swapped a placeholder or dropped a whole
 * axis. This one parses those decisions out of the SQL, which is what makes the executable model an
 * actual tie to the statement rather than a parallel description of it.
 */
function createDecodingTablePool(seed: TableRow[] = []): {
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
        // THE CONFLICT ARM, decoded from the statement rather than assumed. ALL THREE columns are
        // guarded by the same CASE, so all three are decoded the same way: an unconditional
        // `visible = true` / `read_only = true` on a row this port does not own is the un-hiding and
        // the permanent-lock defect, and a model that hardcoded `= true` could not see either.
        const owned = upsertGuardHolds(sql, existing.created_by, createdBy)
        if (resolveUpsertColumn(sql, 'visible', owned)) existing.visible = true
        if (resolveUpsertColumn(sql, 'read_only', owned)) existing.read_only = true
        existing.created_by = resolveUpsertCreatedBy(sql, existing.created_by, createdBy)
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
      const bind = (token: string): unknown => params[Number(token.slice(1)) - 1]
      const at = (pattern: RegExp): string | null => {
        const m = sql.match(pattern)
        return m ? m[1] : null
      }
      // Each axis is read out of the statement TEXT. A clause that is not there decodes to null and
      // the corresponding filter is simply not applied — which is precisely how the real database
      // would behave, and therefore how a dropped axis becomes visible to these assertions.
      const sheetToken = at(/sheet_id\s*=\s*(\$\d+)/)
      const createdByToken = at(/created_by\s*=\s*ANY\((\$\d+)::text\[\]\)/)
        ?? at(/created_by\s*=\s*(\$\d+)/)
      const readOnlyPinned = /read_only\s*=\s*true/.test(sql)
      const subjectTypePinned = /subject_type\s*=\s*'role'/.test(sql)
      const fieldToken = at(/field_id\s*=\s*ANY\((\$\d+)::text\[\]\)/)
      const subjectToken = at(/subject_id\s*=\s*ANY\((\$\d+)::text\[\]\)/)
      const unnest = sql.match(/unnest\((\$\d+)::text\[\],\s*(\$\d+)::text\[\]\)\s*AS\s+desired\((\w+),\s*(\w+)\)/)
      const hasNotExists = /NOT\s+EXISTS\s*\(/.test(sql)
      const returning = (sql.match(/RETURNING\s+([\w,\s]+)/) ?? [, ''])[1]
        .split(',').map((token) => token.trim()).filter(Boolean)

      // The desired set, keyed the way the statement's own alias names key it, AND correlated the
      // way the statement's own subquery predicate correlates it.
      //
      // THE CORRELATION IS THE FIFTH NARROWING and it used to be invisible here: the model paired
      // `desired.field_id` with the row's `field_id` because that is the obvious pairing, so
      // cross-wiring the statement to `desired.field_id = field_permissions.subject_id` changed
      // nothing this suite could see, while in Postgres it makes the reconcile delete the rows the
      // same call just wrote (round-2 finding 4). Now every `desired.X = field_permissions.Y` pair
      // is parsed out of the subquery and the key is built from the ROW columns the statement names.
      const correlations = [...sql.matchAll(
        /desired\.(\w+)\s*=\s*field_permissions\.(\w+)/g,
      )].map((match) => ({ desiredColumn: match[1], rowColumn: match[2] }))
      const desired = new Set<string>()
      let correlatedRowKey: ((row: TableRow) => string) | null = null
      if (unnest && hasNotExists && correlations.length > 0) {
        const [, tokenA, tokenB, nameA, nameB] = unnest
        const byName: Record<string, string[]> = {
          [nameA]: (bind(tokenA) as string[]) ?? [],
          [nameB]: (bind(tokenB) as string[]) ?? [],
        }
        // One tuple per unnest position, projected in the order the correlation predicates appear.
        const width = Math.max(...Object.values(byName).map((list) => list.length), 0)
        for (let i = 0; i < width; i += 1) {
          desired.add(correlations.map((c) => (byName[c.desiredColumn] ?? [])[i]).join(' '))
        }
        correlatedRowKey = (row) => correlations
          .map((c) => (row as unknown as Record<string, unknown>)[c.rowColumn])
          .join(' ')
      }

      const createdByBound = createdByToken ? bind(createdByToken) : null
      const markers = Array.isArray(createdByBound)
        ? (createdByBound as string[])
        : (createdByBound === null ? null : [String(createdByBound)])
      const regionFields = fieldToken ? (bind(fieldToken) as string[]) : null
      const regionRoles = subjectToken ? (bind(subjectToken) as string[]) : null
      const sheetBound = sheetToken ? String(bind(sheetToken)) : null

      const removed: TableRow[] = []
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (sheetBound !== null && row.sheet_id !== sheetBound) continue
        if (subjectTypePinned && row.subject_type !== 'role') continue
        if (markers !== null && !markers.includes(row.created_by)) continue
        if (readOnlyPinned && row.read_only !== true) continue
        if (regionFields !== null && !regionFields.includes(row.field_id)) continue
        if (regionRoles !== null && !regionRoles.includes(row.subject_id)) continue
        if (hasNotExists && correlatedRowKey && desired.has(correlatedRowKey(row))) continue
        removed.push(row)
        rows.splice(i, 1)
      }
      // Only the columns the statement actually RETURNS come back.
      return {
        rows: removed.map((row) => {
          const projected: Record<string, unknown> = {}
          const source = row as unknown as Record<string, unknown>
          for (const column of returning) projected[column] = source[column]
          return projected
        }),
      }
    }
    if (sql.includes('FROM field_permissions')) {
      // Both read shapes, decoded from the statement: the census pins `read_only = true`, the
      // classification snapshot deliberately does not (an operator's hidden-but-writable row must
      // still be seen, or the upsert skip cannot happen).
      const sheetId = String(params[0])
      const filterReadOnly = /read_only\s*=\s*true/.test(sql)
      return {
        rows: rows
          .filter((row) => row.sheet_id === sheetId && row.subject_type === 'role')
          .filter((row) => !filterReadOnly || row.read_only === true)
          .map((row) => ({
            field_id: row.field_id,
            subject_id: row.subject_id,
            created_by: row.created_by,
            visible: row.visible,
            read_only: row.read_only,
          })),
      }
    }
    throw new Error(`decoding pool: unexpected SQL ${sql}`)
  }

  return { pool: { async transaction(handler) { return handler({ query }) } }, rows, deletes }
}

/**
 * Decode the DO UPDATE's provenance arm out of the statement text.
 *
 * An unconditional `created_by = EXCLUDED.created_by` is takeover of whatever was there — the
 * laundering defect. A CASE-guarded arm adopts only a row whose provenance this port could also
 * delete (its own pack marker, or the legacy pack-less marker).
 */
function resolveUpsertCreatedBy(sql: string, currentCreatedBy: string, incoming: string): string {
  const doUpdate = sql.slice(sql.search(/DO UPDATE SET/i))
  if (!/created_by\s*=/i.test(doUpdate)) return currentCreatedBy
  if (!/created_by\s*=\s*CASE/i.test(doUpdate)) return incoming
  return upsertGuardHolds(sql, currentCreatedBy, incoming) ? incoming : currentCreatedBy
}

/**
 * Does the DO UPDATE's ownership guard hold for this row? The guard names the two markers this port
 * may also RETIRE — its own and the pack-less legacy one — so "may I rewrite this row" and "may I
 * delete this row" are the same question asked of the same two values.
 *
 * `created_by` NULL takes the ELSE branch in Postgres (`NULL IN (...)` is NULL, not true), and that
 * is the only shape the authoring route wrote before it started stamping — so it MUST be modelled,
 * not assumed away.
 */
function upsertGuardHolds(sql: string, currentCreatedBy: string | null, incoming: string): boolean {
  if (currentCreatedBy === null) return false
  const adoptable = [incoming, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY]
  return adoptable.includes(currentCreatedBy)
}

/**
 * Decode one guarded DO UPDATE column. `column = true` (unguarded) always writes; `column = CASE ...`
 * writes only when the ownership guard holds; an absent column is not written at all.
 */
function resolveUpsertColumn(sql: string, column: string, guardHolds: boolean): boolean {
  const doUpdate = sql.slice(sql.search(/DO UPDATE SET/i))
  const assignment = doUpdate.match(new RegExp(`${column}\\s*=\\s*(CASE|true|EXCLUDED)`, 'i'))
  if (!assignment) return false
  if (/^CASE$/i.test(assignment[1])) return guardHolds
  return true
}

const PACK_A = 'pack-alpha'
const PACK_B = 'pack-beta'
const markerFor = (packId: string) => `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${packId}`

const packRow = (fieldId: string, roleId: string, createdBy: string): TableRow => ({
  sheet_id: SHEET,
  field_id: fieldId,
  subject_type: 'role',
  subject_id: roleId,
  visible: true,
  read_only: true,
  created_by: createdBy,
})

describe('7-RC1. a declaration with a region but NO entries still reconciles', () => {
  const REGION = { fieldIds: [F_WAREHOUSE_DATE, F_PURCHASE_REPLY], roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] }

  it('empty entries + a region RETIRES everything this port holds in the rectangle', async () => {
    // The shared-custody revision: v2 says every declared role owns every governed column, so it
    // derives ZERO denials. Upsert-only that is a no-op; with a region it must be a full retirement,
    // or v1's denials keep the columns locked for the very roles v2 hands them to.
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A)),
      packRow(F_PURCHASE_REPLY, ROLE_WAREHOUSE, markerFor(PACK_A)),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({
      sheetId: SHEET, entries: [], packId: PACK_A, reconcile: REGION,
    })

    expect(result.applied).toBe(0)
    expect(result.removed).toEqual([
      { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
      { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING },
    ])
    expect(fake.rows).toHaveLength(0)
    expect(fake.deletes).toHaveLength(1)
  })

  it('empty entries and NO region stays the documented total no-op — zero statements', async () => {
    const fake = createDecodingTablePool([packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A))])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({ sheetId: SHEET, entries: [] })

    expect(result).toEqual({ applied: 0, entries: [], removed: [], operatorHeld: [], governedByOtherPacks: [] })
    expect(fake.deletes).toHaveLength(0)
    expect(fake.rows).toHaveLength(1)
  })
})

describe('7-RC2. provenance is per PACK, not per plugin', () => {
  const REGION = { fieldIds: [F_WAREHOUSE_DATE, F_PURCHASE_REPLY], roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] }

  it('a row written by ANOTHER pack is not deleted, even wholly inside the rectangle', async () => {
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_B)), // another pack's denial
      packRow(F_PURCHASE_REPLY, ROLE_PURCHASING, markerFor(PACK_A)), // ours, no longer declared
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
    })

    expect(result.removed).toEqual([{ fieldId: F_PURCHASE_REPLY, roleId: ROLE_PURCHASING }])
    expect(fake.rows.find((row) => row.created_by === markerFor(PACK_B))).toBeDefined()
  })

  /**
   * ═══ THE P0: A LEGACY ROW IS NOT NOBODY'S. ═══
   *
   * Every row every pack ever wrote before this change carries the BARE marker — the pack id lands
   * in `created_by` only as of #5455 — so "a pack-less row has no other owner to protect it for" was
   * false for the entire installed base, and it licensed pack B to retire pack A's live denials
   * (round-2 finding 1). The rule is now a PROOF OBLIGATION on the caller: adoption happens only
   * when it can show, from the install ledger, that this pack is the sheet's only pack.
   */
  it('a LEGACY row is REFUSED, not adopted, when the caller cannot prove sole ownership', async () => {
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
      // legacyAdoptable omitted — the fail-closed default.
    })).rejects.toMatchObject({
      reason: 'LEGACY_UNATTRIBUTED',
      pairs: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }],
    })

    // REFUSED BEFORE ANY WRITE: the legacy row is still there and nothing new was inserted.
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({
      field_id: F_WAREHOUSE_DATE,
      subject_id: ROLE_PURCHASING,
      created_by: STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
    })
    expect(fake.deletes).toHaveLength(0)
  })

  it('a LEGACY row IS adopted and retired once the caller proves this pack is the sheet\'s only one', async () => {
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    const result = await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
      legacyAdoptable: true,
    })

    expect(result.removed).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
  })

  /**
   * THE MARKER SET IS CONDITIONAL, AND THE CONDITION IS BOUND TO THE PARAMETER — not merely to the
   * classifier's opinion. Dropping `legacyAdoptable ? ... : [createdBy]` back to an unconditional
   * two-marker array leaves the DELETE reaching a legacy row the classification did NOT authorise,
   * and the divergence guard turns that into an abort rather than a silent extra delete.
   */
  it('the DELETE\'s marker array carries the legacy marker ONLY when adoption was proven', async () => {
    const seed = () => [
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY),
      packRow(F_PURCHASE_REPLY, ROLE_PURCHASING, markerFor(PACK_A)),
    ]
    const call = async (legacyAdoptable: boolean) => {
      const fake = createDecodingTablePool(seed())
      const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
      await service.applyRoleWriteScopes({
        sheetId: SHEET,
        entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
        packId: PACK_A,
        reconcile: REGION,
        legacyAdoptable,
      })
      return fake.deletes[0].params[1] as string[]
    }
    expect(await call(true)).toEqual([markerFor(PACK_A), STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY])
    // The unproven case never reaches the DELETE (the legacy row refuses first), so the marker
    // array is asserted on a sheet whose ONLY legacy row is outside the rectangle.
    const fake = createDecodingTablePool([
      packRow(F_MATERIAL_TYPE, ROLE_PRODUCTION, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY),
      packRow(F_PURCHASE_REPLY, ROLE_PURCHASING, markerFor(PACK_A)),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
    })
    expect(fake.deletes[0].params[1]).toEqual([markerFor(PACK_A)])
    // …and the out-of-rectangle legacy row is untouched by either arm.
    expect(fake.rows.some((row) => row.field_id === F_MATERIAL_TYPE)).toBe(true)
  })

  /**
   * THE PORT ITSELF REFUSES, not merely the installer. The plugin raises the same 422 from its
   * pre-flight, so a mutation that removed the refusal HERE stayed green across the plugin suites:
   * the installer's copy caught it first. That is precisely the arrangement the atomicity fix exists
   * to defeat — under concurrency the pre-flight's verdict is stale and only this one is binding.
   */
  it('the PORT refuses a declared pair another pack holds, before writing anything', async () => {
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_WAREHOUSE, markerFor(PACK_B)), // the pair v2 declares
      packRow(F_PURCHASE_REPLY, ROLE_PURCHASING, markerFor(PACK_A)), // ours, no longer declared
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
    })).rejects.toMatchObject({
      reason: 'PACK_CONFLICT',
      offending: [PACK_B],
      pairs: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE, packId: PACK_B }],
    })

    // NOTHING WAS WRITTEN AND NOTHING WAS DELETED: the refusal precedes the first upsert, so our own
    // stale row is still standing too — a half-applied refusal would be worse than none.
    expect(fake.deletes).toHaveLength(0)
    expect(fake.rows.map((row) => `${row.field_id} ${row.subject_id}`).sort()).toEqual([
      `${F_PURCHASE_REPLY} ${ROLE_PURCHASING}`,
      `${F_WAREHOUSE_DATE} ${ROLE_WAREHOUSE}`,
    ].sort())
    expect(fake.rows.find((row) => row.field_id === F_WAREHOUSE_DATE)!.created_by).toBe(markerFor(PACK_B))
  })

  it('a reconcile with NO packId is refused: an unattributable delete is not a reconcile', async () => {
    const fake = createDecodingTablePool([packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A))])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      reconcile: REGION,
    })).rejects.toMatchObject({ reason: 'ENTRIES_INVALID' })
    expect(fake.deletes).toHaveLength(0)
    expect(fake.rows).toHaveLength(1)
  })

  it('rows this port writes carry the PACK marker, and the census attributes every row', async () => {
    const fake = createDecodingTablePool([
      packRow(F_PURCHASE_REPLY, ROLE_PURCHASING, markerFor(PACK_B)),
      packRow(F_WAREHOUSE_STATUS, ROLE_WAREHOUSE, 'operator:univer-meta-authoring-route'),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
    })
    expect(fake.rows.find((row) => row.field_id === F_WAREHOUSE_DATE)?.created_by).toBe(markerFor(PACK_A))

    const census = await service.listRoleWriteScopes({ sheetId: SHEET })
    // Plugin-family rows come back attributed by pack; a legacy row reports packId null.
    expect(census.entries).toEqual([
      { fieldId: F_PURCHASE_REPLY, roleId: ROLE_PURCHASING, createdBy: markerFor(PACK_B), packId: PACK_B },
      { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE, createdBy: markerFor(PACK_A), packId: PACK_A },
    ])
    // A row this plugin did NOT write is never silently absorbed into the census — it is reported
    // separately so a caller can neither claim it nor mistake it for its own debris.
    expect(census.foreignEntries).toEqual([
      { fieldId: F_WAREHOUSE_STATUS, roleId: ROLE_WAREHOUSE, createdBy: 'operator:univer-meta-authoring-route' },
    ])
  })

  it('an omitted packId keeps writing the LEGACY marker — every existing caller unchanged', async () => {
    const fake = createDecodingTablePool()
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
    await service.applyRoleWriteScopes({
      sheetId: SHEET, entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
    })
    expect(fake.rows[0].created_by).toBe(STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY)
  })
})

describe('7-RC3. the statement is pinned where the model cannot see', () => {
  it('SOURCE GUARD: the sheet axis, the desired-alias order and the RETURNING list are pinned', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')
    const statement = src.slice(src.search(/DELETE\s+FROM\s+field_permissions/i))
    const where = statement.slice(0, statement.indexOf('RETURNING'))

    // THE SHEET AXIS. `field_permissions` carries no tenant or project column, so this single
    // clause is the whole of the project/sheet/tenant bound. It was asserted by nothing.
    expect(where).toMatch(/WHERE\s+sheet_id\s*=\s*\$1/)
    // THE ALIAS ORDER. Swapping these two names makes `desired.field_id` compare role ids against
    // column ids, NOT EXISTS becomes always-true, and the statement deletes the rows it just wrote.
    expect(where).toMatch(/AS\s+desired\(field_id,\s*subject_id\)/)
    // THE PROJECTION. `removed` is decoded from these two columns by name.
    expect(statement).toMatch(/RETURNING\s+field_id,\s*subject_id/)
  })

  it('the delete is bound to THIS sheet — decoded positionally, not modelled by hand', async () => {
    const twin: TableRow = {
      ...packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A)),
      sheet_id: 'sheet_other',
    }
    const fake = createDecodingTablePool([twin, packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A))])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: { fieldIds: [F_WAREHOUSE_DATE], roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] },
    })

    // Identical (field, role) on another sheet. Only `sheet_id = $1` keeps it alive.
    expect(fake.rows.filter((row) => row.sheet_id === 'sheet_other')).toHaveLength(1)
  })
})

describe('7-RC4. an operator row is never laundered into a plugin row', () => {
  const REGION = { fieldIds: [F_WAREHOUSE_DATE, F_PURCHASE_REPLY], roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE] }

  it('re-declaring a pair an operator owns does NOT take over its provenance, so v2 cannot delete it', async () => {
    const fake = createDecodingTablePool([
      packRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, 'operator:univer-meta-authoring-route'),
    ])
    const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })

    // v1 declares the very same denial the operator already authored.
    await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }],
      packId: PACK_A,
      reconcile: REGION,
    })
    expect(fake.rows[0].created_by).toBe('operator:univer-meta-authoring-route')

    // v2 drops it. The operator's decision must still stand.
    const v2 = await service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
    })
    expect(v2.removed).toEqual([])
    expect(fake.rows.find((row) => row.subject_id === ROLE_PURCHASING)?.created_by)
      .toBe('operator:univer-meta-authoring-route')
  })

  it('SOURCE GUARD: the DO UPDATE never re-stamps provenance unconditionally', () => {
    const src = readFileSync(SERVICE_SOURCE_PATH, 'utf8')
    const upsertAt = src.search(/INSERT\s+INTO\s+field_permissions/i)
    const upsert = src.slice(upsertAt)
    const doUpdateAt = upsert.search(/DO UPDATE SET/i)
    const doUpdate = upsert.slice(doUpdateAt, upsert.indexOf('`', doUpdateAt))
    expect(doUpdate).toMatch(/created_by\s*=\s*CASE/i)
    expect(doUpdate).not.toMatch(/created_by\s*=\s*EXCLUDED\.created_by/)
  })
})

describe('7-RC5. the port declares whether it can reconcile at all', () => {
  it('exposes supportsWriteScopeReconcile === true so a caller can feature-detect it', () => {
    const service = new StockPreparationFieldPermissionsService({ pool: createFakePool().pool })
    expect(service.supportsWriteScopeReconcile).toBe(true)
  })
})

describe('7-RC7. falsy reconcile is absent, not malformed', () => {
  it('reconcile:false / null / undefined are all the additive path, byte-identical', async () => {
    for (const value of [undefined, null, false]) {
      const fake = createFakePool()
      const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
      const result = await service.applyRoleWriteScopes({
        sheetId: SHEET,
        entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }],
        reconcile: value as undefined,
      })
      expect(result).toEqual({
        applied: 1,
        entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }],
        removed: [],
        // No region → no classification, so both classification projections are empty rather than
        // absent: an additive call decided nothing about anybody's rows, and says so.
        operatorHeld: [],
        governedByOtherPacks: [],
      })
      expect(fake.calls.filter((call) => /DELETE/i.test(call.sql))).toHaveLength(0)
      // …and the additive path issues no classification SELECT either — the header's
      // "no statement of any kind beyond the upserts" is a count, not a claim.
      expect(fake.calls.filter((call) => /FROM field_permissions/i.test(call.sql))).toHaveLength(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 8. THE ONE-TIME BACKFILL — the other half of the P0's fix.
//
// The port REFUSES an unattributable pack-less row; this attributes the ones that can be
// attributed. The inference it makes is the load-bearing part and it is a pure function, so it is
// exercised here exhaustively rather than only against a database.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('8. backfill: only a sheet with exactly ONE pack in the ledger can be attributed', () => {
  it('a single-pack target is attributed, and the sheet id is the platform\'s own derivation', () => {
    const { soleOwners, ambiguous } = selectSoleOwnerSheets([
      { projectId: 'p1', objectId: 'plm_stock_preparation_main', packIds: ['pack-alpha'] },
    ])
    expect(ambiguous).toEqual([])
    expect(soleOwners).toHaveLength(1)
    expect(soleOwners[0]).toMatchObject({
      projectId: 'p1',
      objectId: 'plm_stock_preparation_main',
      packId: 'pack-alpha',
      createdBy: stockPreparationFieldPermissionCreatedBy('pack-alpha'),
    })
    // NOT a re-implementation: the same function the installer resolves its rectangle with. A second
    // copy of the sha1 (in a migration's SQL, say) is a copy that can drift.
    expect(soleOwners[0].sheetId).toBe(getObjectSheetId('p1', 'plm_stock_preparation_main'))
  })

  it('TWO packs on one target is AMBIGUOUS and is never guessed — this is the P0', () => {
    // The exact shape the first revision got wrong: two packs share the canonical sheet, every row
    // on it carries the bare marker, and "it must be mine" would hand pack A's live denials to B.
    const { soleOwners, ambiguous } = selectSoleOwnerSheets([
      { projectId: 'p1', objectId: 'obj', packIds: ['pack-alpha', 'pack-beta'] },
    ])
    expect(soleOwners).toEqual([])
    expect(ambiguous).toEqual([{ projectId: 'p1', objectId: 'obj', packIds: ['pack-alpha', 'pack-beta'] }])
  })

  it('duplicate ledger rows for the SAME pack are still one pack', () => {
    // A re-install writes one row per (tenant, project, object, pack), so the same pack can appear
    // more than once across tenants. That is still one owner, and refusing it would leave every
    // multi-tenant host permanently unattributed.
    const { soleOwners, ambiguous } = selectSoleOwnerSheets([
      { projectId: 'p1', objectId: 'obj', packIds: ['pack-alpha', 'pack-alpha'] },
    ])
    expect(ambiguous).toEqual([])
    expect(soleOwners.map((row) => row.packId)).toEqual(['pack-alpha'])
  })

  it('an EMPTY pack list is ambiguous, not trusted — absence of evidence is not evidence', () => {
    const { soleOwners, ambiguous } = selectSoleOwnerSheets([
      { projectId: 'p1', objectId: 'obj', packIds: [] },
      { projectId: 'p2', objectId: 'obj', packIds: ['   ', ''] },
    ])
    expect(soleOwners).toEqual([])
    expect(ambiguous).toHaveLength(2)
  })

  it('two DIFFERENT targets are decided independently', () => {
    const { soleOwners, ambiguous } = selectSoleOwnerSheets([
      { projectId: 'p1', objectId: 'obj', packIds: ['pack-alpha'] },
      { projectId: 'p2', objectId: 'obj', packIds: ['pack-alpha', 'pack-beta'] },
      { projectId: 'p3', objectId: 'obj', packIds: ['pack-beta'] },
    ])
    expect(soleOwners.map((row) => `${row.projectId}:${row.packId}`).sort())
      .toEqual(['p1:pack-alpha', 'p3:pack-beta'])
    expect(ambiguous.map((row) => row.projectId)).toEqual(['p2'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 9. THE CLASSIFICATION'S OWN PROJECTIONS — the invariant, asserted directly.
//
// The plugin suites exercise the INSTALLER against a fake port, so a rule that lives in this file's
// classifier is invisible to them by construction: mutating it there changes nothing they can see.
// Every projection boundary is therefore pinned HERE, against the real function.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('9. classifyRoleWriteScopeRows — each projection holds exactly what it claims', () => {
  const OUT_ROLE = 'role_beiliao_quality'
  const REGION = {
    fieldIds: [F_WAREHOUSE_DATE, F_PURCHASE_REPLY],
    roleIds: [ROLE_PURCHASING, ROLE_WAREHOUSE],
  }
  const snapshotRow = (
    fieldId: string,
    roleId: string,
    createdBy: string | null,
    over: Partial<{ visible: boolean; readOnly: boolean }> = {},
  ) => ({ fieldId, roleId, createdBy, visible: true, readOnly: true, ...over })

  /** One sheet carrying every kind of row this invariant knows about. */
  const classifyMixed = (legacyAdoptable: boolean) => classifyRoleWriteScopeRows({
    sheetId: SHEET,
    packId: PACK_A,
    entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
    region: REGION,
    legacyAdoptable,
    rows: [
      // IN-REGION, ours, no longer declared → the DELETE's row set.
      snapshotRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A)),
      // IN-REGION, ANOTHER pack, on a pair we DECLARE → a conflict.
      snapshotRow(F_WAREHOUSE_DATE, ROLE_WAREHOUSE, markerFor(PACK_B)),
      // IN-REGION, ANOTHER pack, on a pair we do NOT declare → coexistence, not conflict.
      snapshotRow(F_PURCHASE_REPLY, ROLE_WAREHOUSE, markerFor(PACK_B)),
      // IN-REGION, a HUMAN (the real NULL shape) → never changed, reported.
      snapshotRow(F_PURCHASE_REPLY, ROLE_PURCHASING, LEGACY_OPERATOR_CREATED_BY),
      // OUT of region (column axis), pack-less → adoptable or unattributed, on the caller's proof.
      snapshotRow(F_MATERIAL_TYPE, ROLE_PURCHASING, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY),
      // OUT of region (role axis), ours → the ONLY genuine operator to-do.
      snapshotRow(F_WAREHOUSE_DATE, OUT_ROLE, markerFor(PACK_A)),
      // OUT of region (role axis), ANOTHER pack's → not ours, not a to-do.
      snapshotRow(F_PURCHASE_REPLY, OUT_ROLE, markerFor(PACK_B)),
      // OUT of region (role axis), a HUMAN's → a decision, not debris.
      snapshotRow(F_PURCHASE_ETA, OUT_ROLE, OPERATOR_MARKER),
    ],
  })

  it('CONFLICT is a DECLARED-pair overlap only — a sibling pack elsewhere in the rectangle coexists', () => {
    // Widening this to "any sibling row inside my rectangle" bricks every legitimate second pack on
    // the canonical table, which is why the two buckets are asserted together.
    const c = classifyMixed(true)
    expect(c.packConflicts).toEqual([
      { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE, packId: PACK_B },
    ])
    expect(c.governedByOtherPacks).toEqual([
      { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE, packId: PACK_B },
    ])
  })

  it('the operator TO-DO list holds only THIS pack’s own out-of-rectangle debris', () => {
    // Four rows sit outside the rectangle and exactly one of them is this pack’s to answer for.
    // A sibling pack’s live denial and a human’s decision are neither wrong nor ours; an
    // unattributable legacy row out there is not claimable at all.
    const c = classifyMixed(false)
    expect(c.operatorMustClear).toEqual([
      { fieldId: F_WAREHOUSE_DATE, roleId: OUT_ROLE, packId: PACK_A },
    ])
  })

  it('a HUMAN’s in-region row is reported with WHAT they decided, and is never retired', () => {
    const c = classifyMixed(true)
    expect(c.operatorHeldInRegion).toEqual([
      {
        fieldId: F_PURCHASE_REPLY,
        roleId: ROLE_PURCHASING,
        createdBy: null,
        packId: null,
        owner: 'operator',
        declared: false,
        visible: true,
        readOnly: true,
      },
    ])
    expect(c.willRetire).toEqual([{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_PURCHASING }])
  })

  it('a pack-less row is CLAIMED only on the caller’s proof — otherwise nobody speaks for it', () => {
    // The same row, the same position, two verdicts. With proof it is this pack’s (and so, being
    // out of the rectangle, becomes the operator’s to-do); without it, it belongs to nobody this
    // call can name and appears in no projection at all.
    const proven = classifyMixed(true)
    expect(proven.operatorMustClear.map((r) => r.fieldId)).toContain(F_MATERIAL_TYPE)
    const unproven = classifyMixed(false)
    expect(unproven.operatorMustClear.map((r) => r.fieldId)).not.toContain(F_MATERIAL_TYPE)
  })

  it('an operator on a DECLARED pair removes it from the write set — `applied` counts rows WRITTEN', async () => {
    // The port drops the pair before the statement, so the operator's row is not merely guarded by
    // the DO UPDATE's CASE — it is never addressed. `applied` is therefore the number of rows this
    // call really wrote, which is what makes the install's own arithmetic honest.
    for (const createdBy of [OPERATOR_MARKER, LEGACY_OPERATOR_CREATED_BY]) {
      const fake = createDecodingTablePool([
        {
          ...pluginRow(F_WAREHOUSE_DATE, ROLE_WAREHOUSE),
          created_by: createdBy,
          visible: false,
          read_only: false,
        },
      ])
      const service = new StockPreparationFieldPermissionsService({ pool: fake.pool })
      const result = await service.applyRoleWriteScopes({
        sheetId: SHEET,
        entries: [
          { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE },
          { fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE },
        ],
        packId: PACK_A,
        reconcile: REGION,
      })
      expect(result.applied).toBe(1)
      expect(result.entries).toEqual([{ fieldId: F_PURCHASE_REPLY, roleId: ROLE_WAREHOUSE }])
      expect(result.operatorHeld).toEqual([
        { fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE, packId: null },
      ])
      // And the human's row is byte-identical: hidden, writable, unattributed to this plugin.
      const held = fake.rows.find((r) => r.field_id === F_WAREHOUSE_DATE)!
      expect(held).toMatchObject({ visible: false, read_only: false, created_by: createdBy })
    }
  })

  /**
   * THE POST-CONDITION IS ITSELF WITNESSED. `RECONCILE_DIVERGED` is defence in depth: with every
   * narrowing correct it can never fire, so removing it alone changes no other test. Here the pool
   * is rigged to report a delete the classification did not authorise — the shape a widened or
   * cross-wired narrowing produces — and the call must ABORT rather than report the extra delete.
   */
  it('a DELETE that reaches a row the classification did not authorise ABORTS the call', async () => {
    const base = createDecodingTablePool([pluginRow(F_WAREHOUSE_DATE, ROLE_PURCHASING, markerFor(PACK_A))])
    const rigged: StockPreparationFieldPermissionsPool = {
      async transaction(handler) {
        return base.pool.transaction(async ({ query }) => handler({
          query: async (sql, params) => {
            const result = await query(sql, params)
            if (!/DELETE FROM field_permissions/.test(sql)) return result
            // One extra pair, exactly as a widened predicate would have returned.
            return { rows: [...result.rows, { field_id: F_PURCHASE_ETA, subject_id: ROLE_WAREHOUSE }] }
          },
        }))
      },
    }
    const service = new StockPreparationFieldPermissionsService({ pool: rigged })
    await expect(service.applyRoleWriteScopes({
      sheetId: SHEET,
      entries: [{ fieldId: F_WAREHOUSE_DATE, roleId: ROLE_WAREHOUSE }],
      packId: PACK_A,
      reconcile: REGION,
    })).rejects.toMatchObject({ reason: 'RECONCILE_DIVERGED' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 10. THE BACKFILL'S RUNNER — the loop, not just the inference.
//
// `selectSoleOwnerSheets` is the decision; this is what the script DOES with it. It is exercised
// against a fake pool because the two properties that matter are statement-shaped: a dry run must
// issue no UPDATE at all, and the UPDATE it does issue must be narrow enough that a second run is a
// no-op. A runner nobody drives is a runner whose dry-run can lie about the write it rehearses.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('10. runWriteScopePackIdBackfill — dry run rehearses the write it would make', () => {
  const LEDGER_SQL = /FROM integration_stock_prep_pack_installs/
  const SOLE = { projectId: 'p-sole', objectId: 'obj' }
  const AMBIGUOUS = { projectId: 'p-many', objectId: 'obj' }

  /**
   * A pool that answers the ledger query from a fixture and the field_permissions queries from an
   * in-memory row list, recording every statement so the dry-run/apply difference is a fact about
   * the SQL rather than about the summary the function chose to return.
   */
  const createBackfillPool = (options: {
    ledger: Array<{ project_id: string; object_id: string; pack_ids: string[] }>
    bareRowsBySheet: Record<string, number>
  }) => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const rows = { ...options.bareRowsBySheet }
    return {
      statements,
      rows,
      async query(sql: string, params: unknown[] = []) {
        statements.push({ sql, params })
        if (LEDGER_SQL.test(sql)) return { rows: options.ledger } as never
        if (/^\s*UPDATE field_permissions/.test(sql)) {
          const sheetId = String(params[0])
          const affected = rows[sheetId] ?? 0
          // The UPDATE's own predicate: only rows still carrying the BARE marker. Modelling that is
          // what makes the idempotence assertion below mean something.
          rows[sheetId] = 0
          return { rows: [], rowCount: affected } as never
        }
        const sheetId = String(params[0])
        return { rows: [{ count: String(rows[sheetId] ?? 0) }] } as never
      },
    }
  }

  const LEDGER = [
    { project_id: SOLE.projectId, object_id: SOLE.objectId, pack_ids: ['pack-alpha'] },
    { project_id: AMBIGUOUS.projectId, object_id: AMBIGUOUS.objectId, pack_ids: ['pack-alpha', 'pack-beta'] },
  ]
  const soleSheet = getObjectSheetId(SOLE.projectId, SOLE.objectId)
  const ambiguousSheet = getObjectSheetId(AMBIGUOUS.projectId, AMBIGUOUS.objectId)

  it('a DRY RUN issues no UPDATE at all, and counts exactly what an apply would change', async () => {
    const pool = createBackfillPool({
      ledger: LEDGER,
      bareRowsBySheet: { [soleSheet]: 3, [ambiguousSheet]: 2 },
    })
    const summary = await runWriteScopePackIdBackfill(pool)

    expect(pool.statements.some((s) => /^\s*UPDATE/.test(s.sql))).toBe(false)
    expect(summary).toEqual({
      targets: 2,
      soleOwnerSheets: 1,
      ambiguousSheets: 1,
      rowsStamped: 3,
      rowsLeftUnattributed: 2,
    })
    // Nothing moved: the fixture still holds every bare row.
    expect(pool.rows[soleSheet]).toBe(3)
  })

  it('an APPLY stamps only the sole-owner sheet, with this pack\'s marker and the BARE predicate', async () => {
    const pool = createBackfillPool({
      ledger: LEDGER,
      bareRowsBySheet: { [soleSheet]: 3, [ambiguousSheet]: 2 },
    })
    const summary = await runWriteScopePackIdBackfill(pool, { apply: true })

    const updates = pool.statements.filter((s) => /^\s*UPDATE/.test(s.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual([
      soleSheet,
      stockPreparationFieldPermissionCreatedBy('pack-alpha'),
      STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
    ])
    // THE PREDICATE IS THE SAFETY PROPERTY: role-scoped rows on ONE sheet whose provenance is still
    // exactly the bare marker. A row already stamped (this pack's or another's), an operator's row
    // and a NULL row are all outside it — which is also what makes a second run a no-op.
    expect(updates[0].sql).toMatch(/WHERE sheet_id = \$1/)
    expect(updates[0].sql).toMatch(/AND subject_type = 'role'/)
    expect(updates[0].sql).toMatch(/AND created_by = \$3/)
    expect(summary.rowsStamped).toBe(3)
    // The AMBIGUOUS sheet is untouched and reported, never guessed at.
    expect(summary.rowsLeftUnattributed).toBe(2)
    expect(pool.rows[ambiguousSheet]).toBe(2)
  })

  it('IDEMPOTENT: a second apply finds nothing left to stamp', async () => {
    const pool = createBackfillPool({
      ledger: LEDGER,
      bareRowsBySheet: { [soleSheet]: 3, [ambiguousSheet]: 2 },
    })
    await runWriteScopePackIdBackfill(pool, { apply: true })
    const second = await runWriteScopePackIdBackfill(pool, { apply: true })
    expect(second.rowsStamped).toBe(0)
    // …and the ambiguous sheet still refuses on every run, which is the point: it is not a transient
    // state the script works through, it is a decision only a human can make.
    expect(second.rowsLeftUnattributed).toBe(2)
  })

  it('an empty ledger touches nothing — there is nothing it can attribute', async () => {
    const pool = createBackfillPool({ ledger: [], bareRowsBySheet: {} })
    const summary = await runWriteScopePackIdBackfill(pool, { apply: true })
    expect(pool.statements.some((s) => /^\s*UPDATE/.test(s.sql))).toBe(false)
    expect(summary).toEqual({
      targets: 0,
      soleOwnerSheets: 0,
      ambiguousSheets: 0,
      rowsStamped: 0,
      rowsLeftUnattributed: 0,
    })
  })
})
