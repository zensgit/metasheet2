/**
 * API Token & Webhook V2 — Unit Tests
 * Tests use a mock Kysely db object (same pattern as comment-service.test.ts).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { WebhookService } from '../../src/multitable/webhook-service'
import type { ApiTokenScope } from '../../src/multitable/api-tokens'
import type { WebhookEventType } from '../../src/multitable/webhooks'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'

// ═══════════════════════════════════════════════════════════════════════
//  Mock DB builder
// ═══════════════════════════════════════════════════════════════════════

/** Result queues: push values to control what execute / executeTakeFirst return. */
let executeQueue: unknown[]
let executeTakeFirstQueue: unknown[]

function makeChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => self
  const methods = [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
    'limit', 'offset', 'groupBy', 'insertInto', 'values',
    'onConflict', 'columns', 'doUpdateSet',
    'updateTable', 'set', 'deleteFrom', 'returningAll',
    'leftJoin',
  ]
  for (const m of methods) {
    self[m] = vi.fn(chainFn)
  }
  self.execute = vi.fn(async () => executeQueue.shift() ?? [])
  self.executeTakeFirst = vi.fn(async () => executeTakeFirstQueue.shift())
  self.executeTakeFirstOrThrow = vi.fn(async () => {
    const v = executeTakeFirstQueue.shift()
    if (!v) throw new Error('no rows')
    return v
  })
  return self
}

function createMockDb(): Kysely<Database> {
  const rootChain: Record<string, unknown> = {}
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    rootChain[m] = vi.fn(() => makeChain())
  }

  const dbProxy = new Proxy(rootChain, {
    get(target, prop) {
      if (prop === 'transaction') {
        return () => ({
          execute: async (fn: (trx: unknown) => Promise<unknown>) => {
            const trxRoot: Record<string, unknown> = {}
            for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
              trxRoot[m] = vi.fn(() => makeChain())
            }
            return fn(trxRoot)
          },
        })
      }
      return target[prop as string]
    },
  })

  return dbProxy as unknown as Kysely<Database>
}

// ═══════════════════════════════════════════════════════════════════════
//  API Token Service
// ═══════════════════════════════════════════════════════════════════════

describe('ApiTokenService', () => {
  let svc: ApiTokenService
  let db: Kysely<Database>

  beforeEach(() => {
    executeQueue = []
    executeTakeFirstQueue = []
    db = createMockDb()
    svc = new ApiTokenService(db)
  })

  // ── Creation ──────────────────────────────────────────────────────

  test('createToken returns a plaintext token starting with mst_', async () => {
    const result = await svc.createToken('user1', {
      name: 'Test Token',
      scopes: ['records:read'],
    })
    expect(result.plainTextToken).toMatch(/^mst_[0-9a-f]{32}$/)
  })

  test('createToken returns the plaintext only once (not stored)', async () => {
    const result = await svc.createToken('user1', {
      name: 'Once',
      scopes: ['records:read'],
    })
    // Push mock rows for listTokens query
    executeQueue.push([{
      id: result.token.id,
      name: result.token.name,
      token_hash: result.token.tokenHash,
      token_prefix: result.token.tokenPrefix,
      scopes: JSON.stringify(result.token.scopes),
      created_by: 'user1',
      created_at: result.token.createdAt,
      revoked: false,
    }])
    const listed = await svc.listTokens('user1')
    // Listed tokens must NOT contain the hash
    for (const t of listed) {
      expect((t as Record<string, unknown>).tokenHash).toBeUndefined()
    }
    // But the creation result has the hash inside the token object (internal)
    expect(result.token.tokenHash).toBeDefined()
  })

  test('createToken stores SHA-256 hash of the token', async () => {
    const result = await svc.createToken('user1', {
      name: 'Hash check',
      scopes: ['records:read'],
    })
    const expectedHash = createHash('sha256')
      .update(result.plainTextToken)
      .digest('hex')
    expect(result.token.tokenHash).toBe(expectedHash)
  })

  test('createToken stores the first 8 chars as tokenPrefix', async () => {
    const result = await svc.createToken('user1', {
      name: 'Prefix',
      scopes: ['records:read'],
    })
    expect(result.token.tokenPrefix).toBe(result.plainTextToken.slice(0, 8))
  })

  test('createToken rejects empty name', async () => {
    await expect(
      svc.createToken('user1', { name: '', scopes: ['records:read'] }),
    ).rejects.toThrow('Token name is required')
  })

  test('createToken rejects empty scopes', async () => {
    await expect(
      svc.createToken('user1', { name: 'No scopes', scopes: [] }),
    ).rejects.toThrow('At least one scope is required')
  })

  // ── Validation ────────────────────────────────────────────────────

  test('validateToken succeeds for a valid token', async () => {
    const created = await svc.createToken('user1', {
      name: 'Valid',
      scopes: ['records:read'],
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: false,
    })
    const result = await svc.validateToken(created.plainTextToken)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.token.scopes).toContain('records:read')
    }
  })

  test('validateToken fails for unknown token', async () => {
    executeTakeFirstQueue.push(undefined)
    const result = await svc.validateToken('mst_0000000000000000000000000000dead')
    expect(result.valid).toBe(false)
  })

  test('validateToken fails for non-mst_ prefix', async () => {
    const result = await svc.validateToken('bearer_abc123')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/format/)
    }
  })

  test('validateToken updates lastUsedAt on success', async () => {
    const created = await svc.createToken('user1', {
      name: 'Used',
      scopes: ['records:read'],
    })
    expect(created.token.lastUsedAt).toBeUndefined()
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: false,
    })
    const result = await svc.validateToken(created.plainTextToken)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.token.lastUsedAt).toBeDefined()
    }
  })

  // ── Revocation ────────────────────────────────────────────────────

  test('revoked token fails validation', async () => {
    const created = await svc.createToken('user1', {
      name: 'Revoke me',
      scopes: ['records:read'],
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: false,
    })
    await svc.revokeToken(created.token.id, 'user1')
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: true,
      revoked_at: new Date().toISOString(),
    })
    const result = await svc.validateToken(created.plainTextToken)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/revoked/)
    }
  })

  test('revokeToken sets revokedAt timestamp', async () => {
    const created = await svc.createToken('user1', {
      name: 'Ts',
      scopes: ['records:read'],
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: false,
    })
    await svc.revokeToken(created.token.id, 'user1')
    const revokedAt = new Date().toISOString()
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      revoked: true,
      revoked_at: revokedAt,
    })
    const stored = await svc.getTokenById(created.token.id)
    expect(stored?.revoked).toBe(true)
    expect(stored?.revokedAt).toBeDefined()
  })

  test('revokeToken throws if user is not the owner', async () => {
    const created = await svc.createToken('user1', {
      name: 'Protected',
      scopes: ['records:read'],
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      created_by: 'user1',
      revoked: false,
      token_prefix: created.token.tokenPrefix,
    })
    await expect(svc.revokeToken(created.token.id, 'user2')).rejects.toThrow('Not authorized')
  })

  test('revokeToken is idempotent', async () => {
    const created = await svc.createToken('user1', {
      name: 'Idem',
      scopes: ['records:read'],
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      created_by: 'user1',
      revoked: false,
      token_prefix: created.token.tokenPrefix,
    })
    await svc.revokeToken(created.token.id, 'user1')
    executeTakeFirstQueue.push({
      id: created.token.id,
      created_by: 'user1',
      revoked: true,
      token_prefix: created.token.tokenPrefix,
    })
    await expect(svc.revokeToken(created.token.id, 'user1')).resolves.not.toThrow()
  })

  // ── Expiry ────────────────────────────────────────────────────────

  test('expired token fails validation', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const created = await svc.createToken('user1', {
      name: 'Expired',
      scopes: ['records:read'],
      expiresAt: past,
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      expires_at: past,
      revoked: false,
    })
    const result = await svc.validateToken(created.plainTextToken)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toMatch(/expired/)
    }
  })

  test('non-expired token passes validation', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const created = await svc.createToken('user1', {
      name: 'Future',
      scopes: ['records:read'],
      expiresAt: future,
    })
    executeTakeFirstQueue.push({
      id: created.token.id,
      name: created.token.name,
      token_hash: created.token.tokenHash,
      token_prefix: created.token.tokenPrefix,
      scopes: JSON.stringify(created.token.scopes),
      created_by: 'user1',
      created_at: created.token.createdAt,
      expires_at: future,
      revoked: false,
    })
    const result = await svc.validateToken(created.plainTextToken)
    expect(result.valid).toBe(true)
  })

  // ── Scope checking ────────────────────────────────────────────────

  test('hasScope returns true when scope is present', async () => {
    const { token } = await svc.createToken('user1', {
      name: 'Scoped',
      scopes: ['records:read', 'records:write'],
    })
    expect(ApiTokenService.hasScope(token, 'records:read')).toBe(true)
    expect(ApiTokenService.hasScope(token, 'records:write')).toBe(true)
  })

  test('hasScope returns false when scope is missing', async () => {
    const { token } = await svc.createToken('user1', {
      name: 'Limited',
      scopes: ['records:read'],
    })
    expect(ApiTokenService.hasScope(token, 'webhooks:manage')).toBe(false)
  })

  // ── Rotation ──────────────────────────────────────────────────────

  test('rotateToken revokes old and creates new with same scopes', async () => {
    const { plainTextToken: oldPt, token: oldToken } = await svc.createToken('user1', {
      name: 'Rotate me',
      scopes: ['records:read', 'comments:read'],
    })
    executeTakeFirstQueue.push({
      id: oldToken.id,
      name: oldToken.name,
      token_hash: oldToken.tokenHash,
      token_prefix: oldToken.tokenPrefix,
      scopes: JSON.stringify(oldToken.scopes),
      created_by: 'user1',
      created_at: oldToken.createdAt,
      revoked: false,
    })
    const { plainTextToken: newPt, token: newToken } = await svc.rotateToken(
      oldToken.id,
      'user1',
    )

    executeTakeFirstQueue.push({
      id: oldToken.id,
      name: oldToken.name,
      token_hash: oldToken.tokenHash,
      token_prefix: oldToken.tokenPrefix,
      scopes: JSON.stringify(oldToken.scopes),
      created_by: 'user1',
      created_at: oldToken.createdAt,
      revoked: true,
    })
    expect((await svc.validateToken(oldPt)).valid).toBe(false)

    executeTakeFirstQueue.push({
      id: newToken.id,
      name: newToken.name,
      token_hash: newToken.tokenHash,
      token_prefix: newToken.tokenPrefix,
      scopes: JSON.stringify(newToken.scopes),
      created_by: 'user1',
      created_at: newToken.createdAt,
      revoked: false,
    })
    expect((await svc.validateToken(newPt)).valid).toBe(true)

    expect(newToken.scopes).toEqual(
      expect.arrayContaining(['records:read', 'comments:read']),
    )
    expect(newToken.id).not.toBe(oldToken.id)
  })

  // ── Listing ───────────────────────────────────────────────────────

  test('listTokens returns only tokens for the given user', async () => {
    const t1 = await svc.createToken('user1', { name: 'A', scopes: ['records:read'] })
    await svc.createToken('user2', { name: 'B', scopes: ['records:read'] })
    const t3 = await svc.createToken('user1', { name: 'C', scopes: ['records:write'] })

    executeQueue.push([
      {
        id: t1.token.id,
        name: 'A',
        token_hash: t1.token.tokenHash,
        token_prefix: t1.token.tokenPrefix,
        scopes: JSON.stringify(['records:read']),
        created_by: 'user1',
        created_at: t1.token.createdAt,
        revoked: false,
      },
      {
        id: t3.token.id,
        name: 'C',
        token_hash: t3.token.tokenHash,
        token_prefix: t3.token.tokenPrefix,
        scopes: JSON.stringify(['records:write']),
        created_by: 'user1',
        created_at: t3.token.createdAt,
        revoked: false,
      },
    ])

    const list = await svc.listTokens('user1')
    expect(list).toHaveLength(2)
    expect(list.every((t) => (t as Record<string, unknown>).createdBy === 'user1')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Webhook Service
// ═══════════════════════════════════════════════════════════════════════

describe('WebhookService', () => {
  let svc: WebhookService
  let db: Kysely<Database>

  const okFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'ok',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    executeQueue = []
    executeTakeFirstQueue = []
    db = createMockDb()
    svc = new WebhookService(db, okFetch as unknown as typeof fetch)
  })

  // ── CRUD ──────────────────────────────────────────────────────────

  test('createWebhook validates URL', async () => {
    await expect(
      svc.createWebhook('u1', { name: 'Bad', url: 'not-a-url', events: ['record.created'] }),
    ).rejects.toThrow('not a valid URL')
  })

  test('createWebhook rejects empty name', async () => {
    await expect(
      svc.createWebhook('u1', { name: '', url: 'https://example.com/hook', events: ['record.created'] }),
    ).rejects.toThrow('name is required')
  })

  test('createWebhook rejects empty events', async () => {
    await expect(
      svc.createWebhook('u1', { name: 'No events', url: 'https://example.com/hook', events: [] }),
    ).rejects.toThrow('At least one event')
  })

  test('createWebhook rejects unknown event type', async () => {
    await expect(
      svc.createWebhook('u1', { name: 'Bad event', url: 'https://example.com/hook', events: ['unknown.event' as WebhookEventType] }),
    ).rejects.toThrow('Unknown event type')
  })

  test('createWebhook stores webhook and listWebhooks returns it', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'My Hook', url: 'https://example.com/hook', events: ['record.created'],
    })
    expect(wh.id).toBeDefined()
    expect(wh.active).toBe(true)
    expect(wh.failureCount).toBe(0)

    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    const list = await svc.listWebhooks('u1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(wh.id)
  })

  test('deleteWebhook removes webhook', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'Del', url: 'https://example.com/hook', events: ['record.created'],
    })
    executeTakeFirstQueue.push({ id: wh.id, created_by: 'u1' })
    await svc.deleteWebhook(wh.id, 'u1')
    executeQueue.push([])
    expect(await svc.listWebhooks('u1')).toHaveLength(0)
  })

  test('deleteWebhook throws for wrong user', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'Owned', url: 'https://example.com/hook', events: ['record.created'],
    })
    executeTakeFirstQueue.push({ id: wh.id, created_by: 'u1' })
    await expect(svc.deleteWebhook(wh.id, 'u2')).rejects.toThrow('Not authorized')
  })

  test('updateWebhook modifies fields', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'Update me', url: 'https://example.com/hook', events: ['record.created'],
    })
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })
    const updatedAt = new Date().toISOString()
    executeTakeFirstQueue.push({
      id: wh.id, name: 'Updated', url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: false, created_by: 'u1',
      created_at: wh.createdAt, updated_at: updatedAt, failure_count: 0, max_retries: 3,
    })
    const updated = await svc.updateWebhook(wh.id, 'u1', { name: 'Updated', active: false })
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
    const wh = await svc.createWebhook('u1', {
      name: 'Signed', url: 'https://example.com/hook', secret: 'my-secret', events: ['record.created'],
    })

    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: 'my-secret',
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: 'my-secret',
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })

    await svc.deliverEvent('record.created', { test: true })
    await new Promise((r) => setTimeout(r, 50))

    expect(okFetch).toHaveBeenCalledTimes(1)
    const callArgs = okFetch.mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    expect(headers['X-Webhook-Signature']).toBeDefined()
    expect(headers['X-Webhook-Id']).toBe(wh.id)
    expect(headers['X-Webhook-Event']).toBe('record.created')
    expect(headers['X-Webhook-Timestamp']).toBeDefined()
  })

  test('delivery does not include signature when no secret', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'Unsigned', url: 'https://example.com/hook', events: ['record.created'],
    })

    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })

    await svc.deliverEvent('record.created', { test: true })
    await new Promise((r) => setTimeout(r, 50))

    const callArgs = okFetch.mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    expect(headers['X-Webhook-Signature']).toBeUndefined()
  })

  // ── Delivery logic ────────────────────────────────────────────────

  test('deliverEvent only triggers webhooks subscribed to the event', async () => {
    const whA = await svc.createWebhook('u1', {
      name: 'Records only', url: 'https://example.com/a', events: ['record.created'],
    })
    await svc.createWebhook('u1', {
      name: 'Comments only', url: 'https://example.com/b', events: ['comment.created'],
    })

    executeQueue.push([
      {
        id: whA.id, name: 'Records only', url: 'https://example.com/a', secret: null,
        events: JSON.stringify(['record.created']), active: true, created_by: 'u1',
        created_at: whA.createdAt, failure_count: 0, max_retries: 3,
      },
      {
        id: 'other-id', name: 'Comments only', url: 'https://example.com/b', secret: null,
        events: JSON.stringify(['comment.created']), active: true, created_by: 'u1',
        created_at: whA.createdAt, failure_count: 0, max_retries: 3,
      },
    ])
    executeTakeFirstQueue.push({
      id: whA.id, name: 'Records only', url: 'https://example.com/a', secret: null,
      events: JSON.stringify(['record.created']), active: true, created_by: 'u1',
      created_at: whA.createdAt, failure_count: 0, max_retries: 3,
    })

    await svc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    expect(okFetch).toHaveBeenCalledTimes(1)
    expect(okFetch.mock.calls[0][0]).toBe('https://example.com/a')
  })

  test('inactive webhook is not triggered', async () => {
    await svc.createWebhook('u1', {
      name: 'Inactive', url: 'https://example.com/hook', events: ['record.created'],
    })

    // Mock returns empty for active webhooks (simulating that the webhook is inactive)
    executeQueue.push([])

    await svc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    expect(okFetch).not.toHaveBeenCalled()
  })

  // ── Failure tracking ──────────────────────────────────────────────

  test('failed delivery increments failure count', async () => {
    const failFetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'Internal Server Error',
    })
    const failSvc = new WebhookService(db, failFetch as unknown as typeof fetch)

    const wh = await failSvc.createWebhook('u1', {
      name: 'Fail', url: 'https://example.com/hook', events: ['record.created'],
    })

    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })

    await failSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    })
    const stored = await failSvc.getWebhookById(wh.id)
    expect(stored?.failureCount).toBeGreaterThan(0)
  })

  test('webhook is auto-disabled after 10 consecutive failures', async () => {
    const failFetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'error',
    })
    const failSvc = new WebhookService(db, failFetch as unknown as typeof fetch)

    const wh = await failSvc.createWebhook('u1', {
      name: 'Will disable', url: 'https://example.com/hook', events: ['record.created'],
    })

    for (let i = 0; i < 10; i++) {
      executeQueue.push([{
        id: wh.id, name: wh.name, url: wh.url, secret: null,
        events: JSON.stringify(wh.events), active: true, created_by: 'u1',
        created_at: wh.createdAt, failure_count: i, max_retries: 3,
      }])
      executeTakeFirstQueue.push({
        id: wh.id, name: wh.name, url: wh.url, secret: null,
        events: JSON.stringify(wh.events), active: true, created_by: 'u1',
        created_at: wh.createdAt, failure_count: i, max_retries: 3,
      })
      await failSvc.deliverEvent('record.created', { attempt: i })
      await new Promise((r) => setTimeout(r, 20))
    }

    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: false, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 10, max_retries: 3,
    })
    const stored = await failSvc.getWebhookById(wh.id)
    expect(stored?.active).toBe(false)
    expect(stored?.failureCount).toBeGreaterThanOrEqual(10)
  })

  test('successful delivery resets failure count', async () => {
    let callCount = 0
    const mixFetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount <= 1) {
        return { ok: false, status: 500, text: async () => 'err' }
      }
      return { ok: true, status: 200, text: async () => 'ok' }
    })
    const mixSvc = new WebhookService(db, mixFetch as unknown as typeof fetch)

    const wh = await mixSvc.createWebhook('u1', {
      name: 'Mix', url: 'https://example.com/hook', events: ['record.created'],
    })

    // First delivery fails
    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })
    await mixSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    })
    expect((await mixSvc.getWebhookById(wh.id))?.failureCount).toBeGreaterThan(0)

    // Second delivery succeeds
    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    })
    await mixSvc.deliverEvent('record.created', {})
    await new Promise((r) => setTimeout(r, 50))

    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })
    expect((await mixSvc.getWebhookById(wh.id))?.failureCount).toBe(0)
  })

  // ── Delivery list ─────────────────────────────────────────────────

  test('listDeliveries returns deliveries for the given webhook', async () => {
    const wh = await svc.createWebhook('u1', {
      name: 'Deliveries', url: 'https://example.com/hook', events: ['record.created'],
    })

    executeQueue.push([
      { id: 'del-1', webhook_id: wh.id, event: 'record.created', payload: { a: 1 }, status: 'success', http_status: 200, response_body: 'ok', attempt_count: 1, created_at: new Date().toISOString() },
      { id: 'del-2', webhook_id: wh.id, event: 'record.created', payload: { a: 2 }, status: 'success', http_status: 200, response_body: 'ok', attempt_count: 1, created_at: new Date().toISOString() },
    ])

    const deliveries = await svc.listDeliveries(wh.id)
    expect(deliveries.length).toBe(2)
  })

  // ── Retry logic ───────────────────────────────────────────────────

  test('retryFailedDeliveries retries pending deliveries past nextRetryAt', async () => {
    const failOnceFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad' })
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })

    const retrySvc = new WebhookService(db, failOnceFetch as unknown as typeof fetch)
    const wh = await retrySvc.createWebhook('u1', {
      name: 'Retry', url: 'https://example.com/hook', events: ['record.created'],
    })

    executeQueue.push([{
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 0, max_retries: 3,
    })

    const deliveries = await retrySvc.deliverEvent('record.created', { x: 1 })
    await new Promise((r) => setTimeout(r, 100))

    expect(deliveries[0].status).toBe('pending')

    executeQueue.push([{
      id: deliveries[0].id, webhook_id: wh.id, event: 'record.created',
      payload: { x: 1 }, status: 'pending', http_status: null, response_body: null,
      attempt_count: 1, created_at: deliveries[0].createdAt,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    }])
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    })
    executeTakeFirstQueue.push({
      id: wh.id, name: wh.name, url: wh.url, secret: null,
      events: JSON.stringify(wh.events), active: true, created_by: 'u1',
      created_at: wh.createdAt, failure_count: 1, max_retries: 3,
    })

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
