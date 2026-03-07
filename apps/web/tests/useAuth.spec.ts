import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAuth } from '../src/composables/useAuth'

describe('useAuth', () => {
  const store: Record<string, string> = {}
  const ls = {
    getItem: vi.fn((k: string) => store[k] ?? null),
    setItem: vi.fn((k: string, v: string) => (store[k] = v)),
    removeItem: vi.fn((k: string) => delete store[k])
  }

  const original = globalThis.localStorage as any
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    ;(globalThis as any).localStorage = ls
    Object.keys(store).forEach((k) => delete store[k])
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    ;(globalThis as any).localStorage = original
    vi.stubGlobal('fetch', originalFetch)
  })

  it('builds headers with Bearer when jwt exists', () => {
    ls.setItem('jwt', 'abc')
    const { buildAuthHeaders } = useAuth()
    const h = buildAuthHeaders()
    expect(h.Authorization).toBe('Bearer abc')
    expect(h['x-user-id']).toBeUndefined()
  })

  it('falls back to x-user-id when no token', () => {
    const { buildAuthHeaders } = useAuth()
    const h = buildAuthHeaders()
    expect(h.Authorization).toBeUndefined()
    expect(h['x-user-id']).toBe('dev-user')
  })

  it('returns an existing token without refreshing', async () => {
    ls.setItem('devToken', 'cached-token')
    const fetchMock = vi.mocked(globalThis.fetch)
    const { ensureToken } = useAuth()

    await expect(ensureToken()).resolves.toBe('cached-token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes and stores a dev token when none exists', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({ token: 'fresh-token' }))
    } as Response)

    const { ensureToken } = useAuth()

    await expect(ensureToken()).resolves.toBe('fresh-token')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/dev-token')
    expect(ls.setItem).toHaveBeenCalledWith('devToken', 'fresh-token')
  })
})
