import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as registryModule from '../../src/integrations/provider-capability-registry'
import {
  ANCHOR_APP_SCOPE_MAX_LENGTH,
  ANCHOR_APP_SCOPE_PATTERN,
  ANCHOR_TENANT_PATTERN,
  INTEGRATION_CAPABILITIES,
  PROVIDER_NAME_PATTERN,
  assertRegistryWellFormed,
  lookupProviderCapabilityDescriptor,
  resolveProviderCapabilityDescriptor,
  scopeFromValues,
  type ProviderCapabilityDescriptor,
} from '../../src/integrations/provider-capability-registry'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'db',
  'migrations',
  'zzzz20261106130000_create_directory_integration_capabilities.ts',
)

function descriptor(provider: string, governance: Partial<Record<(typeof INTEGRATION_CAPABILITIES)[number], 'legacy' | 'gated' | 'unsupported'>>, extra: Partial<ProviderCapabilityDescriptor> = {}): ProviderCapabilityDescriptor {
  return {
    provider,
    governance: { directory: 'unsupported', login: 'unsupported', notification: 'unsupported', ...governance },
    scopeOf: () => null,
    ...extra,
  }
}

describe('production registry', () => {
  it('registers exactly dingtalk, with every capability governed by the legacy path', () => {
    const dingtalk = resolveProviderCapabilityDescriptor('dingtalk')
    expect(dingtalk).not.toBeNull()
    expect(dingtalk!.provider).toBe('dingtalk')
    expect(dingtalk!.governance).toEqual({ directory: 'legacy', login: 'legacy', notification: 'legacy' })
    for (const capability of INTEGRATION_CAPABILITIES) expect(dingtalk!.governance[capability]).not.toBe('gated')
    expect(dingtalk!.enablePreconditions).toBeUndefined()
  })

  it('has no entry for local, wecom, feishu or an unknown provider', () => {
    for (const provider of ['local', 'wecom', 'feishu', 'unknown', '', 'DingTalk', 'dingtalk ']) {
      expect(resolveProviderCapabilityDescriptor(provider)).toBeNull()
    }
  })

  it('has no gated entry anywhere and none that implements a capability', () => {
    for (const provider of ['dingtalk', 'local', 'wecom']) {
      const entry = resolveProviderCapabilityDescriptor(provider)
      for (const capability of INTEGRATION_CAPABILITIES) {
        if (entry) expect(entry.governance[capability]).not.toBe('gated')
        expect(isCapabilityImplementationAvailable(provider, capability)).toBe(false)
      }
    }
    expect(isCapabilityImplementationAvailable('dingtalk', 'nope' as never)).toBe(false)
    expect(isCapabilityImplementationAvailable('__proto__', 'login')).toBe(false)
  })

  it('exports no function that replaces, adds to or resets the registry', () => {
    expect(Object.keys(registryModule).sort()).toEqual([
      'ANCHOR_APP_SCOPE_MAX_LENGTH',
      'ANCHOR_APP_SCOPE_PATTERN',
      'ANCHOR_TENANT_PATTERN',
      'INTEGRATION_CAPABILITIES',
      'PROVIDER_NAME_PATTERN',
      'assertRegistryWellFormed',
      'lookupProviderCapabilityDescriptor',
      'resolveProviderCapabilityDescriptor',
      'scopeFromValues',
    ])
    expect(resolveProviderCapabilityDescriptor.length).toBe(1)
  })

  it('freezes the descriptor and its governance', () => {
    const dingtalk = resolveProviderCapabilityDescriptor('dingtalk')!
    expect(Object.isFrozen(dingtalk)).toBe(true)
    expect(Object.isFrozen(dingtalk.governance)).toBe(true)
  })
})

describe('registry shape checks', () => {
  it('rejects a gated capability that has no enable preconditions', () => {
    expect(() => assertRegistryWellFormed([descriptor('acme', { login: 'gated' })])).toThrow(/gated capability without enable preconditions/)
    expect(() =>
      assertRegistryWellFormed([descriptor('acme', { login: 'gated' }, { enablePreconditions: async () => ({ ok: true }) })]),
    ).not.toThrow()
  })

  it('ignores the same object registered twice and rejects two different entries for one provider', () => {
    const one = descriptor('acme', {})
    expect(() => assertRegistryWellFormed([one, one])).not.toThrow()
    expect(() => assertRegistryWellFormed([one, descriptor('acme', {})])).toThrow(/duplicate provider/)
  })

  it('looks a provider up in an explicitly passed registry', () => {
    const one = descriptor('acme', {})
    expect(lookupProviderCapabilityDescriptor([one], 'acme')).toBe(one)
    expect(lookupProviderCapabilityDescriptor([one], 'other')).toBeNull()
    expect(lookupProviderCapabilityDescriptor([], 'acme')).toBeNull()
  })
})

describe('scope extraction for dingtalk', () => {
  const dingtalk = resolveProviderCapabilityDescriptor('dingtalk')!
  const row = (corp_id: string, config: unknown) => ({ corp_id, config })

  it('returns the corp id and the trimmed application key', () => {
    expect(dingtalk.scopeOf(row('ding123', { appKey: 'app-key_1' }))).toEqual({ tenant: 'ding123', appScope: 'app-key_1' })
    expect(dingtalk.scopeOf(row('ding123', { appKey: '  app-key_1 ' }))).toEqual({ tenant: 'ding123', appScope: 'app-key_1' })
  })

  it('returns null for a missing, blank, spaced, non-ASCII, over-long or multi-line value', () => {
    const cases: Array<[string, unknown]> = [
      ['ding123', {}],
      ['ding123', null],
      ['ding123', []],
      ['ding123', 'text'],
      ['ding123', { appKey: '' }],
      ['ding123', { appKey: '   ' }],
      ['ding123', { appKey: 7 }],
      ['ding123', { appKey: 'two words' }],
      ['ding123', { appKey: '应用' }],
      ['ding123', { appKey: 'a'.repeat(257) }],
      ['ding123', { appKey: 'line\nbreak' }],
      ['', { appKey: 'ok' }],
      ['has space', { appKey: 'ok' }],
      ['企业', { appKey: 'ok' }],
      ['new\nline', { appKey: 'ok' }],
    ]
    for (const [corp, config] of cases) expect(dingtalk.scopeOf(row(corp, config))).toBeNull()
    expect(dingtalk.scopeOf(row('ding123', { appKey: 'a'.repeat(256) }))).not.toBeNull()
  })

  it('scopeFromValues applies the same two patterns', () => {
    expect(scopeFromValues('t', 'a')).toEqual({ tenant: 't', appScope: 'a' })
    expect(scopeFromValues('t', 'a'.repeat(257))).toBeNull()
    expect(scopeFromValues(1, 'a')).toBeNull()
    expect(scopeFromValues('t', null)).toBeNull()
  })
})

describe('shape patterns', () => {
  it('appear verbatim in the table checks', () => {
    const migration = readFileSync(MIGRATION, 'utf8')
    expect(migration).toContain(`bound_provider ~ '${PROVIDER_NAME_PATTERN}'`)
    for (const capability of INTEGRATION_CAPABILITIES) {
      expect(migration).toContain(`${capability}_bound_tenant ~ '${ANCHOR_TENANT_PATTERN}'`)
      expect(migration).toContain(`${capability}_bound_app_scope ~ '${ANCHOR_APP_SCOPE_PATTERN}'`)
      expect(migration).toContain(`char_length(${capability}_bound_app_scope) <= ${ANCHOR_APP_SCOPE_MAX_LENGTH})`)
    }
  })
})
