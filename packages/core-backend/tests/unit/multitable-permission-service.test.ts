import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

import { deriveCapabilities } from '../../src/multitable/access'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'
import {
  applyContextSheetReadGrant,
  applyContextSheetRecordWriteGrant,
  applyContextSheetSchemaWriteGrant,
  applySheetPermissionScope,
  buildRowActionOverrides,
  canReadWithSheetGrant,
  deriveCapabilityOrigin,
  deriveDefaultRowActions,
  deriveRecordRowActions,
  deriveRowActions,
  deriveSheetAccessLevel,
  ensureRecordWriteAllowed,
  filterReadableSheetRowsForAccess,
  hasRecordPermissionAssignments,
  isSheetPermissionSubjectType,
  loadFieldPermissionScopeMap,
  loadRecordCreatorMap,
  loadRecordPermissionScopeMap,
  loadSheetPermissionScopeMap,
  loadViewPermissionScopeMap,
  requiresOwnWriteRowPolicy,
  resolveReadableSheetIds,
  resolveSheetCapabilities,
  summarizeSheetPermissionCodes,
  type QueryFn,
  type SheetPermissionScope,
} from '../../src/multitable/permission-service'

const adminScope: SheetPermissionScope = {
  hasAssignments: true,
  canRead: true,
  canWrite: true,
  canWriteOwn: true,
  canAdmin: true,
}

const viewerScope: SheetPermissionScope = {
  hasAssignments: true,
  canRead: true,
  canWrite: false,
  canWriteOwn: false,
  canAdmin: false,
}

const writeOwnScope: SheetPermissionScope = {
  hasAssignments: true,
  canRead: true,
  canWrite: false,
  canWriteOwn: true,
  canAdmin: false,
}

const editorScope: SheetPermissionScope = {
  hasAssignments: true,
  canRead: true,
  canWrite: true,
  canWriteOwn: false,
  canAdmin: false,
}

function makeQuery(handlers: Array<(sql: string, params?: unknown[]) => any>): {
  query: QueryFn
  calls: Array<{ sql: string; params?: unknown[] }>
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  let cursor = 0
  const query: QueryFn = async (sql, params) => {
    calls.push({ sql, params })
    const handler = handlers[cursor++] ?? (() => ({ rows: [] }))
    return handler(sql, params)
  }
  return { query, calls }
}

describe('permission-service: predicates', () => {
  it('typeguards sheet permission subject types', () => {
    expect(isSheetPermissionSubjectType('user')).toBe(true)
    expect(isSheetPermissionSubjectType('role')).toBe(true)
    expect(isSheetPermissionSubjectType('member-group')).toBe(true)
    expect(isSheetPermissionSubjectType('guest')).toBe(false)
    expect(isSheetPermissionSubjectType(42)).toBe(false)
  })

  it('derives sheet access level from the strongest code present', () => {
    expect(deriveSheetAccessLevel(['multitable:admin'])).toBe('admin')
    expect(deriveSheetAccessLevel(['multitable:write'])).toBe('write')
    expect(deriveSheetAccessLevel(['multitable:write-own', 'multitable:read'])).toBe('write-own')
    expect(deriveSheetAccessLevel(['multitable:read'])).toBe('read')
    expect(deriveSheetAccessLevel([])).toBeNull()
    expect(deriveSheetAccessLevel(['unknown'])).toBeNull()
  })

  it('summarises sheet permission codes as a scope', () => {
    expect(summarizeSheetPermissionCodes([])).toEqual({
      hasAssignments: false,
      canRead: false,
      canWrite: false,
      canWriteOwn: false,
      canAdmin: false,
    })
    expect(summarizeSheetPermissionCodes(['multitable:write-own'])).toEqual({
      hasAssignments: true,
      canRead: true,
      canWrite: false,
      canWriteOwn: true,
      canAdmin: false,
    })
    expect(summarizeSheetPermissionCodes(['multitable:admin'])).toEqual({
      hasAssignments: true,
      canRead: true,
      canWrite: true,
      canWriteOwn: false,
      canAdmin: true,
    })
  })
})

describe('permission-service: capability composition', () => {
  const base = deriveCapabilities(['multitable:write'], false)

  it('returns admin capabilities unchanged when admin role is set', () => {
    expect(applySheetPermissionScope(base, undefined, true)).toEqual(base)
    expect(applySheetPermissionScope(base, viewerScope, true)).toEqual(base)
  })

  it('applies sheet grant scope to a non-admin with read assignment', () => {
    const capped = applySheetPermissionScope(base, viewerScope, false)
    expect(capped.canRead).toBe(true)
    expect(capped.canCreateRecord).toBe(false)
    expect(capped.canEditRecord).toBe(false)
    expect(capped.canDeleteRecord).toBe(false)
    expect(capped.canManageFields).toBe(false)
    expect(capped.canManageSheetAccess).toBe(false)
    expect(capped.canExport).toBe(true)
  })

  it('grants record write via scope even when base capability is missing', () => {
    const readerBase = deriveCapabilities(['multitable:read'], false)
    const expanded = applyContextSheetRecordWriteGrant(readerBase, editorScope, false)
    expect(expanded.canCreateRecord).toBe(true)
    expect(expanded.canEditRecord).toBe(true)
    expect(expanded.canManageFields).toBe(false)
  })

  it('grants schema write and sheet-access via admin scope', () => {
    const readerBase = deriveCapabilities(['multitable:read'], false)
    const expanded = applyContextSheetSchemaWriteGrant(readerBase, adminScope, false)
    expect(expanded.canManageFields).toBe(true)
    expect(expanded.canManageViews).toBe(true)
    expect(expanded.canManageSheetAccess).toBe(true)
  })

  it('applyContextSheetReadGrant forces canRead only when scope grants read but base does not', () => {
    const noneBase = deriveCapabilities([], false)
    const expanded = applyContextSheetReadGrant(noneBase, viewerScope, false)
    expect(expanded.canRead).toBe(true)
  })

  it('canReadWithSheetGrant respects admin, base, and sheet scope', () => {
    expect(canReadWithSheetGrant(base, undefined, true)).toBe(true)
    expect(canReadWithSheetGrant(base, viewerScope, false)).toBe(true)
    const noneBase = deriveCapabilities([], false)
    expect(canReadWithSheetGrant(noneBase, undefined, false)).toBe(false)
    expect(canReadWithSheetGrant(noneBase, viewerScope, false)).toBe(true)
  })

  it('derives capability origin labels', () => {
    const readerBase = deriveCapabilities(['multitable:read'], false)
    const expanded = applyContextSheetSchemaWriteGrant(readerBase, adminScope, false)
    expect(deriveCapabilityOrigin(base, base, undefined, true)).toEqual({
      source: 'admin',
      hasSheetAssignments: false,
    })
    expect(deriveCapabilityOrigin(base, base, undefined, false)).toEqual({
      source: 'global-rbac',
      hasSheetAssignments: false,
    })
    expect(deriveCapabilityOrigin(readerBase, expanded, adminScope, false)).toEqual({
      source: 'sheet-grant',
      hasSheetAssignments: true,
    })
    expect(deriveCapabilityOrigin(base, applySheetPermissionScope(base, viewerScope, false), viewerScope, false))
      .toEqual({ source: 'sheet-scope', hasSheetAssignments: true })
  })
})

describe('permission-service: row-actions and write-allowed', () => {
  const access = { userId: 'user_1', permissions: ['multitable:write'], isAdminRole: false }
  const adminAccess = { userId: 'user_1', permissions: [], isAdminRole: true }
  const editorCaps = deriveCapabilities(['multitable:write'], false)

  it('derives row actions from capabilities directly', () => {
    expect(deriveRowActions(editorCaps)).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: false,
    })
  })

  it('requiresOwnWriteRowPolicy only when write-own without full write on non-admin', () => {
    expect(requiresOwnWriteRowPolicy(writeOwnScope, false)).toBe(true)
    expect(requiresOwnWriteRowPolicy(writeOwnScope, true)).toBe(false)
    expect(requiresOwnWriteRowPolicy(editorScope, false)).toBe(false)
    expect(requiresOwnWriteRowPolicy(undefined, false)).toBe(false)
  })

  it('deriveDefaultRowActions zeroes out edit/delete under write-own policy', () => {
    expect(deriveDefaultRowActions(editorCaps, writeOwnScope, false)).toEqual({
      canEdit: false,
      canDelete: false,
      canComment: false,
    })
    expect(deriveDefaultRowActions(editorCaps, editorScope, false)).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: false,
    })
  })

  it('deriveRecordRowActions allows edit only when creator matches the access user', () => {
    const own = deriveRecordRowActions(editorCaps, writeOwnScope, access, 'user_1')
    const foreign = deriveRecordRowActions(editorCaps, writeOwnScope, access, 'user_2')
    expect(own).toEqual({ canEdit: true, canDelete: true, canComment: false })
    expect(foreign).toEqual({ canEdit: false, canDelete: false, canComment: false })
  })

  it('buildRowActionOverrides returns only deltas for write-own rows', () => {
    const creatorMap = new Map<string, string | null>([
      ['rec_own', 'user_1'],
      ['rec_other', 'user_2'],
    ])
    const overrides = buildRowActionOverrides(
      [{ id: 'rec_own' }, { id: 'rec_other' }],
      creatorMap,
      editorCaps,
      writeOwnScope,
      access,
    )
    expect(overrides).toEqual({
      rec_own: { canEdit: true, canDelete: true, canComment: false },
    })
  })

  it('buildRowActionOverrides is undefined when own-write not required', () => {
    const creatorMap = new Map<string, string | null>([['rec_1', 'user_1']])
    expect(
      buildRowActionOverrides([{ id: 'rec_1' }], creatorMap, editorCaps, editorScope, access),
    ).toBeUndefined()
    expect(
      buildRowActionOverrides([{ id: 'rec_1' }], creatorMap, editorCaps, writeOwnScope, adminAccess),
    ).toBeUndefined()
  })

  it('ensureRecordWriteAllowed falls back to record-scope map when default row actions deny', () => {
    const readerCaps = deriveCapabilities(['multitable:read'], false)
    const readerAccess = { userId: 'user_2', permissions: ['multitable:read'], isAdminRole: false }
    const recordScopeMap = new Map([
      ['rec_owned', { recordId: 'rec_owned', accessLevel: 'admin' as const }],
    ])
    expect(
      ensureRecordWriteAllowed(
        readerCaps,
        undefined,
        readerAccess,
        'someone_else',
        'edit',
        recordScopeMap,
        'rec_owned',
      ),
    ).toBe(false)

    const writerAccess = { userId: 'user_2', permissions: ['multitable:write'], isAdminRole: false }
    const writerCaps = deriveCapabilities(['multitable:write'], false)
    expect(
      ensureRecordWriteAllowed(
        writerCaps,
        writeOwnScope,
        writerAccess,
        'someone_else',
        'edit',
        recordScopeMap,
        'rec_owned',
      ),
    ).toBe(true)
  })

  it('ensureRecordWriteAllowed honors default row actions without a scope map', () => {
    expect(
      ensureRecordWriteAllowed(editorCaps, editorScope, access, 'user_1', 'edit'),
    ).toBe(true)
    expect(
      ensureRecordWriteAllowed(editorCaps, writeOwnScope, access, 'user_2', 'edit'),
    ).toBe(false)
  })
})

describe('permission-service: DB loaders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('loadSheetPermissionScopeMap prefers direct user codes, then member-group, then role', async () => {
    const { query, calls } = makeQuery([
      () => ({
        rows: [
          { sheet_id: 'sheet_1', perm_code: 'multitable:write-own', subject_type: 'role' },
          { sheet_id: 'sheet_1', perm_code: 'multitable:read', subject_type: 'member-group' },
          { sheet_id: 'sheet_2', perm_code: 'multitable:read', subject_type: 'role' },
        ],
      }),
    ])

    const scopes = await loadSheetPermissionScopeMap(query, ['sheet_1', 'sheet_2'], 'user_1')
    expect(scopes.get('sheet_1')).toEqual(summarizeSheetPermissionCodes(['multitable:read']))
    expect(scopes.get('sheet_2')).toEqual(summarizeSheetPermissionCodes(['multitable:read']))
    expect(calls).toHaveLength(1)
  })

  it('loadSheetPermissionScopeMap returns empty when tables are missing', async () => {
    const { query } = makeQuery([
      () => {
        const err = new Error('relation "spreadsheet_permissions" does not exist')
        ;(err as any).code = '42P01'
        throw err
      },
    ])
    await expect(loadSheetPermissionScopeMap(query, ['sheet_1'], 'user_1')).resolves.toEqual(
      new Map(),
    )
  })

  it('loadViewPermissionScopeMap surfaces per-view access granularity', async () => {
    const { query } = makeQuery([
      () => ({
        rows: [
          { view_id: 'view_1', permissions: ['read', 'write'] },
          { view_id: 'view_2', permissions: ['admin'] },
          { view_id: 'view_3', permissions: [] },
        ],
      }),
    ])
    const scopes = await loadViewPermissionScopeMap(query, ['view_1', 'view_2', 'view_3'], 'user_1')
    expect(scopes.get('view_1')).toEqual({
      hasAssignments: true,
      canRead: true,
      canWrite: true,
      canAdmin: false,
    })
    expect(scopes.get('view_2')).toEqual({
      hasAssignments: true,
      canRead: true,
      canWrite: true,
      canAdmin: true,
    })
    expect(scopes.get('view_3')).toEqual({
      hasAssignments: true,
      canRead: false,
      canWrite: false,
      canAdmin: false,
    })
  })

  it('loadFieldPermissionScopeMap applies most-restrictive merge', async () => {
    const { query } = makeQuery([
      () => ({
        rows: [
          { field_id: 'fld_1', visible: true, read_only: false },
          { field_id: 'fld_1', visible: false, read_only: false },
          { field_id: 'fld_2', visible: true, read_only: true },
        ],
      }),
    ])
    const scopes = await loadFieldPermissionScopeMap(query, 'sheet_1', 'user_1')
    expect(scopes.get('fld_1')).toEqual({ visible: false, readOnly: false })
    expect(scopes.get('fld_2')).toEqual({ visible: true, readOnly: true })
  })

  it('loadRecordPermissionScopeMap keeps the most-permissive access level', async () => {
    const { query } = makeQuery([
      () => ({
        rows: [
          { record_id: 'rec_1', access_level: 'read' },
          { record_id: 'rec_1', access_level: 'admin' },
          { record_id: 'rec_2', access_level: 'write' },
        ],
      }),
    ])
    const scopes = await loadRecordPermissionScopeMap(query, 'sheet_1', ['rec_1', 'rec_2'], 'user_1')
    expect(scopes.get('rec_1')).toEqual({ recordId: 'rec_1', accessLevel: 'admin' })
    expect(scopes.get('rec_2')).toEqual({ recordId: 'rec_2', accessLevel: 'write' })
  })

  it('hasRecordPermissionAssignments tolerates missing table', async () => {
    const { query } = makeQuery([
      () => ({ rows: [{ exists: 1 }] }),
      () => {
        const err = new Error('relation "record_permissions" does not exist')
        ;(err as any).code = '42P01'
        throw err
      },
    ])
    await expect(hasRecordPermissionAssignments(query, 'sheet_1')).resolves.toBe(true)
    await expect(hasRecordPermissionAssignments(query, 'sheet_2')).resolves.toBe(false)
  })

  it('loadRecordCreatorMap ignores missing created_by column', async () => {
    const { query } = makeQuery([
      () => {
        throw new Error('column "created_by" does not exist')
      },
    ])
    await expect(loadRecordCreatorMap(query, 'sheet_1', ['rec_1'])).resolves.toEqual(new Map())
  })
})

describe('permission-service: request-keyed resolvers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('filterReadableSheetRowsForAccess returns all rows for admin without querying', async () => {
    const { query, calls } = makeQuery([])
    const rows = [{ id: 'sheet_1' }, { id: 'sheet_2' }]
    const access = { userId: 'admin_user', permissions: [], isAdminRole: true }
    await expect(filterReadableSheetRowsForAccess(query, rows, access)).resolves.toEqual(rows)
    expect(calls).toHaveLength(0)
  })

  it('filterReadableSheetRowsForAccess drops rows the user cannot read', async () => {
    const { query } = makeQuery([
      () => ({
        rows: [
          { sheet_id: 'sheet_2', perm_code: 'multitable:read', subject_type: 'user' },
        ],
      }),
    ])
    const rows = [{ id: 'sheet_1' }, { id: 'sheet_2' }]
    const access = { userId: 'user_1', permissions: [], isAdminRole: false }
    const result = await filterReadableSheetRowsForAccess(query, rows, access)
    expect(result).toEqual([{ id: 'sheet_2' }])
  })

  it('resolveReadableSheetIds uses tenant/admin fast-path and scope grants', async () => {
    vi.mocked(listUserPermissions).mockResolvedValue([])
    vi.mocked(isAdmin).mockResolvedValue(false)
    const { query } = makeQuery([
      () => ({
        rows: [
          { sheet_id: 'sheet_2', perm_code: 'multitable:read', subject_type: 'user' },
        ],
      }),
    ])
    const req = { user: { id: 'user_1', roles: ['user'] } } as any
    const readable = await resolveReadableSheetIds(req, query, ['sheet_1', 'sheet_2'])
    expect(Array.from(readable)).toEqual(['sheet_2'])
  })

  it('resolveSheetCapabilities labels origin as sheet-grant when scope expands base', async () => {
    vi.mocked(listUserPermissions).mockResolvedValue(['multitable:read'])
    vi.mocked(isAdmin).mockResolvedValue(false)
    const { query } = makeQuery([
      () => ({
        rows: [
          { sheet_id: 'sheet_1', perm_code: 'multitable:admin', subject_type: 'user' },
        ],
      }),
    ])
    const req = { user: { id: 'user_1', roles: ['user'] } } as any
    const res = await resolveSheetCapabilities(req, query, 'sheet_1')
    expect(res.capabilities.canManageFields).toBe(true)
    expect(res.capabilities.canManageSheetAccess).toBe(true)
    expect(res.capabilityOrigin.source).toBe('sheet-grant')
    expect(res.sheetScope?.canAdmin).toBe(true)
  })
})
