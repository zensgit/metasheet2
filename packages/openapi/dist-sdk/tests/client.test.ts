import { describe, expect, it, vi } from 'vitest'
import { createClient } from '../client'

function createResponse<T>(status: number, json: T, etag?: string) {
  return {
    status,
    headers: {
      get: vi.fn((name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null)),
    },
    json: vi.fn(async () => json),
  }
}

describe('@metasheet/sdk client', () => {
  it('sends auth and conditional headers and parses the JSON payload', async () => {
    const fetch = vi.fn(async () => createResponse(200, { ok: true }, 'etag-1'))
    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    const response = await client.request<{ ok: boolean }>(
      'PATCH',
      '/records/1',
      { title: 'Updated' },
      'etag-0',
    )

    expect(fetch).toHaveBeenCalledWith('https://api.example.com/records/1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'etag-0',
      },
      body: JSON.stringify({ title: 'Updated' }),
    })
    expect(response).toEqual({
      status: 200,
      etag: 'etag-1',
      json: { ok: true },
    })
  })

  it('returns undefined JSON when the response body cannot be parsed', async () => {
    const fetch = vi.fn(async () => ({
      status: 204,
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => {
        throw new Error('no json body')
      }),
    }))
    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: async () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.request('GET', '/health')).resolves.toEqual({
      status: 204,
      etag: undefined,
      json: undefined,
    })
  })

  it('refreshes the parent ETag and retries once after a 409 conflict', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(409, { message: 'conflict' }, 'stale-etag'))
      .mockResolvedValueOnce(createResponse(200, { data: { id: 'wf-1' } }, 'fresh-etag'))
      .mockResolvedValueOnce(createResponse(200, { ok: true }, 'fresh-etag'))

    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    const response = await client.requestWithRetry(
      'POST',
      '/workflow/123/approve',
      { comment: 'approved' },
      'stale-etag',
    )

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/workflow/123/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'stale-etag',
      },
      body: JSON.stringify({ comment: 'approved' }),
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/workflow/123', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://api.example.com/workflow/123/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'fresh-etag',
      },
      body: JSON.stringify({ comment: 'approved' }),
    })
    expect(response).toEqual({
      status: 200,
      etag: 'fresh-etag',
      json: { ok: true },
    })
  })
})
