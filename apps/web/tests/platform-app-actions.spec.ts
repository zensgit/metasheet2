import { describe, expect, it } from 'vitest'
import {
  resolvePlatformAppInstallState,
  resolvePlatformAppPrimaryAction,
  type PlatformAppSummary,
} from '../src/composables/usePlatformApps'

function createAppSummary(overrides: Partial<PlatformAppSummary> = {}): PlatformAppSummary {
  return {
    id: 'after-sales',
    pluginId: 'plugin-after-sales',
    pluginName: 'plugin-after-sales',
    pluginVersion: '1.0.0',
    pluginDisplayName: 'After Sales Plugin',
    pluginStatus: 'active',
    pluginError: undefined,
    displayName: 'After Sales',
    runtimeModel: 'instance',
    boundedContext: {
      code: 'after-sales',
      description: 'Support ops',
    },
    platformDependencies: ['multitable'],
    navigation: [],
    permissions: [],
    featureFlags: [],
    objects: [],
    workflows: [],
    integrations: [],
    entryPath: '/p/plugin-after-sales/after-sales',
    instance: null,
    ...overrides,
  }
}

describe('resolvePlatformAppPrimaryAction', () => {
  it('returns onboarding action when no app instance exists', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary())
    expect(action).toMatchObject({
      kind: 'onboard',
      label: 'Open onboarding',
      route: '/p/plugin-after-sales/after-sales',
    })
  })

  it('returns install action for instance apps with manifest install bindings', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary({
      runtimeBindings: {
        currentPath: '/api/after-sales/projects/current',
        installPath: '/api/after-sales/projects/install',
        installPayload: {
          templateId: 'after-sales-default',
        },
      },
    }))

    expect(action).toMatchObject({
      kind: 'install',
      label: 'Install app',
      route: '/apps/after-sales',
      mutation: {
        path: '/api/after-sales/projects/install',
        payload: {
          templateId: 'after-sales-default',
        },
      },
    })
  })

  it('returns recovery action for failed instances', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary({
      runtimeBindings: {
        currentPath: '/api/after-sales/projects/current',
        installPath: '/api/after-sales/projects/install',
        installPayload: {
          templateId: 'after-sales-default',
        },
      },
      instance: {
        id: 'pai_1',
        tenantId: 'tenant_42',
        workspaceId: 'tenant_42',
        appId: 'after-sales',
        pluginId: 'plugin-after-sales',
        instanceKey: 'primary',
        projectId: 'tenant_42:after-sales',
        displayName: 'Acme Support',
        status: 'failed',
        config: {},
        metadata: {},
      },
    }))

    expect(action).toMatchObject({
      kind: 'reinstall',
      label: 'Reinstall app',
      route: '/apps/after-sales',
      mutation: {
        path: '/api/after-sales/projects/install',
        payload: {
          templateId: 'after-sales-default',
          mode: 'reinstall',
        },
      },
    })
  })

  it('returns direct open action for active instances', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary({
      instance: {
        id: 'pai_1',
        tenantId: 'tenant_42',
        workspaceId: 'tenant_42',
        appId: 'after-sales',
        pluginId: 'plugin-after-sales',
        instanceKey: 'primary',
        projectId: 'tenant_42:after-sales',
        displayName: 'Acme Support',
        status: 'active',
        config: {},
        metadata: {},
      },
    }))

    expect(action).toMatchObject({
      kind: 'open',
      label: 'Open app',
      route: '/p/plugin-after-sales/after-sales',
    })
  })

  it('falls back to shell inspection when plugin runtime failed', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary({
      pluginStatus: 'failed',
    }))

    expect(action).toMatchObject({
      kind: 'inspect',
      label: 'Inspect shell',
      route: '/apps/after-sales',
    })
  })

  it('returns direct open action for direct-runtime apps without instance state', () => {
    const action = resolvePlatformAppPrimaryAction(createAppSummary({
      id: 'attendance',
      pluginId: 'plugin-attendance',
      pluginName: 'plugin-attendance',
      displayName: 'Attendance',
      runtimeModel: 'direct',
      entryPath: '/attendance',
      instance: null,
    }))

    expect(action).toMatchObject({
      kind: 'open',
      label: 'Open app',
      route: '/attendance',
    })
  })

  it('reports direct install state for direct-runtime apps', () => {
    const installState = resolvePlatformAppInstallState(createAppSummary({
      id: 'attendance',
      pluginId: 'plugin-attendance',
      pluginName: 'plugin-attendance',
      displayName: 'Attendance',
      runtimeModel: 'direct',
      entryPath: '/attendance',
      instance: null,
    }))

    expect(installState).toBe('direct')
  })
})
