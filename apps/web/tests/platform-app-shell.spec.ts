import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component, type Ref } from 'vue'
import { setPlatformAppRuntimeInstallState, type PlatformAppSummary } from '../src/composables/usePlatformApps'

let currentAppId = 'after-sales'
const appsRef = ref<PlatformAppSummary[]>([])
const loadingRef = ref(false)
const errorRef = ref<string | null>(null)
const fetchAppByIdMock = vi.fn()
const apiGetMock = vi.fn()
const apiPostMock = vi.fn()
const pushMock = vi.fn()

vi.mock('vue-router', async () => {
  const vue = await import('vue')
  return {
    useRoute: () => ({
      params: {
        appId: currentAppId,
      },
    }),
    useRouter: () => ({
      push: pushMock,
    }),
    RouterLink: vue.defineComponent({
      props: {
        to: {
          type: [String, Object],
          required: false,
        },
      },
      setup(props, { slots }) {
        return () => vue.h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default ? slots.default() : [])
      },
    }),
  }
})

vi.mock('../src/composables/usePlatformApps', async () => {
  const actual = await vi.importActual<typeof import('../src/composables/usePlatformApps')>('../src/composables/usePlatformApps')
  return {
    ...actual,
    usePlatformApps: () => ({
      apps: appsRef as Ref<PlatformAppSummary[]>,
      loading: loadingRef as Ref<boolean>,
      error: errorRef as Ref<string | null>,
      fetchAppById: fetchAppByIdMock,
    }),
  }
})

vi.mock('../src/utils/api', () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiPost: (...args: unknown[]) => apiPostMock(...args),
}))

function createInstanceApp(overrides: Partial<PlatformAppSummary> = {}): PlatformAppSummary {
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
      owner: 'customer-success',
      description: 'Support ops',
    },
    runtimeBindings: {
      currentPath: '/api/after-sales/projects/current',
      installPath: '/api/after-sales/projects/install',
      installPayload: {
        templateId: 'after-sales-default',
      },
    },
    platformDependencies: ['multitable'],
    navigation: [
      {
        id: 'after-sales-home',
        title: 'After Sales',
        path: '/p/plugin-after-sales/after-sales',
        location: 'main-nav',
      },
    ],
    permissions: [],
    featureFlags: ['afterSales'],
    objects: [],
    workflows: [],
    integrations: [],
    entryPath: '/p/plugin-after-sales/after-sales',
    instance: null,
    ...overrides,
  }
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('PlatformAppShellView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    currentAppId = 'after-sales'
    appsRef.value = []
    loadingRef.value = false
    errorRef.value = null
    setPlatformAppRuntimeInstallState('after-sales', null)
    fetchAppByIdMock.mockReset()
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    pushMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    setPlatformAppRuntimeInstallState('after-sales', null)
  })

  it('renders runtime diagnostics from the bound current endpoint', async () => {
    const failedApp = createInstanceApp({
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
    })
    appsRef.value = [failedApp]
    fetchAppByIdMock.mockResolvedValue(failedApp)
    apiGetMock.mockResolvedValue({
      ok: true,
      data: {
        status: 'failed',
        projectId: 'tenant_42:after-sales',
        reportRef: 'ledger_1',
        installResult: {
          status: 'failed',
          createdObjects: ['serviceTicket'],
          createdViews: ['ticket-board'],
          warnings: ['platform app instance registration failed'],
          reportRef: 'ledger_1',
        },
      },
    })

    const View = (await import('../src/views/PlatformAppShellView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi()

    expect(apiGetMock).toHaveBeenCalledWith('/api/after-sales/projects/current')
    expect(container.textContent).toContain('Runtime diagnostics')
    expect(container.textContent).toContain('ledger_1')
    expect(container.textContent).toContain('platform app instance registration failed')
  })

  it('runs install action and refreshes runtime diagnostics', async () => {
    const initialApp = createInstanceApp()
    const installedApp = createInstanceApp({
      instance: {
        id: 'pai_2',
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

    appsRef.value = [initialApp]
    fetchAppByIdMock
      .mockImplementationOnce(async () => {
        appsRef.value = [initialApp]
        return initialApp
      })
      .mockImplementationOnce(async () => {
        appsRef.value = [installedApp]
        return installedApp
      })

    apiGetMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 'not-installed',
          installResult: {
            status: 'failed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 'installed',
          projectId: 'tenant_42:after-sales',
          reportRef: 'ledger_2',
          installResult: {
            status: 'installed',
            createdObjects: ['serviceTicket'],
            createdViews: ['ticket-board'],
            warnings: [],
            reportRef: 'ledger_2',
          },
        },
      })

    apiPostMock.mockResolvedValue({
      ok: true,
      data: {
        projectId: 'tenant_42:after-sales',
      },
    })

    const View = (await import('../src/views/PlatformAppShellView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi()

    const button = container.querySelector('.platform-app-shell__primary') as HTMLButtonElement | null
    expect(button?.textContent).toContain('Install app')
    button?.click()
    await flushUi(6)

    expect(apiPostMock).toHaveBeenCalledWith('/api/after-sales/projects/install', {
      templateId: 'after-sales-default',
    })
    expect(fetchAppByIdMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('App install completed and runtime state has been refreshed.')
    expect(container.textContent).toContain('ledger_2')
  })

  it('treats partial runtime snapshots as degraded in the shell', async () => {
    const partialApp = createInstanceApp({
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

    appsRef.value = [partialApp]
    fetchAppByIdMock.mockResolvedValue(partialApp)
    apiGetMock.mockResolvedValue({
      ok: true,
      data: {
        status: 'partial',
        projectId: 'tenant_42:after-sales',
        reportRef: 'ledger_partial',
        installResult: {
          status: 'partial',
          createdObjects: ['serviceTicket'],
          createdViews: ['ticket-board'],
          warnings: ['runtime install is incomplete'],
          reportRef: 'ledger_partial',
        },
      },
    })

    const View = (await import('../src/views/PlatformAppShellView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi()

    const button = container.querySelector('.platform-app-shell__primary') as HTMLButtonElement | null
    expect(button?.textContent).toContain('Reinstall app')
    expect(container.textContent).toContain('partial')
    expect(container.textContent).toContain('runtime install is incomplete')
  })
})
