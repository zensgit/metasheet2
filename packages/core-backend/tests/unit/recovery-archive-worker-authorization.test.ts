import { describe, expect, test, vi } from 'vitest'
import type { ExactAnchorPlanAuthContext } from '../../src/multitable/exact-anchor-recovery-execute'
import type { QueryFn } from '../../src/multitable/permission-service'
import type { RecoveryArchiveWorkerIdentity } from '../../src/multitable/recovery-archive-async-restore'
import { createRecoveryArchiveWorkerAuthorization } from '../../src/routes/univer-meta'

const identity: RecoveryArchiveWorkerIdentity = Object.freeze({ jobId: 'job', actorId: 'actor', workspaceId: 'workspace', baseId: 'base', sheetId: 'sheet' })
function database() {
  const state = { active: true, exists: true, base: 'base', workspace: 'workspace' }
  const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async (sql) => {
    if (sql.includes('SELECT sheet_row.base_id')) {
      expect(sql).toContain('sheet_row.deleted_at IS NULL')
      expect(sql).toContain('base_row.deleted_at IS NULL')
      return { rows: state.exists ? [{ base_id: state.base, workspace_id: state.workspace }] : [] }
    }
    if (sql.includes('FROM users')) return { rows: [{ role: 'admin', permissions: [], is_active: state.active, rbac_admin: true }] }
    return { rows: [] }
  })
  return { state, query }
}
function context(): ExactAnchorPlanAuthContext {
  return { mode: 'revert', actorId: identity.actorId, sheetId: identity.sheetId,
    plan: { reverts: [], resurrects: [], deletedAtAnchorLiveNow: [], createdAfterAnchor: [], driftCount: 0, unchangedCount: 0 },
    revertWrites: [], deleteRecordIds: [] }
}

describe('production archive worker authorization', () => {
  test('uses persisted actor and fresh database without any HTTP request', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    expect(await worker.recheckAuthority(query, identity)).toBe(true)
    expect(await worker.apply.preliminaryFullRead(query, identity)).toBe(true)
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM users'))?.[1]).toEqual(['actor'])
    state.active = false
    expect(await worker.recheckAuthority(query, identity)).toBe(false)
    expect(await worker.apply.preliminaryFullRead(query, identity)).toBe(false)
  })
  test.each(['base', 'workspace', 'deleted'] as const)('denies %s scope drift before actor lookup', async (change) => {
    const { state, query } = database()
    if (change === 'deleted') state.exists = false
    else state[change] = 'other'
    expect(await createRecoveryArchiveWorkerAuthorization().recheckAuthority(query, identity)).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM users'))).toBe(false)
  })
  test.each(['jobId', 'actorId', 'workspaceId', 'baseId', 'sheetId'] as const)('rejects malformed %s before query', async (key) => {
    const { query } = database()
    expect(await createRecoveryArchiveWorkerAuthorization().recheckAuthority(query, { ...identity, [key]: ' ' })).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })
  test('final full-read requires the source sheet in the lock scope and rechecks revocation', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    const scope = { authoritySheetIds: ['other'], liveRows: [], lockedRecordKeys: new Set<string>() }
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(false)
    expect(query).not.toHaveBeenCalled()
    scope.authoritySheetIds = [identity.sheetId]
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(true)
    state.active = false
    expect(await worker.apply.finalLockedFullRead(query, scope, identity)).toBe(false)
  })
  test('plan authorization uses canonical shared policy and rejects mismatched identity', async () => {
    const { state, query } = database()
    const worker = createRecoveryArchiveWorkerAuthorization()
    expect(await worker.apply.evaluatePlanAuthorization(query, context(), identity)).toBe(true)
    state.active = false
    expect(await worker.apply.evaluatePlanAuthorization(query, context(), identity)).toBe(false)
    query.mockClear()
    const wrong = { ...context(), actorId: 'other' }
    expect(await worker.apply.evaluatePlanAuthorization(query, wrong, identity)).toBe(false)
    expect(await worker.apply.stabilizeAuthorization(query, wrong, identity)).toBe('unavailable')
    expect(query).not.toHaveBeenCalled()
  })
})
