import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

describe('usePlatformApps', () => {
  beforeEach(async () => {
    apiGetMock.mockReset()
    vi.resetModules()
  })

  it('refetches a single app when force=true even if it exists in cache', async () => {
    const { usePlatformApps } = await import('../src/composables/usePlatformApps')
    const { fetchApps, fetchAppById, apps } = usePlatformApps()

    apiGetMock.mockResolvedValueOnce({
      list: [{
        id: 'after-sales',
        pluginId: 'plugin-after-sales',
        pluginName: 'plugin-after-sales',
        pluginVersion: '1.0.0',
        pluginDisplayName: 'After Sales Plugin',
        pluginStatus: 'active',
        displayName: 'After Sales',
        boundedContext: { code: 'after-sales' },
        platformDependencies: [],
        navigation: [],
        permissions: [],
        featureFlags: [],
        objects: [],
        workflows: [],
        integrations: [],
        entryPath: '/p/plugin-after-sales/after-sales',
        instance: null,
      }],
    })

    await fetchApps({ force: true })
    expect(apps.value[0]?.instance).toBeNull()

    apiGetMock.mockResolvedValueOnce({
      id: 'after-sales',
      pluginId: 'plugin-after-sales',
      pluginName: 'plugin-after-sales',
      pluginVersion: '1.0.0',
      pluginDisplayName: 'After Sales Plugin',
      pluginStatus: 'active',
      displayName: 'After Sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: [],
      navigation: [],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
      entryPath: '/p/plugin-after-sales/after-sales',
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
    })

    const refreshed = await fetchAppById('after-sales', { force: true })

    expect(apiGetMock).toHaveBeenNthCalledWith(1, '/api/platform/apps')
    expect(apiGetMock).toHaveBeenNthCalledWith(2, '/api/platform/apps/after-sales')
    expect(refreshed?.instance?.projectId).toBe('tenant_42:after-sales')
    expect(apps.value[0]?.instance?.projectId).toBe('tenant_42:after-sales')
  })

  it('deduplicates concurrent app fetches and clears stale error state', async () => {
    const { usePlatformApps } = await import('../src/composables/usePlatformApps')
    const { fetchAppById, apps, error, loading } = usePlatformApps()

    error.value = 'stale error'

    let resolveRequest: ((value: any) => void) | null = null
    apiGetMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRequest = resolve
    }))

    const first = fetchAppById('after-sales')
    const second = fetchAppById('after-sales')

    expect(apiGetMock).toHaveBeenCalledTimes(1)
    expect(error.value).toBeNull()
    expect(loading.value).toBe(true)

    resolveRequest?.({
      id: 'after-sales',
      pluginId: 'plugin-after-sales',
      pluginName: 'plugin-after-sales',
      pluginVersion: '1.0.0',
      pluginDisplayName: 'After Sales Plugin',
      pluginStatus: 'active',
      displayName: 'After Sales',
      runtimeModel: 'instance',
      boundedContext: { code: 'after-sales' },
      platformDependencies: [],
      navigation: [],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
      entryPath: '/p/plugin-after-sales/after-sales',
      instance: null,
    })

    const [app, duplicate] = await Promise.all([first, second])

    expect(app?.id).toBe('after-sales')
    expect(duplicate?.id).toBe('after-sales')
    expect(apps.value).toHaveLength(1)
    expect(loading.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('publishes fetch failures through the shared error and loading state', async () => {
    const { usePlatformApps } = await import('../src/composables/usePlatformApps')
    const { fetchAppById, error, loading } = usePlatformApps()

    apiGetMock.mockRejectedValueOnce(new Error('boom'))

    const result = await fetchAppById('after-sales', { force: true })

    expect(result).toBeNull()
    expect(loading.value).toBe(false)
    expect(error.value).toBe('boom')
  })
})
