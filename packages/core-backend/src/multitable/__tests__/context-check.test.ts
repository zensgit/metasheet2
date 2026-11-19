import type { Request } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkSheetContext, ResourceCheckUnavailable } from '../context-check'
import { deriveCapabilities } from '../access'
import * as service from '../permission-service'
import { strictGuardLookups } from '../../rbac/strict-guard-lookups'

vi.mock('../permission-service', () => ({
  resolveSheetCapabilitiesForAccess: vi.fn(),
  canReadWithSheetGrant: vi.fn().mockReturnValue(true),
  filterReadableSheetRowsForAccess: vi.fn(async (_q, rows) => rows),
  loadViewPermissionScopeMap: vi.fn().mockResolvedValue(new Map()),
  loadFieldPermissionScopeMap: vi.fn().mockResolvedValue(new Map()),
  hasRecordPermissionAssignments: vi.fn().mockResolvedValue(false),
  loadRecordPermissionScopeMap: vi.fn().mockResolvedValue(new Map()),
  loadRowLevelReadDenyEnabledStrict: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../rbac/strict-principal', () => ({ readStrictPrincipal: vi.fn().mockResolvedValue({ id: 'target', role: 'user' }) }))

const caps = deriveCapabilities(['multitable:read'], false)
const req = { user: { id: 'actor', role: 'user', permissions: ['multitable:read'] } } as unknown as Request
const subject = { kind: 'target' as const, userId: 'target' }
const sheet = { baseId: 'base', sheetId: 'sheet' }
let failSchema = false
let missingParent = false
let tooManyRows = false
let hiddenSheet = false
const query = vi.fn(async (sql: string) => {
  if (failSchema && sql.includes('spreadsheet_permissions LIMIT 0')) throw new Error('missing schema')
  if (tooManyRows && sql.includes('spreadsheet_permissions LIMIT 0')) return { rows: Array.from({ length: 1001 }, () => ({})) }
  if (sql.includes('FROM meta_sheets s JOIN')) return { rows: missingParent ? [] : [{ id: 'sheet', ...(hiddenSheet ? { description: '__metasheet_system:people__' } : {}) }] }
  if (sql.includes('FROM meta_views WHERE')) return { rows: [{ id: 'view' }] }
  if (sql.includes('FROM meta_records WHERE')) return { rows: [{ id: 'record' }] }
  if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields')) return { rows: [{ id: 'field', type: 'text', property: {} }] }
  if (sql.includes('SELECT permissions FROM users')) return { rows: [{ permissions: [] }] }
  return { rows: [] }
})
const lookups = strictGuardLookups(query)
beforeEach(() => {
  vi.clearAllMocks()
  failSchema = false
  missingParent = false
  tooManyRows = false
  hiddenSheet = false
  vi.mocked(service.canReadWithSheetGrant).mockReturnValue(true)
  vi.mocked(service.filterReadableSheetRowsForAccess).mockImplementation(async (_query, rows) => rows)
  vi.mocked(service.resolveSheetCapabilitiesForAccess).mockResolvedValue({ access: { userId: 'actor', permissions: [], isAdminRole: false }, capabilities: caps, capabilityOrigin: {} as never, sheetLiveness: 'live' })
  vi.mocked(service.loadViewPermissionScopeMap).mockResolvedValue(new Map())
  vi.mocked(service.loadFieldPermissionScopeMap).mockResolvedValue(new Map())
  vi.mocked(service.hasRecordPermissionAssignments).mockResolvedValue(false)
  vi.mocked(service.loadRecordPermissionScopeMap).mockResolvedValue(new Map())
  vi.mocked(service.loadRowLevelReadDenyEnabledStrict).mockResolvedValue(false)
})

describe('resource snapshot guards', () => {
  it('refuses a deleted sheet even when capability remains readable', async () => {
    vi.mocked(service.resolveSheetCapabilitiesForAccess).mockResolvedValueOnce({ access: { userId: 'actor', permissions: [], isAdminRole: false }, capabilities: caps, capabilityOrigin: {} as never, sheetLiveness: 'deleted' })
    expect((await checkSheetContext(query, req, lookups, subject, sheet)).visibility).toBe('unknown')
  })
  it('refuses caller-hidden resources before computing target', async () => {
    vi.mocked(service.canReadWithSheetGrant).mockReturnValueOnce(false)
    expect((await checkSheetContext(query, req, lookups, subject, sheet)).visibility).toBe('unknown')
    expect(service.resolveSheetCapabilitiesForAccess).toHaveBeenCalledOnce()
  })
  it('refuses missing ACL schema even when the loader could degrade', async () => {
    failSchema = true
    await expect(checkSheetContext(query, req, lookups, subject, sheet)).rejects.toBeInstanceOf(ResourceCheckUnavailable)
  })
  it('refuses missing or cross-parent sheet', async () => {
    missingParent = true
    expect((await checkSheetContext(query, req, lookups, subject, sheet)).context).toBe('unknown')
  })
  it('enforces the caller view capability before target inspection', async () => {
    vi.mocked(service.loadViewPermissionScopeMap).mockResolvedValueOnce(new Map([['view', { hasAssignments: true, canRead: false, canWrite: false, canAdmin: false }]]))
    expect((await checkSheetContext(query, req, lookups, subject, { ...sheet, viewId: 'view' })).visibility).toBe('unknown')
  })
  it('enforces a caller record deny when the flag is on', async () => {
    vi.mocked(service.hasRecordPermissionAssignments).mockResolvedValue(true)
    vi.mocked(service.loadRecordPermissionScopeMap).mockResolvedValue(new Map([['record', { recordId: 'record', accessLevel: 'none' }]]))
    vi.mocked(service.loadRowLevelReadDenyEnabledStrict).mockResolvedValue(true)
    expect((await checkSheetContext(query, req, lookups, subject, { ...sheet, recordId: 'record' })).visibility).toBe('unknown')
  })
  it('enforces the caller field mask', async () => {
    vi.mocked(service.loadFieldPermissionScopeMap).mockResolvedValue(new Map([['field', { visible: false, readOnly: false }]]))
    expect((await checkSheetContext(query, req, lookups, subject, { ...sheet, fieldId: 'field', recordId: 'record' })).visibility).toBe('unknown')
  })
  it('refuses hidden system sheets', async () => {
    hiddenSheet = true
    expect((await checkSheetContext(query, req, lookups, subject, sheet)).visibility).toBe('unknown')
  })
  it('bounds the returned row count', async () => {
    tooManyRows = true
    await expect(checkSheetContext(query, req, lookups, subject, sheet)).rejects.toBeInstanceOf(ResourceCheckUnavailable)
  })
  it('bounds the number of queries even if a helper expands', async () => {
    vi.mocked(service.resolveSheetCapabilitiesForAccess).mockImplementationOnce(async (limitedQuery) => {
      for (let index = 0; index < 81; index++) await limitedQuery('SELECT 1')
      return { access: { userId: 'actor', permissions: [], isAdminRole: false }, capabilities: caps, capabilityOrigin: {} as never, sheetLiveness: 'live' }
    })
    await expect(checkSheetContext(query, req, lookups, subject, sheet)).rejects.toBeInstanceOf(ResourceCheckUnavailable)
  })
  it('does not infer an e-learning target tenant from database identity', async () => {
    const projection = { baseId: 'base', sheetId: `sht_el_stats_${'a'.repeat(32)}` }
    expect((await checkSheetContext(query, req, lookups, subject, projection)).context).toBe('unknown')
  })
  it('does not reconstruct target token claims in trusted-token mode', async () => {
    vi.stubEnv('RBAC_TOKEN_TRUST', 'true')
    try { expect((await checkSheetContext(query, req, lookups, subject, sheet)).context).toBe('unknown') }
    finally { vi.unstubAllEnvs() }
  })

  it('bounds elapsed time', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(5001)
    try { await expect(checkSheetContext(query, req, lookups, subject, sheet)).rejects.toBeInstanceOf(ResourceCheckUnavailable) }
    finally { clock.mockRestore() }
  })

})
