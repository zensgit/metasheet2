import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MultitableHomeView from '../src/views/MultitableHomeView.vue'

// UI-P2-1c batch-1: MultitableHomeView's hero refresh + per-card favorite / open controls were
// migrated from bespoke <button>s to the shared MtButton primitive (refresh/favorite = default
// ghost, open = variant="primary" — its bespoke #2563eb fill equals --ms-color-primary exactly).
// The create-and-open button (`.multitable-home__primary`) is deliberately NOT migrated: it sits
// inside <form @submit.prevent> with implicit type="submit" (Enter-to-submit semantics), while
// MtButton hardcodes type="button" — not byte-equivalent. Behavior-preservation proof: the three
// migrated controls stay native, keyboard-operable <button>s; :disabled="loading" survives on
// refresh; clicking still runs the SAME handlers (loadHomeData / toggleFavoriteBase / openBase)
// with the SAME payloads.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listBases: vi.fn(),
  listTemplates: vi.fn(),
  loadContext: vi.fn(),
  createBase: vi.fn(),
  createSheet: vi.fn(),
  installTemplate: vi.fn(),
}))

const FAVORITE_BASES_KEY = 'metasheet:multitable:favorite-base-ids:v1'
const RECENT_BASES_KEY = 'metasheet:multitable:recent-base-opens:v1'

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: mocks.push }),
  }
})

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listBases: mocks.listBases,
    listTemplates: mocks.listTemplates,
    loadContext: mocks.loadContext,
    createBase: mocks.createBase,
    createSheet: mocks.createSheet,
    installTemplate: mocks.installTemplate,
  },
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.multitable-home').length).toBe(0) // residue guard
  localStorage.removeItem(FAVORITE_BASES_KEY)
  localStorage.removeItem(RECENT_BASES_KEY)
  vi.clearAllMocks()
})

function mountView(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render: () => h(MultitableHomeView),
  })
  app.component('router-link', {
    props: ['to'],
    render() {
      return h('a', {}, this.$slots.default ? this.$slots.default() : [])
    },
  })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const baseFixture = { id: 'base_ops', name: 'Ops Base', color: '#0f766e' }

function primeHappyPath() {
  mocks.listBases.mockResolvedValue({ bases: [baseFixture] })
  mocks.listTemplates.mockResolvedValue({ templates: [] })
  mocks.loadContext.mockResolvedValue({
    base: { id: 'base_ops', name: 'Ops Base' },
    sheet: { id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' },
    sheets: [{ id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' }],
    views: [{ id: 'view_grid', sheetId: 'sheet_ops', name: 'Grid', type: 'grid' }],
    capabilities: {},
  })
}

const refreshBtn = (root: HTMLElement) => root.querySelector('.multitable-home__refresh') as HTMLButtonElement
const favoriteBtn = (root: HTMLElement) => root.querySelector('.multitable-home__favorite') as HTMLButtonElement
const openBtn = (root: HTMLElement) => root.querySelector('.multitable-home__open') as HTMLButtonElement

describe('MultitableHomeView — MtButton migration (UI-P2-1c batch-1)', () => {
  it('renders refresh / favorite / open as native <button>s; refresh :disabled="loading" survives', async () => {
    let releaseBases!: (value: { bases: Array<typeof baseFixture> }) => void
    mocks.listBases.mockReturnValue(new Promise((resolve) => { releaseBases = resolve }))
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()
    expect(refreshBtn(root).tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(refreshBtn(root).disabled).toBe(true) // loading in flight → :disabled="loading"

    releaseBases({ bases: [baseFixture] })
    await flushUi()
    expect(refreshBtn(root).disabled).toBe(false)
    expect(favoriteBtn(root).tagName).toBe('BUTTON')
    expect(openBtn(root).tagName).toBe('BUTTON')
  })

  it('clicking refresh re-runs loadHomeData (same handler: listBases + listTemplates again)', async () => {
    primeHappyPath()
    const root = mountView()
    await flushUi()
    expect(mocks.listBases).toHaveBeenCalledTimes(1) // onMounted load

    refreshBtn(root).click()
    await flushUi()
    expect(mocks.listBases).toHaveBeenCalledTimes(2)
    expect(mocks.listTemplates).toHaveBeenCalledTimes(2)
  })

  it('clicking favorite still toggles + persists the favorite (aria-pressed and storage unchanged)', async () => {
    primeHappyPath()
    const root = mountView()
    await flushUi()

    expect(favoriteBtn(root).getAttribute('aria-pressed')).toBe('false')
    favoriteBtn(root).click()
    await flushUi()
    expect(favoriteBtn(root).getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem(FAVORITE_BASES_KEY)).toContain('base_ops')

    favoriteBtn(root).click()
    await flushUi()
    expect(favoriteBtn(root).getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking open still resolves the base context and routes with the same payload', async () => {
    primeHappyPath()
    const root = mountView()
    await flushUi()

    openBtn(root).click()
    await flushUi()

    expect(mocks.loadContext).toHaveBeenCalledWith({ baseId: 'base_ops' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: 'multitable',
      params: { sheetId: 'sheet_ops', viewId: 'view_grid' },
      query: { baseId: 'base_ops' },
    })
  })

  it('the create-and-open button stays a bespoke submit button (deliberately NOT migrated)', async () => {
    primeHappyPath()
    const root = mountView()
    await flushUi()

    const create = root.querySelector('.multitable-home__primary') as HTMLButtonElement
    expect(create.tagName).toBe('BUTTON')
    expect(create.type).toBe('submit') // implicit form-submit semantics — the reason it is excluded
    expect(create.classList.contains('mt-button')).toBe(false) // still bespoke, not an MtButton root
  })
})
