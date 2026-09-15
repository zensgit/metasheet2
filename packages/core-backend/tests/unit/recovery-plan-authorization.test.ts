import { describe, expect, test, vi } from 'vitest'
import { deriveCapabilities } from '../../src/multitable/access'
import type { ExactAnchorPlanAuthContext } from '../../src/multitable/exact-anchor-recovery-execute'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoverySheetAuthority } from '../../src/multitable/recovery-authorization-stability'
import { createRecoveryPlanAuthorization } from '../../src/multitable/recovery-plan-authorization'

const authority = (): RecoverySheetAuthority => ({
  access: { userId: 'actor', permissions: [], isAdminRole: true },
  capabilities: deriveCapabilities([], true),
  capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
})
const context = (): ExactAnchorPlanAuthContext => ({
  mode: 'revert', sheetId: 'source', actorId: 'actor',
  plan: { reverts: [], resurrects: [], deletedAtAnchorLiveNow: [], createdAfterAnchor: [], driftCount: 0, unchangedCount: 0 },
  revertWrites: [], deleteRecordIds: [],
})

describe('shared recovery true-delta authorization', () => {
  test('uses the caller transaction and fresh resolver on every evaluation', async () => {
    const query: QueryFn = vi.fn(async () => ({ rows: [] }))
    const current = authority()
    const resolve = vi.fn(async () => current)
    const read = vi.fn(async () => true)
    const evaluate = createRecoveryPlanAuthorization('source', resolve, read)
    expect(await evaluate(query, context())).toBe(true)
    expect(resolve).toHaveBeenCalledWith(query, 'source')
    expect(read).toHaveBeenCalledWith(query, 'source', current)
    current.capabilities.canManageSheetAccess = false
    expect(await evaluate(query, context())).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  test.each(['actor', 'manage', 'read'] as const)('%s denial precedes source record lookup', async (denial) => {
    const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async () => ({ rows: [] }))
    const current = authority()
    if (denial === 'actor') current.access.userId = 'other'
    if (denial === 'manage') current.capabilities.canManageSheetAccess = false
    const ctx = context()
    ctx.deleteRecordIds = ['record']
    const evaluate = createRecoveryPlanAuthorization('source', async () => current, async () => denial !== 'read')
    expect(await evaluate(query, ctx)).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM meta_records'))).toBe(false)
  })

  test.each(['string', 'formula', 'lookup', 'rollup'] as const)('true changed %s field preserves write policy', async (type) => {
    const query: QueryFn = async (sql) => ({ rows: sql.includes('FROM meta_fields')
      ? [{ id: 'field', name: 'Field', type, property: {} }]
      : sql.includes('SELECT id, created_by') ? [{ id: 'record', created_by: 'actor' }] : [] })
    const ctx = context()
    ctx.revertWrites = [{ recordId: 'record', liveVersion: 1, changedFieldIds: ['field'], patch: { field: 'new' }, projectedData: { field: 'new' }, linkUpdates: [] }]
    expect(await createRecoveryPlanAuthorization('source', async () => authority(), async () => true)(query, ctx)).toBe(type === 'string')
  })

  test('foreign authority denial precedes target record lookup', async () => {
    const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async (sql) => ({ rows: sql.includes('FROM meta_fields')
      ? [{ id: 'link', name: 'Link', type: 'link', property: { foreignSheetId: 'foreign' } }]
      : sql.includes('SELECT id, created_by') ? [{ id: 'record', created_by: 'actor' }] : [] }))
    const ctx = context()
    ctx.revertWrites = [{ recordId: 'record', liveVersion: 1, changedFieldIds: ['link'], patch: {}, projectedData: {}, linkUpdates: [{ fieldId: 'link', targetIds: ['target'] }] }]
    const resolve = vi.fn(async (_query: QueryFn, sheetId: string) => {
      const current = authority()
      if (sheetId === 'foreign') current.capabilities.canRead = false
      return current
    })
    expect(await createRecoveryPlanAuthorization('source', resolve, async () => true)(query, ctx)).toBe(false)
    expect(resolve).toHaveBeenCalledWith(query, 'foreign')
    expect(query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(false)
  })
})
