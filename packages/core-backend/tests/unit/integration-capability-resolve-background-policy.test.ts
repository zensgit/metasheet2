/** Policy-only registry mocks are isolated from production-registry parity and vectors. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INPUT, refusal, scripted } from '../helpers/background-capability-fixture'

const control = vi.hoisted(() => ({ governance: 'gated', implemented: true }))
vi.mock('../../src/integrations/provider-capability-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/provider-capability-registry')>()
  return {
    ...actual,
    resolveProviderCapabilityDescriptor: (provider: string) => {
      const descriptor = actual.resolveProviderCapabilityDescriptor(provider)
      return descriptor && { ...descriptor, governance: { ...descriptor.governance, notification: control.governance } }
    },
  }
})
vi.mock('../../src/integrations/integration-capability-implementations', () => ({
  isCapabilityImplementationAvailable: () => control.implemented,
}))

import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'

beforeEach(() => {
  vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED', 'true')
  control.governance = 'gated'
  control.implemented = true
})
afterEach(() => { vi.unstubAllEnvs() })

describe('BG-U06: governance and implementation refusals', () => {
  it.each([
    ['legacy', true, 'governed_by_legacy_path'],
    ['unsupported', true, 'unsupported'],
    ['gated', false, 'implementation_missing'],
    ['legacy', false, 'governed_by_legacy_path'],
    ['unsupported', false, 'unsupported'],
  ])('keeps %s / implemented=%j before stored state', async (governance, implemented, reason) => {
    control.governance = governance as string
    control.implemented = implemented as boolean
    const { executor, statements } = scripted({ capabilities: [] })
    expect(await resolveEffectiveNotificationCapabilityForBackground(executor, INPUT)).toEqual(refusal(reason as string))
    expect(statements).toHaveLength(6)
  })
})
