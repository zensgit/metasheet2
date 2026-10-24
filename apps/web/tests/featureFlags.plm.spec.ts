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
    // #5392: the platform-mode default landing is now the 我的应用 apps page, not attendance —
    // the assertion this replaces (`.toBe('/attendance')`) reds against the pre-fix store.
    expect(flags.resolveHomePath()).toBe('/home')
    expect(flags.isPlmWorkbenchFocused()).toBe(false)
  })
})

describe('welding flags only mirror explicit backend booleans', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear() })
  it.each([
    [{}, false, false],
    [{ weldingRead: false, weldingWrite: true }, false, false],
    [{ weldingRead: true, weldingWrite: false }, true, false],
    [{ weldingRead: true, weldingWrite: true }, true, true],
    [{ weldingRead: 'true', weldingWrite: 'true' }, false, false],
  ])('backend %j resolves read=%s/write=%s without PLM/admin/override inference', async (patch, read, write) => {
    localStorage.setItem('auth_token', 'native-session')
    localStorage.setItem('metasheet_features', JSON.stringify({ plm: true, weldingRead: true, weldingWrite: true }))
    vi.stubEnv('DEV', true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { user: { id: 'native', role: 'admin' }, features: { attendance: false, workflow: false, plm: true, mode: 'plm-workbench', ...patch } } }), { status: 200 })))
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    await flags.loadProductFeatures(true)
    expect(flags.hasFeature('plm')).toBe(true)
    expect(flags.hasFeature('weldingRead')).toBe(read)
    expect(flags.hasFeature('weldingWrite')).toBe(write)
  })
})
