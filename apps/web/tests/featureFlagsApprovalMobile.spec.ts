import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// T3-1 v0 rollout gate (ballot Q11) — locks the REAL featureFlags store logic
// (DEFAULT_FEATURES + boolOrDefault + no-inference), which the mounted view
// specs deliberately mock out. Proves `approvalMobile` is default OFF and only
// an explicit backend flag or authorized dev override flips it on.
// ---------------------------------------------------------------------------

function meResponse(features: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { user: { role: 'user', features } } }),
  }
}

describe('featureFlags — approvalMobile rollout gate (T3-1)', () => {
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

  it('defaults approvalMobile OFF when the backend does not enable it (no admin/mode inference)', async () => {
    localStorage.setItem('auth_token', 'session-token')
    // attendance + workflow booleans present → no /api/plugins inference fetch.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/me')) {
        return meResponse({ attendance: true, workflow: false, mode: 'platform' })
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.approvalMobile).toBe(false)
    expect(flags.hasFeature('approvalMobile')).toBe(false)
  })

  it('honors an explicit backend enable (snake_case alias)', async () => {
    localStorage.setItem('auth_token', 'session-token')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/me')) {
        return meResponse({ attendance: true, workflow: false, approval_mobile: true, mode: 'platform' })
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.approvalMobile).toBe(true)
    expect(flags.hasFeature('approvalMobile')).toBe(true)
  })

  it('honors an authorized dev override even when the backend omits the flag', async () => {
    vi.stubEnv('VITE_ALLOW_FEATURE_OVERRIDE', 'true')
    localStorage.setItem('auth_token', 'session-token')
    localStorage.setItem('metasheet_features', JSON.stringify({ approvalMobile: true }))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/me')) {
        return meResponse({ attendance: true, workflow: false, mode: 'platform' })
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features = await flags.loadProductFeatures(true)

    expect(features.approvalMobile).toBe(true)
  })
})
