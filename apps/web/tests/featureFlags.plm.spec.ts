import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('featureFlags plm gating', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('honors explicit plm disable from backend and avoids plm home redirects', async () => {
    localStorage.setItem('auth_token', 'session-token')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              user: {
                role: 'admin',
                features: {
                  attendance: true,
                  attendance_admin: true,
                  attendance_import: true,
                  plm: false,
                  mode: 'platform',
                },
              },
            },
          }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.plm).toBe(false)
    expect(features.mode).toBe('platform')
    expect(flags.resolveHomePath()).toBe('/grid')
    expect(flags.isPlmWorkbenchFocused()).toBe(false)
  })
})
