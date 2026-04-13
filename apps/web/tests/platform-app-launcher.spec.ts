import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'
import { setPlatformAppRuntimeInstallState, type PlatformAppSummary } from '../src/composables/usePlatformApps'

const apiGetMock = vi.fn()

vi.mock('vue-router', async () => {
  const vue = await import('vue')
  return {
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

vi.mock('../src/utils/api', () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
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
    ...overrides,
  }
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('PlatformAppLauncherView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    setPlatformAppRuntimeInstallState('after-sales', null)
    apiGetMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    setPlatformAppRuntimeInstallState('after-sales', null)
  })

  it('marks apps as partial when the current runtime snapshot is degraded', async () => {
    apiGetMock
      .mockResolvedValueOnce({
        list: [createInstanceApp()],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 'partial',
          projectId: 'tenant_42:after-sales',
          installResult: {
            status: 'partial',
            createdObjects: ['serviceTicket'],
            createdViews: ['ticket-board'],
            warnings: ['runtime install is incomplete'],
            reportRef: 'ledger_partial',
          },
        },
      })

    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)

    expect(apiGetMock).toHaveBeenNthCalledWith(1, '/api/platform/apps')
    expect(apiGetMock).toHaveBeenNthCalledWith(2, '/api/after-sales/projects/current')
    expect(container.textContent).toContain('partial')
    expect(container.textContent).toContain('Reinstall app')
  })
})
