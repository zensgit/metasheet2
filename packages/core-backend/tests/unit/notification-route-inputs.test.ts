import { describe, expect, it, vi } from 'vitest'
import { readRecipientRouteInputs } from '../../src/notifications/route-inputs'
import { resolveNotificationTopic } from '../../src/notifications/topic-registry'
import type { RecipientResolver, ResolveResult } from '../../src/notifications/recipient-resolver'

const topic = resolveNotificationTopic('task_reminder')!
const preference = (userId: string, endpoint: string | null) => ({ user_id: userId, primary_endpoint_id: endpoint,
  fallback_endpoint_id: null, enabled: true, revision: 2, quiet_start: null, quiet_end: null, quiet_timezone: null })
const success = (userId: string): ResolveResult => ({ ok: true, target: {
  provider: 'dingtalk', connectionId: 'connection', proofId: userId, addressKind: 'dingtalk_userid',
  addressWitness: 'a'.repeat(64), proofWitness: 'b'.repeat(64), boundTenant: 'tenant', boundAppScope: 'scope',
  address: { reveal: () => 'PRIVATE_ADDRESS' },
} } as unknown as ResolveResult)

describe('shared batched routing inputs', () => {
  it.each([1, 2000])('reads %i distinct users in two queries and one call per resolver mode', async count => {
    const users = Array.from({ length: count }, (_, index) => `user${index}`)
    const db = { query: vi.fn(async () => ({ rows: [] })) }
    const deriveDefaultTargets = vi.fn(async (_db, input) => input.userIds.map(success))
    const verifyEndpoints = vi.fn()
    const result = await readRecipientRouteInputs(db, { orgId: 'org', userIds: [...users, users[0]],
      defaultConnectionId: 'connection', topic, resolver: { deriveDefaultTargets, verifyEndpoints } as unknown as RecipientResolver })
    expect(db.query).toHaveBeenCalledTimes(2)
    expect(db.query.mock.calls[0][1]).toEqual(['org', 'task_reminder', users])
    expect(db.query.mock.calls[1][1]).toEqual(['org', users])
    expect(deriveDefaultTargets).toHaveBeenCalledOnce(); expect(verifyEndpoints).not.toHaveBeenCalled()
    expect(deriveDefaultTargets.mock.calls[0][1].userIds).toEqual(users)
    expect(result.recipients.size).toBe(count); expect([...result.connections]).toEqual(['connection'])
    expect(JSON.stringify([...result.recipients])).not.toContain('PRIVATE_ADDRESS')
    expect(JSON.stringify([...result.recipients])).not.toContain('"address":')
  })
  it('does not replace a failed explicit selection with an organization default, or borrow another user endpoint', async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: [preference('a', 'endpoint'), preference('b', null)] })
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint', user_id: 'other', connection_id: 'foreign', provider: 'dingtalk', status: 'active', revision: 3 }] }) }
    const verifyEndpoints = vi.fn(async () => [{ ok: false, code: 'endpoint_not_found' }])
    const deriveDefaultTargets = vi.fn(async () => [success('b')])
    const result = await readRecipientRouteInputs(db, { orgId: 'org', userIds: ['a', 'b'], defaultConnectionId: 'connection', topic,
      resolver: { deriveDefaultTargets, verifyEndpoints } as unknown as RecipientResolver })
    expect(verifyEndpoints.mock.calls[0][1]).toEqual({ orgId: 'org', refs: [{ userId: 'a', endpointId: 'endpoint' }] })
    expect(deriveDefaultTargets.mock.calls[0][1].userIds).toEqual(['b'])
    expect(result.recipients.get('a')?.candidates).toMatchObject([{ resolution: { ok: false, code: 'target_endpoint_not_found' } }])
    expect([...result.connections]).toEqual(['connection'])
  })
  it('counts changed proofs and keeps stale and revoked endpoint outcomes distinct', async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rows: ['a', 'b', 'c'].map(id => preference(id, id)) })
      .mockResolvedValueOnce({ rows: ['active', 'stale', 'revoked'].map((status, index) => ({ id: 'abc'[index], user_id: 'abc'[index],
        connection_id: 'connection', provider: 'dingtalk', status, revision: 3 })) }) }
    const verifyEndpoints = vi.fn(async () => [{ ok: false, code: 'proof_changed' }, success('b'), success('c')])
    const result = await readRecipientRouteInputs(db, { orgId: 'org', userIds: ['a', 'b', 'c'], defaultConnectionId: null, topic,
      resolver: { verifyEndpoints } as unknown as RecipientResolver })
    expect(result.proofChangedEndpoints).toBe(1)
    expect(result.resolutionCounts).toEqual({ proof_changed: 1, ok: 2 })
    expect([...result.recipients.values()].map(value => value.candidates[0].resolution)).toEqual([
      { ok: false, code: 'target_proof_changed' }, { ok: false, code: 'target_endpoint_stale' }, { ok: false, code: 'target_endpoint_revoked' },
    ])
  })
})
