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

  it('bootstraps a dev token before the first auth/me when no token exists', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              user: { role: 'admin' },
              features: {
                workflow: true,
                attendance: false,
                attendanceAdmin: true,
                attendanceImport: false,
                mode: 'plm-workbench',
              },
            },
          }),
        }
      }

      if (url.endsWith('/api/auth/dev-token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'dev-bootstrap-token' }),
        }
      }

      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            list: [
              { name: 'plugin-attendance', status: 'inactive' },
              { name: 'workflow-toolkit', status: 'active' },
            ],
          }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features).toMatchObject({
      workflow: true,
      attendanceAdmin: true,
      mode: 'platform',
    })
    expect(localStorage.getItem('auth_token')).toBe('dev-bootstrap-token')
    expect(localStorage.getItem('jwt')).toBe('dev-bootstrap-token')
    expect(localStorage.getItem('devToken')).toBe('dev-bootstrap-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries auth/me after a 401 when the existing token is stale', async () => {
    localStorage.setItem('auth_token', 'stale-token')

    let meRequests = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/auth/me')) {
        meRequests += 1
        if (meRequests === 1) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'Invalid token' }),
          }
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              user: { role: 'admin' },
              features: { workflow: true, mode: 'platform' },
            },
          }),
        }
      }

      if (url.endsWith('/api/auth/dev-token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'refreshed-dev-token' }),
        }
      }

      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ list: [] }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.workflow).toBe(true)
    expect(localStorage.getItem('auth_token')).toBe('refreshed-dev-token')
    expect(meRequests).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('falls back to plugin inference when auth/me does not include feature flags', async () => {
    localStorage.setItem('auth_token', 'existing-token')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              user: { role: 'user' },
            },
          }),
        }
      }

      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            list: [
              { name: 'workflow-toolkit', status: 'active' },
            ],
          }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.workflow).toBe(true)
    expect(features.attendance).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it('reuses a primed session payload instead of calling auth/me again after login bootstrap', async () => {
    localStorage.setItem('auth_token', 'fresh-login-token')

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/plugins')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ list: [] }),
        }
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { useAuth } = await import('../src/composables/useAuth')
    useAuth().primeSession({
      success: true,
      data: {
        user: { role: 'admin', permissions: ['users:write'] },
        features: {
          workflow: true,
          attendance: true,
          attendanceAdmin: true,
          attendanceImport: true,
          mode: 'attendance',
        },
      },
    })

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features).toMatchObject({
      workflow: true,
      attendance: true,
      attendanceAdmin: true,
      mode: 'attendance',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
