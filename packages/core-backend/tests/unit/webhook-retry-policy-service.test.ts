/**
 * Webhook retry-policy service wiring.
 *
 * 1) computeBackoffMs is the pure backoff function the stored policy drives:
 *    base * 2^(attempt-1), capped at maxMs, defaulting to today's behavior
 *    (1s base, uncapped) when the policy is absent.
 * 2) createWebhook persists the stored policy columns.
 * 3) the auto-disable threshold is env-configurable, defaulting to 10.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebhookService } from '../../src/multitable/webhook-service'
import { WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS } from '../../src/multitable/webhooks'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'

// ── Minimal mock db capturing insert values ───────────────────────────────
function makeChain(captured: { insertValues?: Record<string, unknown> }): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const chainFn = () => self
  for (const m of [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit',
    'insertInto', 'updateTable', 'set', 'deleteFrom', 'forUpdate', 'skipLocked',
  ]) {
    self[m] = vi.fn(chainFn)
  }
  self.values = vi.fn((v: Record<string, unknown>) => {
    captured.insertValues = v
    return self
  })
  self.execute = vi.fn(async () => [])
  self.executeTakeFirst = vi.fn(async () => undefined)
  self.executeTakeFirstOrThrow = vi.fn(async () => {
    throw new Error('no rows')
  })
  return self
}

function createMockDb(captured: { insertValues?: Record<string, unknown> }): Kysely<Database> {
  const root: Record<string, unknown> = {}
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    root[m] = vi.fn(() => makeChain(captured))
  }
  return root as unknown as Kysely<Database>
}

describe('WebhookService.computeBackoffMs', () => {
  test('default (no policy) reproduces today behavior: 1s base, exponential, uncapped', () => {
    expect(WebhookService.computeBackoffMs(1)).toBe(WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS)
    expect(WebhookService.computeBackoffMs(2)).toBe(WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS * 2)
    expect(WebhookService.computeBackoffMs(3)).toBe(WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS * 4)
  })

  test('honors a custom base delay', () => {
    expect(WebhookService.computeBackoffMs(1, 5_000)).toBe(5_000)
    expect(WebhookService.computeBackoffMs(2, 5_000)).toBe(10_000)
  })

  test('caps the computed backoff at maxMs', () => {
    // 1000 * 2^4 = 16000, but capped at 8000
    expect(WebhookService.computeBackoffMs(5, 1_000, 8_000)).toBe(8_000)
  })

  test('uncapped when maxMs is undefined', () => {
    expect(WebhookService.computeBackoffMs(6, 1_000)).toBe(1_000 * 2 ** 5)
  })
})

describe('WebhookService.createWebhook persists retry policy', () => {
  let captured: { insertValues?: Record<string, unknown> }
  let svc: WebhookService

  beforeEach(() => {
    captured = {}
    svc = new WebhookService(createMockDb(captured))
  })

  test('stores maxRetries + backoff columns when provided', async () => {
    await svc.createWebhook('u1', {
      name: 'Policy',
      url: 'https://example.com/hook',
      events: ['record.created'],
      maxRetries: 7,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 30_000,
    })
    expect(captured.insertValues?.max_retries).toBe(7)
    expect(captured.insertValues?.retry_base_delay_ms).toBe(2_000)
    expect(captured.insertValues?.retry_max_delay_ms).toBe(30_000)
  })

  test('defaults max_retries to 3 and leaves backoff NULL when omitted', async () => {
    await svc.createWebhook('u1', {
      name: 'No policy',
      url: 'https://example.com/hook',
      events: ['record.created'],
    })
    expect(captured.insertValues?.max_retries).toBe(3)
    expect(captured.insertValues?.retry_base_delay_ms ?? null).toBeNull()
    expect(captured.insertValues?.retry_max_delay_ms ?? null).toBeNull()
  })
})

describe('WebhookService auto-disable threshold', () => {
  const ORIG = process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES

  afterEach(() => {
    if (ORIG === undefined) delete process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES
    else process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = ORIG
  })

  test('defaults to 10', () => {
    delete process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES
    expect(WebhookService.maxConsecutiveFailures()).toBe(10)
  })

  test('reads an env override', () => {
    process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = '25'
    expect(WebhookService.maxConsecutiveFailures()).toBe(25)
  })

  test('ignores a non-numeric env value (falls back to 10)', () => {
    process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES = 'oops'
    expect(WebhookService.maxConsecutiveFailures()).toBe(10)
  })
})
