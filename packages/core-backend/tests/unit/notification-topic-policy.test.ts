import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTopicPolicyService } from '../../src/notifications/topic-policy-service'
import { resolveEffectiveIntegrationCapability } from '../../src/integrations/integration-capability-resolve'
import type { RecipientResolver } from '../../src/notifications/recipient-resolver'

vi.mock('../../src/integrations/integration-capability-resolve', () => ({ resolveEffectiveIntegrationCapability: vi.fn() }))
vi.mock('../../src/notifications/adapters/notification-adapter', () => ({ resolveNotificationAdapter: () => ({ transport: 'work_notification' }) }))
vi.mock('../../src/notifications/topic-registry', () => ({
  resolveNotificationTopic: (topic: string) => topic === 'task_reminder' ? { topic, integrated: true, profiles: { dingtalk: { transport: 'work_notification' } } } : null,
  listNotificationTopics: () => [{ topic: 'task_reminder', integrated: true }],
}))
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
  const verification = vi.fn(async () => ({ ok: true as const, verification: { level: 'token' as const, verifiedUntil: '2026-12-01T00:00:00Z', valid: true } }))
  const transaction = vi.fn(async (fn: (client: typeof db) => Promise<unknown>) => { queries.push('BEGIN ISOLATION LEVEL READ COMMITTED');
    try { const result = await fn(db); queries.push('COMMIT'); return result } catch (error) { queries.push('ROLLBACK'); throw error } })
  const service = createTopicPolicyService({ db, transaction: transaction as never, audit, verification,
    isActiveOrgMembers: async (db, orgId, ids) => new Set((await db.query('SELECT user_id FROM user_orgs', [orgId, ids])).rows.map(row => String(row.user_id))),
    deliveryEnabled: () => true, resolver: {} as RecipientResolver })
  return { service, db, queries, audit, verification, transaction }
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
    await expect(s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active' })).rejects.toMatchObject({ code: 'DEFAULT_CONNECTION_CONFIRM_REQUIRED' })
    expect(s.queries.at(-1)).toBe('ROLLBACK'); expect(s.audit).not.toHaveBeenCalled()
  })
  it('takes over with confirmed null and never invents a capability call', async () => {
    const s = setup()
    expect(await s.service.put(ACTOR, TOPIC, { expectedRevision: 0, state: 'active', confirmNoDefaultConnection: true }))
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
