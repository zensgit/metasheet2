/**
 * 一个项目一张备料表 G1 — the host's narrow grant port (ADR adr-stock-prep-project-sheets-20261008 §2 /
 * addendum A.6; register R-35), against a fake query function (no DB) and a source census.
 *
 *   G-01 ROLE NAMESPACE: a role id outside `stock-prep` / `stock-prep_…` refuses the WHOLE call
 *        (422) before any statement; a non-array / blank id is 422 too.
 *   G-02 EVERY ROLE MUST EXIST: a configured role the `roles` table does not hold refuses (404)
 *        with nothing inserted.
 *   G-03 THE WRITE: one INSERT per role, `subject_type = 'role'`, `user_id` NULL, the literal
 *        `spreadsheet:write`, ON CONFLICT DO NOTHING; a repeat is `alreadyGranted` and inserts nothing;
 *        every landed grant writes exactly one `meta_config_revisions` row in the same query stream.
 *   G-04 ADD-ONLY: a role that already holds `spreadsheet:read` gains the write row and KEEPS the
 *        read row (no DELETE anywhere); a role that already holds admin gets no history row.
 *   G-05 SOURCE CENSUS: the service file contains exactly one INSERT, zero DELETE, zero UPDATE of
 *        spreadsheet_permissions, and the only `perm_code` value bound is the contract literal.
 *   G-06 THE WRAPPER (plugin-scope): exposed iff the host exposes it; refuses — in order — a foreign
 *        project namespace, a role outside the namespace, an objectId without the project-sheet
 *        shape, a sheet id that is not the derived one, a sheet the strict hook does not attribute
 *        to the plugin, a sheet the registry does not attribute to the project; and a host without
 *        the strict hook cannot grant at all. Only after all six does the host method run, with the
 *        normalized role list.
 *   G-07 the history entity id matches the operator route's `permissionConfigEntityId` shape.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE,
  STOCK_PREPARATION_ROLE_NAMESPACE,
  StockPreparationProjectSheetGrantError,
  isStockPreparationProjectSheetObjectId,
  normalizeStockPreparationGrantRoleIds,
} from '../../src/multitable/stock-preparation-project-sheet-grant-contract'
import {
  grantStockPreparationProjectSheetRoleWrite,
  stockPreparationProjectSheetGrantEntityId,
} from '../../src/services/stock-preparation-project-sheet-grants'
import {
  MultitableProjectNamespaceError,
  MultitableSheetScopeError,
  createPluginScopedMultitableApi,
} from '../../src/multitable/plugin-scope'
import { permissionConfigEntityId } from '../../src/routes/univer-meta'

const SHEET = 'sheet_s1_project_a'
const ROLE_A = 'stock-prep_frontline'
const ROLE_B = 'stock-prep_puller'

/**
 * A fake of the host's transaction-bound query: it understands exactly the statements the service
 * issues, keeps `spreadsheet_permissions` and `meta_config_revisions` in memory, and records every
 * statement so a test can count them.
 */
function makeFakeQuery({ roles = [ROLE_A, ROLE_B], existingPermissions = [] as Array<{ subjectId: string; permCode: string }>, liveness = 'live' } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const permissions = existingPermissions.map((row) => ({ sheet_id: SHEET, subject_type: 'role', subject_id: row.subjectId, perm_code: row.permCode }))
  const revisions: unknown[][] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    statements.push({ sql: normalized, params })
    if (normalized.includes('FROM meta_sheets') && normalized.includes('FOR UPDATE')) {
      return { rows: liveness === 'missing' ? [] : [{ id: params[0], deleted_at: liveness === 'deleted' ? new Date() : null }], rowCount: liveness === 'missing' ? 0 : 1 }
    }
    if (normalized.startsWith('SELECT id FROM roles')) {
      const wanted = params[0] as string[]
      return { rows: roles.filter((id) => wanted.includes(id)).map((id) => ({ id })), rowCount: 0 }
    }
    if (normalized.startsWith('SELECT perm_code FROM spreadsheet_permissions')) {
      const [sheetId, subjectId, codes] = params as [string, string, string[]]
      return { rows: permissions.filter((row) => row.sheet_id === sheetId && row.subject_type === 'role' && row.subject_id === subjectId && codes.includes(row.perm_code)).map((row) => ({ perm_code: row.perm_code })), rowCount: 0 }
    }
    if (normalized.startsWith('INSERT INTO spreadsheet_permissions')) {
      const [sheetId, subjectId, permCode] = params as [string, string, string]
      const exists = permissions.some((row) => row.sheet_id === sheetId && row.subject_type === 'role' && row.subject_id === subjectId && row.perm_code === permCode)
      if (exists) return { rows: [], rowCount: 0 }
      permissions.push({ sheet_id: sheetId, subject_type: 'role', subject_id: subjectId, perm_code: permCode })
      return { rows: [{ subject_id: subjectId }], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO meta_config_revisions')) {
      revisions.push(params)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL in test: ${normalized}`)
  })
  return { query, statements, permissions, revisions }
}

describe('stock-preparation project-sheet grant port (G1)', () => {
  it('G-01 refuses a role outside the stock-prep namespace, and malformed lists, before any statement', async () => {
    const fake = makeFakeQuery()
    for (const roleIds of [['multitable_admin'], [ROLE_A, 'admin'], ['stock-prep-operator'], ['stockprep_x'], [''], [' '], [42 as unknown as string]]) {
      await expect(grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds })).rejects.toMatchObject({ status: 422 })
    }
    await expect(grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: 'stock-prep_x' as unknown as string[] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLES_INVALID' })
    await expect(grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: '', roleIds: [ROLE_A] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_INVALID' })
    expect(fake.statements).toEqual([])
    const outside = (() => { try { normalizeStockPreparationGrantRoleIds(['stock-prep-operator']); return null } catch (error) { return error as StockPreparationProjectSheetGrantError } })()
    expect(outside?.code).toBe('STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE')
    expect(outside?.details).toEqual({ field: 'roleIds', roleId: 'stock-prep-operator', namespace: STOCK_PREPARATION_ROLE_NAMESPACE })
    // The exact namespace rule: the bare namespace and `stock-prep_<x>`, trimmed and de-duplicated.
    expect(normalizeStockPreparationGrantRoleIds([' stock-prep ', ROLE_A, ROLE_A, ROLE_B])).toEqual(['stock-prep', ROLE_A, ROLE_B])
    // An empty list is the one total no-op.
    await expect(grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: [] })).resolves.toEqual({ sheetId: SHEET, granted: [], alreadyGranted: [] })
    expect(fake.statements).toEqual([])
  })

  it('G-02 refuses the whole call when any configured role does not exist, with nothing inserted', async () => {
    const fake = makeFakeQuery({ roles: [ROLE_A] })
    await expect(grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: [ROLE_A, ROLE_B] })).rejects.toMatchObject({
      status: 404,
      code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND',
      details: { field: 'roleIds', missingRoleIds: [ROLE_B] },
    })
    expect(fake.statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false)
    expect(fake.permissions).toEqual([])
    // The liveness lock runs first: a dead sheet refuses before the roles are even looked up.
    const dead = makeFakeQuery({ liveness: 'deleted' })
    await expect(grantStockPreparationProjectSheetRoleWrite(dead.query, { sheetId: SHEET, roleIds: [ROLE_A] })).rejects.toMatchObject({ name: 'SheetNotLiveError' })
    expect(dead.statements.some((s) => s.sql.startsWith('SELECT id FROM roles'))).toBe(false)
  })

  it('G-03 writes one add-only row per role with the literal code, audits each landed grant, and is idempotent', async () => {
    const fake = makeFakeQuery()
    const first = await grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: [ROLE_A, ROLE_B], actorId: 'u_pull', batchId: 'batch-1' })
    expect(first).toEqual({ sheetId: SHEET, granted: [ROLE_A, ROLE_B], alreadyGranted: [] })
    const inserts = fake.statements.filter((s) => s.sql.startsWith('INSERT INTO spreadsheet_permissions'))
    expect(inserts).toHaveLength(2)
    for (const insert of inserts) {
      expect(insert.sql).toContain("VALUES ($1, NULL, 'role', $2, $3)")
      expect(insert.sql).toContain('ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING')
      expect(insert.params[0]).toBe(SHEET)
      expect(insert.params[2]).toBe('spreadsheet:write')
    }
    expect(fake.permissions).toEqual([
      { sheet_id: SHEET, subject_type: 'role', subject_id: ROLE_A, perm_code: 'spreadsheet:write' },
      { sheet_id: SHEET, subject_type: 'role', subject_id: ROLE_B, perm_code: 'spreadsheet:write' },
    ])
    expect(fake.revisions).toHaveLength(2)
    const [, sheetId, entityType, entityId, action, before, after, changedKeys, batchId, actorId] = fake.revisions[0] as unknown[]
    expect([sheetId, entityType, entityId, action, before, batchId, actorId]).toEqual([SHEET, 'permission', `sheet:${JSON.stringify(['role', ROLE_A])}`, 'create', 'null', 'batch-1', 'u_pull'])
    expect(JSON.parse(after as string)).toEqual({ subjectType: 'role', subjectId: ROLE_A, accessLevel: 'write' })
    expect(changedKeys).toEqual(['subjectType', 'subjectId', 'accessLevel'])
    // The REPEAT: nothing inserted, nothing audited, every role reported as already granted.
    const statementsBefore = fake.statements.length
    const again = await grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: [ROLE_A, ROLE_B] })
    expect(again).toEqual({ sheetId: SHEET, granted: [], alreadyGranted: [ROLE_A, ROLE_B] })
    expect(fake.permissions).toHaveLength(2)
    expect(fake.revisions).toHaveLength(2)
    expect(fake.statements.slice(statementsBefore).filter((s) => s.sql.startsWith('INSERT INTO meta_config_revisions'))).toHaveLength(0)
  })

  it('G-04 is ADD-ONLY: a read grant is kept beside the new write row; an admin grant gets no history row', async () => {
    const fake = makeFakeQuery({ existingPermissions: [{ subjectId: ROLE_A, permCode: 'spreadsheet:read' }, { subjectId: ROLE_B, permCode: 'spreadsheet:admin' }] })
    const result = await grantStockPreparationProjectSheetRoleWrite(fake.query, { sheetId: SHEET, roleIds: [ROLE_A, ROLE_B] })
    expect(result).toEqual({ sheetId: SHEET, granted: [ROLE_A, ROLE_B], alreadyGranted: [] })
    expect(fake.permissions.filter((row) => row.subject_id === ROLE_A).map((row) => row.perm_code).sort()).toEqual(['spreadsheet:read', 'spreadsheet:write'])
    expect(fake.permissions.filter((row) => row.subject_id === ROLE_B).map((row) => row.perm_code).sort()).toEqual(['spreadsheet:admin', 'spreadsheet:write'])
    expect(fake.statements.some((s) => /\bDELETE\b/i.test(s.sql) || /\bUPDATE spreadsheet_permissions\b/i.test(s.sql))).toBe(false)
    // read → write is an UPDATE history row; admin stays admin, so no row.
    expect(fake.revisions).toHaveLength(1)
    const [, , , entityId, action, before, after, changedKeys] = fake.revisions[0] as unknown[]
    expect(entityId).toBe(`sheet:${JSON.stringify(['role', ROLE_A])}`)
    expect(action).toBe('update')
    expect(JSON.parse(before as string)).toEqual({ accessLevel: 'read' })
    expect(JSON.parse(after as string)).toEqual({ accessLevel: 'write' })
    expect(changedKeys).toEqual(['accessLevel'])
  })

  it('G-05 source census: one INSERT, zero DELETE, the perm code bound only as the contract literal', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'stock-preparation-project-sheet-grants.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code.match(/INSERT INTO spreadsheet_permissions/g)).toHaveLength(1)
    expect(code.match(/\bDELETE\b/g)).toBeNull()
    expect(code.match(/UPDATE spreadsheet_permissions/g)).toBeNull()
    expect(code.match(/\bvisible\b/g)).toBeNull()
    expect(code).toContain('STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE]')
    expect(code).not.toMatch(/'spreadsheet:(read|admin|write-own)'/)
    expect(STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE).toBe('spreadsheet:write')
    expect(code).toContain("VALUES ($1, NULL, 'role', $2, $3)")
  })

  it('G-07 the history entity id matches the operator route\'s shape', () => {
    expect(stockPreparationProjectSheetGrantEntityId(ROLE_A)).toBe(permissionConfigEntityId('sheet', ['role', ROLE_A]))
  })
})

describe('plugin-scope grantSheetRoleWrite wrapper (G1)', () => {
  const PLUGIN = 'plugin-integration-core'
  const PROJECT_ID = 'tenant-s1:integration-core'
  const OBJECT_ID = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
  const derived = (projectId: string, objectId: string) => `sheet_${projectId}_${objectId}`

  // `assertSheetOwnedByPlugin: null` means "the host provides NO strict hook" (a default parameter
  // would re-create the hook on an explicit `undefined`, which is how an earlier cut of case 5b
  // tested nothing).
  function build({ withHost = true, assertSheetOwnedByPlugin = vi.fn(async () => {}), isSheetOwnedByProject = vi.fn(async () => true) }: {
    withHost?: boolean
    assertSheetOwnedByPlugin?: ((input: { pluginName: string; sheetId: string }) => Promise<void>) | null
    isSheetOwnedByProject?: (input: { sheetId: string; projectId: string }) => Promise<boolean>
  } = {}) {
    const host = vi.fn(async (input: { sheetId: string; roleIds: string[] }) => ({ sheetId: input.sheetId, granted: [...input.roleIds], alreadyGranted: [] }))
    const multitable = {
      provisioning: {
        getObjectSheetId: derived,
        isSheetOwnedByProject: vi.fn(async () => { throw new Error('the hook, not the host, must answer') }),
        ...(withHost ? { grantSheetRoleWrite: host } : {}),
      },
      records: {},
    }
    const hooks = assertSheetOwnedByPlugin === null
      ? { isSheetOwnedByProject }
      : { assertSheetOwnedByPlugin, isSheetOwnedByProject }
    const scoped = createPluginScopedMultitableApi(multitable as never, PLUGIN, hooks)
    return { scoped, host, assertSheetOwnedByPlugin, isSheetOwnedByProject }
  }

  it('is exposed iff the host exposes it', () => {
    expect(typeof build({ withHost: true }).scoped.provisioning.grantSheetRoleWrite).toBe('function')
    expect(build({ withHost: false }).scoped.provisioning.grantSheetRoleWrite).toBeUndefined()
  })

  it('G-06 refuses, in order, before the host method runs', async () => {
    const good = { projectId: PROJECT_ID, sheetId: derived(PROJECT_ID, OBJECT_ID), objectId: OBJECT_ID, roleIds: [` ${ROLE_A} `, ROLE_A, ROLE_B], actorId: ' u_pull ' }

    // 1. foreign project namespace
    let b = build()
    await expect(b.scoped.provisioning.grantSheetRoleWrite!({ ...good, projectId: 'tenant-s1:attendance' })).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
    expect(b.host).not.toHaveBeenCalled()
    expect(b.assertSheetOwnedByPlugin).not.toHaveBeenCalled()

    // 2. a role outside the namespace
    b = build()
    await expect(b.scoped.provisioning.grantSheetRoleWrite!({ ...good, roleIds: [ROLE_A, 'multitable_admin'] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE' })
    expect(b.host).not.toHaveBeenCalled()

    // 3. an objectId without the project-sheet shape (the canonical main table, a hand-named twin)
    for (const objectId of ['plm_stock_preparation_main', 'plm_stock_preparation_sandbox_handmade', 'plm_stock_preparation_sandbox_p_abc']) {
      b = build()
      await expect(b.scoped.provisioning.grantSheetRoleWrite!({ ...good, objectId, sheetId: derived(PROJECT_ID, objectId) })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET' })
      expect(b.host).not.toHaveBeenCalled()
      expect(b.assertSheetOwnedByPlugin).not.toHaveBeenCalled()
    }
    expect(isStockPreparationProjectSheetObjectId(OBJECT_ID)).toBe(true)

    // 4. a sheet id that is not the one derived for (project, objectId)
    b = build()
    await expect(b.scoped.provisioning.grantSheetRoleWrite!({ ...good, sheetId: 'sheet_canonical_main' })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_MISMATCH' })
    expect(b.host).not.toHaveBeenCalled()
    expect(b.assertSheetOwnedByPlugin).not.toHaveBeenCalled()

    // 5. the strict hook refuses (unregistered / another plugin's)
    b = build({ assertSheetOwnedByPlugin: vi.fn(async ({ pluginName, sheetId }) => { throw new MultitableSheetScopeError(pluginName, sheetId, 'unregistered') }) })
    await expect(b.scoped.provisioning.grantSheetRoleWrite!(good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
    expect(b.host).not.toHaveBeenCalled()
    expect(b.isSheetOwnedByProject).not.toHaveBeenCalled()

    // 5b. no strict hook at all: the port cannot verify and refuses
    b = build({ assertSheetOwnedByPlugin: null })
    await expect(b.scoped.provisioning.grantSheetRoleWrite!(good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
    expect(b.host).not.toHaveBeenCalled()

    // 6. the registry does not attribute the sheet to this project
    b = build({ isSheetOwnedByProject: vi.fn(async () => false) })
    await expect(b.scoped.provisioning.grantSheetRoleWrite!(good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
    expect(b.host).not.toHaveBeenCalled()

    // all six pass: the host runs ONCE with the normalized list and a trimmed actor
    b = build()
    await expect(b.scoped.provisioning.grantSheetRoleWrite!(good)).resolves.toEqual({ sheetId: good.sheetId, granted: [ROLE_A, ROLE_B], alreadyGranted: [] })
    expect(b.host).toHaveBeenCalledTimes(1)
    expect(b.host).toHaveBeenCalledWith({ projectId: PROJECT_ID, sheetId: good.sheetId, objectId: OBJECT_ID, roleIds: [ROLE_A, ROLE_B], actorId: 'u_pull' })
    expect(b.assertSheetOwnedByPlugin).toHaveBeenCalledWith({ pluginName: PLUGIN, sheetId: good.sheetId })
    expect(b.isSheetOwnedByProject).toHaveBeenCalledWith({ sheetId: good.sheetId, projectId: PROJECT_ID })
  })
})
