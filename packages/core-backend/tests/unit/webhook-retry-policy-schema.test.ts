/**
 * Webhook retry-policy route schema — accepts in-bounds policy, rejects
 * out-of-bounds. Mirrors the bounds the FE validation enforces.
 */
import { describe, expect, test } from 'vitest'
import {
  CreateWebhookSchema,
  UpdateWebhookSchema,
  WEBHOOK_MAX_MAX_RETRIES,
  WEBHOOK_MAX_BASE_RETRY_DELAY_MS,
} from '../../src/multitable/webhooks'

const baseCreate = {
  name: 'Hook',
  url: 'https://example.com/hook',
  events: ['record.created'],
}

describe('CreateWebhookSchema retry policy', () => {
  test('accepts a webhook with no retry policy (defaults applied downstream)', () => {
    const parsed = CreateWebhookSchema.parse(baseCreate)
    expect(parsed.maxRetries).toBeUndefined()
    expect(parsed.retryBaseDelayMs).toBeUndefined()
    expect(parsed.retryMaxDelayMs).toBeUndefined()
  })

  test('accepts in-bounds maxRetries + backoff', () => {
    const parsed = CreateWebhookSchema.parse({
      ...baseCreate,
      maxRetries: 5,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 30_000,
    })
    expect(parsed.maxRetries).toBe(5)
    expect(parsed.retryBaseDelayMs).toBe(2_000)
    expect(parsed.retryMaxDelayMs).toBe(30_000)
  })

  test('accepts the lower bound maxRetries = 0', () => {
    expect(CreateWebhookSchema.parse({ ...baseCreate, maxRetries: 0 }).maxRetries).toBe(0)
  })

  test('rejects maxRetries above the max', () => {
    expect(() =>
      CreateWebhookSchema.parse({ ...baseCreate, maxRetries: WEBHOOK_MAX_MAX_RETRIES + 1 }),
    ).toThrow()
  })

  test('rejects negative maxRetries', () => {
    expect(() => CreateWebhookSchema.parse({ ...baseCreate, maxRetries: -1 })).toThrow()
  })

  test('rejects non-integer maxRetries', () => {
    expect(() => CreateWebhookSchema.parse({ ...baseCreate, maxRetries: 2.5 })).toThrow()
  })

  test('rejects retryBaseDelayMs above the max', () => {
    expect(() =>
      CreateWebhookSchema.parse({
        ...baseCreate,
        retryBaseDelayMs: WEBHOOK_MAX_BASE_RETRY_DELAY_MS + 1,
      }),
    ).toThrow()
  })

  test('rejects retryBaseDelayMs below the min', () => {
    expect(() =>
      CreateWebhookSchema.parse({ ...baseCreate, retryBaseDelayMs: 1 }),
    ).toThrow()
  })
})

describe('UpdateWebhookSchema retry policy', () => {
  test('accepts a partial update of maxRetries only', () => {
    expect(UpdateWebhookSchema.parse({ maxRetries: 7 }).maxRetries).toBe(7)
  })

  test('rejects out-of-bounds maxRetries on update', () => {
    expect(() => UpdateWebhookSchema.parse({ maxRetries: 99 })).toThrow()
  })
})
