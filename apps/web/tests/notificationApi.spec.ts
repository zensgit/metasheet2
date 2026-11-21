import { beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('../src/utils/api', () => ({ apiFetch: transport.apiFetch }))

import {
  createNotificationTestIdempotencyKey,
  establishNotificationEndpoint,
  listNotificationEndpoints,
  listNotificationPreferences,
  parseNotificationEndpointsListing,
  parseNotificationPreferencesListing,
  patchNotificationPreference,
  revokeNotificationEndpoint,
  testNotificationEndpoint,
} from '../src/notifications/notificationApi'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const OTHER_CONNECTION = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const OTHER_ENDPOINT = '44444444-4444-4444-8444-444444444444'

function endpoint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENDPOINT,
    connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
    addressKind: 'dingtalk_userid',
    proofKind: 'directory_link',
    status: 'active',
    revision: 1,
    usable: true,
    unusableReason: null,
    capability: { effective: false, reason: 'switch_off' },
    verified: false,
    lastVerifiedAt: '2026-11-06T08:00:00.000Z',
    ...over,
  }
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
    proofKind: 'directory_link',
    addressable: true,
    reasonCode: null,
    endpointId: null,
    ...over,
  }
}

function endpointsListing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery: { enabled: false, testSendAvailable: false, reason: 'delivery_disabled' },
    endpoints: [endpoint()],
    candidates: [candidate()],
    ...over,
  }
}

function topic(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: 'task_reminder',
    integrated: false,
    applies: { now: false, reason: 'topic_not_integrated' },
    preference: null,
    effective: { source: 'none', connection: null, usable: false, fallback: null },
    ...over,
  }
}

function preferencesListing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { topics: [topic()], ...over }
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response
}

function ok(body: unknown): Response {
  return response(200, body)
}

function expectNoAccountFields(body: string): void {
  const forbidden = new Set(['openId', 'unionId', 'userId', 'externalId', 'externalUserId', 'email', 'mobile', 'orgId', 'address', 'recipient'])
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      expect(forbidden.has(key), `request must not carry account field ${key}`).toBe(false)
      visit(child)
    }
  }
  visit(JSON.parse(body))
}

beforeEach(() => {
  transport.apiFetch.mockReset()
})

describe('notification endpoint reads', () => {
  it('reads and strictly parses the actual listing shape', async () => {
    transport.apiFetch.mockResolvedValue(ok(endpointsListing()))
    const result = await listNotificationEndpoints()
    expect(transport.apiFetch).toHaveBeenCalledWith('/api/me/notification-endpoints')
    expect(result).toEqual({ kind: 'ok', value: endpointsListing() })
  })

  it('fails closed for test sending when its capability field or reason is absent', async () => {
    transport.apiFetch.mockResolvedValue(ok(endpointsListing({ delivery: { enabled: false } })))
    const result = await listNotificationEndpoints()
    expect(result).toEqual({
      kind: 'ok',
      value: endpointsListing({ delivery: { enabled: false, testSendAvailable: false, reason: null } }),
    })
  })

  it.each([
    ['an extra top-level key', endpointsListing({ extra: true })],
    ['a missing collection', { delivery: { enabled: false }, endpoints: [] }],
    ['an extra endpoint key', endpointsListing({ endpoints: [endpoint({ extra: true })] })],
    ['a missing endpoint key', endpointsListing({ endpoints: [{ ...endpoint(), lastVerifiedAt: undefined }] })],
    ['an unknown endpoint status', endpointsListing({ endpoints: [endpoint({ status: 'revoked' })] })],
    ['an extra connection key', endpointsListing({ endpoints: [endpoint({ connection: { id: CONNECTION, provider: 'dingtalk', label: 'x', openId: 'x' } })] })],
    ['an invalid candidate reason', endpointsListing({ candidates: [candidate({ reasonCode: 'endpoint_stale' })] })],
    ['an extra delivery key', endpointsListing({ delivery: { enabled: false, extra: true } })],
    ['a mistyped test capability', endpointsListing({ delivery: { enabled: false, testSendAvailable: 'yes' } })],
  ])('rejects %s', async (_name, body) => {
    expect(parseNotificationEndpointsListing(body)).toBeNull()
    transport.apiFetch.mockResolvedValue(ok(body))
    expect(await listNotificationEndpoints()).toEqual({ kind: 'error', status: 200 })
  })

  it.each([
    [404, 'disabled'],
    [403, 'forbidden'],
    [500, 'error'],
  ] as const)('maps HTTP %s to %s', async (status, kind) => {
    transport.apiFetch.mockResolvedValue(response(status, null))
    expect(await listNotificationEndpoints()).toEqual(kind === 'error' ? { kind, status } : { kind })
  })

  it('maps a transport failure to an error', async () => {
    transport.apiFetch.mockRejectedValue(new TypeError('offline'))
    expect(await listNotificationEndpoints()).toEqual({ kind: 'error', status: 0 })
  })
})

describe('notification endpoint writes', () => {
  it('enables with exactly connectionId and proofKind and parses a 201 response', async () => {
    transport.apiFetch.mockResolvedValue(response(201, { endpoint: endpoint() }))
    const result = await establishNotificationEndpoint({ connectionId: CONNECTION, proofKind: 'directory_link' })
    const [path, init] = transport.apiFetch.mock.calls[0]
    expect(path).toBe('/api/me/notification-endpoints')
    expect(init).toEqual({ method: 'POST', body: '{"connectionId":"11111111-1111-4111-8111-111111111111","proofKind":"directory_link"}' })
    expectNoAccountFields(init.body)
    expect(result).toEqual({ kind: 'ok', endpoint: endpoint() })
  })

  it('rejects an extra key in an establish response', async () => {
    transport.apiFetch.mockResolvedValue(response(201, { endpoint: endpoint(), extra: true }))
    expect(await establishNotificationEndpoint({ connectionId: CONNECTION, proofKind: 'directory_link' })).toEqual({ kind: 'error', status: 201 })
  })

  it('revokes through DELETE without a request body and strictly parses the tombstone', async () => {
    transport.apiFetch.mockResolvedValue(ok({ endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } }))
    const result = await revokeNotificationEndpoint(ENDPOINT)
    expect(transport.apiFetch).toHaveBeenCalledWith(`/api/me/notification-endpoints/${ENDPOINT}`, { method: 'DELETE' })
    expect(transport.apiFetch.mock.calls[0][1].body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } })
  })

  it('rejects an extra key in a revoke response', async () => {
    transport.apiFetch.mockResolvedValue(ok({ endpoint: { id: ENDPOINT, status: 'revoked', revision: 2, userId: 'forbidden' } }))
    expect(await revokeNotificationEndpoint(ENDPOINT)).toEqual({ kind: 'error', status: 200 })
  })
})

describe('notification preference reads and writes', () => {
  it('reads the topics shape including a complete preference and effective fallback', async () => {
    const body = preferencesListing({
      topics: [topic({
        preference: {
          enabled: true,
          primaryEndpointId: ENDPOINT,
          fallbackEndpointId: OTHER_ENDPOINT,
          quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' },
          revision: 3,
        },
        effective: {
          source: 'user_primary',
          connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
          usable: true,
          fallback: { connection: { id: OTHER_CONNECTION, provider: 'feishu', label: 'Feishu · Backup' }, usable: true },
        },
      })],
    })
    transport.apiFetch.mockResolvedValue(ok(body))
    expect(await listNotificationPreferences()).toEqual({ kind: 'ok', value: body })
    expect(transport.apiFetch).toHaveBeenCalledWith('/api/me/notification-preferences')
  })

  it.each([
    ['an extra top-level key', preferencesListing({ extra: true })],
    ['an unknown topic', preferencesListing({ topics: [topic({ topic: 'other' })] })],
    ['an extra applies key', preferencesListing({ topics: [topic({ applies: { now: false, reason: null, extra: true } })] })],
    ['an unknown applies reason', preferencesListing({ topics: [topic({ applies: { now: false, reason: 'unknown' } })] })],
    ['a missing preference key', preferencesListing({ topics: [topic({ preference: { enabled: true } })] })],
    ['an extra effective key', preferencesListing({ topics: [topic({ effective: { source: 'none', connection: null, usable: false, fallback: null, extra: true } })] })],
    ['an invalid quiet window', preferencesListing({ topics: [topic({ preference: { enabled: true, primaryEndpointId: null, fallbackEndpointId: null, quietHours: { start: '22:00', end: '22:00', timeZone: 'Asia/Shanghai' }, revision: 0 } })] })],
  ])('rejects %s', async (_name, body) => {
    expect(parseNotificationPreferencesListing(body)).toBeNull()
    transport.apiFetch.mockResolvedValue(ok(body))
    expect(await listNotificationPreferences()).toEqual({ kind: 'error', status: 200 })
  })

  it('serializes a full patch byte for byte without account fields', async () => {
    const updated = topic({ preference: { enabled: false, primaryEndpointId: ENDPOINT, fallbackEndpointId: OTHER_ENDPOINT, quietHours: { start: '22:00', end: '08:00', timeZone: 'Pacific/Chatham' }, revision: 4 } })
    transport.apiFetch.mockResolvedValue(ok(updated))
    const result = await patchNotificationPreference({
      topic: 'task_reminder',
      expectedRevision: 3,
      enabled: false,
      primaryEndpointId: ENDPOINT,
      fallbackEndpointId: OTHER_ENDPOINT,
      quietHours: { start: '22:00', end: '08:00', timeZone: 'Pacific/Chatham' },
    })
    const [path, init] = transport.apiFetch.mock.calls[0]
    expect(path).toBe('/api/me/notification-preferences')
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe('{"topic":"task_reminder","expectedRevision":3,"enabled":false,"primaryEndpointId":"33333333-3333-4333-8333-333333333333","fallbackEndpointId":"44444444-4444-4444-8444-444444444444","quietHours":{"start":"22:00","end":"08:00","timeZone":"Pacific/Chatham"}}')
    expectNoAccountFields(init.body)
    expect(result).toEqual({ kind: 'ok', topic: updated })
  })

  it('keeps explicit null clears and omits untouched optional keys', async () => {
    transport.apiFetch.mockResolvedValue(ok(topic()))
    await patchNotificationPreference({ topic: 'task_reminder', expectedRevision: 2, primaryEndpointId: null, quietHours: null })
    expect(transport.apiFetch.mock.calls[0][1].body).toBe('{"topic":"task_reminder","expectedRevision":2,"primaryEndpointId":null,"quietHours":null}')
  })

  it('returns a typed conflict with the current revision', async () => {
    transport.apiFetch.mockResolvedValue(response(409, { error: { code: 'PREFERENCE_STALE', currentRevision: 7 } }))
    expect(await patchNotificationPreference({ topic: 'task_reminder', expectedRevision: 6 })).toEqual({ kind: 'conflict', code: 'PREFERENCE_STALE', currentRevision: 7 })
  })

  it('preserves a non-stale conflict reason for display', async () => {
    transport.apiFetch.mockResolvedValue(response(409, { error: { code: 'ENDPOINT_NOT_USABLE', reason: 'endpoint_stale' } }))
    expect(await patchNotificationPreference({ topic: 'task_reminder', expectedRevision: 6 })).toEqual({ kind: 'conflict', code: 'ENDPOINT_NOT_USABLE', reason: 'endpoint_stale' })
  })

  it('preserves server-provided validation fields for display', async () => {
    transport.apiFetch.mockResolvedValue(response(422, { error: { code: 'INVALID_REQUEST', fields: ['quietHours.start'] } }))
    expect(await patchNotificationPreference({ topic: 'task_reminder', expectedRevision: 6 })).toEqual({ kind: 'validation', code: 'INVALID_REQUEST', fields: ['quietHours.start'] })
  })
})

describe('notification test sends', () => {
  const KEY = 'key_ABC123'
  const success = (outcome: string) => ({ outcome, code: 'TEST_OUTCOME', testSendId: 'test-send-1' })

  it('generates fresh allowed keys with crypto.getRandomValues', () => {
    let fill = 0
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
      const bytes = target as Uint8Array
      bytes.fill(fill)
      fill += 1
      return target
    })
    try {
      const first = createNotificationTestIdempotencyKey()
      const second = createNotificationTestIdempotencyKey()
      expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
      expect(first).toHaveLength(24)
      expect(second).not.toBe(first)
      expect(random).toHaveBeenCalledTimes(2)
    } finally {
      random.mockRestore()
    }
  })

  it('posts confirm and idempotencyKey to /test byte for byte', async () => {
    transport.apiFetch.mockResolvedValue(response(200, success('accepted')))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'accepted', code: 'TEST_OUTCOME', testSendId: 'test-send-1' })
    expect(transport.apiFetch).toHaveBeenCalledWith(`/api/me/notification-endpoints/${ENDPOINT}/test`, {
      method: 'POST',
      body: '{"confirm":true,"idempotencyKey":"key_ABC123"}',
    })
    const body = transport.apiFetch.mock.calls[0][1].body as string
    expect(JSON.parse(body).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expectNoAccountFields(body)
  })

  it.each([
    ['failed', 'failed'],
    ['outcome_unknown', 'outcome_unknown'],
  ] as const)('maps the 200 %s outcome with its evidence', async (outcome, kind) => {
    transport.apiFetch.mockResolvedValue(response(200, success(outcome)))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind, code: 'TEST_OUTCOME', testSendId: 'test-send-1' })
  })

  it.each([
    ['a missing key', { outcome: 'accepted', code: 'TEST_OUTCOME' }],
    ['an extra key', { ...success('accepted'), extra: true }],
    ['an unknown outcome', success('delivered')],
    ['a non-string code', { ...success('accepted'), code: 7 }],
    ['a non-string testSendId', { ...success('accepted'), testSendId: null }],
    ['a non-object body', null],
  ])('rejects a 200 response with %s', async (_name, body) => {
    transport.apiFetch.mockResolvedValue(response(200, body))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'error', status: 200 })
  })

  it.each(['short', 'bad key!', 'x'.repeat(65)])('refuses the invalid idempotency key %j before transport', async (key) => {
    expect(await testNotificationEndpoint(ENDPOINT, key)).toEqual({ kind: 'error', status: 0 })
    expect(transport.apiFetch).not.toHaveBeenCalled()
  })

  it('maps 422 CONFIRM_REQUIRED', async () => {
    transport.apiFetch.mockResolvedValue(response(422, { error: { code: 'CONFIRM_REQUIRED' } }))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'confirm_required' })
  })

  it.each([
    ['NOTIFICATION_DELIVERY_DISABLED', 'delivery_disabled'],
    ['ENDPOINT_NOT_USABLE', 'endpoint_not_usable'],
    ['CONNECTION_NOT_READY', 'connection_not_ready'],
    ['TEST_SEND_IN_PROGRESS', 'in_progress'],
  ] as const)('maps 409 %s', async (code, kind) => {
    transport.apiFetch.mockResolvedValue(response(409, { error: { code } }))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind })
  })

  it('maps 429 TEST_SEND_RATE_LIMITED and reads Retry-After seconds', async () => {
    transport.apiFetch.mockResolvedValue(response(429, { error: { code: 'TEST_SEND_RATE_LIMITED' } }, { 'retry-after': '17' }))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 17 })
  })

  it('maps the 404 error shape', async () => {
    transport.apiFetch.mockResolvedValue(response(404, { error: { code: 'NOT_FOUND' } }))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'not_found' })
  })

  it('distinguishes a transport failure for same-key retry', async () => {
    transport.apiFetch.mockRejectedValue(new TypeError('offline'))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'network_error' })
  })

  it('maps an unspecified HTTP error without inventing an outcome', async () => {
    transport.apiFetch.mockResolvedValue(response(500, null))
    expect(await testNotificationEndpoint(ENDPOINT, KEY)).toEqual({ kind: 'error', status: 500 })
  })
})
