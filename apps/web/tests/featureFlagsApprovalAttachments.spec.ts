import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractFeaturesFromPayload } from '../src/stores/featureFlags'

describe('approval attachment feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { approvalAttachments: true } } } }, true],
    [{ data: { user: { features: { approval_attachments: true } } } }, true],
    [{ data: { user: { features: { approvalAttachments: false, approval_attachments: true } } } }, false],
    [{ data: { user: { features: { approvalAttachments: 'true' } } } }, undefined],
  ])('parses only an explicit boolean from supported payload keys', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).approvalAttachments).toBe(expected)
  })
})

describe('approval Canvas V2 feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { approvalCanvasV2: true } } } }, true],
    [{ data: { user: { features: { approval_canvas_v2: true } } } }, true],
    [{ data: { user: { features: { approvalCanvasV2: false, approval_canvas_v2: true } } } }, false],
    [{ data: { user: { features: { approvalCanvasV2: 'true' } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from supported payload keys', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).approvalCanvasV2).toBe(expected)
  })
})

describe('approval FWB writeback feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { approvalFwbWriteback: true } } } }, true],
    [{ data: { user: { features: { approval_fwb_writeback: true } } } }, true],
    [{ data: { user: { features: { approvalFwbWriteback: false, approval_fwb_writeback: true } } } }, false],
    [{ data: { user: { features: { approvalFwbWriteback: 'true' } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from supported payload keys', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).approvalFwbWriteback).toBe(expected)
  })
})

describe('elearning feature flag parsing', () => {
  it.each([
    [{ data: { user: { features: { elearning: true } } } }, true],
    [{ data: { user: { features: { elearning: false } } } }, false],
    [{ data: { user: { features: { elearning: 'true' } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from the elearning payload key', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).elearning).toBe(expected)
  })
})

describe('elearning product feature resolution', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadWithSessionFeatures(
    extraFeatures: Record<string, unknown>,
    options: {
      role?: string
      includeAttendanceWorkflow?: boolean
      plugins?: Array<{ name: string; status: string }>
      override?: Record<string, unknown>
    } = {},
  ) {
    const role = options.role ?? 'admin'
    const includeAttendanceWorkflow = options.includeAttendanceWorkflow !== false
    if (options.override) {
      localStorage.setItem('metasheet_features', JSON.stringify(options.override))
    }
    localStorage.setItem('auth_token', 'session-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/plugins')) {
        if (!options.plugins) {
          throw new Error('plugin inference must not run')
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ list: options.plugins }),
        }
      }
      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              user: {
                role,
                features: {
                  ...(includeAttendanceWorkflow ? { attendance: true, workflow: false } : {}),
                  ...extraFeatures,
                },
              },
            },
          }),
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }))
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    return useFeatureFlags().loadProductFeatures(true)
  }

  it('defaults elearning off and does not infer it from admin role when attendance/workflow are explicit', async () => {
    const features = await loadWithSessionFeatures({})
    expect(features.elearning).toBe(false)
    expect(features.attendance).toBe(true)
    expect(features.attendanceAdmin).toBe(true)
  })

  it('enables elearning only from an explicit backend true', async () => {
    const features = await loadWithSessionFeatures({ elearning: true }, { role: 'user' })
    expect(features.elearning).toBe(true)
  })

  it('keeps elearning off when the backend explicitly sends false', async () => {
    const features = await loadWithSessionFeatures({ elearning: false })
    expect(features.elearning).toBe(false)
  })

  it('does not infer elearning from admin role, platform mode, or an active plugin-elearning', async () => {
    const features = await loadWithSessionFeatures(
      { mode: 'platform' },
      {
        includeAttendanceWorkflow: false,
        plugins: [{ name: 'plugin-elearning', status: 'active' }],
      },
    )
    expect(features.elearning).toBe(false)
    expect(features.mode).toBe('platform')
  })

  it('lets the authorized DEV override enable elearning over backend false', async () => {
    const features = await loadWithSessionFeatures(
      { elearning: false },
      { override: { elearning: true } },
    )
    expect(features.elearning).toBe(true)
  })
})

// R-69 1b-iii (I4 verifier F2): the rule editor offers run_integration_job only while the session feature
// integrationAutomationRunAction is true. Default OFF before the session loads, OFF when an (older) backend omits
// the key, and ON only from an explicit backend boolean true — never from a string, the admin role or plugin state.
describe('integrationAutomationRunAction feature flag', () => {
  it.each([
    [{ data: { user: { features: { integrationAutomationRunAction: true } } } }, true],
    [{ data: { user: { features: { integrationAutomationRunAction: false } } } }, false],
    [{ data: { user: { features: { integrationAutomationRunAction: 'true' } } } }, undefined],
    [{ data: { user: { features: { integrationAutomationRunAction: 1 } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from the payload key', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).integrationAutomationRunAction).toBe(expected)
  })

  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadWith(features: Record<string, unknown>, role = 'admin') {
    localStorage.setItem('auth_token', 'session-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { user: { role, features: { attendance: true, workflow: false, ...features } } } }),
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }))
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const features_ = await flags.loadProductFeatures(true)
    return { features: features_, hasFeature: flags.hasFeature }
  }

  it('is off before the session has loaded (store default)', async () => {
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    expect(flags.state.loaded).toBe(false)
    expect(flags.hasFeature('integrationAutomationRunAction')).toBe(false)
  })

  it('stays off when the backend omits the key, even for an administrator', async () => {
    const { features, hasFeature } = await loadWith({})
    expect(features.integrationAutomationRunAction).toBe(false)
    expect(hasFeature('integrationAutomationRunAction')).toBe(false)
  })

  it('stays off for an explicit backend false or a string "true"', async () => {
    expect((await loadWith({ integrationAutomationRunAction: false })).features.integrationAutomationRunAction).toBe(false)
    vi.resetModules()
    expect((await loadWith({ integrationAutomationRunAction: 'true' })).features.integrationAutomationRunAction).toBe(false)
  })

  it('turns on only from an explicit backend boolean true (not role-derived)', async () => {
    const { features, hasFeature } = await loadWith({ integrationAutomationRunAction: true }, 'user')
    expect(features.integrationAutomationRunAction).toBe(true)
    expect(hasFeature('integrationAutomationRunAction')).toBe(true)
  })
})

// R-69 1c: the rule editor offers the integration.run_finished trigger only while the session feature
// integrationAutomationRunEvent is true. Same discipline: OFF before the session loads, OFF when an (older) backend
// omits the key, ON only from an explicit backend boolean true — never from a string, the admin role or plugin state.
describe('integrationAutomationRunEvent feature flag', () => {
  it.each([
    [{ data: { user: { features: { integrationAutomationRunEvent: true } } } }, true],
    [{ data: { user: { features: { integrationAutomationRunEvent: false } } } }, false],
    [{ data: { user: { features: { integrationAutomationRunEvent: 'true' } } } }, undefined],
    [{ data: { user: { features: { integrationAutomationRunEvent: 1 } } } }, undefined],
    [{ data: { user: { features: {} } } }, undefined],
  ])('parses only an explicit boolean from the payload key', (payload, expected) => {
    expect(extractFeaturesFromPayload(payload).integrationAutomationRunEvent).toBe(expected)
  })

  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadWith(features: Record<string, unknown>, role = 'admin') {
    localStorage.setItem('auth_token', 'session-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { user: { role, features: { attendance: true, workflow: false, ...features } } } }),
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }))
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    const flags = useFeatureFlags()
    const loaded = await flags.loadProductFeatures(true)
    return { features: loaded, hasFeature: flags.hasFeature }
  }

  it('is off before the session has loaded, and when the backend omits the key (even for an administrator)', async () => {
    const { useFeatureFlags } = await import('../src/stores/featureFlags')
    expect(useFeatureFlags().hasFeature('integrationAutomationRunEvent')).toBe(false)
    vi.resetModules()
    const { features, hasFeature } = await loadWith({})
    expect(features.integrationAutomationRunEvent).toBe(false)
    expect(hasFeature('integrationAutomationRunEvent')).toBe(false)
  })

  it('stays off for a string "true", and turns on only from an explicit boolean true (not role-derived)', async () => {
    expect((await loadWith({ integrationAutomationRunEvent: 'true' })).features.integrationAutomationRunEvent).toBe(false)
    vi.resetModules()
    const { features, hasFeature } = await loadWith({ integrationAutomationRunEvent: true }, 'user')
    expect(features.integrationAutomationRunEvent).toBe(true)
    expect(hasFeature('integrationAutomationRunEvent')).toBe(true)
    // independent of the action switch's key
    expect(features.integrationAutomationRunAction).toBe(false)
  })
})
