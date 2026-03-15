import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('featureFlags', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('skips auth bootstrap when feature loading is requested for a public route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            list: [
              { name: 'plugin-attendance', status: 'active' },
            ],
          }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true, { skipSessionProbe: true })

    expect(features.attendance).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toMatch(/\/api\/plugins$/)
  })

  it('refreshes with a session probe after an anonymous bootstrap', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            list: [
              { name: 'plugin-attendance', status: 'active' },
            ],
          }),
        }
      }

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
                  mode: 'attendance',
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

    const anonymous = await flags.loadProductFeatures(true, { skipSessionProbe: true })
    expect(anonymous.attendanceAdmin).toBe(false)

    const authenticated = await flags.loadProductFeatures()
    expect(authenticated.attendanceAdmin).toBe(true)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.filter((url) => url.endsWith('/api/plugins'))).toHaveLength(2)
    expect(urls.filter((url) => url.endsWith('/api/auth/me'))).toHaveLength(1)
  })
})
