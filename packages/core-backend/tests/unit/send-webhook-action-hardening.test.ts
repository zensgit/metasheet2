/**
 * send_webhook automation-action hardening.
 *
 * The send_webhook action is a distinct dispatch path from webhook-service
 * deliveries, but it should share the same security/timeout posture:
 *  - HMAC-SHA256 signing when a `secret` is configured (same X-Webhook-Signature
 *    header + algorithm as WebhookService.signPayload)
 *  - no signature header when no secret
 *  - bounded retries with the failure surfaced in the step result (not silent)
 */
import { describe, test, expect, vi } from 'vitest'
import { createHmac } from 'crypto'
import { AutomationExecutor, type AutomationDeps } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

function deps(fetchFn: typeof fetch): AutomationDeps {
  return {
    eventBus: new EventBus(),
    queryFn: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    fetchFn,
  }
}

function rule(config: Record<string, unknown>) {
  return {
    id: 'rule_1',
    name: 'Webhook rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created' as const, config: {} },
    actions: [{ type: 'send_webhook' as const, config }],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('send_webhook HMAC signing', () => {
  test('signs the body with HMAC-SHA256 when a secret is configured', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 })) as unknown as typeof fetch
    const executor = new AutomationExecutor(deps(fetchFn))
    const body = { hello: 'world' }

    const result = await executor.execute(
      rule({ url: 'https://example.com/hook', secret: 's3cr3t', body }),
      { recordId: 'r1', data: {}, sheetId: 'sheet_1' },
    )

    expect(result.status).toBe('success')
    const callArgs = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    const sentBody = callArgs[1].body as string
    const expected = createHmac('sha256', 's3cr3t').update(sentBody).digest('hex')
    expect(headers['X-Webhook-Signature']).toBe(expected)
    expect(headers['X-Webhook-Timestamp']).toBeDefined()
  })

  test('omits the signature header when no secret', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 })) as unknown as typeof fetch
    const executor = new AutomationExecutor(deps(fetchFn))

    await executor.execute(rule({ url: 'https://example.com/hook' }), {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    })

    const callArgs = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    const headers = callArgs[1].headers as Record<string, string>
    expect(headers['X-Webhook-Signature']).toBeUndefined()
  })
})

describe('send_webhook failure surfacing', () => {
  test('exhausted retries surface as a failed step with an error message', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const executor = new AutomationExecutor(deps(fetchFn))

    const result = await executor.execute(rule({ url: 'https://example.com/hook' }), {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].actionType).toBe('send_webhook')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toMatch(/Webhook failed after/)
  })
})
