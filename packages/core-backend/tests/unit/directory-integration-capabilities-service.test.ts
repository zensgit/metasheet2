import { describe, expect, it, vi } from 'vitest'
import {
  createDirectoryIntegrationCapabilitiesService,
  type CapabilitiesServiceDeps,
} from '../../src/integrations/directory-integration-capabilities-service'
import type { CapabilityRow } from '../../src/integrations/integration-capability-evaluate'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import {
  resolveProviderCapabilityDescriptor,
  scopeFromValues,
  type ProviderCapabilityDescriptor,
} from '../../src/integrations/provider-capability-registry'

const ID = '11111111-1111-4111-8111-111111111111'
const CORP = 'ding-corp-secret-id'
const APP_KEY = 'ding-app-key-secret'

type Row = Record<string, unknown>

function integrationRow(overrides: Row = {}): Row {
  return {
    id: ID,
    org_id: 'default',
    provider: 'dingtalk',
    status: 'active',
    corp_id: CORP,
    config: { appKey: APP_KEY, appSecret: 'enc:secret', workNotificationAgentId: 'enc:agent' },
    sync_enabled: true,
    schedule_cron: '0 2 * * *',
    ...overrides,
  }
}

function stateRow(overrides: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    integration_id: ID,
    bound_provider: 'dingtalk',
    bound_org_id: 'default',
    directory_enabled: false,
    directory_bound_tenant: null,
    directory_bound_app_scope: null,
    login_enabled: false,
    login_bound_tenant: null,
    login_bound_app_scope: null,
    notification_enabled: false,
    notification_bound_tenant: null,
    notification_bound_app_scope: null,
    revision: '4',
    created_by: 'admin-1',
    updated_by: 'admin-1',
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-02T03:04:05.000Z'),
    ...overrides,
  }
}

function executor(options: { tables?: boolean; integration?: Row | null; state?: object | null } = {}) {
  const tables = options.tables ?? true
  const integration = options.integration === undefined ? integrationRow() : options.integration
  const state = (options.state === undefined ? null : options.state) as Row | null
  const query = vi.fn(async (sql: string) => {
    if (/to_regclass/.test(sql)) return { rows: [{ capabilities: tables, history: tables }], rowCount: 1 }
    if (/FROM directory_integrations/.test(sql)) return { rows: integration ? [integration] : [], rowCount: integration ? 1 : 0 }
    if (/FROM directory_integration_capabilities/.test(sql)) return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
    throw new Error('unexpected statement')
  })
  return query
}

function deps(query: ReturnType<typeof executor>, overrides: Partial<CapabilitiesServiceDeps> = {}): CapabilitiesServiceDeps {
  return {
    executor: { query },
    isEnabled: () => true,
    resolveDescriptor: resolveProviderCapabilityDescriptor,
    isImplementationAvailable: isCapabilityImplementationAvailable,
    readLoginRuntime: () => ({ available: true, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
    isIntegrationScopedCredentialsEnabled: () => false,
    ...overrides,
  }
}

const NO_ANCHOR = { bound: false, matchesCurrent: null }

describe('read: switch and schema', () => {
  it('issues no statement while the switch is off', async () => {
    const query = executor()
    const service = createDirectoryIntegrationCapabilitiesService(deps(query, { isEnabled: () => false }))
    expect(service.isEnabled()).toBe(false)
    expect(await service.read(ID)).toEqual({ kind: 'disabled' })
    expect(query).not.toHaveBeenCalled()
  })

  it('stops after the existence probe when a table is missing', async () => {
    const query = executor({ tables: false })
    const service = createDirectoryIntegrationCapabilitiesService(deps(query))
    expect(await service.read(ID)).toEqual({ kind: 'schema_unavailable' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('reports a missing integration after reading it only', async () => {
    const query = executor({ integration: null })
    const service = createDirectoryIntegrationCapabilitiesService(deps(query))
    expect(await service.read(ID)).toEqual({ kind: 'not_found' })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('lets a database error through for the route to answer with its fixed sentence', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }))
    const service = createDirectoryIntegrationCapabilitiesService(deps(query))
    await expect(service.read(ID)).rejects.toMatchObject({ code: '57014' })
  })
})

describe('view for a dingtalk integration with no capability row', () => {
  it('shows every capability as legacy-governed, off and unbound, with the legacy blocks', async () => {
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor()))
    const result = await service.read(ID)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.view).toEqual({
      integrationId: ID,
      provider: 'dingtalk',
      integrationStatus: 'active',
      revision: 0,
      updatedAt: null,
      capabilities: {
        directory: {
          enabled: false, governance: 'legacy', effective: null, reason: 'governed_by_legacy_path', anchor: NO_ANCHOR,
          legacy: { syncEnabled: true, scheduleConfigured: true },
        },
        login: {
          enabled: false, governance: 'legacy', effective: null, reason: 'governed_by_legacy_path', anchor: NO_ANCHOR,
          legacy: { covers: 'oauth_scan_login_only', available: true, requireGrant: false, autoLinkEmail: false, autoProvision: false },
        },
        notification: {
          enabled: false, governance: 'legacy', effective: null, reason: 'governed_by_legacy_path', anchor: NO_ANCHOR,
          legacy: {
            integrationScopedCredentialsSwitch: false,
            verification: { route: '/api/admin/directory/dingtalk/work-notification/verify', levels: ['config', 'token', 'send'] },
          },
        },
      },
    })
  })

  it('carries no corp id, application key, secret, environment value or scope value anywhere in the view', async () => {
    const runtime = { available: true, requireGrant: true, autoLinkEmail: true, autoProvision: true, corpId: 'env-corp-value', allowedCorpIds: ['env-allowed-corp'], missingEnv: ['X'], unavailableReason: null, configured: true }
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor(), { readLoginRuntime: () => runtime }))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    const text = JSON.stringify(result.view)
    for (const value of [CORP, APP_KEY, 'enc:secret', 'enc:agent', 'env-corp-value', 'env-allowed-corp', '0 2 * * *', 'allowedCorpIds', 'corpId', 'appKey']) {
      expect(text).not.toContain(value)
    }
    expect(result.view.capabilities.login.legacy).toEqual({
      covers: 'oauth_scan_login_only', available: true, requireGrant: true, autoLinkEmail: true, autoProvision: true,
    })
  })

  it('shows the schedule as not configured for a blank cron and sync as off', async () => {
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ integration: integrationRow({ sync_enabled: false, schedule_cron: '  ' }) })))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.capabilities.directory.legacy).toEqual({ syncEnabled: false, scheduleConfigured: false })
  })

  it('shows the integration-scoped credentials switch as it is', async () => {
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor(), { isIntegrationScopedCredentialsEnabled: () => true }))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect((result.view.capabilities.notification.legacy as { integrationScopedCredentialsSwitch: boolean }).integrationScopedCredentialsSwitch).toBe(true)
  })
})

describe('view with a stored capability row', () => {
  it('shows the revision as an integer and the update time as an ISO string, and the anchor as bound without its value', async () => {
    const state = stateRow({ login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP_KEY })
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ state })))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.revision).toBe(4)
    expect(result.view.updatedAt).toBe('2026-11-02T03:04:05.000Z')
    expect(result.view.capabilities.login.enabled).toBe(true)
    expect(result.view.capabilities.login.anchor).toEqual({ bound: true, matchesCurrent: true })
    expect(result.view.capabilities.directory.anchor).toEqual(NO_ANCHOR)
    expect(JSON.stringify(result.view)).not.toContain(APP_KEY)
  })

  it('shows an anchor that no longer matches the integration as not matching', async () => {
    const state = stateRow({ notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: 'an-older-key' })
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ state })))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.capabilities.notification.anchor).toEqual({ bound: true, matchesCurrent: false })
  })

  it('refuses a revision outside the safe integer range or not an integer', async () => {
    for (const revision of ['9007199254740993', '-1', '1.5', 'abc', '']) {
      const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ state: stateRow({ revision }) })))
      await expect(service.read(ID), revision).rejects.toThrow()
    }
    const ok = createDirectoryIntegrationCapabilitiesService(deps(executor({ state: stateRow({ revision: '9007199254740991' }) })))
    const result = await ok.read(ID)
    expect(result.kind === 'ok' && result.view.revision).toBe(9007199254740991)
  })
})

describe('view for a provider that is not registered', () => {
  it('shows governance null, effective null and the reason for every capability, with no legacy block', async () => {
    for (const provider of ['local', 'wecom']) {
      const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ integration: integrationRow({ provider }) })))
      const result = await service.read(ID)
      if (result.kind !== 'ok') throw new Error('expected a view')
      for (const capability of ['directory', 'login', 'notification'] as const) {
        expect(result.view.capabilities[capability]).toEqual({
          enabled: false, governance: null, effective: null, reason: 'provider_not_registered', anchor: NO_ANCHOR,
        })
      }
    }
  })
})

describe('view with an injected registry (gated capabilities)', () => {
  const gated: ProviderCapabilityDescriptor = {
    provider: 'acme',
    governance: { directory: 'gated', login: 'gated', notification: 'unsupported' },
    scopeOf: (row) => scopeFromValues(row.corp_id, (row.config as { app?: string }).app ?? ''),
    enablePreconditions: async () => ({ ok: true }),
  }
  const integration = () => integrationRow({ provider: 'acme', corp_id: 'corp-1', config: { app: 'app-1' } })

  it('gives effective true or false only for gated capabilities', async () => {
    const state = stateRow({
      bound_provider: 'acme',
      login_enabled: true, login_bound_tenant: 'corp-1', login_bound_app_scope: 'app-1',
    })
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ integration: integration(), state }), {
      resolveDescriptor: (provider) => (provider === 'acme' ? gated : null),
      isImplementationAvailable: () => true,
    }))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.capabilities.login).toMatchObject({ governance: 'gated', effective: true, reason: null, enabled: true })
    expect(result.view.capabilities.directory).toMatchObject({ governance: 'gated', effective: false, reason: 'not_enabled', enabled: false })
    expect(result.view.capabilities.notification).toMatchObject({ governance: 'unsupported', effective: null, reason: 'unsupported' })
    expect(result.view.capabilities.login.legacy).toBeUndefined()
  })

  it('reports a gated capability with no implementation as not effective', async () => {
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ integration: integration() }), {
      resolveDescriptor: () => gated,
      isImplementationAvailable: () => false,
    }))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.capabilities.login).toMatchObject({ effective: false, reason: 'implementation_missing' })
  })

  it('reports a stored row that belongs to another integration as a mismatch', async () => {
    const state = stateRow({ bound_provider: 'acme', integration_id: '22222222-2222-4222-8222-222222222222' })
    const service = createDirectoryIntegrationCapabilitiesService(deps(executor({ integration: integration(), state }), {
      resolveDescriptor: () => gated,
      isImplementationAvailable: () => true,
    }))
    const result = await service.read(ID)
    if (result.kind !== 'ok') throw new Error('expected a view')
    expect(result.view.capabilities.login).toMatchObject({ effective: false, reason: 'state_mismatch' })
  })
})

describe('production binding of the implementation table', () => {
  it('has no implementation for any provider, so no capability can be effective', () => {
    for (const provider of ['dingtalk', 'wecom', 'local']) {
      for (const capability of ['directory', 'login', 'notification'] as const) {
        expect(isCapabilityImplementationAvailable(provider, capability)).toBe(false)
      }
    }
  })
})
