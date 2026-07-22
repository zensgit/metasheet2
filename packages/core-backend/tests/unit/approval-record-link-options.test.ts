import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgState = vi.hoisted(() => ({
  query: vi.fn(),
}))

const permissionState = vi.hoisted(() => ({
  loadFieldPermissionScopeMap: vi.fn(async () => new Map()),
  loadRowLevelReadDenyEnabledStrict: vi.fn(async () => false),
  loadDeniedRecordIds: vi.fn(async () => new Set<string>()),
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: (...args: unknown[]) => pgState.query(...args) },
}))

vi.mock('../../src/multitable/permission-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/multitable/permission-service')>(
    '../../src/multitable/permission-service',
  )
  return {
    ...actual,
    loadFieldPermissionScopeMap: permissionState.loadFieldPermissionScopeMap,
    loadRowLevelReadDenyEnabledStrict: permissionState.loadRowLevelReadDenyEnabledStrict,
    loadDeniedRecordIds: permissionState.loadDeniedRecordIds,
  }
})

import {
  APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
  APPROVAL_RECORD_LINK_GENERIC_LABEL,
  APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE,
  buildDisplayLabelSqlExpression,
  clampPageInt,
  formatApprovalRecordLinkDisplay,
  isComputedOrSystemFieldType,
  listApprovalRecordLinkOptions,
} from '../../src/services/approval-record-link-options'
import {
  RECORD_LINK_TARGET_AUTH_STAGES,
  resolveRecordLinkTargetAuthOnQuery,
} from '../../src/services/approval-record-link-txn-auth'

/**
 * Query fixture that satisfies the txn-local dual base+sheet gate (membership + admin +
 * permission_codes + sheet_scope) so list options can proceed to field/record queries.
 */
function authorizedDualGateQuery(extra?: (sql: string) => { rows: unknown[] } | null) {
  return async (sql: string) => {
    const q = sql.replace(/\s+/g, ' ')
    if (extra) {
      const hit = extra(q)
      if (hit) return hit
    }
    // Permission UNION also joins user_roles — match permission_code before bare admin probe.
    if (q.includes('permission_code') || q.includes('user_permissions')) {
      return { rows: [{ code: 'multitable:read' }] }
    }
    if (q.includes('FROM user_roles')) {
      return { rows: [] }
    }
    if (q.includes('FROM meta_sheets') && q.includes('deleted_at')) {
      return { rows: [{ id: 'sheet-1', base_id: 'base-1' }] }
    }
    if (q.includes('FROM meta_bases')) {
      return { rows: [{ owner_id: 'user-1' }] }
    }
    if (q.includes('FROM users') && q.includes('permissions')) {
      return { rows: [{ permissions: [] }] }
    }
    if (q.includes('FROM spreadsheet_permissions')) {
      return {
        rows: [{
          sheet_id: 'sheet-1',
          perm_code: 'spreadsheet:read',
          subject_type: 'user',
        }],
      }
    }
    if (q.includes('FROM meta_fields')) {
      return { rows: [{ id: 'fld_title', type: 'string', property: {} }] }
    }
    return { rows: [] }
  }
}

describe('formatApprovalRecordLinkDisplay', () => {
  it('uses only preferred (visible source) field ids — never arbitrary JSON keys', () => {
    expect(formatApprovalRecordLinkDisplay(
      { title: '客户甲', secret: 'LEAK' },
      ['title'],
    )).toBe('客户甲')
    expect(formatApprovalRecordLinkDisplay(
      { secret: 'LEAK_ME' },
      [],
    )).toBe(APPROVAL_RECORD_LINK_GENERIC_LABEL)
    expect(formatApprovalRecordLinkDisplay(
      { secret: 'LEAK_ME' },
      ['title'],
    )).toBe(APPROVAL_RECORD_LINK_GENERIC_LABEL)
    expect(formatApprovalRecordLinkDisplay(
      { f1: '', f2: 'from-second' },
      ['f1', 'f2'],
    )).toBe('from-second')
    expect(formatApprovalRecordLinkDisplay({ amount: 12 }, ['amount'])).toBe('12')
  })

  it('collapses a visible value equal to the record id into the generic label', () => {
    expect(formatApprovalRecordLinkDisplay(
      { title: 'rec-xyz' },
      ['title'],
      'rec-xyz',
    )).toBe(APPROVAL_RECORD_LINK_GENERIC_LABEL)
    expect(formatApprovalRecordLinkDisplay(
      { f1: 'rec-xyz', f2: '客户乙' },
      ['f1', 'f2'],
      'rec-xyz',
    )).toBe('客户乙')
  })

  it('classifies computed/system field types as non-source; canonical multitable text is string', () => {
    expect(isComputedOrSystemFieldType('formula')).toBe(true)
    expect(isComputedOrSystemFieldType('lookup')).toBe(true)
    expect(isComputedOrSystemFieldType('string')).toBe(false)
    expect(isComputedOrSystemFieldType('longText')).toBe(false)
  })
})

describe('buildDisplayLabelSqlExpression', () => {
  it('builds ordered COALESCE/NULLIF chain ending in the generic label (display/search parity)', () => {
    const { expression, fieldParams, bindParams } = buildDisplayLabelSqlExpression(['a', 'b'], 3)
    expect(fieldParams).toEqual(['a', 'b'])
    expect(bindParams).toEqual(['a', 'b', APPROVAL_RECORD_LINK_GENERIC_LABEL])
    expect(expression).toBe(
      "COALESCE(NULLIF(NULLIF(BTRIM(data->>$3), ''), id), NULLIF(NULLIF(BTRIM(data->>$4), ''), id), $5)",
    )
    const empty = buildDisplayLabelSqlExpression([], 1)
    expect(empty.expression).toBe('$1')
    expect(empty.bindParams).toEqual([APPROVAL_RECORD_LINK_GENERIC_LABEL])
    expect(empty.fieldParams).toEqual([])
  })
})

describe('clampPageInt', () => {
  it('floors and clamps non-integer / out-of-range page params', () => {
    expect(clampPageInt(1.5, 20, 1, 100)).toBe(1)
    expect(clampPageInt(20.9, 20, 1, 100)).toBe(20)
    expect(clampPageInt(-3, 0, 0)).toBe(0)
    expect(clampPageInt(Number.NaN, 20, 1, 100)).toBe(20)
    expect(clampPageInt(999, 20, 1, 100)).toBe(100)
    expect(clampPageInt('12.7', 20, 1, 100)).toBe(12)
  })
})

describe('listApprovalRecordLinkOptions — values-free DATABASE_UNAVAILABLE', () => {
  const RAW_DIAGNOSTIC =
    'connection to host=db.internal port=5432 user=metasheet failed while executing SELECT data FROM meta_records WHERE sheet_id=$1'

  beforeEach(() => {
    pgState.query.mockReset()
    permissionState.loadFieldPermissionScopeMap.mockReset()
    permissionState.loadFieldPermissionScopeMap.mockResolvedValue(new Map())
    permissionState.loadRowLevelReadDenyEnabledStrict.mockReset()
    permissionState.loadRowLevelReadDenyEnabledStrict.mockResolvedValue(false)
    permissionState.loadDeniedRecordIds.mockReset()
    permissionState.loadDeniedRecordIds.mockResolvedValue(new Set())
  })

  it('COUNT failure returns fixed 503 and never echoes raw err.message diagnostics', async () => {
    pgState.query.mockImplementation(authorizedDualGateQuery((q) => {
      if (q.includes('COUNT(*)')) throw new Error(RAW_DIAGNOSTIC)
      return null
    }))

    const result = await listApprovalRecordLinkOptions({
      userId: 'user-1',
      baseId: 'base-1',
      sheetId: 'sheet-1',
    })

    expect(result).toEqual({
      ok: false,
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(RAW_DIAGNOSTIC)
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('port=5432')
    expect(serialized).not.toContain('user=metasheet')
    expect(serialized).not.toContain('SELECT data FROM meta_records')
    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.message).toBe('Database not available')
      expect(result.message).not.toContain(':')
    }
  })

  it('SELECT failure returns fixed 503 and never echoes raw err.message diagnostics', async () => {
    pgState.query.mockImplementation(authorizedDualGateQuery((q) => {
      if (q.includes('COUNT(*)')) return { rows: [{ n: 1 }] }
      if (q.includes('FROM meta_records') && q.includes('LIMIT')) {
        throw new Error(RAW_DIAGNOSTIC)
      }
      return null
    }))

    const result = await listApprovalRecordLinkOptions({
      userId: 'user-1',
      baseId: 'base-1',
      sheetId: 'sheet-1',
      limit: 1.5 as unknown as number,
      offset: 2.9 as unknown as number,
    })

    expect(result).toEqual({
      ok: false,
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(RAW_DIAGNOSTIC)
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('metasheet')
  })

  it('missing sheet / base mismatch / missing base / unreadable share public refuse + same stage transcript', async () => {
    const cases: Array<{
      label: string
      sheetRows: Array<{ id: string; base_id: string }>
      baseRows: Array<{ owner_id: string }>
      permCodes: string[]
    }> = [
      { label: 'missing-sheet', sheetRows: [], baseRows: [{ owner_id: 'user-1' }], permCodes: ['multitable:read'] },
      {
        label: 'base-mismatch',
        sheetRows: [{ id: 'sheet-1', base_id: 'other-base' }],
        baseRows: [{ owner_id: 'user-1' }],
        permCodes: ['multitable:read'],
      },
      {
        label: 'missing-base',
        sheetRows: [{ id: 'sheet-1', base_id: 'base-1' }],
        baseRows: [],
        permCodes: ['multitable:read'],
      },
      {
        label: 'unreadable',
        sheetRows: [{ id: 'sheet-1', base_id: 'base-1' }],
        baseRows: [{ owner_id: 'someone-else' }],
        permCodes: [], // no base-read codes, not owner, not admin
      },
    ]

    const publicShapes: unknown[] = []
    const stageLists: string[][] = []
    const stageSqlCounts: number[] = []

    for (const c of cases) {
      const sqlKinds: string[] = []
      const queryFn = vi.fn(async (sql: string) => {
        const q = sql.replace(/\s+/g, ' ')
        // Permission UNION mentions user_roles — match before bare admin probe.
        if (q.includes('permission_code') || q.includes('user_permissions')) {
          sqlKinds.push('permission_codes')
          return { rows: c.permCodes.map((code) => ({ code })) }
        }
        if (q.includes('FROM user_roles')) {
          sqlKinds.push('admin_role')
          return { rows: [] }
        }
        if (q.includes('FROM meta_sheets') && q.includes('deleted_at')) {
          sqlKinds.push('sheet_membership')
          return { rows: c.sheetRows }
        }
        if (q.includes('FROM meta_bases')) {
          sqlKinds.push('base_lookup')
          return { rows: c.baseRows }
        }
        if (q.includes('FROM users') && q.includes('permissions')) {
          sqlKinds.push('legacy_perms')
          return { rows: [{ permissions: [] }] }
        }
        if (q.includes('FROM spreadsheet_permissions')) {
          sqlKinds.push('sheet_scope')
          return { rows: [] }
        }
        return { rows: [] }
      })

      const transcript: string[] = []
      const auth = await resolveRecordLinkTargetAuthOnQuery(
        queryFn,
        { userId: 'user-1', baseId: 'base-1', sheetId: 'sheet-1' },
        transcript,
      )
      expect(auth.ok, c.label).toBe(false)
      expect(transcript, c.label).toEqual([...RECORD_LINK_TARGET_AUTH_STAGES])
      stageLists.push([...transcript])
      // Discriminating: admin + permission probes always run (even when base is missing).
      expect(sqlKinds, c.label).toContain('admin_role')
      expect(sqlKinds, c.label).toContain('permission_codes')
      expect(sqlKinds, c.label).toContain('base_lookup')
      stageSqlCounts.push(sqlKinds.filter((k) => (
        k === 'sheet_membership'
        || k === 'base_lookup'
        || k === 'admin_role'
        || k === 'permission_codes'
        || k === 'sheet_scope'
      )).length)

      // Wire the same fixture through the public picker surface.
      pgState.query.mockReset()
      pgState.query.mockImplementation(queryFn)
      const result = await listApprovalRecordLinkOptions({
        userId: 'user-1',
        baseId: 'base-1',
        sheetId: 'sheet-1',
      })
      publicShapes.push(result)
    }

    expect(publicShapes[0]).toEqual(APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE)
    for (let i = 1; i < publicShapes.length; i += 1) {
      expect(publicShapes[i]).toEqual(publicShapes[0])
      expect(stageLists[i]).toEqual(stageLists[0])
      // Target-dependent authorization stages share the same query-kind count.
      expect(stageSqlCounts[i]).toBe(stageSqlCounts[0])
    }
    // missing-base must NOT skip admin/permission (the old early-return oracle).
    expect(stageLists[0]).toEqual([...RECORD_LINK_TARGET_AUTH_STAGES])
  })
})
