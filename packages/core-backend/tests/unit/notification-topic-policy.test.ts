import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTopicPolicyService } from '../../src/notifications/topic-policy-service'
import { resolveEffectiveIntegrationCapability } from '../../src/integrations/integration-capability-resolve'
import { resolveNotificationAdapter } from '../../src/notifications/adapters/notification-adapter'
import { resolveNotificationTopic } from '../../src/notifications/topic-registry'
import type { NotificationVerificationCheck } from '../../src/notifications/verification-evidence'
import type { RecipientResolver } from '../../src/notifications/recipient-resolver'

vi.mock('../../src/integrations/integration-capability-resolve', () => ({ resolveEffectiveIntegrationCapability: vi.fn() }))
vi.mock('../../src/notifications/adapters/notification-adapter', () => ({ resolveNotificationAdapter: vi.fn(() => ({ transport: 'work_notification' })) }))
vi.mock('../../src/notifications/topic-registry', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/notifications/topic-registry')>()
  return { ...original, resolveNotificationTopic: vi.fn((topic: string) => {
    const descriptor = original.resolveNotificationTopic(topic)
    return descriptor ? { ...descriptor, integrated: true } : null
  }) }
})
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const ACTOR = { actorId: 'fixture-user', authenticatedTenantId: 'default' }
const TOPIC = 'task_reminder'
function setup(current: Record<string, unknown> | null = null) {
  const queries: string[] = []
  const db = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push(sql)
    if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: ACTOR.actorId }] }
    if (sql.includes('to_regclass')) return { rows: [{ present: true }] }
    if (sql.includes('FOR UPDATE')) return { rows: current ? [current] : [] }
    if (sql.startsWith('INSERT INTO org_notification') || sql.startsWith('UPDATE org_notification')) {
      current = { topic: TOPIC, state: params![2], default_connection_id: params![3], revision: Number(current?.revision ?? 0) + 1 }
      return { rows: [current] }
    }
    return { rows: [] }
  }) }
  const audit = vi.fn(async () => {})
  const verification = vi.fn(async (): Promise<NotificationVerificationCheck> => ({ ok: true as const, verification: { level: 'token' as const, verifiedUntil: '2026-12-01T00:00:00Z', valid: true } }))
  const transaction = vi.fn(async (fn: (client: typeof db) => Promise<unknown>) => { queries.push('BEGIN ISOLATION LEVEL READ COMMITTED');
    try { const result = await fn(db); queries.push('COMMIT'); return result } catch (error) { queries.push('ROLLBACK'); throw error } })
  const deliveryEnabled = vi.fn(() => true)
  const service = createTopicPolicyService({ db, transaction: transaction as never, audit, verification,
    isActiveOrgMembers: async (db, orgId, ids) => new Set((await db.query('SELECT user_id FROM user_orgs', [orgId, ids])).rows.map(row => String(row.user_id))),
    deliveryEnabled, resolver: { deriveDefaultTargets: async (_db, input) => input.userIds.map(() => ({ ok: false, code: 'connection_not_found' })), verifyEndpoints: async () => [] } as unknown as RecipientResolver })
  return { service, db, queries, audit, verification, transaction, deliveryEnabled }
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: true, orgId: 'default', provider: 'dingtalk', revision: 1, witness: 'a'.repeat(64) } as never) })

describe('authenticated management policy contract', () => {
  it.each([undefined, '', 'other'])('refuses first null takeover for tenant %s without writes', async authenticatedTenantId => {
    const s = setup()
    await expect(s.service.put({ ...ACTOR, authenticatedTenantId }, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true }))
      .rejects.toMatchObject({ status: authenticatedTenantId === 'other' ? 403 : 422, code: authenticatedTenantId === 'other' ? 'ORG_MISMATCH' : 'ORG_MISSING' })
    expect(s.transaction).not.toHaveBeenCalled(); expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
  })
  it('requires explicit no-default confirmation and rolls back', async () => {
    const s = setup()
    await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null })).rejects.toMatchObject({ code: 'DEFAULT_CONNECTION_CONFIRM_REQUIRED' })
    expect(s.queries.at(-1)).toBe('ROLLBACK'); expect(s.audit).not.toHaveBeenCalled()
  })
  it('takes over with confirmed null and never invents a capability call', async () => {
    const s = setup()
    expect(await s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true }))
      .toEqual({ topic: TOPIC, state: 'active', defaultConnectionId: null, revision: 1 })
    expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
    expect(s.queries.filter(sql => sql.includes('to_regclass'))).toHaveLength(4)
    expect(s.queries).toContain('SELECT 1 FROM task_notification_delivery_decisions LIMIT 1')
    expect(s.audit).toHaveBeenCalledOnce()
  })
  it('validates a nonnull default with R-1 after bounded SETs and discards its witness', async () => {
    const s = setup()
    const result = await s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: CONNECTION })
    expect(resolveEffectiveIntegrationCapability).toHaveBeenCalledWith(expect.anything(), { integrationId: CONNECTION, capability: 'notification', expectedOrgId: 'default' })
    expect(s.queries.slice(1, 5)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '5s'", 'COMMIT'])
    expect(JSON.stringify(result)).not.toContain('witness'); expect(JSON.stringify(s.audit.mock.calls)).not.toContain('witness')
  })
  it('rolls back a swallowed resolver read failure before any policy write', async () => {
    vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: false, reason: 'read_failed' })
    const s = setup()
    await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: CONNECTION })).rejects.toMatchObject({ code: 'NOTIFICATION_BUSY' })
    expect(s.queries.at(-1)).toBe('ROLLBACK'); expect(s.queries.join(' ')).not.toContain('INSERT')
  })
  it('state-only update retains the default and does not broaden the membership gate', async () => {
    const s = setup({ topic: TOPIC, revision: 4, state: 'active', default_connection_id: CONNECTION })
    expect(await s.service.put({ actorId: ACTOR.actorId }, TOPIC, { expectedRevision: 4, state: 'paused' }))
      .toMatchObject({ revision: 5, state: 'paused', defaultConnectionId: CONNECTION })
    expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
    expect(s.queries.join(' ')).not.toContain('FROM user_orgs')
  })
  it('explicit null clears a default after takeover without new first-takeover confirmation', async () => {
    const s = setup({ topic: TOPIC, revision: 4, state: 'active', default_connection_id: CONNECTION })
    expect(await s.service.put({ actorId: ACTOR.actorId }, TOPIC, { expectedRevision: 4, state: 'paused', defaultConnectionId: null })).toMatchObject({ defaultConnectionId: null })
  })
  it('rejects a stale revision without changing a policy or auditing success', async () => {
    const s = setup({ topic: TOPIC, revision: 4, state: 'active', default_connection_id: null })
    await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 2, state: 'paused' })).rejects.toMatchObject({ code: 'POLICY_STALE' })
    expect(s.queries.some(sql => sql.startsWith('UPDATE'))).toBe(false); expect(s.audit).not.toHaveBeenCalled()
  })
  it('rejects inactive members before the authority read', async () => {
    const s = setup(); s.db.query.mockResolvedValueOnce({ rows: [] })
    await expect(s.service.requireMember(ACTOR)).rejects.toMatchObject({ code: 'ORG_MISMATCH' })
    expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
  })
})

it('refuses a production topic before transactions, writes or success audit', async () => {
  const original = await vi.importActual<typeof import('../../src/notifications/topic-registry')>('../../src/notifications/topic-registry')
  vi.mocked(resolveNotificationTopic).mockImplementationOnce(original.resolveNotificationTopic)
  const s = setup()
  await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true }))
    .rejects.toMatchObject({ status: 409, code: 'TOPIC_NOT_INTEGRATED' })
  expect(s.transaction).not.toHaveBeenCalled(); expect(s.audit).not.toHaveBeenCalled()
})
it('refuses first takeover with delivery disabled before transactions or writes', async () => {
  const s = setup(); s.deliveryEnabled.mockReturnValue(false)
  await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true }))
    .rejects.toMatchObject({ status: 409, code: 'NOTIFICATION_DELIVERY_DISABLED' })
  expect(s.transaction).not.toHaveBeenCalled(); expect(s.audit).not.toHaveBeenCalled()
})
it.each(['verification_missing', 'verification_stale', 'verification_invalidated', 'verification_anchor_changed', 'verification_fingerprint_changed'] as const)
  ('refuses a default with %s evidence before the policy transaction', async code => {
    const s = setup()
    s.verification.mockResolvedValue({ ok: false, code, verification: { level: null, verifiedUntil: null, valid: false } })
    await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: CONNECTION }))
      .rejects.toMatchObject({ status: 409, code: 'DEFAULT_CONNECTION_NOT_READY' })
    expect(s.transaction).toHaveBeenCalledOnce(); expect(s.queries.join(' ')).not.toContain('INSERT')
    expect(s.audit).not.toHaveBeenCalled()
  })
it.each([undefined, 'other'])('preview tenant %s is refused before R-1 and any preview query', async authenticatedTenantId => {
  const s = setup()
  await expect(s.service.preview({ ...ACTOR, authenticatedTenantId }, TOPIC, CONNECTION))
    .rejects.toMatchObject({ status: authenticatedTenantId ? 403 : 422, code: authenticatedTenantId ? 'ORG_MISMATCH' : 'ORG_MISSING' })
  expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled(); expect(s.db.query).not.toHaveBeenCalled()
})
it.each(['put', 'preview'] as const)('%s refuses an inactive member with a fixed 403', async method => {
  const s = setup(); s.db.query.mockResolvedValueOnce({ rows: [] })
  const call = method === 'put'
    ? s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true })
    : s.service.preview(ACTOR, TOPIC, CONNECTION)
  await expect(call).rejects.toMatchObject({ status: 403, code: 'ORG_MISMATCH' })
  expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled(); expect(s.transaction).not.toHaveBeenCalled()
})
it.each([
  { expectedRevision: 0, state: 'paused' as const, defaultConnectionId: CONNECTION },
  { expectedRevision: 0, state: 'active' as const, confirmNoDefaultConnection: true as const },
])('rejects an invalid first transition or omitted default', async patch => {
  const s = setup()
  await expect(s.service.put(ACTOR, TOPIC, patch)).rejects.toMatchObject({ status: 422, code: 'INVALID_REQUEST' })
  expect(s.transaction).not.toHaveBeenCalled(); expect(s.audit).not.toHaveBeenCalled()
})
it('records the chosen default and first-takeover marker without authority witnesses', async () => {
  const s = setup()
  await s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: CONNECTION })
  expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: {
    state: 'active', revision: 1, defaultConnectionId: CONNECTION, firstTakeover: true,
  } }))
})
it('refuses a foreign successful capability result before verification and writes', async () => {
  vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: true, orgId: 'other', provider: 'dingtalk', revision: 1, witness: 'a'.repeat(64) } as never)
  const s = setup()
  await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 1, state: 'active', defaultConnectionId: CONNECTION }))
    .rejects.toMatchObject({ status: 409, code: 'DEFAULT_CONNECTION_NOT_READY' })
  expect(s.verification).not.toHaveBeenCalled(); expect(s.queries.join(' ')).not.toContain('UPDATE')
})
it.each([undefined, 'other'])('an explicit selection on an existing policy still requires tenant %s', async authenticatedTenantId => {
  const s = setup({ topic: TOPIC, revision: 4, state: 'active', default_connection_id: null })
  await expect(s.service.put({ ...ACTOR, authenticatedTenantId }, TOPIC, { expectedRevision: 4, state: 'active', defaultConnectionId: CONNECTION }))
    .rejects.toMatchObject({ code: authenticatedTenantId ? 'ORG_MISMATCH' : 'ORG_MISSING' })
  expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled(); expect(s.transaction).not.toHaveBeenCalled()
})

it.each(['unregistered_profile', 'wrong_transport'])('refuses default %s before verification and policy writes', async mode => {
  if (mode === 'unregistered_profile') vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: true, orgId: 'default', provider: 'other', revision: 1, witness: 'a'.repeat(64) } as never)
  else vi.mocked(resolveNotificationAdapter).mockReturnValueOnce({ transport: 'different' } as never)
  const s = setup()
  await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', defaultConnectionId: CONNECTION }))
    .rejects.toMatchObject({ status: 409, code: 'DEFAULT_CONNECTION_NOT_READY' })
  expect(s.verification).not.toHaveBeenCalled(); expect(s.queries.join(' ')).not.toContain('INSERT')
})
it('preview gives the same fixed counts and warning for missing and foreign connections', async () => {
  vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: false, reason: 'integration_missing' })
  const s = setup()
  const missing = await s.service.preview(ACTOR, TOPIC, CONNECTION)
  const foreign = await s.service.preview(ACTOR, TOPIC, '22222222-2222-4222-8222-222222222222')
  expect(missing).toEqual(foreign)
  expect(missing).toMatchObject({ counts: { connection_not_found: 1 }, warnings: ['default_connection_not_ready'] })
  expect(s.queries.join(' ')).not.toMatch(/INSERT|UPDATE|DELETE/)
})
