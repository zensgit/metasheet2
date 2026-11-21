import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fresh: vi.fn(), send: vi.fn(), poolQuery: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: mocks.poolQuery, pool: null }))
vi.mock('../../src/integrations/dingtalk/client', async (original) => ({
  ...(await original<typeof import('../../src/integrations/dingtalk/client')>()),
  fetchDingTalkAppAccessTokenFresh: mocks.fresh,
  sendDingTalkWorkNotification: mocks.send,
}))
import { createNotificationVerificationService, notificationVerificationAuditMeta, NotificationVerificationEvidenceError } from '../../src/notifications/verification-service'
import { notificationTupleFingerprint } from '../../src/integrations/dingtalk/notification-fingerprint'
import { DingTalkBusinessError } from '../../src/integrations/dingtalk/transport'
import type { Db } from '../../src/notifications/recipient-resolver'
const ID = 'd1000000-0000-4000-8000-000000000001'
const config = { appKey: 'synthetic-key', appSecret: 'synthetic-secret', workNotificationAgentId: '12345', baseUrl: 'https://oapi.dingtalk.com' }

function harness() {
  const row = { id: ID, name: 'Test', status: 'active', org_id: 'default', corp_id: 'synthetic-corp', config: { ...config }, updated_at: '2026-11-01T00:00:00Z' }
  let evidence: Record<string, unknown> | undefined
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SET ')) return { rows: [] }
    if (sql.includes('FROM directory_integrations')) return { rows: sql.includes("org_id = 'default'") && row.org_id !== 'default' ? [] : [row] }
    if (sql.startsWith('INSERT INTO notification_connection_verifications')) {
      evidence = { provider: params[1], reached_level: params[2], tuple_fingerprint: params[3], bound_tenant: params[4],
        bound_app_scope: params[5], verified_at: params[7], invalidated_at: null }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE notification_connection_verifications')) {
      if (evidence && Number(params[3]) <= (evidence.reached_level === 'send' ? 3 : 2)) evidence.invalidated_at = params[2]
      return { rows: [] }
    }
    if (sql.includes('FROM notification_connection_verifications')) return { rows: evidence ? [evidence] : [] }
    throw new Error('unexpected query')
  })
  const db: Db = { query }
  const transaction = vi.fn(async <T>(fn: (client: Db) => Promise<T>) => fn(db))
  const service = createNotificationVerificationService({ db, transaction })
  return { row, query, transaction, service, evidence: () => evidence }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  mocks.poolQuery.mockReset()
  mocks.fresh.mockReset().mockResolvedValue('synthetic-token')
  mocks.send.mockReset().mockResolvedValue({ taskId: 'synthetic-task', raw: { errcode: 0, task_id: 'synthetic-task' } })
})

describe('production verification wrapper', () => {
  it('refuses another organization before any verification or evidence write', async () => {
    const h = harness()
    h.row.org_id = 'another-org'
    await expect(h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(mocks.fresh).not.toHaveBeenCalled()
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('rechecks the actual tuple organization before network when the row changed after the first check', async () => {
    const h = harness()
    h.query.mockImplementationOnce(async () => {
      h.row.org_id = 'another-org'
      return { rows: [{ id: ID }] }
    })
    await expect(h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(mocks.fresh).not.toHaveBeenCalled()
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('refuses an organization change during the provider call before evidence persistence', async () => {
    const h = harness()
    mocks.fresh.mockImplementationOnce(async () => { h.row.org_id = 'another-org'; return 'token' })
    await expect(h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })).rejects.toMatchObject({
      status: 404, code: 'NOT_FOUND',
      auditMeta: { accessTokenVerified: true, evidenceRecorded: false, evidenceFailureCode: 'NOT_FOUND' },
    })
    expect(h.evidence()).toBeUndefined()
  })

  it.each(['fingerprint', 'anchor'] as const)('rejects an unsupported %s before token or send with a fixed code', async (binding) => {
    const h = harness()
    if (binding === 'fingerprint') h.row.config.baseUrl = 'https://synthetic-private.invalid'
    else h.row.corp_id = ''
    const error = await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret', verifiedBy: 'admin' })
      .catch((failure: unknown) => failure)
    expect(error).toMatchObject({ status: 409, code: 'VERIFICATION_TUPLE_UNSUPPORTED' })
    expect(error).not.toBeInstanceOf(NotificationVerificationEvidenceError)
    expect(mocks.fresh).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(h.transaction).not.toHaveBeenCalled()
    expect(JSON.stringify(error)).not.toContain('synthetic-private')
  })

  it.each([
    ['55P03', 503, 'NOTIFICATION_BUSY'],
    ['42P01', 503, 'NOTIFICATION_SCHEMA_UNAVAILABLE'],
    ['synthetic-private-code', 500, 'VERIFICATION_EVIDENCE_WRITE_FAILED'],
  ] as const)('retains a safe completed-send audit when evidence persistence fails with %s', async (code, status, failureCode) => {
    const h = harness()
    const answer = h.query.getMockImplementation()!
    h.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO notification_connection_verifications')) {
        throw Object.assign(new Error('synthetic-private-driver-message'), { code })
      }
      return answer(sql, params)
    })
    const error = await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret', verifiedBy: 'admin' })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(NotificationVerificationEvidenceError)
    expect(error).toMatchObject({
      status, code: failureCode,
      auditMeta: {
        requestedLevel: 'send', reachedLevel: 'send', notificationAttempted: true, notificationAccepted: true,
        recipientUserIdLength: 16, evidenceRecorded: false, evidenceFailureCode: failureCode,
      },
    })
    expect(mocks.fresh).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(h.transaction).toHaveBeenCalledOnce()
    expect(h.evidence()).toBeUndefined()
    for (const privateValue of ['synthetic-private', 'synthetic-secret', 'recipient-secret', 'synthetic-corp', 'sourceScope']) {
      expect(JSON.stringify(error)).not.toContain(privateValue)
    }
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('result')
  })

  it('writes evidence from the exact tested tuple, even if credentials and anchor change during token verification', async () => {
    const h = harness()
    mocks.fresh.mockImplementationOnce(async () => {
      h.row.config.appSecret = 'rotated-secret'
      h.row.corp_id = 'rotated-corp'
      return 'synthetic-token'
    })
    const response = await h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })
    const original = notificationTupleFingerprint({ appKey: config.appKey, appSecret: config.appSecret, agentId: '12345', baseUrl: config.baseUrl })
    expect(original.ok).toBe(true)
    expect(h.evidence()).toMatchObject({ reached_level: 'token', bound_tenant: 'synthetic-corp', tuple_fingerprint: original.ok ? original.value : '' })
    expect(response.evidence).toMatchObject({ level: 'token', valid: false })
    expect(mocks.poolQuery).not.toHaveBeenCalled()
    expect(h.transaction).toHaveBeenCalledOnce()
    const output = JSON.stringify(response)
    for (const privateValue of ['synthetic-secret', 'rotated-secret', 'synthetic-corp', 'sourceScope', original.ok ? original.value : '']) {
      expect(output).not.toContain(privateValue)
    }
  })

  it('downgrades prior send evidence to token after a send failure', async () => {
    const h = harness()
    await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret', verifiedBy: 'admin' })
    mocks.send.mockRejectedValueOnce(new DingTalkBusinessError('provider-sensitive-message', { errcode: 40001 }))
    const response = await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret', verifiedBy: 'admin' })
    expect(response.result).toMatchObject({ passed: false, reachedLevel: 'token', failure: { level: 'send' } })
    expect(response.evidence).toMatchObject({ level: 'token', valid: true })
    expect(h.evidence()?.reached_level).toBe('token')
    expect(JSON.stringify(notificationVerificationAuditMeta(response.result))).not.toContain('recipient-secret')
    expect(notificationVerificationAuditMeta(response.result)).toMatchObject({ recipientUserIdLength: 16 })
  })

  it.each(['token', 'config'] as const)('invalidates prior send evidence on a %s failure, irrespective of the requested send level', async (failedLevel) => {
    const h = harness()
    await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient', verifiedBy: 'admin' })
    if (failedLevel === 'token') mocks.fresh.mockRejectedValueOnce(new DingTalkBusinessError('redacted', { errcode: 40001 }))
    else h.row.status = 'inactive'
    const response = await h.service.verify({ integrationId: ID, level: 'send', recipientUserId: 'recipient', verifiedBy: 'admin' })
    expect(response.result.failure?.level).toBe(failedLevel)
    expect(h.evidence()?.invalidated_at).toBeInstanceOf(Date)
    expect(response.evidence).toMatchObject({ level: 'send', valid: false })
  })

  it('maps a current-read database failure for rollback and retains safe failure audit metadata', async () => {
    const h = harness()
    const answer = h.query.getMockImplementation()!
    let tupleReads = 0
    h.query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT id, name, status') && ++tupleReads === 2) {
        throw Object.assign(new Error('private-driver-text'), { code: '57014' })
      }
      return answer(sql, params)
    })
    await expect(h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })).rejects.toMatchObject({
      status: 503, code: 'NOTIFICATION_BUSY',
      auditMeta: { accessTokenVerified: true, evidenceRecorded: false, evidenceFailureCode: 'NOTIFICATION_BUSY' },
    })
  })

  it('a successful config run leaves prior evidence untouched and creates no evidence on its own', async () => {
    const h = harness()
    const empty = await h.service.verify({ integrationId: ID, level: 'config', verifiedBy: 'admin' })
    expect(empty.evidence).toEqual({ level: null, verifiedUntil: null, valid: false })
    await h.service.verify({ integrationId: ID, level: 'token', verifiedBy: 'admin' })
    const before = { ...h.evidence() }
    await h.service.verify({ integrationId: ID, level: 'config', verifiedBy: 'admin' })
    expect(h.evidence()).toEqual(before)
  })
})
