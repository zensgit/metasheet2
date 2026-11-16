import { describe, expect, it, vi } from 'vitest'
import {
  evaluateIntegrationCapability,
  peekIntegrationCapabilityState,
  probeCapabilityTables,
  type CapabilityRow,
  type EvaluateInput,
} from '../../src/integrations/integration-capability-evaluate'
import type { IntegrationCapability, ProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { scopeFromValues } from '../../src/integrations/provider-capability-registry'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'

function gatedDescriptor(provider = 'acme'): ProviderCapabilityDescriptor {
  return {
    provider,
    governance: { directory: 'gated', login: 'gated', notification: 'gated' },
    scopeOf: (row) => {
      const config = row.config as { app?: string } | null
      return scopeFromValues(row.corp_id, config?.app ?? '')
    },
    enablePreconditions: async () => ({ ok: true }),
  }
}

function stateRow(overrides: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    integration_id: ID,
    bound_provider: 'acme',
    bound_org_id: 'org-1',
    directory_enabled: true,
    directory_bound_tenant: 'corp-1',
    directory_bound_app_scope: 'app-1',
    login_enabled: true,
    login_bound_tenant: 'corp-1',
    login_bound_app_scope: 'app-1',
    notification_enabled: true,
    notification_bound_tenant: 'corp-1',
    notification_bound_app_scope: 'app-1',
    revision: '3',
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-02T00:00:00Z'),
    ...overrides,
  }
}

function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    capability: 'login',
    switchOn: true,
    schemaAvailable: true,
    descriptor: gatedDescriptor(),
    implementationAvailable: true,
    expectedOrgId: 'org-1',
    integration: { id: ID, org_id: 'org-1', provider: 'acme', status: 'active', corp_id: 'corp-1', config: { app: 'app-1' } },
    state: stateRow(),
    ...overrides,
  }
}

describe('evaluateIntegrationCapability: one case per reason, in the fixed order', () => {
  it('is effective when every condition holds', () => {
    expect(evaluateIntegrationCapability(input())).toEqual({ effective: true, reason: null })
  })

  it('refuses a blank expected organization even when the integration organization is blank too', () => {
    const blank = input({
      expectedOrgId: '',
      integration: { ...input().integration, org_id: '' },
      state: stateRow({ bound_org_id: '' }),
    })
    expect(evaluateIntegrationCapability(blank)).toEqual({ effective: false, reason: 'org_mismatch' })
    const spaces = input({
      expectedOrgId: '  ',
      integration: { ...input().integration, org_id: '  ' },
      state: stateRow({ bound_org_id: '  ' }),
    })
    expect(evaluateIntegrationCapability(spaces)).toEqual({ effective: false, reason: 'org_mismatch' })
  })

  it('refuses with each reason', () => {
    const cases: Array<[string, Partial<EvaluateInput>]> = [
      ['switch_off', { switchOn: false }],
      ['schema_unavailable', { schemaAvailable: false }],
      ['org_mismatch', { expectedOrgId: 'org-2' }],
      ['org_mismatch', { expectedOrgId: '' }],
      ['org_mismatch', { expectedOrgId: '   ' }],
      ['state_mismatch', { state: stateRow({ integration_id: OTHER_ID }) }],
      ['state_mismatch', { state: stateRow({ bound_provider: 'other' }) }],
      ['state_mismatch', { state: stateRow({ bound_org_id: 'org-2' }) }],
      ['provider_not_registered', { descriptor: null }],
      ['governed_by_legacy_path', { descriptor: { ...gatedDescriptor(), governance: { directory: 'legacy', login: 'legacy', notification: 'legacy' } } }],
      ['unsupported', { descriptor: { ...gatedDescriptor(), governance: { directory: 'unsupported', login: 'unsupported', notification: 'unsupported' } } }],
      ['implementation_missing', { implementationAvailable: false }],
      ['not_enabled', { state: null }],
      ['not_enabled', { state: stateRow({ login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null }) }],
      ['integration_inactive', { integration: { ...input().integration, status: 'disabled' } }],
      ['scope_changed', { integration: { ...input().integration, config: { app: 'app-2' } } }],
      ['scope_changed', { integration: { ...input().integration, corp_id: 'corp-2' } }],
      ['scope_changed', { integration: { ...input().integration, config: {} } }],
    ]
    for (const [reason, overrides] of cases) {
      expect(evaluateIntegrationCapability(input(overrides)), reason).toEqual({ effective: false, reason })
    }
  })

  it('returns the earlier reason when two conditions fail together', () => {
    const order: Array<[string, Partial<EvaluateInput>, string, Partial<EvaluateInput>]> = [
      ['switch_off', { switchOn: false }, 'schema_unavailable', { schemaAvailable: false }],
      ['schema_unavailable', { schemaAvailable: false }, 'org_mismatch', { expectedOrgId: 'org-2' }],
      ['org_mismatch', { expectedOrgId: 'org-2' }, 'provider_not_registered', { descriptor: null }],
      ['org_mismatch', { expectedOrgId: 'org-2' }, 'state_mismatch', { state: stateRow({ bound_provider: 'other' }) }],
      ['state_mismatch', { state: stateRow({ bound_provider: 'other' }) }, 'provider_not_registered', { descriptor: null }],
      ['provider_not_registered', { descriptor: null }, 'not_enabled', { state: null }],
      ['implementation_missing', { implementationAvailable: false }, 'not_enabled', { state: null }],
      ['not_enabled', { state: null }, 'integration_inactive', { integration: { ...input().integration, status: 'disabled' } }],
    ]
    for (const [first, firstOverrides, second, secondOverrides] of order) {
      const both = evaluateIntegrationCapability(input({ ...firstOverrides, ...secondOverrides }))
      expect(both.reason, `${first} before ${second}`).toBe(first)
    }
    const inactiveAndChanged = evaluateIntegrationCapability(
      input({ integration: { ...input().integration, status: 'disabled', config: { app: 'app-2' } } }),
    )
    expect(inactiveAndChanged.reason).toBe('integration_inactive')
  })

  it('does not compare the organization when none is given', () => {
    expect(evaluateIntegrationCapability(input({ expectedOrgId: undefined, integration: { ...input().integration, org_id: 'org-9' }, state: stateRow({ bound_org_id: 'org-9' }) }))).toEqual({ effective: true, reason: null })
  })

  it('judges each capability by its own anchor', () => {
    const state = stateRow({ login_bound_app_scope: 'stale-app' })
    const caps: IntegrationCapability[] = ['directory', 'login', 'notification']
    const results = Object.fromEntries(caps.map((capability) => [capability, evaluateIntegrationCapability(input({ capability, state }))]))
    expect(results.login).toEqual({ effective: false, reason: 'scope_changed' })
    expect(results.directory).toEqual({ effective: true, reason: null })
    expect(results.notification).toEqual({ effective: true, reason: null })
  })

  it('treats an anchor that is only partly present as no match', () => {
    const state = stateRow({ login_bound_tenant: null })
    expect(evaluateIntegrationCapability(input({ state }))).toEqual({ effective: false, reason: 'scope_changed' })
  })
})

describe('probeCapabilityTables', () => {
  it('is true only when both tables exist, and asks with to_regclass', async () => {
    const query = vi.fn()
    query.mockResolvedValueOnce({ rows: [{ capabilities: true, history: true }] })
    expect(await probeCapabilityTables({ query })).toBe(true)
    expect(String(query.mock.calls[0][0])).toContain("to_regclass('directory_integration_capabilities')")
    expect(String(query.mock.calls[0][0])).toContain("to_regclass('directory_integration_capability_history')")
    for (const row of [{ capabilities: true, history: false }, { capabilities: false, history: true }, { capabilities: false, history: false }, {}]) {
      query.mockResolvedValueOnce({ rows: [row] })
      expect(await probeCapabilityTables({ query })).toBe(false)
    }
    query.mockResolvedValueOnce({ rows: [] })
    expect(await probeCapabilityTables({ query })).toBe(false)
  })

  it('runs one plain statement and does not catch a database error', async () => {
    const query = vi.fn().mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }))
    await expect(probeCapabilityTables({ query })).rejects.toMatchObject({ code: '57014' })
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('peekIntegrationCapabilityState', () => {
  it('reads the integration and then the capability row, without locking', async () => {
    const integration = { id: ID, org_id: 'org-1', provider: 'acme', status: 'active', corp_id: 'c', config: {}, sync_enabled: false, schedule_cron: null }
    const query = vi.fn().mockResolvedValueOnce({ rows: [integration] }).mockResolvedValueOnce({ rows: [stateRow()] })
    const peeked = await peekIntegrationCapabilityState({ query }, ID)
    expect(peeked?.integration).toBe(integration)
    expect(peeked?.state?.revision).toBe('3')
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[0][0])).toMatch(/FROM directory_integrations WHERE id = \$1::uuid/)
    expect(String(query.mock.calls[1][0])).toMatch(/FROM directory_integration_capabilities WHERE integration_id = \$1::uuid/)
    for (const call of query.mock.calls) {
      expect(String(call[0])).not.toMatch(/FOR\s+(SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i)
      expect(call[1]).toEqual([ID])
    }
  })

  it('returns a null state when there is no row, and null when the integration is missing (one statement)', async () => {
    const integration = { id: ID, org_id: 'org-1', provider: 'acme', status: 'active', corp_id: 'c', config: {}, sync_enabled: false, schedule_cron: null }
    const withoutState = vi.fn().mockResolvedValueOnce({ rows: [integration] }).mockResolvedValueOnce({ rows: [] })
    expect((await peekIntegrationCapabilityState({ query: withoutState }, ID))?.state).toBeNull()
    const missing = vi.fn().mockResolvedValueOnce({ rows: [] })
    expect(await peekIntegrationCapabilityState({ query: missing }, ID)).toBeNull()
    expect(missing).toHaveBeenCalledTimes(1)
  })
})
