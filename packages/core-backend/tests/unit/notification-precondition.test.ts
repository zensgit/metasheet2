import { describe, expect, it, vi } from 'vitest'
import type { EnablePreconditionContext } from '../../src/integrations/provider-capability-registry'
import { createNotificationEnablePreconditions } from '../../src/notifications/notification-precondition'
import { NOTIFICATION_VERIFICATION_MAX_AGE_MS } from '../../src/notifications/verification-evidence'

const FINGERPRINT = 'c'.repeat(64)

function harness(overrides: Record<string, unknown> = {}, missing = false) {
  const row = {
    provider: 'dingtalk', reached_level: 'token', tuple_fingerprint: FINGERPRINT,
    bound_tenant: 'fixture-tenant', bound_app_scope: 'fixture-app',
    verified_at: new Date(Date.now() - 1000), invalidated_at: null,
    ...overrides,
  }
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: missing ? [] : [row], rowCount: missing ? 0 : 1 }))
  const context: EnablePreconditionContext = {
    integrationId: '00000000-0000-4000-8000-000000000102', provider: 'dingtalk', orgId: 'fixture-org',
    scope: { tenant: 'fixture-tenant', appScope: 'fixture-app' }, client: { query },
  }
  const readFingerprint = vi.fn(async (_id: string, _client: EnablePreconditionContext['client']) => ({ ok: true as const, value: FINGERPRINT }))
  return { context, query, readFingerprint, precondition: createNotificationEnablePreconditions(readFingerprint) }
}

describe('notification capability precondition', () => {
  it('uses the published callback context and the write client for ordinary reads only', async () => {
    const h = harness()
    expect(await h.precondition('notification', h.context)).toEqual({ ok: true })
    expect(h.readFingerprint).toHaveBeenCalledOnce()
    expect(h.readFingerprint).toHaveBeenCalledWith(h.context.integrationId, h.context.client)
    expect(h.query).toHaveBeenCalledOnce()
    for (const [sql] of h.query.mock.calls) {
      expect(sql.trim()).toMatch(/^SELECT /)
      expect(sql).not.toMatch(/FOR\s+(?:UPDATE|SHARE)|LOCK\s+TABLE|BEGIN/i)
    }
  })

  it.each(['directory', 'login'] as const)('fails closed for unregistered capability %s without a read', async (capability) => {
    const h = harness()
    expect(await h.precondition(capability, h.context)).toEqual({ ok: false, code: 'precondition_not_registered' })
    expect(h.readFingerprint).not.toHaveBeenCalled()
    expect(h.query).not.toHaveBeenCalled()
  })

  it('fails closed for another provider', async () => {
    const h = harness()
    expect(await h.precondition('notification', { ...h.context, provider: 'local' }))
      .toEqual({ ok: false, code: 'precondition_not_registered' })
    expect(h.readFingerprint).not.toHaveBeenCalled()
    expect(h.query).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', {}, true, 'verification_missing'],
    ['stale', { verified_at: new Date(Date.now() - NOTIFICATION_VERIFICATION_MAX_AGE_MS - 1000) }, false, 'verification_stale'],
    ['invalidated', { invalidated_at: new Date() }, false, 'verification_invalidated'],
    ['anchor changed', { bound_app_scope: 'changed' }, false, 'verification_anchor_changed'],
    ['fingerprint changed', { tuple_fingerprint: 'd'.repeat(64) }, false, 'verification_fingerprint_changed'],
  ] as const)('returns a fixed code for %s evidence', async (_label, row, missing, code) => {
    const h = harness(row, missing)
    expect(await h.precondition('notification', h.context)).toEqual({ ok: false, code })
  })

  it('fails closed if the current tuple cannot be resolved', async () => {
    const h = harness()
    const callback = createNotificationEnablePreconditions(async () => ({ ok: false, code: 'configuration_unavailable' }))
    expect(await callback('notification', h.context)).toEqual({ ok: false, code: 'verification_fingerprint_changed' })
  })

  it('leaves database error classification to the capability write service', async () => {
    const h = harness()
    const error = Object.assign(new Error('fixture query failed'), { code: '57014' })
    h.query.mockRejectedValueOnce(error)
    await expect(h.precondition('notification', h.context)).rejects.toBe(error)
  })
})
