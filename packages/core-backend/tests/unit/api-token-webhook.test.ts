/**
 * API Token & Webhook V1 — Unit Tests
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { WebhookService } from '../../src/multitable/webhook-service'
import type { ApiTokenScope } from '../../src/multitable/api-tokens'
import type { WebhookEventType } from '../../src/multitable/webhooks'

// ═══════════════════════════════════════════════════════════════════════
//  API Token Service
// ═══════════════════════════════════════════════════════════════════════

describe('ApiTokenService', () => {
  let svc: ApiTokenService

  beforeEach(() => {
    svc = new ApiTokenService()
  })

  // ── Creation ──────────────────────────────────────────────────────

  test('createToken returns a plaintext token starting with mst_', () => {
    const result = svc.createToken('user1', {
      name: 'Test Token',
      scopes: ['records:read'],
    })
    expect(result.plainTextToken).toMatch(/^mst_[0-9a-f]{32}$/)
  })

  test('createToken returns the plaintext only once (not stored)', () => {
    const result = svc.createToken('user1', {
      name: 'Once',
      scopes: ['records:read'],
    })
    const listed = svc.listTokens('user1')
    // Listed tokens must NOT contain the hash
    for (const t of listed) {
      expect((t as Record<string, unknown>).tokenHash).toBeUndefined()
    }
    // But the creation result has the hash inside the token object (internal)
    expect(result.token.tokenHash).toBeDefined()
  })

  test('createToken stores SHA-256 hash of the token', () => {
    const result = svc.createToken('user1', {
      name: 'Hash check',
      scopes: ['records:read'],
    })
    const expectedHash = createHash('sha256')
      .update(result.plainTextToken)
      .digest('hex')
    expect(result.token.tokenHash).toBe(expectedHash)
  })

  test('createToken stores the first 8 chars as tokenPrefix', () => {
    const result = svc.createToken('user1', {
      name: 'Prefix',
      scopes: ['records:read'],
    })
    expect(result.token.tokenPrefix).toBe(result.plainTextToken.slice(0, 8))
  })

  test('createToken rejects empty name', () => {
    expect(() =>
      svc.createToken('user1', { name: '', scopes: ['records:read'] }),
    ).toThrow('Token name is required')
  })

  test('createToken rejects empty scopes', () => {
    expect(() =>
      svc.createToken('user1', { name: 'No scopes', scopes: [] }),
    ).toThrow('At least one scope is required')
  })

  // ── Validation ────────────────────────────────────────────────────

  test('validateToken succeeds for a valid token', () => {
    const { plainTextToken } = svc.createToken('user1', {
      name: 'Valid',
      scopes: ['records:read'],
    })
    const result = svc.validateToken(plainTextToken)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.token.scopes).toContain('records:read')
    }
  })

  test('validateToken fails for unknown token', () => {
    const result = svc.validateToken('mst_0000000000000000000000000000dead')
    expect(result.valid).toBe(false)
  })

  test('validateToken fails for non-mst_ prefix', () => {
    const result = svc.validateToken('bearer_abc123')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/format/)
    }
  })

  test('validateToken updates lastUsedAt on success', () => {
    const { plainTextToken, token } = svc.createToken('user1', {
      name: 'Used',
      scopes: ['records:read'],
    })
    expect(token.lastUsedAt).toBeUndefined()
    svc.validateToken(plainTextToken)
    const stored = svc.getTokenById(token.id)
    expect(stored?.lastUsedAt).toBeDefined()
  })

  // ── Revocation ────────────────────────────────────────────────────

  test('revoked token fails validation', () => {
    const { plainTextToken, token } = svc.createToken('user1', {
      name: 'Revoke me',
      scopes: ['records:read'],
    })
    svc.revokeToken(token.id, 'user1')
    const result = svc.validateToken(plainTextToken)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/revoked/)
    }
  })

  test('revokeToken sets revokedAt timestamp', () => {
    const { token } = svc.createToken('user1', {
      name: 'Ts',
      scopes: ['records:read'],
    })
    svc.revokeToken(token.id, 'user1')
    const stored = svc.getTokenById(token.id)
    expect(stored?.revoked).toBe(true)
    expect(stored?.revokedAt).toBeDefined()
  })

  test('revokeToken throws if user is not the owner', () => {
    const { token } = svc.createToken('user1', {
      name: 'Protected',
      scopes: ['records:read'],
    })
    expect(() => svc.revokeToken(token.id, 'user2')).toThrow('Not authorized')
  })

  test('revokeToken is idempotent', () => {
    const { token } = svc.createToken('user1', {
      name: 'Idem',
      scopes: ['records:read'],
    })
    svc.revokeToken(token.id, 'user1')
    expect(() => svc.revokeToken(token.id, 'user1')).not.toThrow()
  })

  // ── Expiry ────────────────────────────────────────────────────────

  test('expired token fails validation', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const { plainTextToken } = svc.createToken('user1', {
      name: 'Expired',
      scopes: ['records:read'],
      expiresAt: past,
    })
    const result = svc.validateToken(plainTextToken)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/expired/)
    }
  })

  test('non-expired token passes validation', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const { plainTextToken } = svc.createToken('user1', {
      name: 'Future',
      scopes: ['records:read'],
      expiresAt: future,
    })
    const result = svc.validateToken(plainTextToken)
    expect(result.valid).toBe(true)
  })

  // ── Scope checking ────────────────────────────────────────────────

  test('hasScope returns true when scope is present', () => {
    const { token } = svc.createToken('user1', {
      name: 'Scoped',
      scopes: ['records:read', 'records:write'],
    })
    expect(ApiTokenService.hasScope(token, 'records:read')).toBe(true)
    expect(ApiTokenService.hasScope(token, 'records:write')).toBe(true)
  })

  test('hasScope returns false when scope is missing', () => {
    const { token } = svc.createToken('user1', {
      name: 'Limited',
      scopes: ['records:read'],
    })
    expect(ApiTokenService.hasScope(token, 'webhooks:manage')).toBe(false)
  })

  // ── Rotation ──────────────────────────────────────────────────────

  test('rotateToken revokes old and creates new with same scopes', () => {
    const { plainTextToken: old, token: oldToken } = svc.createToken('user1', {
      name: 'Rotate me',
      scopes: ['records:read', 'comments:read'],
    })
    const { plainTextToken: newPt, token: newToken } = svc.rotateToken(
      oldToken.id,
      'user1',
    )

    // Old token revoked
    expect(svc.validateToken(old).valid).toBe(false)
    // New token valid
    expect(svc.validateToken(newPt).valid).toBe(true)
    // Same scopes
    expect(newToken.scopes).toEqual(
      expect.arrayContaining(['records:read', 'comments:read']),
    )
    // Different IDs
    expect(newToken.id).not.toBe(oldToken.id)
  })

  // ── Listing ───────────────────────────────────────────────────────

  test('listTokens returns only tokens for the given user', () => {
    svc.createToken('user1', { name: 'A', scopes: ['records:read'] })
    svc.createToken('user2', { name: 'B', scopes: ['records:read'] })
    svc.createToken('user1', { name: 'C', scopes: ['records:write'] })

    const list = svc.listTokens('user1')
    expect(list).toHaveLength(2)
    expect(list.every((t) => (t as Record<string, unknown>).createdBy === 'user1')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Webhook Service
// ═══════════════════════════════════════════════════════════════════════

describe('WebhookService', () => {
  let svc: WebhookService

  // Default mock fetch that returns 200
  const okFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'ok',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    svc = new WebhookService(okFetch as unknown as typeof fetch)
  })

  // ── CRUD ──────────────────────────────────────────────────────────

  test('createWebhook validates URL', () => {
    expect(() =>
      svc.createWebhook('u1', {
        name: 'Bad',
        url: 'not-a-url',
        events: ['record.created'],
      }),
    ).toThrow('not a valid URL')
  })

  test('createWebhook rejects empty name', () => {
    expect(() =>
      svc.createWebhook('u1', {
        name: '',
        url: 'https://example.com/hook',
        events: ['record.created'],
      }),
    ).toThrow('name is required')
  })

  test('createWebhook rejects empty events', () => {
    expect(() =>
      svc.createWebhook('u1', {
        name: 'No events',
        url: 'https://example.com/hook',
        events: [],
      }),
    ).toThrow('At least one event')
  })

  test('createWebhook rejects unknown event type', () => {
    expect(() =>
      svc.createWebhook('u1', {
        name: 'Bad event',
        url: 'https://example.com/hook',
        events: ['unknown.event' as WebhookEventType],
      }),
    ).toThrow('Unknown event type')
  })

  test('createWebhook stores webhook and listWebhooks returns it', () => {
    const wh = svc.createWebhook('u1', {
      name: 'My Hook',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    expect(wh.id).toBeDefined()
    expect(wh.active).toBe(true)
    expect(wh.failureCount).toBe(0)

    const list = svc.listWebhooks('u1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(wh.id)
  })

  test('deleteWebhook removes webhook', () => {
    const wh = svc.createWebhook('u1', {
      name: 'Del',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    svc.deleteWebhook(wh.id, 'u1')
    expect(svc.listWebhooks('u1')).toHaveLength(0)
  })

  test('deleteWebhook throws for wrong user', () => {
    const wh = svc.createWebhook('u1', {
      name: 'Owned',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    expect(() => svc.deleteWebhook(wh.id, 'u2')).toThrow('Not authorized')
  })

  test('updateWebhook modifies fields', () => {
    const wh = svc.createWebhook('u1', {
      name: 'Update me',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    const updated = svc.updateWebhook(wh.id, 'u1', {
      name: 'Updated',
      active: false,
    })
    expect(updated.name).toBe('Updated')
    expect(updated.active).toBe(false)
    expect(updated.updatedAt).toBeDefined()
  })

  // ── HMAC Signature ────────────────────────────────────────────────

  test('signPayload produces correct HMAC-SHA256', () => {
    const body = '{"hello":"world"}'
    const secret = 'test-secret'
    const expected = createHmac('sha256', secret).update(body).digest('hex')
    expect(WebhookService.signPayload(body, secret)).toBe(expected)
  })

  test('delivery includes signature header when secret is set', async () => {
    const wh = svc.createWebhook('u1', {
      name: 'Signed',
      url: 'https://example.com/hook',
      secret: 'my-secret',
      events: ['record.created'],
    })

    await svc.deliverEvent('record.created', { test: true })

    expect(okFetch).toHaveBeenCalledTimes(1)
    const callArgs = okFetch.mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    expect(headers['X-Webhook-Signature']).toBeDefined()
    expect(headers['X-Webhook-Id']).toBe(wh.id)
    expect(headers['X-Webhook-Event']).toBe('record.created')
    expect(headers['X-Webhook-Timestamp']).toBeDefined()
  })

  test('delivery does not include signature when no secret', async () => {
    svc.createWebhook('u1', {
      name: 'Unsigned',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    await svc.deliverEvent('record.created', { test: true })

    // Wait for fire-and-forget delivery
    await new Promise((r) => setTimeout(r, 50))

    const callArgs = okFetch.mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    expect(headers['X-Webhook-Signature']).toBeUndefined()
  })

  // ── Delivery logic ────────────────────────────────────────────────

  test('deliverEvent only triggers webhooks subscribed to the event', async () => {
    svc.createWebhook('u1', {
      name: 'Records only',
      url: 'https://example.com/a',
      events: ['record.created'],
    })
    svc.createWebhook('u1', {
      name: 'Comments only',
      url: 'https://example.com/b',
      events: ['comment.created'],
    })

    await svc.deliverEvent('record.created', {})
    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50))

    expect(okFetch).toHaveBeenCalledTimes(1)
    expect(okFetch.mock.calls[0][0]).toBe('https://example.com/a')
  })

  test('inactive webhook is not triggered', async () => {
    const wh = svc.createWebhook('u1', {
      name: 'Inactive',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    svc.updateWebhook(wh.id, 'u1', { active: false })

    await svc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    expect(okFetch).not.toHaveBeenCalled()
  })

  // ── Failure tracking ──────────────────────────────────────────────

  test('failed delivery increments failure count', async () => {
    const failFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })
    const failSvc = new WebhookService(failFetch as unknown as typeof fetch)

    const wh = failSvc.createWebhook('u1', {
      name: 'Fail',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    await failSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    const stored = failSvc.getWebhookById(wh.id)
    expect(stored?.failureCount).toBeGreaterThan(0)
  })

  test('webhook is auto-disabled after 10 consecutive failures', async () => {
    const failFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'error',
    })
    const failSvc = new WebhookService(failFetch as unknown as typeof fetch)

    const wh = failSvc.createWebhook('u1', {
      name: 'Will disable',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    // Simulate 10 consecutive failures
    for (let i = 0; i < 10; i++) {
      await failSvc.deliverEvent('record.created', { attempt: i })
      await new Promise((r) => setTimeout(r, 20))
    }

    const stored = failSvc.getWebhookById(wh.id)
    expect(stored?.active).toBe(false)
    expect(stored?.failureCount).toBeGreaterThanOrEqual(10)
  })

  test('successful delivery resets failure count', async () => {
    // First fail, then succeed
    let callCount = 0
    const mixFetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount <= 1) {
        return { ok: false, status: 500, text: async () => 'err' }
      }
      return { ok: true, status: 200, text: async () => 'ok' }
    })
    const mixSvc = new WebhookService(mixFetch as unknown as typeof fetch)

    const wh = mixSvc.createWebhook('u1', {
      name: 'Mix',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    // First delivery fails
    await mixSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))
    expect(mixSvc.getWebhookById(wh.id)?.failureCount).toBeGreaterThan(0)

    // Second delivery succeeds
    await mixSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))
    expect(mixSvc.getWebhookById(wh.id)?.failureCount).toBe(0)
  })

  // ── Delivery list ─────────────────────────────────────────────────

  test('listDeliveries returns deliveries for the given webhook', async () => {
    const wh = svc.createWebhook('u1', {
      name: 'Deliveries',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    await svc.deliverEvent('record.created', { a: 1 })
    await svc.deliverEvent('record.created', { a: 2 })
    await new Promise((r) => setTimeout(r, 50))

    const deliveries = svc.listDeliveries(wh.id)
    expect(deliveries.length).toBe(2)
  })

  // ── Retry logic ───────────────────────────────────────────────────

  test('retryFailedDeliveries retries pending deliveries past nextRetryAt', async () => {
    const failOnceFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad' })
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })

    const retrySvc = new WebhookService(failOnceFetch as unknown as typeof fetch)
    retrySvc.createWebhook('u1', {
      name: 'Retry',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })

    const deliveries = await retrySvc.deliverEvent('record.created', { x: 1 })
    // Wait for first (failing) delivery
    await new Promise((r) => setTimeout(r, 100))

    // The delivery should be pending with a nextRetryAt
    expect(deliveries[0].status).toBe('pending')

    // Force nextRetryAt to be in the past for test
    deliveries[0].nextRetryAt = new Date(Date.now() - 1000).toISOString()

    const retried = await retrySvc.retryFailedDeliveries()
    expect(retried).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  HMAC Signature (standalone)
// ═══════════════════════════════════════════════════════════════════════

describe('WebhookService.signPayload', () => {
  test('returns hex-encoded HMAC-SHA256', () => {
    const sig = WebhookService.signPayload('test-body', 'secret')
    // Must be 64-char hex string (256 bits)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  test('different secrets produce different signatures', () => {
    const a = WebhookService.signPayload('same-body', 'secret-a')
    const b = WebhookService.signPayload('same-body', 'secret-b')
    expect(a).not.toBe(b)
  })

  test('different bodies produce different signatures', () => {
    const a = WebhookService.signPayload('body-a', 'same-secret')
    const b = WebhookService.signPayload('body-b', 'same-secret')
    expect(a).not.toBe(b)
  })
})
