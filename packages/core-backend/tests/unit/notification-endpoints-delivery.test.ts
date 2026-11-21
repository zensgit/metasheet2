import { describe, expect, it, vi } from 'vitest'
import { createEndpointsService } from '../../src/notifications/endpoints-service'
import type { Db, RecipientResolver } from '../../src/notifications/recipient-resolver'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const NOW = '2026-11-21T01:00:00.000Z'
const ROW = {
  id: ENDPOINT, org_id: 'org-1', user_id: 'user-1', connection_id: CONNECTION, provider: 'dingtalk',
  address_kind: 'dingtalk_userid', proof_kind: 'directory_link', status: 'active', revision: '1', last_verified_at: NOW,
  proof_id: 'never-return-proof', proof_witness: 'never-return-witness', address: 'never-return-address',
}

function fixture(input: { enabled?: boolean; usable?: boolean; capability?: boolean; verified?: boolean; rows?: typeof ROW[] } = {}) {
  const rows = input.rows ?? [ROW]
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM user_notification_endpoints')) return { rows }
    if (sql.includes('to_regclass')) return { rows: [{ capabilities: true, history: true }] }
    if (sql.includes('SELECT id::text AS id, name')) return { rows: [{ id: CONNECTION, name: 'HQ' }] }
    if (sql.includes('FROM directory_integrations')) return { rows: [{ id: CONNECTION, org_id: 'org-1', provider: 'dingtalk', status: 'active', corp_id: 'tenant', config: { appKey: 'app' } }] }
    if (sql.includes('FROM directory_integration_capabilities')) return { rows: [{
      integration_id: CONNECTION, bound_provider: 'dingtalk', bound_org_id: 'org-1', notification_enabled: input.capability ?? true,
      notification_bound_tenant: 'tenant', notification_bound_app_scope: 'app', revision: '1',
    }] }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const db = { query } as Db
  const transaction = vi.fn()
  const connectionVerified = vi.fn(async (_db: Db, _input: { orgId: string; connectionId: string; provider: string }) => input.verified ?? true)
  const resolver = {
    listCandidates: vi.fn(async () => []),
    verifyEndpoints: vi.fn(async () => rows.map(() => input.usable === false ? { ok: false, code: 'proof_changed' } : { ok: true, target: {} })),
  } as unknown as RecipientResolver
  const service = createEndpointsService({
    db, transaction, resolver, audit: vi.fn(), capabilitySwitchOn: () => true,
    deliveryEnabled: () => input.enabled ?? true, connectionVerified,
  })
  return { service, query, transaction, connectionVerified }
}

describe('GET endpoint delivery display', () => {
  it.each([
    [{ enabled: false }, { enabled: false, testSendAvailable: false, reason: 'delivery_disabled' }],
    [{ usable: false }, { enabled: true, testSendAvailable: false, reason: 'endpoint_unusable' }],
    [{ capability: false }, { enabled: true, testSendAvailable: false, reason: 'capability_off' }],
    [{ verified: false }, { enabled: true, testSendAvailable: false, reason: 'not_verified' }],
    [{}, { enabled: true, testSendAvailable: true, reason: null }],
    [{ rows: [] }, { enabled: true, testSendAvailable: false, reason: 'endpoint_unusable' }],
  ])('reports the safe availability summary for %j', async (input, delivery) => {
    const test = fixture(input)
    const result = await test.service.list({ orgId: 'org-1', userId: 'user-1' })
    expect(result.delivery).toEqual(delivery)
    expect(test.transaction).not.toHaveBeenCalled()
    expect(test.query.mock.calls.some(([sql]) => /FOR (SHARE|UPDATE)/.test(sql))).toBe(false)
  })

  it('returns exactly the existing endpoint shape, with valid evidence and no internal values', async () => {
    const test = fixture()
    const result = await test.service.list({ orgId: 'org-1', userId: 'user-1' })
    expect(result).toEqual({
      delivery: { enabled: true, testSendAvailable: true, reason: null },
      endpoints: [{
        id: ENDPOINT, connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · HQ' },
        addressKind: 'dingtalk_userid', proofKind: 'directory_link', status: 'active', revision: 1,
        usable: true, unusableReason: null, capability: { effective: true, reason: null }, verified: true, lastVerifiedAt: NOW,
      }], candidates: [],
    })
    expect(JSON.stringify(result)).not.toMatch(/never-return|fingerprint|proof_id|address_witness/)
  })

  it('marks stale endpoints unusable and reads evidence once per connection', async () => {
    const test = fixture({ rows: [ROW, { ...ROW, id: '44444444-4444-4444-8444-444444444444', status: 'stale' }] })
    const result = await test.service.list({ orgId: 'org-1', userId: 'user-1' })
    expect(result.endpoints.map((endpoint) => endpoint.usable)).toEqual([true, false])
    expect(test.connectionVerified).toHaveBeenCalledTimes(1)
    expect(test.connectionVerified.mock.calls[0][1]).toEqual({ orgId: 'org-1', connectionId: CONNECTION, provider: 'dingtalk' })
  })

  it('skips credentials and verification evidence while delivery is disabled', async () => {
    const test = fixture({ enabled: false })
    test.connectionVerified.mockRejectedValue(new Error('fixture credential failure'))
    const result = await test.service.list({ orgId: 'org-1', userId: 'user-1' })
    expect(result.delivery).toEqual({ enabled: false, testSendAvailable: false, reason: 'delivery_disabled' })
    expect(result.endpoints[0].verified).toBe(false)
    expect(test.connectionVerified).not.toHaveBeenCalled()
  })

  it('marks only the failing connection unverified and keeps other endpoints visible', async () => {
    const secondConnection = '22222222-2222-4222-8222-222222222222'
    const test = fixture({ rows: [
      ROW,
      { ...ROW, id: '44444444-4444-4444-8444-444444444444' },
      { ...ROW, id: '55555555-5555-4555-8555-555555555555', connection_id: secondConnection },
    ] })
    test.connectionVerified.mockImplementation(async (_db, input) => {
      if (input.connectionId === CONNECTION) {
        throw Object.assign(new Error('fixture secret must not escape'), { name: 'EncryptionMaterialError' })
      }
      return true
    })
    const result = await test.service.list({ orgId: 'org-1', userId: 'user-1' })
    expect(result.endpoints.map((endpoint) => endpoint.verified)).toEqual([false, false, true])
    expect(result.endpoints.every((endpoint) => endpoint.usable)).toBe(true)
    expect(result.delivery).toEqual({ enabled: true, testSendAvailable: true, reason: null })
    expect(test.connectionVerified).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result)).not.toMatch(/fixture secret|EncryptionMaterialError/)
  })
})
