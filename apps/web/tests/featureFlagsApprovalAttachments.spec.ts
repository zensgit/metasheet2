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
