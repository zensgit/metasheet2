import { describe, expect, it, vi } from 'vitest'
import { buildLastErrorInfo, createMetaBackendClient, type HttpError } from '../src/metaBackend'
import type { StorageLike } from '../src/metaStorage'

function createStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial))

  return {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

function createResponse(status: number, json: unknown, url: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    json: vi.fn(async () => json),
  }
}

describe('metaBackend client', () => {
  it('retries an authenticated request once after a 401 and refreshes the cached token', async () => {
    const storage = createStorage({ 'metasheet.devToken': 'stale-token' })
    const fetch = vi.fn()

    fetch
      .mockResolvedValueOnce(createResponse(401, { error: 'expired' }, 'https://api.example.com/view'))
      .mockResolvedValueOnce(createResponse(200, { token: 'fresh-token' }, '/api/auth/dev-token'))
      .mockResolvedValueOnce(createResponse(200, { ok: true, data: { views: [] } }, 'https://api.example.com/view'))

    const client = createMetaBackendClient({
      backendUrl: 'https://api.example.com/view',
      viewsUrl: 'https://api.example.com/views',
      fetch: fetch as typeof globalThis.fetch,
      storage,
    })

    await expect(client.fetchWithAuth('https://api.example.com/view')).resolves.toEqual(
      expect.objectContaining({
        status: 200,
      }),
    )

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/view', {
      headers: {
        Authorization: 'Bearer stale-token',
      },
    })
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/auth/dev-token')
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://api.example.com/view', {
      headers: {
        Authorization: 'Bearer fresh-token',
      },
    })
  })

  it('throws a backend payload error when the response is not ok', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(200, { token: 'token-1' }, '/api/auth/dev-token'))
      .mockResolvedValueOnce(createResponse(200, { ok: false, error: { message: 'no data' } }, 'https://api.example.com/view'))

    const client = createMetaBackendClient({
      backendUrl: 'https://api.example.com/view',
      viewsUrl: 'https://api.example.com/views',
      fetch: fetch as typeof globalThis.fetch,
      storage: createStorage(),
    })

    await expect(client.fetchMetaView()).rejects.toThrow('no data')
  })

  it('builds structured error info with scope, status, and url', () => {
    const error = new Error('HTTP 401') as HttpError
    error.status = 401
    error.url = 'https://api.example.com/views'

    expect(buildLastErrorInfo('views', error, new Date('2026-03-06T12:00:00Z'))).toEqual({
      scope: 'views',
      message: 'HTTP 401',
      status: 401,
      url: 'https://api.example.com/views',
      at: new Date('2026-03-06T12:00:00Z').toLocaleTimeString(),
    })
  })
})
