import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'
import { setPlatformAppRuntimeInstallState, usePlatformApps, type PlatformAppSummary } from '../src/composables/usePlatformApps'

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

// The session's product features as the router guard has loaded them. Only `elearning` is steered,
// defaulting to the real store's own default (off); every other feature keeps the real answer.
const productFeatures = vi.hoisted(() => ({ elearning: false }))
vi.mock('../src/stores/featureFlags', async () => {
  const actual = await vi.importActual<typeof import('../src/stores/featureFlags')>('../src/stores/featureFlags')
  return {
    ...actual,
    useFeatureFlags: () => {
      const real = actual.useFeatureFlags()
      return {
        ...real,
        hasFeature: (feature: Parameters<typeof real.hasFeature>[0]) =>
          feature === 'elearning' ? productFeatures.elearning : real.hasFeature(feature),
      }
    },
  }
})

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
    localStorage.clear()
    // `apps` is a MODULE-level singleton and `fetchApps()` returns early when it is already
    // populated, so without this reset every case after the first would render the previous
    // case's list instead of its own.
    usePlatformApps().apps.value = []
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
    // The second argument is NOT decoration: usePlatformApps.ts:202-204 passes
    // `{ suppressUnauthorizedRedirect: true }` on the runtime-install probe so a 401 on an app's own
    // current-state endpoint cannot bounce the whole launcher to the login page. This assertion
    // omitted it and had been red since that option landed (verified red at 5f4b32122, before this
    // branch) — which is why this file sat in run-required-web-tests.sh's quarantine list and ran in
    // NO workflow. Asserting the real call shape re-opens the file for CI.
    expect(apiGetMock).toHaveBeenNthCalledWith(2, '/api/after-sales/projects/current', {
      suppressUnauthorizedRedirect: true,
    })
    expect(container.textContent).toContain('partial')
    expect(container.textContent).toContain('Reinstall app')
  })

  /**
   * G-7 (4), browser side. `GET /api/platform/apps` is already filtered server-side
   * (packages/core-backend/src/routes/platform-apps.ts#canSeePlatformApp); this case pins the
   * SECOND line, which is what keeps a list the server served to some other principal -- or any
   * summary already sitting in the shared `apps` ref -- from rendering a card whose shell route
   * would 404. Remove `accessibleApps` from the view and this goes red.
   */
  it('does not render a card for an app whose declared codes the caller holds none of', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['elearning:read']))
    apiGetMock.mockResolvedValueOnce({
      list: [
        createInstanceApp({
          id: 'stock-preparation',
          displayName: 'Stock Preparation',
          runtimeBindings: undefined,
          permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin'],
        }),
      ],
    })

    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)

    expect(container.querySelectorAll('.platform-app-launcher__card')).toHaveLength(0)
    expect(container.textContent).not.toContain('Stock Preparation')
    expect(container.textContent).toContain('No platform apps discovered.')
  })

  it('renders the same app once the caller holds ONE of its declared codes', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['stock-prep:operate']))
    apiGetMock.mockResolvedValueOnce({
      list: [
        createInstanceApp({
          id: 'stock-preparation',
          displayName: 'Stock Preparation',
          runtimeBindings: undefined,
          permissions: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin'],
        }),
      ],
    })

    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)

    expect(container.querySelectorAll('.platform-app-launcher__card')).toHaveLength(1)
    expect(container.textContent).toContain('Stock Preparation')
  })

  it('still renders an app that declares no codes at all (owner decision 3: public)', async () => {
    localStorage.setItem('user_permissions', JSON.stringify([]))
    apiGetMock.mockResolvedValueOnce({
      list: [createInstanceApp({ runtimeBindings: undefined, permissions: [] })],
    })

    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)

    expect(container.querySelectorAll('.platform-app-launcher__card')).toHaveLength(1)
    expect(container.textContent).toContain('After Sales')
  })

  /**
   * 云课堂 master switch, launcher side. The server drops the app from `GET /api/platform/apps`
   * while the switch is off (routes/platform-apps.ts); this pins the browser's second line for a list
   * that still carries it (served before the switch changed, or by an older backend): no card, and
   * the other apps are untouched. Keyed on the manifest's `featureFlags: ['elearning']`, the same
   * key the server's catalog gate reads.
   */
  function elearningSummary(): PlatformAppSummary {
    return createInstanceApp({
      id: 'elearning',
      pluginId: 'plugin-elearning',
      pluginName: 'plugin-elearning',
      displayName: '学习中心',
      runtimeBindings: undefined,
      permissions: ['elearning:read', 'elearning:write', 'elearning:grade', 'elearning:stats', 'elearning:admin'],
      featureFlags: ['elearning'],
      entryPath: '/learn',
      instance: null,
    })
  }

  async function mountWith(list: PlatformAppSummary[]) {
    localStorage.setItem('user_permissions', JSON.stringify(['elearning:admin']))
    apiGetMock.mockResolvedValueOnce({ list })
    const View = (await import('../src/views/PlatformAppLauncherView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi(6)
    return container
  }

  it('elearning switch off: no 学习中心 card, the other cards stay', async () => {
    productFeatures.elearning = false
    try {
      const root = await mountWith([createInstanceApp({ runtimeBindings: undefined }), elearningSummary()])
      expect(root.querySelectorAll('.platform-app-launcher__card')).toHaveLength(1)
      expect(root.textContent).toContain('After Sales')
      expect(root.textContent).not.toContain('学习中心')
    } finally {
      productFeatures.elearning = false
    }
  })

  it('elearning switch on (positive control): the 学习中心 card is back', async () => {
    productFeatures.elearning = true
    try {
      const root = await mountWith([createInstanceApp({ runtimeBindings: undefined }), elearningSummary()])
      expect(root.querySelectorAll('.platform-app-launcher__card')).toHaveLength(2)
      expect(root.textContent).toContain('学习中心')
    } finally {
      productFeatures.elearning = false
    }
  })

})
