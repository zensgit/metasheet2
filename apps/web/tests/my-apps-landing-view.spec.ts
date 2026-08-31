import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'

const FAVORITE_BASES_KEY = 'metasheet:multitable:favorite-base-ids:v1'
const RECENT_BASES_KEY = 'metasheet:multitable:recent-base-opens:v1'

const mocks = vi.hoisted(() => {
  // A tiny stand-in for the REAL appRoutes.ts meta these two paths carry today (`/p/:plugin/:viewId`
  // has no gate; `/stock-prep` requires `stock-prep:read` — see appRoutes.ts). The component under
  // test only cares about the resolved `meta`, not vue-router's own path-matching, so this fixture
  // keeps the spec a focused unit test of MyAppsLandingView's OWN reachability filter.
  const routeMetaFixture: Record<string, Record<string, unknown>> = {
    '/p/plugin-after-sales/after-sales': { requiresAuth: true },
    '/stock-prep': { requiresAuth: true, permissions: ['stock-prep:read'] },
  }
  return {
    push: vi.fn(),
    resolve: vi.fn((path: string) => ({ path, meta: routeMetaFixture[path] ?? {} })),
    listBases: vi.fn(),
    loadContext: vi.fn(),
    apiGet: vi.fn(),
  }
})

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: mocks.push, resolve: mocks.resolve }),
  }
})

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listBases: mocks.listBases,
    loadContext: mocks.loadContext,
  },
}))

vi.mock('../src/utils/api', () => ({
  apiGet: (...args: unknown[]) => mocks.apiGet(...args),
}))

function afterSalesFixture(): Record<string, unknown> {
  return {
    id: 'after-sales',
    pluginId: 'plugin-after-sales',
    pluginName: 'plugin-after-sales',
    pluginStatus: 'active',
    displayName: 'After Sales',
    runtimeModel: 'instance',
    boundedContext: {
      code: 'after-sales',
      description: 'Service tickets, warranty handling, dispatch, and closure feedback.',
    },
    platformDependencies: [],
    navigation: [
      { id: 'after-sales-home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav' },
    ],
    permissions: [],
    featureFlags: [],
    objects: [],
    workflows: [],
    integrations: [],
    entryPath: '/p/plugin-after-sales/after-sales',
    instance: null,
  }
}

function stockPrepFixture(): Record<string, unknown> {
  return {
    id: 'stock-preparation',
    pluginId: 'plugin-integration-core',
    pluginName: 'plugin-integration-core',
    pluginStatus: 'active',
    displayName: 'BOM备料',
    valueStatement: '从 PLM 拉取项目 BOM，逐层展开为备料明细；冲突交人工确认，人工列永不被系统覆盖。',
    runtimeModel: 'direct',
    boundedContext: { code: 'stock-preparation' },
    platformDependencies: [],
    navigation: [
      { id: 'stock-prep-confirmation-queue', title: 'BOM备料', path: '/stock-prep', location: 'main-nav' },
    ],
    permissions: [],
    featureFlags: [],
    objects: [],
    workflows: [],
    integrations: [],
    entryPath: '/stock-prep',
    instance: null,
  }
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findButton(container: HTMLElement, text: string, opts: { exact?: boolean } = {}): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => {
    const content = node.textContent?.trim() ?? ''
    return opts.exact ? content === text : content.includes(text)
  })
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

describe('MyAppsLandingView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    mocks.push.mockReset()
    mocks.listBases.mockReset()
    mocks.loadContext.mockReset()
    mocks.apiGet.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    localStorage.removeItem(FAVORITE_BASES_KEY)
    localStorage.removeItem(RECENT_BASES_KEY)
    localStorage.clear()
  })

  async function mountView(): Promise<HTMLDivElement> {
    const View = (await import('../src/views/MyAppsLandingView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      render() {
        const href = typeof this.$props.to === 'string' ? this.$props.to : JSON.stringify(this.$props.to)
        return h('a', { href, 'data-router-link-to': href }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    await flushUi()
    return container
  }

  it('renders an app card with the manifest value statement and links 进入 to the entry route', async () => {
    mocks.apiGet.mockResolvedValue({ list: [afterSalesFixture()] })
    mocks.listBases.mockResolvedValue({ bases: [] })

    const root = await mountView()

    const card = root.querySelector('[data-testid="my-apps-landing-app-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('After Sales')
    expect(card?.textContent).toContain('Service tickets, warranty handling, dispatch, and closure feedback.')
    const link = card?.querySelector('a[data-router-link-to]')
    expect(link?.getAttribute('href')).toBe('/p/plugin-after-sales/after-sales')
  })

  it('hides a card whose entry route requires a permission the catalog reader does not hold, without inventing new permission logic', async () => {
    // No `user_permissions` in localStorage -> useAuth().hasPermission('stock-prep:read') is false
    // by the SAME real predicate the router guard itself uses (no permission logic added here).
    mocks.apiGet.mockResolvedValue({ list: [afterSalesFixture(), stockPrepFixture()] })
    mocks.listBases.mockResolvedValue({ bases: [] })

    const root = await mountView()

    const cards = Array.from(root.querySelectorAll('[data-testid="my-apps-landing-app-card"]'))
    expect(cards.map((node) => node.textContent)).toEqual([expect.stringContaining('After Sales')])
    expect(root.textContent).not.toContain('BOM备料')
  })

  it('shows the gated card once the reader holds the permission its entry route requires', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['stock-prep:read']))
    mocks.apiGet.mockResolvedValue({ list: [stockPrepFixture()] })
    mocks.listBases.mockResolvedValue({ bases: [] })

    const root = await mountView()

    const card = root.querySelector('[data-testid="my-apps-landing-app-card"]')
    expect(card?.textContent).toContain('BOM备料')
    expect(card?.textContent).toContain('从 PLM 拉取项目 BOM')
  })

  it('renders the empty state, not a crash, when the platform apps catalog is empty', async () => {
    mocks.apiGet.mockResolvedValue({ list: [] })
    mocks.listBases.mockResolvedValue({ bases: [] })

    const root = await mountView()

    expect(root.querySelector('[data-testid="my-apps-landing-empty-apps"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="my-apps-landing-app-card"]')).toBeNull()
  })

  it('lists 最近打开的 Base cards from the shared recent-open local state and opens one through multitableClient', async () => {
    localStorage.setItem(
      RECENT_BASES_KEY,
      JSON.stringify([{ baseId: 'base_ops', openedAt: '2026-08-30T00:00:00.000Z' }]),
    )
    mocks.apiGet.mockResolvedValue({ list: [] })
    mocks.listBases.mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base', color: '#0f766e' }] })
    mocks.loadContext.mockResolvedValue({
      base: { id: 'base_ops', name: 'Ops Base' },
      sheet: { id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' },
      sheets: [{ id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' }],
      views: [{ id: 'view_grid', sheetId: 'sheet_ops', name: 'Grid', type: 'grid' }],
      capabilities: {},
    })

    const root = await mountView()

    const card = root.querySelector('[data-testid="my-apps-landing-base-card"]')
    expect(card?.textContent).toContain('Ops Base')
    expect(card?.textContent).toContain('最近打开')

    findButton(root, '打开', { exact: true }).click()
    await flushUi()

    const { AppRouteNames } = await import('../src/router/types')
    expect(mocks.loadContext).toHaveBeenCalledWith({ baseId: 'base_ops' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_ops', viewId: 'view_grid' },
      query: { baseId: 'base_ops' },
    })
  })

  it('renders the empty-bases state when nothing has been opened recently', async () => {
    mocks.apiGet.mockResolvedValue({ list: [] })
    mocks.listBases.mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] })

    const root = await mountView()

    expect(root.querySelector('[data-testid="my-apps-landing-empty-bases"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="my-apps-landing-base-card"]')).toBeNull()
  })
})
