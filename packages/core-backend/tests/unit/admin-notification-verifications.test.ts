import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Request, Response } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
const mocks = vi.hoisted(() => ({ audit: vi.fn(), verify: vi.fn(), admin: vi.fn() }))
vi.mock('../../src/routes/admin-directory', () => ({ ensurePlatformAdmin: mocks.admin }))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))
vi.mock('../../src/routes/me-notification-wiring', () => ({ productionNotificationDbDeps: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn() }))
import { createAdminNotificationVerificationsRouter } from '../../src/routes/admin-notification-verifications'
import { DingTalkConfigValidationError } from '../../src/integrations/dingtalk/config-validation-error'
import { DINGTALK_WORK_NOTIFICATION_VERIFY_SCOPE, type DingTalkWorkNotificationVerifyResult } from '../../src/integrations/dingtalk/work-notification-verify'
import { NotificationVerificationEvidenceError } from '../../src/notifications/verification-service'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
const ID = 'd1000000-0000-4000-8000-000000000001'
const BASE = '/api/admin/directory/notification-verification'
const pinned = usePinnedServer()
let enabled = true
let delivery = true
const report: DingTalkWorkNotificationVerifyResult = {
  integrationId: ID, integration: null, requestedLevel: 'send', reachedLevel: 'send', passed: true,
  scope: DINGTALK_WORK_NOTIFICATION_VERIFY_SCOPE.send, resolution: null,
  accessToken: { verified: true, cacheBypassed: true, valuePrinted: false },
  notification: { attempted: true, accepted: true, recipientUserIdLength: 16, verificationRunId: 'test-run' }, failure: null,
}
function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/admin/directory', createAdminNotificationVerificationsRouter({
    service: { verify: mocks.verify }, isEnabled: () => enabled, isDeliveryEnabled: () => delivery,
  }))
  return instance
}
async function post(body: unknown, role = 'admin') {
  pinned.setApp(app())
  return request(pinned.url()).post(BASE).set('x-test-role', role).send(body as object)
}
beforeEach(() => {
  enabled = true
  delivery = true
  mocks.audit.mockReset().mockResolvedValue(undefined)
  mocks.verify.mockReset().mockResolvedValue({ result: report, evidence: { level: 'send', verifiedUntil: '2026-12-21T00:00:00.000Z', valid: true } })
  mocks.admin.mockReset().mockImplementation(async (req: Request, res: Response) => {
    const role = req.get('x-test-role')
    if (role === 'admin') return 'admin-1'
    res.status(role === 'anonymous' ? 401 : 403).json({ error: { code: role === 'anonymous' ? 'UNAUTHENTICATED' : 'FORBIDDEN' } })
    return null
  })
})

describe('notification verification management wrapper', () => {
  it.each([['anonymous', 401], ['user', 403]] as const)('checks %s authorization before flags and body', async (role, status) => {
    enabled = false
    expect((await post({ malformed: true }, role)).status).toBe(status)
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('preferences OFF returns 404 without verification or audit', async () => {
    enabled = false
    expect((await post({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret' })).status).toBe(404)
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('delivery OFF blocks send before any verifier call but permits token verification', async () => {
    delivery = false
    const refused = await post({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret' })
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: { code: 'NOTIFICATION_DELIVERY_DISABLED' } })
    expect(mocks.verify).not.toHaveBeenCalled()
    expect((await post({ integrationId: ID, level: 'token' })).status).toBe(200)
  })
  it('permits the management recipient exception and emits only recipient length to audit', async () => {
    const response = await post({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ result: report, evidence: { level: 'send', verifiedUntil: '2026-12-21T00:00:00.000Z', valid: true } })
    expect(mocks.verify).toHaveBeenCalledWith({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret', verifiedBy: 'admin-1' })
    const audit = mocks.audit.mock.calls[0][0]
    expect(audit.action).toBe('notification.verification.record')
    expect(audit.meta).toMatchObject({ recipientUserIdLength: 16 })
    expect(audit.meta).not.toHaveProperty('recipientUserId')
    expect(JSON.stringify([response.body, audit])).not.toContain('recipient-secret')
  })
  it.each([{ integrationId: ID, level: 'send', confirm: true }, { integrationId: ID, level: 'token', webhook: 'private-url' }, []])('refuses unknown keys and non-object bodies without echoing values', async (body) => {
    const response = await post(body)
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST' } })
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('invalid UUID is rejected before verifier', async () => {
    const response = await post({ integrationId: 'not-a-uuid', level: 'token' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('DIRECTORY_INTEGRATION_ID_INVALID')
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it.each(['config', 'TOKEN', ' send', null, {}, 1])('rejects unsupported HTTP verification level %s', async (level) => {
    const response = await post({ integrationId: ID, level })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST' } })
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('rejects non-JSON content before verification', async () => {
    pinned.setApp(app())
    const response = await request(pinned.url()).post(BASE).set('x-test-role', 'admin')
      .set('Content-Type', 'text/plain').send(JSON.stringify({ integrationId: ID, level: 'token' }))
    expect(response.status).toBe(422)
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('forwards only the fixed other-organization refusal', async () => {
    const { NotificationHttpError } = await import('../../src/notifications/notification-errors')
    mocks.verify.mockRejectedValueOnce(new NotificationHttpError(404, 'NOT_FOUND'))
    const response = await post({ integrationId: ID, level: 'token' })
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND' } })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('uses the original verifier shape validation and redacts rejected input', async () => {
    mocks.verify.mockRejectedValueOnce(new DingTalkConfigValidationError('recipient-private-string'))
    const response = await post({ integrationId: ID, level: 'send', recipientUserId: 'bad,recipient' })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST' } })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('returns a fixed unsupported-tuple refusal without recording a provider attempt', async () => {
    mocks.verify.mockRejectedValueOnce(new NotificationHttpError(409, 'VERIFICATION_TUPLE_UNSUPPORTED'))
    const response = await post({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret' })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: { code: 'VERIFICATION_TUPLE_UNSUPPORTED' } })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it.each([
    [new NotificationHttpError(404, 'NOT_FOUND'), 404, 'NOT_FOUND'],
    [Object.assign(new Error('synthetic-private-driver-message'), { code: '55P03' }), 503, 'NOTIFICATION_BUSY'],
    [Object.assign(new Error('synthetic-private-driver-message'), { code: '42P01' }), 503, 'NOTIFICATION_SCHEMA_UNAVAILABLE'],
    [Object.assign(new Error('synthetic-private-driver-message'), { code: 'synthetic-private-code' }), 500, 'VERIFICATION_EVIDENCE_WRITE_FAILED'],
  ] as const)('audits a completed provider send exactly once before returning evidence failure %s', async (failure, status, code) => {
    mocks.verify.mockRejectedValueOnce(new NotificationVerificationEvidenceError(report, failure))
    const response = await post({ integrationId: ID, level: 'send', recipientUserId: 'recipient-secret' })
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: { code } })
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(mocks.audit).toHaveBeenCalledOnce()
    const audit = mocks.audit.mock.calls[0][0]
    expect(audit).toMatchObject({
      actorId: 'admin-1', actorType: 'user', action: 'notification.verification.record',
      resourceType: 'notification-connection-verification', resourceId: ID,
      meta: {
        requestedLevel: 'send', reachedLevel: 'send', notificationAttempted: true, notificationAccepted: true,
        recipientUserIdLength: 16, evidenceRecorded: false, evidenceFailureCode: code,
      },
    })
    for (const privateValue of ['recipient-secret', 'synthetic-private', 'sourceScope', 'tupleFingerprint']) {
      expect(JSON.stringify([response.body, audit])).not.toContain(privateValue)
    }
  })
  it.each([
    [503, 'NOTIFICATION_BUSY', 503, 'NOTIFICATION_BUSY'],
    [503, 'NOTIFICATION_SCHEMA_UNAVAILABLE', 503, 'NOTIFICATION_SCHEMA_UNAVAILABLE'],
    [503, 'synthetic-private-code', 500, 'INTERNAL'],
    [404, 'synthetic-private-code', 500, 'INTERNAL'],
    [500, 'NOT_FOUND', 500, 'INTERNAL'],
    [500, 'NOTIFICATION_BUSY', 500, 'INTERNAL'],
    [500, 'VERIFICATION_TUPLE_UNSUPPORTED', 500, 'INTERNAL'],
  ] as const)('bounds typed error %s/%s to fixed response %s/%s', async (status, code, expectedStatus, expectedCode) => {
    const { NotificationHttpError } = await import('../../src/notifications/notification-errors')
    mocks.verify.mockRejectedValueOnce(new NotificationHttpError(status, code, { detail: 'synthetic-private-detail' }))
    const response = await post({ integrationId: ID, level: 'token' })
    expect(response.status).toBe(expectedStatus)
    expect(response.body).toEqual({ error: { code: expectedCode } })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it.each([['55P03', 503, 'NOTIFICATION_BUSY'], ['42P01', 503, 'NOTIFICATION_SCHEMA_UNAVAILABLE'], ['unknown', 500, 'INTERNAL']] as const)('redacts %s driver/provider failures', async (code, status, expected) => {
    mocks.verify.mockRejectedValueOnce(Object.assign(new Error('password=synthetic-private-driver-value'), { code }))
    const response = await post({ integrationId: ID, level: 'token' })
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: { code: expected } })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
