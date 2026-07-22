/**
 * FWB-0 Layer 2 — transaction-local record-link auth (no global RBAC pool/cache).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RECORD_LINK_AUTHORITY_LOCK_ORDER,
  RECORD_LINK_BASE_AUTH_STAGES,
  RECORD_LINK_MULTI_TARGET_LOCK_PHASES,
  RECORD_LINK_TARGET_AUTH_STAGES,
  isAdminOnQuery,
  listUserPermissionsOnQuery,
  loadApprovalTemplateVisibilityActorOnQuery,
  lockRecordLinkAuthorityRowsOnQuery,
  lockRecordLinkMultiTargetAuthorityPhasedOnQuery,
  lockRecordLinkMultiTargetCreatePathOnQuery,
  resolveBaseReadableForUserOnQuery,
  resolveRecordLinkTargetAuthOnQuery,
  resolveSheetCapabilitiesForUserOnQuery,
  userHasApprovalsWriteOnQuery,
} from '../../src/services/approval-record-link-txn-auth'

describe('approval-record-link-txn-auth — queryFn-only, no global cache', () => {
  /** Route SQL to the right fixture — permission UNION also mentions user_roles. */
  function routeAuthSql(
    sql: string,
    handlers: {
      bases?: { rows: unknown[] }
      admin?: { rows: unknown[] }
      codes?: { rows: unknown[] }
      legacy?: { rows: unknown[] }
      sheets?: { rows: unknown[] }
      sheetScope?: { rows: unknown[] }
    },
  ): { rows: unknown[] } {
    const q = sql.replace(/\s+/g, ' ')
    if (q.includes('FROM meta_sheets') && q.includes('base_id = $2') && q.includes('ANY($1::text[])')) {
      return { rows: [] }
    }
    // Permission-code UNION includes user_roles join — match it BEFORE bare admin probe.
    if (q.includes('permission_code') || q.includes('user_permissions')) {
      return handlers.codes ?? { rows: [] }
    }
    // Sheet-scope SQL contains a user_roles subquery; route it before the bare admin probe.
    if (q.includes('spreadsheet_permissions')) {
      return handlers.sheetScope ?? { rows: [] }
    }
    if (q.includes('FROM user_roles')) {
      return handlers.admin ?? { rows: [] }
    }
    if (q.includes('FROM roles')) {
      return { rows: [] }
    }
    if (q.includes('FROM users') && q.includes('permissions')) {
      return handlers.legacy ?? { rows: [{ permissions: [] }] }
    }
    if (q.includes('FROM meta_bases')) {
      return handlers.bases ?? { rows: [] }
    }
    if (q.includes('FROM meta_sheets')) {
      return handlers.sheets ?? { rows: [] }
    }
    return { rows: [] }
  }

  it('isAdminOnQuery / listUserPermissionsOnQuery only touch the supplied queryFn', async () => {
    const query = vi.fn(async (sql: string) => routeAuthSql(sql, {
      admin: { rows: [{ '?column?': 1 }] },
      codes: { rows: [{ code: 'multitable:read' }, { code: 'multitable:base:read' }] },
      legacy: { rows: [{ permissions: ['approvals:write'] }] },
    }))
    await expect(isAdminOnQuery(query, 'u1')).resolves.toBe(true)
    const codes = await listUserPermissionsOnQuery(query, 'u1')
    expect(codes).toEqual(expect.arrayContaining([
      'multitable:read',
      'multitable:base:read',
      'approvals:write',
    ]))
    expect(query.mock.calls.length).toBeGreaterThan(0)
  })

  it('resolveBaseReadableForUserOnQuery still runs admin+permission stages when base is missing', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('permission_code') || q.includes('user_permissions')) {
        kinds.push('permission_codes')
        return { rows: [{ code: 'multitable:base:read' }] }
      }
      if (q.includes('FROM user_roles')) {
        kinds.push('admin_role')
        return { rows: [{ '?column?': 1 }] }
      }
      if (q.includes('FROM meta_bases')) {
        kinds.push('base_lookup')
        return { rows: [] }
      }
      if (q.includes('FROM users')) {
        kinds.push('legacy_perms')
        return { rows: [{ permissions: [] }] }
      }
      return { rows: [] }
    })
    const transcript: string[] = []
    await expect(
      resolveBaseReadableForUserOnQuery(query, 'admin-user', 'missing-base', transcript),
    ).resolves.toBe(false)
    expect(transcript).toEqual([...RECORD_LINK_BASE_AUTH_STAGES])
    // Discriminating: old resolveBaseReadableForUser returned before isAdmin/listUserPermissions.
    expect(kinds).toContain('admin_role')
    expect(kinds).toContain('permission_codes')
    expect(kinds).toContain('base_lookup')
  })

  it('resolveBaseReadableForUserOnQuery grants owner / base-read code / admin on existing base', async () => {
    const ownerQuery = vi.fn(async (sql: string) => routeAuthSql(sql, {
      bases: { rows: [{ owner_id: 'owner-1' }] },
    }))
    await expect(resolveBaseReadableForUserOnQuery(ownerQuery, 'owner-1', 'b1')).resolves.toBe(true)
    await expect(resolveBaseReadableForUserOnQuery(ownerQuery, 'other', 'b1')).resolves.toBe(false)

    const codeQuery = vi.fn(async (sql: string) => routeAuthSql(sql, {
      bases: { rows: [{ owner_id: 'x' }] },
      codes: { rows: [{ code: 'multitable:base:read' }] },
    }))
    await expect(resolveBaseReadableForUserOnQuery(codeQuery, 'u', 'b1')).resolves.toBe(true)
  })

  it('resolveSheetCapabilitiesForUserOnQuery derives canRead from queryFn permissions + scope', async () => {
    const query = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [{ code: 'multitable:read' }] },
    }))
    const caps = await resolveSheetCapabilitiesForUserOnQuery(query, 'sheet-1', 'u1')
    expect(caps.isAdminRole).toBe(false)
    expect(caps.capabilities.canRead).toBe(true)
  })

  it('resolveSheetCapabilitiesForUserOnQuery derives share authority from DB/sheet scope, not request claims', async () => {
    const denied = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [] },
      legacy: { rows: [{ permissions: [] }] },
    }))
    await expect(
      resolveSheetCapabilitiesForUserOnQuery(denied, 'sheet-1', 'u1'),
    ).resolves.toMatchObject({ capabilities: { canManageSheetAccess: false } })

    const scopedAdmin = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [] },
      legacy: { rows: [{ permissions: [] }] },
      sheetScope: {
        rows: [{ sheet_id: 'sheet-1', perm_code: 'spreadsheet:admin', subject_type: 'user' }],
      },
    }))
    await expect(
      resolveSheetCapabilitiesForUserOnQuery(scopedAdmin, 'sheet-1', 'u1'),
    ).resolves.toMatchObject({ capabilities: { canManageSheetAccess: true } })
  })

  it('preserves the approval-projection write fence on the query-bound resolver', async () => {
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('SELECT DISTINCT permission_code AS code')) {
        return {
          rows: [
            { code: 'multitable:read' },
            { code: 'multitable:write' },
            { code: 'multitable:share' },
          ],
        }
      }
      if (q.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      if (q.includes('FROM user_roles')) return { rows: [] }
      if (q.includes('FROM spreadsheet_permissions')) return { rows: [] }
      if (q.includes('FROM meta_sheets') && q.includes('base_id = $2')) {
        return { rows: [{ id: 'projection-sheet' }] }
      }
      if (q.includes('JOIN meta_records')) return { rows: [{ id: 'projection-sheet' }] }
      return { rows: [] }
    })

    const result = await resolveSheetCapabilitiesForUserOnQuery(
      query,
      'projection-sheet',
      'projection-participant',
    )
    expect(result.isAdminRole).toBe(false)
    expect(result.capabilities).toMatchObject({
      canRead: true,
      canManageSheetAccess: false,
      canEditRecord: false,
      canCreateRecord: false,
    })
  })

  it('rebuilds template visibility actor from query-bound active user, roles and permissions', async () => {
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('SELECT role, department, is_admin')) {
        return { rows: [{ role: 'user', department: 'finance', is_admin: false, is_active: true }] }
      }
      if (q.includes('SELECT ur.role_id, r.name')) {
        return { rows: [{ role_id: 'finance-approver', name: 'Finance Approver' }] }
      }
      if (q.includes('SELECT DISTINCT permission_code AS code')) {
        return { rows: [{ code: 'approval-templates:manage' }] }
      }
      if (q.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
      return { rows: [] }
    })
    await expect(loadApprovalTemplateVisibilityActorOnQuery(query, 'u1')).resolves.toEqual({
      userId: 'u1',
      departmentIds: ['finance'],
      roles: ['user', 'finance-approver', 'Finance Approver'],
      permissions: ['approval-templates:manage'],
      isTemplateManager: true,
    })
  })

  it('keeps a DB-authorized external actor when no local users profile exists', async () => {
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('SELECT role, department, is_admin')) return { rows: [] }
      if (q.includes('SELECT ur.role_id, r.name')) {
        return { rows: [{ role_id: 'external-approver', name: 'External Approver' }] }
      }
      if (q.includes('SELECT DISTINCT permission_code AS code')) {
        return { rows: [{ code: 'approvals:write' }] }
      }
      if (q.includes('SELECT permissions FROM users')) return { rows: [] }
      return { rows: [] }
    })
    await expect(loadApprovalTemplateVisibilityActorOnQuery(query, 'external-u1')).resolves.toEqual({
      userId: 'external-u1',
      departmentIds: [],
      roles: ['external-approver', 'External Approver'],
      permissions: ['approvals:write'],
      isTemplateManager: false,
    })
  })

  it('rejects a present but inactive local profile even when stale grants remain', async () => {
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ')
      if (q.includes('SELECT role, department, is_admin')) {
        return { rows: [{ role: 'admin', department: 'finance', is_admin: true, is_active: false }] }
      }
      if (q.includes('SELECT ur.role_id, r.name')) {
        return { rows: [{ role_id: 'admin', name: 'admin' }] }
      }
      if (q.includes('SELECT DISTINCT permission_code AS code')) {
        return { rows: [{ code: '*:*' }] }
      }
      if (q.includes('SELECT permissions FROM users')) return { rows: [{ permissions: ['*:*'] }] }
      return { rows: [] }
    })
    await expect(loadApprovalTemplateVisibilityActorOnQuery(query, 'disabled-u1')).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('userHasApprovalsWriteOnQuery: empty DB codes default DENY (no fail-open; no request grants)', async () => {
    const empty = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [] },
      legacy: { rows: [{ permissions: [] }] },
    }))
    await expect(userHasApprovalsWriteOnQuery(empty, 'u1')).resolves.toBe(false)
  })

  it('userHasApprovalsWriteOnQuery: JWT/request grants are NOT authority (DB-only final gate)', async () => {
    // Regression: actor.permissions may be DB-hydrated without provenance; final create must
    // not treat request-only write as frozen authority after a concurrent DB revoke.
    const empty = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [] },
      legacy: { rows: [{ permissions: [] }] },
    }))
    // Even if a caller mistakenly passed request grants, the API no longer accepts them.
    await expect(userHasApprovalsWriteOnQuery(empty, 'u1')).resolves.toBe(false)
  })

  it('userHasApprovalsWriteOnQuery: DB codes with write allow', async () => {
    const dbWrite = vi.fn(async (sql: string) => routeAuthSql(sql, {
      codes: { rows: [{ code: 'approvals:write' }] },
    }))
    await expect(userHasApprovalsWriteOnQuery(dbWrite, 'u1')).resolves.toBe(true)
  })

  it('lockRecordLinkAuthorityRowsOnQuery locks every consumed source in deterministic order', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('FROM meta_bases') && q.includes('FOR SHARE')) {
        kinds.push('meta_bases')
        return { rows: [{ id: 'b1' }] }
      }
      if (q.includes('FROM meta_sheets') && q.includes('FOR SHARE')) {
        kinds.push('meta_sheets')
        return { rows: [{ id: 's1' }] }
      }
      if (q.includes('FROM user_roles') && q.includes('FOR SHARE')) {
        kinds.push('user_roles')
        return { rows: [{ role_id: 'role-a' }, { role_id: 'role-b' }] }
      }
      if (q.includes('FROM roles') && q.includes('FOR SHARE')) {
        kinds.push('roles')
        return { rows: [{ id: 'role-a', name: 'Role A' }, { id: 'role-b', name: 'Role B' }] }
      }
      if (q.includes('FROM role_permissions') && q.includes('FOR SHARE')) {
        kinds.push('role_permissions')
        expect(params?.[0]).toEqual(['role-a', 'role-b'])
        return { rows: [{ role_id: 'role-a', permission_code: 'approvals:write' }] }
      }
      if (q.includes('FROM user_permissions') && q.includes('FOR SHARE')) {
        kinds.push('user_permissions')
        return { rows: [{ permission_code: 'multitable:read' }] }
      }
      if (q.includes('FROM users') && q.includes('FOR SHARE')) {
        kinds.push('users')
        return { rows: [{ id: 'u1' }] }
      }
      if (q.includes('FROM platform_member_group_members') && q.includes('FOR SHARE')) {
        kinds.push('platform_member_group_members')
        return { rows: [{ group_id: 'g1' }] }
      }
      if (q.includes('FROM spreadsheet_permissions') && q.includes('FOR SHARE')) {
        kinds.push('spreadsheet_permissions')
        // user + roles + groups subjects
        expect(params?.[0]).toBe('s1')
        expect(params?.[1]).toBe('u1')
        expect(params?.[2]).toEqual(['role-a', 'role-b'])
        expect(params?.[3]).toEqual(['g1'])
        return { rows: [{ sheet_id: 's1' }] }
      }
      throw new Error(`unexpected SQL: ${q}`)
    })
    await lockRecordLinkAuthorityRowsOnQuery(query, {
      userId: 'u1',
      baseId: 'b1',
      sheetId: 's1',
    })
    expect(kinds).toEqual([...RECORD_LINK_AUTHORITY_LOCK_ORDER])
  })

  it('lockRecordLinkAuthorityRowsOnQuery fail-closed rethrows core-table lock errors', async () => {
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('FROM meta_bases')) return { rows: [{ id: 'b1' }] }
      if (q.includes('FROM meta_sheets')) return { rows: [{ id: 's1' }] }
      if (q.includes('FROM user_roles')) return { rows: [{ role_id: 'r1' }] }
      if (q.includes('FROM role_permissions')) {
        const err = new Error('permission denied for table role_permissions') as Error & { code?: string }
        err.code = '42501'
        throw err
      }
      return { rows: [] }
    })
    await expect(
      lockRecordLinkAuthorityRowsOnQuery(query, { userId: 'u1', baseId: 'b1', sheetId: 's1' }),
    ).rejects.toThrow(/permission denied for table role_permissions/)
  })

  it('lockRecordLinkMultiTargetAuthorityPhasedOnQuery: all bases then sheets then actor once then grants', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('FROM meta_bases') && q.includes('FOR SHARE')) {
        kinds.push(`meta_bases:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM meta_sheets') && q.includes('FOR SHARE')) {
        kinds.push(`meta_sheets:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM user_roles') && q.includes('FOR SHARE')) {
        kinds.push('user_roles')
        return { rows: [{ role_id: 'r1' }] }
      }
      if (q.includes('FROM roles') && q.includes('FOR SHARE')) {
        kinds.push('roles')
        return { rows: [{ id: 'r1', name: 'Role 1' }] }
      }
      if (q.includes('FROM role_permissions') && q.includes('FOR SHARE')) {
        kinds.push('role_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM user_permissions') && q.includes('FOR SHARE')) {
        kinds.push('user_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM users') && q.includes('FOR SHARE')) {
        kinds.push('users')
        return { rows: [{ id: 'u1' }] }
      }
      if (q.includes('FROM platform_member_group_members') && q.includes('FOR SHARE')) {
        kinds.push('platform_member_group_members')
        return { rows: [] }
      }
      if (q.includes('FROM spreadsheet_permissions') && q.includes('FOR SHARE')) {
        kinds.push(`spreadsheet_permissions:${String(params?.[0] ?? '')}`)
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${q}`)
    })

    // Unsorted input: base-b before base-a — phases must still lock a then b.
    await lockRecordLinkMultiTargetAuthorityPhasedOnQuery(query, {
      userId: 'u1',
      targets: [
        { baseId: 'base-b', sheetId: 'sheet-b' },
        { baseId: 'base-a', sheetId: 'sheet-a' },
      ],
    })

    expect(kinds.filter((k) => k.startsWith('meta_bases:'))).toEqual([
      'meta_bases:base-a',
      'meta_bases:base-b',
    ])
    expect(kinds.filter((k) => k.startsWith('meta_sheets:'))).toEqual([
      'meta_sheets:sheet-a',
      'meta_sheets:sheet-b',
    ])
    // Actor-wide rows exactly once (not once per target).
    expect(kinds.filter((k) => k === 'user_roles')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'users')).toHaveLength(1)
    expect(kinds.filter((k) => k.startsWith('spreadsheet_permissions:'))).toEqual([
      'spreadsheet_permissions:sheet-a',
      'spreadsheet_permissions:sheet-b',
    ])
    // Global phase order: last base before first sheet; last sheet before actor; actor before grants.
    const lastBase = kinds.lastIndexOf('meta_bases:base-b')
    const firstSheet = kinds.indexOf('meta_sheets:sheet-a')
    const actor = kinds.indexOf('user_roles')
    const firstGrant = kinds.indexOf('spreadsheet_permissions:sheet-a')
    expect(lastBase).toBeGreaterThanOrEqual(0)
    expect(firstSheet).toBeGreaterThan(lastBase)
    expect(actor).toBeGreaterThan(kinds.lastIndexOf('meta_sheets:sheet-b'))
    expect(firstGrant).toBeGreaterThan(kinds.indexOf('users'))
    expect(RECORD_LINK_MULTI_TARGET_LOCK_PHASES[0]).toBe('target_bases')
  })

  /**
   * Mutation-killing DEFAULT create-path phase order.
   * Calls lockRecordLinkMultiTargetCreatePathOnQuery WITHOUT interleavedPerCandidate.
   * If production default is restored to per-candidate interleaving, this reds:
   *   - actor appears once (interleaved ⇒ twice for two targets)
   *   - full global order: all bases → all sheets → actor → all grants → all row-auth/records
   *   - no base/sheet after actor, no grant after record, no actor between targets
   * The integration [A,B] vs [B] golden alone can stay green under a weak barrier if T2
   * finishes before t1Release — this unit does not depend on that choreography.
   */
  it('DEFAULT lockRecordLinkMultiTargetCreatePathOnQuery: full phased order (bases→sheets→actor once→grants→row/records)', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('pg_advisory_xact_lock')) {
        kinds.push(`advisory:${String(params?.[0] ?? '')}`)
        return { rows: [{}] }
      }
      if (q.includes('FROM record_permissions') && q.includes('FOR UPDATE')) {
        kinds.push(`record_permissions:${String(params?.[0] ?? '')}:${String(params?.[1] ?? '')}`)
        return { rows: [] }
      }
      if (q.includes('FROM meta_records') && q.includes('FOR UPDATE')) {
        kinds.push(`meta_records:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM meta_bases') && q.includes('FOR SHARE')) {
        kinds.push(`meta_bases:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM meta_sheets') && q.includes('FOR SHARE')) {
        kinds.push(`meta_sheets:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM user_roles') && q.includes('FOR SHARE')) {
        kinds.push('user_roles')
        return { rows: [{ role_id: 'r1' }] }
      }
      if (q.includes('FROM roles') && q.includes('FOR SHARE')) {
        kinds.push('roles')
        return { rows: [{ id: 'r1', name: 'Role 1' }] }
      }
      if (q.includes('FROM role_permissions') && q.includes('FOR SHARE')) {
        kinds.push('role_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM user_permissions') && q.includes('FOR SHARE')) {
        kinds.push('user_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM users') && q.includes('FOR SHARE')) {
        kinds.push('users')
        return { rows: [{ id: 'u1' }] }
      }
      if (q.includes('FROM platform_member_group_members')) {
        kinds.push('platform_member_group_members')
        return { rows: [] }
      }
      if (q.includes('FROM spreadsheet_permissions') && q.includes('FOR SHARE')) {
        kinds.push(`spreadsheet_permissions:${String(params?.[0] ?? '')}`)
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${q}`)
    })

    // DEFAULT path — no options.interleavedPerCandidate. Unequal multi-target set shape
    // ([A,B] order reversed in input) must still globally phase.
    await lockRecordLinkMultiTargetCreatePathOnQuery(query, {
      userId: 'u1',
      targets: [
        { baseId: 'base-b', sheetId: 'sheet-b', recordId: 'rec-b' },
        { baseId: 'base-a', sheetId: 'sheet-a', recordId: 'rec-a' },
      ],
    })

    // Phase 1: all bases (sorted), no sheets/actor/grants/records interleaved among them.
    const bases = kinds.filter((k) => k.startsWith('meta_bases:'))
    expect(bases).toEqual(['meta_bases:base-a', 'meta_bases:base-b'])

    // Phase 2: all sheets after every base.
    const sheets = kinds.filter((k) => k.startsWith('meta_sheets:'))
    expect(sheets).toEqual(['meta_sheets:sheet-a', 'meta_sheets:sheet-b'])
    expect(kinds.indexOf('meta_sheets:sheet-a')).toBeGreaterThan(kinds.lastIndexOf('meta_bases:base-b'))

    // Phase 3: actor-wide exactly ONCE (interleaved default would lock actor twice).
    expect(kinds.filter((k) => k === 'user_roles')).toEqual(['user_roles'])
    expect(kinds.filter((k) => k === 'users')).toEqual(['users'])
    expect(kinds.indexOf('user_roles')).toBeGreaterThan(kinds.lastIndexOf('meta_sheets:sheet-b'))

    // Phase 4: all sheet grants after actor, before any row-auth/record.
    const grants = kinds.filter((k) => k.startsWith('spreadsheet_permissions:'))
    expect(grants).toEqual([
      'spreadsheet_permissions:sheet-a',
      'spreadsheet_permissions:sheet-b',
    ])
    expect(kinds.indexOf('spreadsheet_permissions:sheet-a')).toBeGreaterThan(kinds.indexOf('users'))

    // Phase 5: row-auth + records only after all grants; canonical target order a then b.
    const firstAdvisory = kinds.findIndex((k) => k.startsWith('advisory:'))
    const firstRecord = kinds.findIndex((k) => k.startsWith('meta_records:'))
    expect(firstAdvisory).toBeGreaterThan(kinds.lastIndexOf('spreadsheet_permissions:sheet-b'))
    expect(firstRecord).toBeGreaterThan(kinds.lastIndexOf('spreadsheet_permissions:sheet-b'))
    expect(kinds.filter((k) => k.startsWith('meta_records:'))).toEqual([
      'meta_records:rec-a',
      'meta_records:rec-b',
    ])

    // Discriminating anti-interleave: no second actor block after any row/record lock.
    const lastActor = Math.max(kinds.lastIndexOf('user_roles'), kinds.lastIndexOf('users'))
    const firstRowPhase = Math.min(
      ...kinds
        .map((k, i) => (k.startsWith('advisory:') || k.startsWith('meta_records:') ? i : -1))
        .filter((i) => i >= 0),
    )
    expect(lastActor).toBeLessThan(firstRowPhase)

    // No base lock after sheets started (interleaved re-takes base per candidate mid-stream).
    const firstSheetIdx = kinds.indexOf('meta_sheets:sheet-a')
    expect(kinds.slice(firstSheetIdx).some((k) => k.startsWith('meta_bases:'))).toBe(false)

    // Exact coarse phase skeleton (ids sorted; actor/grant/record phases collapsed to markers).
    const skeleton = kinds.map((k) => {
      if (k.startsWith('meta_bases:')) return 'base'
      if (k.startsWith('meta_sheets:')) return 'sheet'
      if (
        k === 'user_roles'
        || k === 'roles'
        || k === 'role_permissions'
        || k === 'user_permissions'
        || k === 'users'
        || k === 'platform_member_group_members'
      ) {
        return 'actor'
      }
      if (k.startsWith('spreadsheet_permissions:')) return 'grant'
      if (k.startsWith('advisory:') || k.startsWith('record_permissions:') || k.startsWith('meta_records:')) {
        return 'row'
      }
      return k
    })
    // Collapse consecutive same markers for readability of global phases.
    const phases: string[] = []
    for (const step of skeleton) {
      if (phases[phases.length - 1] !== step) phases.push(step)
    }
    expect(phases).toEqual(['base', 'sheet', 'actor', 'grant', 'row'])
  })

  it('lockRecordLinkMultiTargetCreatePathOnQuery interleaved mode re-locks actor per candidate', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('pg_advisory_xact_lock')) {
        kinds.push(`advisory:${String(params?.[0] ?? '')}`)
        return { rows: [{}] }
      }
      if (q.includes('FROM record_permissions') && q.includes('FOR UPDATE')) {
        kinds.push('record_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM meta_records') && q.includes('FOR UPDATE')) {
        kinds.push(`meta_records:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM meta_bases') && q.includes('FOR SHARE')) {
        kinds.push(`meta_bases:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM meta_sheets') && q.includes('FOR SHARE')) {
        kinds.push(`meta_sheets:${String(params?.[0] ?? '')}`)
        return { rows: [{ id: params?.[0] }] }
      }
      if (q.includes('FROM user_roles') && q.includes('FOR SHARE')) {
        kinds.push('user_roles')
        return { rows: [] }
      }
      if (q.includes('FROM user_permissions') && q.includes('FOR SHARE')) {
        kinds.push('user_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM users') && q.includes('FOR SHARE')) {
        kinds.push('users')
        return { rows: [{ id: 'u1' }] }
      }
      if (q.includes('FROM platform_member_group_members')) {
        kinds.push('platform_member_group_members')
        return { rows: [] }
      }
      if (q.includes('FROM spreadsheet_permissions') && q.includes('FOR SHARE')) {
        kinds.push('spreadsheet_permissions')
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${q}`)
    })

    await lockRecordLinkMultiTargetCreatePathOnQuery(
      query,
      {
        userId: 'u1',
        targets: [
          { baseId: 'b1', sheetId: 's1', recordId: 'r1' },
          { baseId: 'b2', sheetId: 's2', recordId: 'r2' },
        ],
      },
      { interleavedPerCandidate: true },
    )
    // Interleaved mutation: actor rows once per candidate instead of the production global phase.
    expect(kinds.filter((k) => k === 'user_roles')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'users')).toHaveLength(2)
  })

  it('lockRecordLinkAuthorityRowsOnQuery treats missing platform_member_group_members as empty groups', async () => {
    const kinds: string[] = []
    const query = vi.fn(async (sql: string) => {
      const q = sql.replace(/\s+/g, ' ').trim()
      if (q.startsWith('SAVEPOINT') || q.startsWith('ROLLBACK TO SAVEPOINT') || q.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (q.includes('FROM meta_bases') && q.includes('FOR SHARE')) {
        kinds.push('meta_bases')
        return { rows: [] }
      }
      if (q.includes('FROM meta_sheets') && q.includes('FOR SHARE')) {
        kinds.push('meta_sheets')
        return { rows: [] }
      }
      if (q.includes('FROM user_roles') && q.includes('FOR SHARE')) {
        kinds.push('user_roles')
        return { rows: [] }
      }
      if (q.includes('FROM user_permissions') && q.includes('FOR SHARE')) {
        kinds.push('user_permissions')
        return { rows: [] }
      }
      if (q.includes('FROM users') && q.includes('FOR SHARE')) {
        kinds.push('users')
        return { rows: [] }
      }
      if (q.includes('FROM platform_member_group_members')) {
        const err = new Error('relation "platform_member_group_members" does not exist') as Error & {
          code?: string
        }
        err.code = '42P01'
        throw err
      }
      if (q.includes('FROM spreadsheet_permissions') && q.includes('FOR SHARE')) {
        kinds.push('spreadsheet_permissions')
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${q}`)
    })
    await expect(
      lockRecordLinkAuthorityRowsOnQuery(query, { userId: 'u1', baseId: 'b1', sheetId: 's1' }),
    ).resolves.toBeUndefined()
    expect(kinds).toEqual([
      'meta_bases',
      'meta_sheets',
      'user_roles',
      'user_permissions',
      'users',
      'spreadsheet_permissions',
    ])
  })

  it('resolveRecordLinkTargetAuthOnQuery: missing/mismatch/missing-base/unreadable share stage list', async () => {
    const fixtures = [
      {
        label: 'missing-sheet',
        sheet: [] as Array<{ id: string; base_id: string }>,
        base: [{ owner_id: 'u' }],
        perms: ['multitable:read'],
      },
      {
        label: 'mismatch',
        sheet: [{ id: 's', base_id: 'other' }],
        base: [{ owner_id: 'u' }],
        perms: ['multitable:read'],
      },
      {
        label: 'missing-base',
        sheet: [{ id: 's', base_id: 'b' }],
        base: [] as Array<{ owner_id: string }>,
        perms: ['multitable:read'],
      },
      {
        label: 'unreadable',
        sheet: [{ id: 's', base_id: 'b' }],
        base: [{ owner_id: 'someone' }],
        perms: [] as string[],
      },
    ]
    const transcripts: string[][] = []
    for (const f of fixtures) {
      const query = vi.fn(async (sql: string) => routeAuthSql(sql, {
        sheets: { rows: f.sheet },
        bases: { rows: f.base },
        codes: { rows: f.perms.map((code) => ({ code })) },
      }))
      const transcript: string[] = []
      const result = await resolveRecordLinkTargetAuthOnQuery(
        query,
        { userId: 'u', baseId: 'b', sheetId: 's' },
        transcript,
      )
      expect(result.ok, f.label).toBe(false)
      transcripts.push(transcript)
      expect(transcript, f.label).toEqual([...RECORD_LINK_TARGET_AUTH_STAGES])
    }
    for (let i = 1; i < transcripts.length; i += 1) {
      expect(transcripts[i]).toEqual(transcripts[0])
    }
  })
})
