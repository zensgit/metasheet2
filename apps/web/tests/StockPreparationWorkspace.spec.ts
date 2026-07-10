import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h as vh, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Covers ONLY the new sp-fe-shell surface: the routed tabbed workspace shell, its route
// registration, the permission-gated App nav entry, and the six readonly per-view service stubs.
// (Unrelated apps/web specs are red on main from api mocks — this spec asserts only its own surface.)

// Shared mutable holder — vi.hoisted so the mock factories below can read it, and the test body can
// flip locale / permission BEFORE each mount (useLocale/useAuth are invoked fresh per mount).
const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  hasPerm: true,
  route: { path: '/multitable', fullPath: '/multitable', meta: {} as Record<string, unknown> },
  apiFetch: vi.fn(),
  loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  fetchPlugins: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRoute: () => h.route,
    useRouter: () => ({ push: vi.fn() }),
  }
})

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({ navItems: ref([]), fetchPlugins: h.fetchPlugins }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: h.loadProductFeatures,
    isAttendanceFocused: () => false,
    isPlmWorkbenchFocused: () => false,
    hasFeature: () => false,
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, email: '' }),
    hasPermission: (permission: string) => permission === 'integration:write' && h.hasPerm,
  }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return {
    ...actual,
    apiFetch: h.apiFetch,
    clearStoredAuthState: vi.fn(),
    getApiBase: () => 'https://api.example.com',
  }
})

import App from '../src/App.vue'
import StockPreparationWorkspace from '../src/components/integration/stockPreparation/StockPreparationWorkspace.vue'
import { getStockPreparationWorkspaceOverview } from '../src/services/integration/stockPreparation/projectWorkspace'
import {
  getStockPreparationSnapshotDiff,
  listStockPreparationSnapshotBatches,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'
import { getStockPreparationMaterialMappingSummary } from '../src/services/integration/stockPreparation/materialMapping'
import { getStockPreparationUnitConversionSummary } from '../src/services/integration/stockPreparation/unitConversion'
import { getStockPreparationLineSummary } from '../src/services/integration/stockPreparation/prepLine'
import { getStockPreparationExceptionQueueSummary } from '../src/services/integration/stockPreparation/exceptionQueue'

// Values-free forbidden-substring guard: rendered shell copy must never surface any of these.
const FORBIDDEN_SUBSTRINGS = [
  'password',
  'token',
  'authorityCode',
  'connection-string',
  'connectionString',
  'secret',
]

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const VIEW_KEYS = [
  'project-workspace',
  'bom-snapshot-diff',
  'material-mapping',
  'unit-conversion',
  'prep-line',
  'exception-queue',
] as const

// Source-level drift pin (matching the repo idiom in approvalTemplateRouteGuard.spec.ts): importing
// appRoutes eagerly pulls every view + element-plus CSS into jsdom, so assert on the source text.
describe('Stock Preparation route registration (source drift pin)', () => {
  const SRC = readFileSync(join(__dirname, '../src/router/appRoutes.ts'), 'utf8')

  function routeBlockByPath(path: string): string | null {
    const i = SRC.indexOf(`path: '${path}'`)
    if (i === -1) return null
    const end = SRC.indexOf('\n  },', i)
    return end === -1 ? SRC.slice(i) : SRC.slice(i, end)
  }

  it('registers /stock-prep bound to a lazy shell component and the integration:write gate', () => {
    const block = routeBlockByPath('/stock-prep')
    expect(block, 'route /stock-prep must exist in appRoutes.ts').toBeTruthy()
    expect(block).toContain('AppRouteNames.INTEGRATION_STOCK_PREPARATION')
    expect(block).toContain("import('../components/integration/stockPreparation/StockPreparationWorkspace.vue')")
    expect(block).toMatch(/requiresAuth:\s*true/)
    expect(block).toMatch(/permissions:\s*\[\s*'integration:write'\s*\]/)
    expect(block).toContain("titleZh: '备料工作台'")
  })

  it('binds the route name constant to the string the router uses', () => {
    const TYPES = readFileSync(join(__dirname, '../src/router/types.ts'), 'utf8')
    expect(TYPES).toContain("INTEGRATION_STOCK_PREPARATION: 'integration-stock-preparation'")
  })
})

describe('StockPreparationWorkspace shell', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mountShell(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationWorkspace as Component)
    app.mount(container!)
    await flushUi()
    return container!
  }

  it('renders the tablist with all six MVP view tabs', async () => {
    const root = await mountShell()
    const tablist = root.querySelector('[data-testid="stock-prep-tabs"]')
    expect(tablist).not.toBeNull()
    expect(tablist!.getAttribute('role')).toBe('tablist')
    for (const key of VIEW_KEYS) {
      expect(root.querySelector(`[data-testid="stock-prep-tab-${key}"]`)).not.toBeNull()
    }
    expect(root.querySelectorAll('[data-testid^="stock-prep-tab-"]').length).toBe(6)
  })

  it('renders Chinese labels + the readonly-boundary copy when locale is zh-CN', async () => {
    h.locale = 'zh-CN'
    const root = await mountShell()
    const tabs = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    expect(tabs.textContent).toContain('项目工作台')
    // NAMING: snapshot uses 快照批次 / batch vocabulary (collision-avoidance requirement).
    expect(tabs.textContent).toContain('BOM 快照批次与差异')
    expect(tabs.textContent).toContain('异常队列')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toContain('只读')
    expect(boundary.textContent).toMatch(/K3 Save/)
  })

  it('renders English labels when locale is not zh-CN', async () => {
    h.locale = 'en'
    const root = await mountShell()
    const tabs = root.querySelector('[data-testid="stock-prep-tabs"]') as HTMLElement
    expect(tabs.textContent).toContain('Project Workspace')
    expect(tabs.textContent).toContain('BOM Snapshot Batch & Diff')
    expect(tabs.textContent).toContain('Exception Queue')
    const boundary = root.querySelector('[data-testid="stock-prep-boundary"]') as HTMLElement
    expect(boundary.textContent).toMatch(/readonly/i)
  })

  it('shows the active view panel as a readonly GET placeholder and switches on tab click', async () => {
    const root = await mountShell()
    const panel = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panel.getAttribute('data-active')).toBe('project-workspace')
    const endpoint = root.querySelector('[data-testid="stock-prep-panel-endpoint"]') as HTMLElement
    expect(endpoint.textContent).toMatch(/GET/)
    expect(endpoint.textContent).toContain('/api/integration/stock-preparation/projects')

    const exceptionTab = root.querySelector('[data-testid="stock-prep-tab-exception-queue"]') as HTMLButtonElement
    exceptionTab.click()
    await flushUi()
    const panelAfter = root.querySelector('[data-testid="stock-prep-panel"]') as HTMLElement
    expect(panelAfter.getAttribute('data-active')).toBe('exception-queue')
    expect(panelAfter.querySelector('[data-testid="stock-prep-desc-exception-queue"]')).not.toBeNull()
  })

  it('shell copy is values-free (no secrets, no long numeric runs) in both locales', async () => {
    for (const locale of ['zh-CN', 'en']) {
      h.locale = locale
      const root = await mountShell()
      const text = (root.textContent || '').toLowerCase()
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(text).not.toContain(forbidden.toLowerCase())
      }
      // No digit-run >= 5 (no real project/material/BOM identifiers in placeholder copy).
      expect(root.textContent || '').not.toMatch(/\d{5,}/)
      if (app) app.unmount()
      app = null
    }
  })
})

describe('App nav entry for Stock Preparation', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  function mountApp(): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(App as Component)
    app.component('router-view', { render: () => null })
    // Anchor stub so each nav link's href + label text are queryable.
    app.component('router-link', {
      props: ['to'],
      render() {
        return vh('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
  }

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.hasPerm = true
    h.route = { path: '/multitable', fullPath: '/multitable', meta: {} }
    window.localStorage.clear()
    window.localStorage.setItem('auth_token', 'session-token')
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function findStockPrepLink(root: HTMLElement): HTMLAnchorElement | undefined {
    return Array.from(root.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/stock-prep')
  }

  it('renders a /stock-prep nav link with the zh label when the user has integration:write', async () => {
    mountApp()
    await flushUi()
    const link = findStockPrepLink(container as HTMLElement)
    expect(link).toBeTruthy()
    expect(link!.textContent).toContain('备料工作台')
  })

  it('renders the English nav label when locale is not zh-CN', async () => {
    h.locale = 'en'
    mountApp()
    await flushUi()
    const link = findStockPrepLink(container as HTMLElement)
    expect(link).toBeTruthy()
    expect(link!.textContent).toContain('Stock Preparation')
  })

  it('hides the /stock-prep nav link when the user lacks integration:write', async () => {
    h.hasPerm = false
    mountApp()
    await flushUi()
    expect(findStockPrepLink(container as HTMLElement)).toBeUndefined()
  })
})

describe('Stock Preparation per-view service stubs (readonly GET, values-free)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
    h.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }))
  })

  function lastCall(): [string, unknown?] {
    const calls = h.apiFetch.mock.calls
    return calls[calls.length - 1] as [string, unknown?]
  }

  it('projectWorkspace GETs the projects summary with no write options', async () => {
    await getStockPreparationWorkspaceOverview({ tenantId: 't1' })
    const [url, options] = lastCall()
    expect(url).toContain('/api/integration/stock-preparation/projects')
    expect(url).toContain('tenantId=t1')
    expect(options).toBeUndefined() // no method/body → readonly GET
  })

  it('bomSnapshotDiff lists snapshot batches and diffs by batch id (readonly)', async () => {
    await listStockPreparationSnapshotBatches({ projectId: 'p1' })
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/snapshot-batches')
    expect(lastCall()[0]).toContain('projectId=p1')
    expect(lastCall()[1]).toBeUndefined()

    await getStockPreparationSnapshotDiff('batch-1')
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/snapshot-batches/batch-1/diff')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('materialMapping GETs the mapping summary (readonly)', async () => {
    await getStockPreparationMaterialMappingSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/material-mappings/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('unitConversion GETs the unit-conversion summary (readonly)', async () => {
    await getStockPreparationUnitConversionSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/unit-conversions/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('prepLine GETs the prep-line summary (readonly)', async () => {
    await getStockPreparationLineSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/prep-lines/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('exceptionQueue GETs the exception summary (readonly)', async () => {
    await getStockPreparationExceptionQueueSummary()
    expect(lastCall()[0]).toContain('/api/integration/stock-preparation/exceptions/summary')
    expect(lastCall()[1]).toBeUndefined()
  })

  it('NONE of the readonly stubs ever issues a write method (no POST/PUT/PATCH/DELETE)', async () => {
    await Promise.all([
      getStockPreparationWorkspaceOverview(),
      listStockPreparationSnapshotBatches(),
      getStockPreparationMaterialMappingSummary(),
      getStockPreparationUnitConversionSummary(),
      getStockPreparationLineSummary(),
      getStockPreparationExceptionQueueSummary(),
    ])
    for (const call of h.apiFetch.mock.calls) {
      const options = call[1] as { method?: string } | undefined
      expect(options?.method).toBeUndefined()
    }
  })
})
