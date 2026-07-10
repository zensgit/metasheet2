import { describe, it, expect, vi } from 'vitest'
import { PLMAdapter, isFeatureAvailable } from '../../src/data-adapters/PLMAdapter'

const createAdapter = () => {
  const configService = { get: vi.fn().mockResolvedValue(undefined) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const adapter = new PLMAdapter(configService as any, logger as any)
  ;(adapter as any).apiMode = 'yuantus'
  ;(adapter as any).mockMode = false
  return adapter
}

const MANIFEST = {
  schema_version: 'v1',
  provider: 'yuantus-plm',
  advisory: true,
  features: {
    approval_automation: {
      supported: true,
      api_version: 'v1',
      entitled: true,
      cache_scope: { supported: 'global', entitled: 'tenant' },
      scenarios: ['eco'],
      actions: ['notify'],
      action_status: 'stubbed',
    },
    bom_multitable: {
      supported: false,
      api_version: null,
      entitled: false,
      cache_scope: { supported: 'global', entitled: 'tenant' },
    },
  },
}

describe('PLMAdapter integration capabilities (PLM-COLLAB P2.5 handshake)', () => {
  it('returns the typed manifest in yuantus mode', async () => {
    const adapter = createAdapter()
    ;(adapter as any).query = vi.fn().mockResolvedValue({ data: [MANIFEST] })

    const result = await adapter.getIntegrationCapabilities()

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.manifest.advisory).toBe(true)
      expect(result.manifest.features.approval_automation.supported).toBe(true)
      expect(result.manifest.features.approval_automation.entitled).toBe(true)
      expect(result.manifest.features.approval_automation.action_status).toBe('stubbed')
      expect(result.manifest.features.bom_multitable.supported).toBe(false)
    }
  })

  it('degrades to unavailable when the endpoint is absent (404/error)', async () => {
    const adapter = createAdapter()
    ;(adapter as any).query = vi
      .fn()
      .mockRejectedValue(new Error('Request failed with status code 404'))

    const result = await adapter.getIntegrationCapabilities()

    expect(result).toEqual({ available: false, reason: 'unavailable' })
  })

  it('degrades to unsupported-mode for a non-yuantus PLM without attempting a fetch', async () => {
    const adapter = createAdapter()
    ;(adapter as any).apiMode = 'legacy'
    const queryMock = vi.fn()
    ;(adapter as any).query = queryMock

    const result = await adapter.getIntegrationCapabilities()

    expect(result).toEqual({ available: false, reason: 'unsupported-mode' })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('caches a successful manifest (a second call does not re-fetch)', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({ data: [MANIFEST] })
    ;(adapter as any).query = queryMock

    await adapter.getIntegrationCapabilities()
    await adapter.getIntegrationCapabilities()

    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('refresh clears the cache and re-fetches', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({ data: [MANIFEST] })
    ;(adapter as any).query = queryMock

    await adapter.getIntegrationCapabilities()
    await adapter.refreshIntegrationCapabilities()
    await adapter.getIntegrationCapabilities()

    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure (retries on the next call)', async () => {
    const adapter = createAdapter()
    const queryMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: [MANIFEST] })
    ;(adapter as any).query = queryMock

    const first = await adapter.getIntegrationCapabilities()
    const second = await adapter.getIntegrationCapabilities()

    expect(first.available).toBe(false)
    expect(second.available).toBe(true)
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a false-positive response (wrong provider / not advisory) as unavailable', async () => {
    const adapter = createAdapter()
    ;(adapter as any).query = vi.fn().mockResolvedValue({
      data: [{ provider: 'some-other-service', advisory: false, schema_version: 'v1', features: { x: {} } }],
    })

    const result = await adapter.getIntegrationCapabilities()

    expect(result).toEqual({ available: false, reason: 'unavailable' })
  })

  it('accepts a forward-compatible future schema_version (additive evolution)', async () => {
    const adapter = createAdapter()
    ;(adapter as any).query = vi
      .fn()
      .mockResolvedValue({ data: [{ ...MANIFEST, schema_version: 'v2' }] })

    const result = await adapter.getIntegrationCapabilities()

    expect(result.available).toBe(true)
  })

  // #4020 (PLM-COLLAB C1 follow-up): the provider now emits a unified per-feature `available`
  // field (Yuantus provider #1156). This is a STRUCTURAL passthrough / no-degrade check only --
  // getIntegrationCapabilities must accept a manifest carrying discussion_core / metasheet_review
  // / available without rejecting it as malformed. Whether any consumer VISIBILITY branch acts on
  // `available` is out of scope here (see isFeatureAvailable below and the plm-workbench route
  // tests) -- this slice does not wire any discussion UI affordance.
  it('accepts a forward-compatible manifest carrying discussion_core/metasheet_review/available without degrading (#4020)', async () => {
    const adapter = createAdapter()
    const manifestWithAvailable = {
      ...MANIFEST,
      features: {
        ...MANIFEST.features,
        discussion_core: {
          supported: true,
          api_version: 'v1',
          entitled: false,
          available: true,
          packaging: 'base',
          cache_scope: { supported: 'global', entitled: 'tenant', available: 'tenant' },
          scenarios: ['object_discussion'],
        },
        metasheet_review: {
          supported: true,
          api_version: 'v1',
          entitled: false,
          available: false,
          packaging: 'paid',
          cache_scope: { supported: 'global', entitled: 'tenant', available: 'tenant' },
          scenarios: ['bom_review'],
        },
      },
    }
    ;(adapter as any).query = vi.fn().mockResolvedValue({ data: [manifestWithAvailable] })

    const result = await adapter.getIntegrationCapabilities()

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.manifest.features.discussion_core.available).toBe(true)
      expect(result.manifest.features.discussion_core.entitled).toBe(false)
      expect(result.manifest.features.metasheet_review.available).toBe(false)
      // pre-existing keys pass through untouched alongside the new ones
      expect(result.manifest.features.bom_multitable.supported).toBe(false)
    }
  })
})

// #4020: isFeatureAvailable is the shared affordance-visibility judgment every capability
// consumer routes through -- consumes entry.available DIRECTLY when the provider sends it,
// and falls back to the pre-#4020 supported+entitled derivation only when it is absent (an
// older provider manifest), so nothing regresses for a not-yet-upgraded PLM.
describe('isFeatureAvailable (#4020 unified affordance-visibility formula)', () => {
  it('discussion_core-shaped entry: entitled=false + available=true -> visible (the bug #4020 fixes)', () => {
    // Base-packaged feature, no license row on this deployment: entitled reads false, but the
    // provider-computed available says visible -- a naive entitled-only derivation would have
    // wrongly hidden this affordance.
    expect(
      isFeatureAvailable({
        supported: true,
        api_version: 'v1',
        entitled: false,
        available: true,
      }),
    ).toBe(true)
  })

  it('paid-key-shaped entry: available=false -> hidden even though supported=true', () => {
    expect(
      isFeatureAvailable({
        supported: true,
        api_version: 'v1',
        entitled: false,
        available: false,
      }),
    ).toBe(false)
  })

  it('available absent (older provider manifest) -> falls back to supported && entitled', () => {
    expect(
      isFeatureAvailable({ supported: true, api_version: 'v1', entitled: true }),
    ).toBe(true)
    expect(
      isFeatureAvailable({ supported: true, api_version: 'v1', entitled: false }),
    ).toBe(false)
    expect(
      isFeatureAvailable({ supported: false, api_version: null, entitled: true }),
    ).toBe(false)
  })

  it('missing/undefined entry -> never available', () => {
    expect(isFeatureAvailable(undefined)).toBe(false)
    expect(isFeatureAvailable(null)).toBe(false)
  })
})
