import { describe, expect, it, vi } from 'vitest'
import {
  checkNotificationVerification,
  NOTIFICATION_VERIFICATION_MAX_AGE_MS,
  writeNotificationVerification,
  type WriteNotificationVerificationInput,
} from '../../src/notifications/verification-evidence'

const NOW = new Date('2026-11-21T04:00:00.000Z')
const FINGERPRINT = 'a'.repeat(64)
const identity = {
  connectionId: '00000000-0000-4000-8000-000000000101',
  provider: 'dingtalk',
  scope: { tenant: 'fixture-tenant', appScope: 'fixture-app' },
  tupleFingerprint: FINGERPRINT,
  now: NOW,
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'dingtalk', reached_level: 'token', tuple_fingerprint: FINGERPRINT,
    bound_tenant: identity.scope.tenant, bound_app_scope: identity.scope.appScope,
    verified_at: new Date(NOW.getTime() - 1000), invalidated_at: null,
    ...overrides,
  }
}

function dbWith(row?: Record<string, unknown>) {
  return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: row ? [row] : [] })) }
}

describe('notification verification evidence checks', () => {
  it.each(['token', 'send'])('accepts current %s evidence with matching scope and credentials', async (level) => {
    const db = dbWith(evidence({ reached_level: level }))
    expect(await checkNotificationVerification(db, identity)).toEqual({
      ok: true,
      verification: { level, verifiedUntil: '2026-12-21T03:59:59.000Z', valid: true },
    })
    expect(db.query).toHaveBeenCalledOnce()
    const [sql, params] = db.query.mock.calls[0]
    expect(sql).not.toMatch(/FOR\s+(?:UPDATE|SHARE)|LOCK\s+TABLE/i)
    expect(sql.trim()).toMatch(/^SELECT /)
    expect(params).toEqual([identity.connectionId])
  })

  it.each([
    ['missing', undefined, 'verification_missing'],
    ['unproved level', evidence({ reached_level: 'config' }), 'verification_missing'],
    ['invalidated', evidence({ invalidated_at: NOW }), 'verification_invalidated'],
    ['provider changed', evidence({ provider: 'other' }), 'verification_anchor_changed'],
    ['tenant changed', evidence({ bound_tenant: 'another-tenant' }), 'verification_anchor_changed'],
    ['application changed', evidence({ bound_app_scope: 'another-app' }), 'verification_anchor_changed'],
    ['credentials changed', evidence({ tuple_fingerprint: 'b'.repeat(64) }), 'verification_fingerprint_changed'],
    ['expired', evidence({ verified_at: new Date(NOW.getTime() - NOTIFICATION_VERIFICATION_MAX_AGE_MS - 1) }), 'verification_stale'],
    ['exact expiry', evidence({ verified_at: new Date(NOW.getTime() - NOTIFICATION_VERIFICATION_MAX_AGE_MS) }), 'verification_stale'],
    ['future date', evidence({ verified_at: new Date(NOW.getTime() + 1) }), 'verification_stale'],
  ] as const)('rejects %s evidence with the fixed reason', async (_label, row, code) => {
    const answer = await checkNotificationVerification(dbWith(row), identity)
    expect(answer).toMatchObject({ ok: false, code, verification: { valid: false } })
    expect(Object.keys(answer.verification).sort()).toEqual(['level', 'valid', 'verifiedUntil'])
    expect(JSON.stringify(answer)).not.toContain(FINGERPRINT)
    expect(JSON.stringify(answer)).not.toContain(identity.scope.tenant)
  })

  it('accepts evidence one millisecond before expiry', async () => {
    const row = evidence({ verified_at: new Date(NOW.getTime() - NOTIFICATION_VERIFICATION_MAX_AGE_MS + 1) })
    expect(await checkNotificationVerification(dbWith(row), identity)).toMatchObject({ ok: true })
  })

  it('rejects a scope that can no longer be derived', async () => {
    expect(await checkNotificationVerification(dbWith(evidence()), { ...identity, scope: null }))
      .toMatchObject({ ok: false, code: 'verification_anchor_changed' })
  })

  it('rejects a credential tuple that can no longer be resolved', async () => {
    expect(await checkNotificationVerification(dbWith(evidence()), { ...identity, tupleFingerprint: null }))
      .toMatchObject({ ok: false, code: 'verification_fingerprint_changed' })
  })
})

describe('notification verification evidence writes', () => {
  function input(report: WriteNotificationVerificationInput['report']): WriteNotificationVerificationInput {
    return { ...identity, verifiedBy: 'fixture-admin', report }
  }

  it.each(['token', 'send'] as const)('upserts a reached %s level, replacing old evidence and clearing invalidation', async (reachedLevel) => {
    const db = dbWith()
    await writeNotificationVerification(db, input({ reachedLevel, requestedLevel: reachedLevel, failure: null }))
    expect(db.query).toHaveBeenCalledOnce()
    const [sql, params] = db.query.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (connection_id) DO UPDATE SET')
    expect(sql).toContain('reached_level = EXCLUDED.reached_level')
    expect(sql).toContain('invalidated_at = NULL')
    expect(sql).toContain('revision = notification_connection_verifications.revision + 1')
    expect(params).toEqual([
      identity.connectionId, identity.provider, reachedLevel, FINGERPRINT,
      identity.scope.tenant, identity.scope.appScope, 'fixture-admin', NOW,
    ])
  })

  it('replaces prior send evidence with token when the current send step fails', async () => {
    const db = dbWith()
    await writeNotificationVerification(db, input({
      reachedLevel: 'token', requestedLevel: 'send',
      failure: { level: 'send', code: 'send_rejected', message: 'fixture failure' },
    }))
    expect(db.query).toHaveBeenCalledOnce()
    expect(db.query.mock.calls[0][0]).toMatch(/^INSERT/)
    expect(db.query.mock.calls[0][1]?.[2]).toBe('token')
  })

  it.each([
    ['config', 'none', 1],
    ['token', 'config', 2],
    ['send', 'config', 3],
  ] as const)('invalidates at the %s failure level even when send was requested', async (level, reachedLevel, rank) => {
    const db = dbWith()
    await writeNotificationVerification(db, { ...input({
      reachedLevel, requestedLevel: 'send', failure: { level, code: 'send_rejected', message: 'fixture failure' },
    }), scope: null, tupleFingerprint: null })
    const [sql, params] = db.query.mock.calls[0]
    expect(sql).toMatch(/^UPDATE/)
    expect(sql).toContain("CASE reached_level WHEN 'token' THEN 2 WHEN 'send' THEN 3 ELSE 0 END >= $4")
    expect(params).toEqual([identity.connectionId, identity.provider, NOW, rank])
  })

  it.each(['none', 'config'] as const)('does not change existing evidence for a failure-free %s report', async (reachedLevel) => {
    const db = dbWith()
    await writeNotificationVerification(db, input({ reachedLevel, requestedLevel: 'config', failure: null }))
    expect(db.query).not.toHaveBeenCalled()
  })

  it.each([
    { scope: null }, { tupleFingerprint: null }, { tupleFingerprint: 'invalid' },
  ])('refuses to record passing evidence without complete binding %j', async (missing) => {
    const db = dbWith()
    await expect(writeNotificationVerification(db, {
      ...input({ reachedLevel: 'token', requestedLevel: 'token', failure: null }), ...missing,
    })).rejects.toMatchObject({ status: 409, code: 'VERIFICATION_TUPLE_UNSUPPORTED' })
    expect(db.query).not.toHaveBeenCalled()
  })
})
