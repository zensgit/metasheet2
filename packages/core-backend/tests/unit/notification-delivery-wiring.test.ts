import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { readNotificationTupleFingerprint } from '../../src/integrations/dingtalk/notification-fingerprint'
import { resolveEffectiveIntegrationCapability } from '../../src/integrations/integration-capability-resolve'
import { productionNotificationConnectionReadiness, productionNotificationDeliveryEnabled, productionNotificationVerificationSummary } from '../../src/routes/me-notification-wiring'
import type { Db } from '../../src/notifications/recipient-resolver'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))
vi.mock('../../src/integrations/dingtalk/notification-fingerprint', () => ({ readNotificationTupleFingerprint: vi.fn() }))
vi.mock('../../src/integrations/integration-capability-resolve', () => ({ resolveEffectiveIntegrationCapability: vi.fn() }))
vi.mock('../../src/services/task-org-members', () => ({ findActiveOrgMembers: vi.fn() }))

const INPUT = { orgId: 'authenticated-org', connectionId: '11111111-1111-4111-8111-111111111111', provider: 'dingtalk' }
const FINGERPRINT = 'f'.repeat(64)
const WITNESS = 'a'.repeat(64)

describe('production notification delivery wiring', () => {
  let db: Db
  let queryTx: ReturnType<typeof vi.fn>
  let evidence: Record<string, unknown>
  let events: string[]

  beforeEach(() => {
    vi.resetAllMocks()
    events = []
    evidence = {
      provider: 'dingtalk', reached_level: 'token', tuple_fingerprint: FINGERPRINT, bound_tenant: 'tenant', bound_app_scope: 'app',
      verified_at: new Date(), invalidated_at: null,
    }
    queryTx = vi.fn(async (sql: string) => {
      events.push(sql)
      if (sql.includes('FROM directory_integrations')) return { rows: [{ corp_id: 'tenant', config: { appKey: 'app' } }] }
      if (sql.includes('FROM notification_connection_verifications')) return { rows: [evidence] }
      return { rows: [] }
    })
    db = { query: queryTx }
    vi.mocked(transaction).mockImplementation(async (fn) => {
      events.push('BEGIN')
      try {
        const result = await fn(db as never)
        events.push('COMMIT')
        return result
      } catch (error) {
        events.push('ROLLBACK')
        throw error
      }
    })
    vi.mocked(readNotificationTupleFingerprint).mockImplementation(async (_id, client) => {
      expect(client).toBe(db)
      events.push('FINGERPRINT')
      return { ok: true, value: FINGERPRINT }
    })
    vi.mocked(resolveEffectiveIntegrationCapability).mockImplementation(async (_executor, input) => {
      events.push('RESOLVE')
      expect(input).toEqual({ integrationId: INPUT.connectionId, capability: 'notification', expectedOrgId: INPUT.orgId })
      return { effective: true, capability: 'notification', integrationId: INPUT.connectionId, orgId: INPUT.orgId, provider: 'dingtalk', status: 'active', revision: 1, witness: WITNESS, orgSource: 'authenticated_tenant' }
    })
  })

  it('checks authoritative capability and current evidence on one bounded transaction before returning', async () => {
    expect(await productionNotificationConnectionReadiness(INPUT)).toEqual({ ok: true, witness: WITNESS })
    expect(events.slice(0, 5)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', "SET LOCAL lock_timeout = '2s'", "SET LOCAL statement_timeout = '5s'", 'RESOLVE'])
    expect(events.indexOf('FINGERPRINT')).toBeGreaterThan(events.indexOf('RESOLVE'))
    expect(events.at(-1)).toBe('COMMIT')
    expect(query).not.toHaveBeenCalled()
    expect(queryTx.mock.calls.find(([sql]) => sql.includes('FROM directory_integrations'))?.[1]).toEqual([INPUT.connectionId, INPUT.orgId, INPUT.provider])
  })

  it('rolls back resolver read failures and returns fixed busy semantics', async () => {
    vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: false, reason: 'read_failed' })
    await expect(productionNotificationConnectionReadiness(INPUT)).rejects.toMatchObject({ status: 503, code: 'NOTIFICATION_BUSY' })
    expect(events.at(-1)).toBe('ROLLBACK')
    expect(readNotificationTupleFingerprint).not.toHaveBeenCalled()
  })

  it('does not read credentials when capability is ineffective', async () => {
    vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: false, reason: 'not_enabled' })
    expect(await productionNotificationConnectionReadiness(INPUT)).toEqual({ ok: false, code: 'not_enabled' })
    expect(readNotificationTupleFingerprint).not.toHaveBeenCalled()
  })

  it('keeps credential failures authoritative and rolls back instead of using the display fallback', async () => {
    const failure = Object.assign(new Error('fixture credential failure'), { name: 'EncryptionMaterialError' })
    vi.mocked(readNotificationTupleFingerprint).mockRejectedValue(failure)
    await expect(productionNotificationConnectionReadiness(INPUT)).rejects.toBe(failure)
    expect(events.at(-1)).toBe('ROLLBACK')
    expect(events.some((sql) => sql.includes('FROM notification_connection_verifications'))).toBe(false)
  })

  it('rejects changed credentials even with an effective capability', async () => {
    evidence.tuple_fingerprint = 'b'.repeat(64)
    expect(await productionNotificationConnectionReadiness(INPUT)).toEqual({ ok: false, code: 'verification_fingerprint_changed' })
  })

  it('rejects invalidated evidence', async () => {
    evidence.invalidated_at = new Date()
    expect(await productionNotificationConnectionReadiness(INPUT)).toEqual({ ok: false, code: 'verification_invalidated' })
  })

  it('uses only ordinary reads for GET evidence display', async () => {
    expect((await productionNotificationVerificationSummary(db, INPUT)).ok).toBe(true)
    expect(transaction).not.toHaveBeenCalled()
    expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
    expect(queryTx.mock.calls.some(([sql]) => /FOR (SHARE|UPDATE)/.test(sql))).toBe(false)
  })

  it('requires the exact literal true for all three send switches', () => {
    const flags = ['USER_NOTIFICATION_PREFERENCES_ENABLED', 'EXTERNAL_NOTIFICATION_DELIVERY_ENABLED', 'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED']
    try {
      for (const name of flags) vi.stubEnv(name, 'true')
      expect(productionNotificationDeliveryEnabled()).toBe(true)
      for (const name of flags) {
        for (const value of ['', 'false', 'TRUE', '1', ' true']) {
          vi.stubEnv(name, value)
          expect(productionNotificationDeliveryEnabled()).toBe(false)
        }
        vi.stubEnv(name, 'true')
      }
    } finally { vi.unstubAllEnvs() }
  })
})
