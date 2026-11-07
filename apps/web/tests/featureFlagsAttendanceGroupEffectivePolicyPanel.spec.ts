import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadPanelFlag(
  features: Record<string, unknown>,
  options: { role?: string; plugins?: boolean } = {},
) {
  localStorage.setItem('auth_token', 'synthetic-panel-session')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/auth/me')) {
      return { ok: true, status: 200, json: async () => ({
        data: { user: { role: options.role ?? 'admin', features } },
      }) }
    }
    if (url.endsWith('/api/plugins') && options.plugins) {
      return { ok: true, status: 200, json: async () => ({
        list: [{ name: 'plugin-attendance', status: 'active' }],
      }) }
    }
    throw new Error('Unexpected synthetic feature request')
  }))
  const { useFeatureFlags } = await import('../src/stores/featureFlags')
  const flags = useFeatureFlags()
  const result = await flags.loadProductFeatures(true)
  expect(flags.hasFeature('attendanceGroupEffectivePolicyPanel'))
    .toBe(result.attendanceGroupEffectivePolicyPanel)
  return result.attendanceGroupEffectivePolicyPanel
}

describe('attendance effective-policy panel uses the real default-off feature store', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_ALLOW_FEATURE_OVERRIDE', 'false')
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('starts OFF before any session or plugin response', async () => {
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    expect(useFeatureFlags().hasFeature('attendanceGroupEffectivePolicyPanel')).toBe(false)
  })

  it.each(['admin', 'user'])('stays OFF when the %s session omits the flag', async role => {
    expect(await loadPanelFlag({ attendance: true, workflow: false }, { role })).toBe(false)
  })

  it('does not infer enablement from attendance mode, admin role or an active plugin', async () => {
    expect(await loadPanelFlag({ mode: 'attendance' }, { plugins: true })).toBe(false)
  })

  it.each([
    [{ attendanceGroupEffectivePolicyPanel: true }, true],
    [{ attendance_group_effective_policy_panel: true }, true],
    [{ attendanceGroupEffectivePolicyPanel: false }, false],
    [{ attendanceGroupEffectivePolicyPanel: false, attendance_group_effective_policy_panel: true }, false],
    [{ attendanceGroupEffectivePolicyPanel: 'true' }, false],
    [{ attendanceGroupEffectivePolicyPanel: 1 }, false],
    [{ attendanceGroupEffectivePolicyPanel: null }, false],
    [{ attendance_group_effective_policy_panel: 'true' }, false],
  ])('honors only explicit boolean payloads: %j', async (extra, expected) => {
    expect(await loadPanelFlag({ attendance: true, workflow: false, ...extra })).toBe(expected)
  })

  it('ignores a local true override when overrides are not authorized', async () => {
    localStorage.setItem('metasheet_features', JSON.stringify({ attendanceGroupEffectivePolicyPanel: true }))
    expect(await loadPanelFlag({ attendance: true, workflow: false })).toBe(false)
  })

  it('preserves the existing authorized override path without inferring authorization', async () => {
    vi.stubEnv('VITE_ALLOW_FEATURE_OVERRIDE', 'true')
    localStorage.setItem('metasheet_features', JSON.stringify({ attendanceGroupEffectivePolicyPanel: true }))
    expect(await loadPanelFlag({
      attendance: true, workflow: false, attendanceGroupEffectivePolicyPanel: false,
    })).toBe(true)
  })
})
