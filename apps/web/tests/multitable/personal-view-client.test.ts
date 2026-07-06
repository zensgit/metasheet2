/**
 * MultitableApiClient personal-config methods — Slice 3 FE client (design-lock
 * docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md).
 *
 * G-FE-1 (LOAD-BEARING): every personal-config request the client emits carries only whatever headers the
 * CALLER explicitly sets (Content-Type for a JSON body) — never a userId/user_id body field, query param, or
 * x-user-id-style header. (Authorization + x-tenant-id are injected by `apiFetch`/`authHeaders()` further
 * down the stack — out of scope for THIS client, which must never add identity of its own; see
 * apps/web/src/utils/api.ts:147-161.) Reverting the guard (e.g. smuggling a userId into the PUT body) is
 * exercised below as the observed-RED case.
 */
import { describe, expect, it, vi } from 'vitest'

import { MultitableApiClient } from '../../src/multitable/api/client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function serializedRequestHasNoIdentity(url: string, init: RequestInit | undefined): void {
  expect(url).not.toMatch(/user_?id/i)
  const headers = (init?.headers ?? {}) as Record<string, string>
  for (const key of Object.keys(headers)) {
    expect(key.toLowerCase()).not.toBe('x-user-id')
    expect(key.toLowerCase()).not.toMatch(/user_?id/i)
  }
  if (typeof init?.body === 'string') {
    expect(init.body).not.toMatch(/user_?id/i)
  }
}

describe('MultitableApiClient personal-config — request shaping + G-FE-1 identity-leak guard', () => {
  it('getPersonalViewConfig hits GET .../personal-config and unwraps { viewId, config, updatedAt }', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { ok: true, data: { viewId: 'view_1', config: { hiddenFieldIds: ['f2'] }, updatedAt: '2026-07-06T00:00:00.000Z' } }),
    )
    const client = new MultitableApiClient({ fetchFn })

    const result = await client.getPersonalViewConfig('view_1')

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('/api/multitable/views/view_1/personal-config')
    expect(init?.method ?? 'GET').toBe('GET')
    serializedRequestHasNoIdentity(url, init)
    expect(result).toEqual({ viewId: 'view_1', config: { hiddenFieldIds: ['f2'] }, updatedAt: '2026-07-06T00:00:00.000Z' })
  })

  it('putPersonalViewConfig PUTs a { config } envelope with no identity anywhere in the request', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { ok: true, data: { viewId: 'view_1', config: { hiddenFieldIds: ['f2'] }, updatedAt: '2026-07-06T00:00:00.000Z' } }),
    )
    const client = new MultitableApiClient({ fetchFn })

    await client.putPersonalViewConfig('view_1', { hiddenFieldIds: ['f2'], sortInfo: { rules: [{ fieldId: 'f1', desc: false }] } })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/views/view_1/personal-config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ config: { hiddenFieldIds: ['f2'], sortInfo: { rules: [{ fieldId: 'f1', desc: false }] } } })
    serializedRequestHasNoIdentity(url, init)
  })

  it('deletePersonalViewConfig DELETEs .../personal-config with no body and no identity', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true, data: { viewId: 'view_1', deleted: true } }))
    const client = new MultitableApiClient({ fetchFn })

    const result = await client.deletePersonalViewConfig('view_1')

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined]
    expect(url).toBe('/api/multitable/views/view_1/personal-config')
    expect(init?.method).toBe('DELETE')
    serializedRequestHasNoIdentity(url, init)
    expect(result).toEqual({ viewId: 'view_1', deleted: true })
  })

  it('viewId is URI-encoded in the path (defense against an id containing path-breaking characters)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true, data: { viewId: 'a/b', config: null, updatedAt: null } }))
    const client = new MultitableApiClient({ fetchFn })

    await client.getPersonalViewConfig('a/b')

    const [url] = fetchFn.mock.calls[0] as [string]
    expect(url).toBe('/api/multitable/views/a%2Fb/personal-config')
  })

  it('OBSERVED-RED: a client that smuggled a userId into the PUT body would fail the no-identity guard', async () => {
    // This does not call the real client — it demonstrates that the guard used above is discriminator-sound
    // by feeding it the shape a regressed client would produce (a userId alongside the overlay). See the
    // Slice 3 verification MD for how this was exercised against the actual client (revert-and-run).
    const regressedInit: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { hiddenFieldIds: ['f2'] }, userId: 'u_123' }),
    }
    expect(() => serializedRequestHasNoIdentity('/api/multitable/views/view_1/personal-config', regressedInit)).toThrow()
  })

  it('throws MultitableApiError with the server code/message on a non-2xx (e.g. flag-off 404)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }),
    )
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.getPersonalViewConfig('view_1')).rejects.toMatchObject({
      name: 'MultitableApiError',
      status: 404,
      code: 'NOT_FOUND',
    })
  })
})
