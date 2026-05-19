import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableHomeView from '../src/views/MultitableHomeView.vue'
import { AppRouteNames } from '../src/router/types'

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
    useRouter: () => ({
      push: mocks.push,
    }),
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

function findButton(container: HTMLElement, text: string, opts: { exact?: boolean } = {}): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((node) => {
      const content = node.textContent?.trim() ?? ''
      return opts.exact ? content === text : content.includes(text)
    })
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

function findCardButton(container: HTMLElement, cardTitle: string, buttonText: string): HTMLButtonElement {
  const card = Array.from(container.querySelectorAll('.multitable-home__card'))
    .find((node) => node.textContent?.includes(cardTitle))
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Card not found: ${cardTitle}`)
  }
  return findButton(card, buttonText, { exact: true })
}

function readBaseCardNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.multitable-home__card h3'))
    .map((node) => node.textContent?.trim() ?? '')
}

describe('MultitableHomeView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    localStorage.removeItem(FAVORITE_BASES_KEY)
    localStorage.removeItem(RECENT_BASES_KEY)
    vi.clearAllMocks()
  })

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MultitableHomeView as Component)
    app.component('router-link', {
      props: ['to'],
      render() {
        const href = typeof this.$props.to === 'string' ? this.$props.to : JSON.stringify(this.$props.to)
        return h('a', { href, 'data-router-link-to': href }, this.$slots.default ? this.$slots.default() : [])
      },
    })
    app.mount(container)
    return container
  }

  it('lists bases and opens the first sheet/view for a base', async () => {
    mocks.listBases.mockResolvedValue({
      bases: [{ id: 'base_ops', name: 'Ops Base', color: '#0f766e' }],
    })
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    mocks.loadContext.mockResolvedValue({
      base: { id: 'base_ops', name: 'Ops Base' },
      sheet: { id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' },
      sheets: [{ id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' }],
      views: [{ id: 'view_grid', sheetId: 'sheet_ops', name: 'Grid', type: 'grid' }],
      capabilities: {},
    })

    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('Ops Base')

    findButton(root, '打开', { exact: true }).click()
    await flushUi()

    expect(mocks.loadContext).toHaveBeenCalledWith({ baseId: 'base_ops' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_ops', viewId: 'view_grid' },
      query: { baseId: 'base_ops' },
    })
  })

  it('filters visible bases by name or id without changing the loaded list', async () => {
    mocks.listBases.mockResolvedValue({
      bases: [
        { id: 'base_ops', name: 'Ops Base', color: '#0f766e' },
        { id: 'base_sales', name: 'Sales Pipeline', color: '#f97316' },
      ],
    })
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('Ops Base')
    expect(root.textContent).toContain('Sales Pipeline')
    expect(root.textContent).toContain('2 个')

    const search = root.querySelector('input[aria-label="Search bases"]')
    expect(search).toBeInstanceOf(HTMLInputElement)
    ;(search as HTMLInputElement).value = 'sales'
    search?.dispatchEvent(new Event('input'))
    await flushUi()

    expect(root.textContent).not.toContain('Ops Base')
    expect(root.textContent).toContain('Sales Pipeline')
    expect(root.textContent).toContain('匹配 1 / 2 个')

    ;(search as HTMLInputElement).value = 'missing'
    search?.dispatchEvent(new Event('input'))
    await flushUi()

    expect(root.textContent).toContain('没有匹配的 Base')
    expect(root.textContent).not.toContain('暂无可访问的 Base')
  })

  it('promotes favorite bases and persists the favorite marker', async () => {
    mocks.listBases.mockResolvedValue({
      bases: [
        { id: 'base_ops', name: 'Ops Base', color: '#0f766e' },
        { id: 'base_sales', name: 'Sales Pipeline', color: '#f97316' },
      ],
    })
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()

    expect(readBaseCardNames(root)).toEqual(['Ops Base', 'Sales Pipeline'])

    findCardButton(root, 'Sales Pipeline', '收藏').click()
    await flushUi()

    expect(readBaseCardNames(root)).toEqual(['Sales Pipeline', 'Ops Base'])
    expect(root.textContent).toContain('已收藏')
    expect(JSON.parse(localStorage.getItem(FAVORITE_BASES_KEY) ?? '[]')).toEqual(['base_sales'])
  })

  it('promotes recently opened bases without pinning them above favorites', async () => {
    mocks.listBases.mockResolvedValue({
      bases: [
        { id: 'base_ops', name: 'Ops Base', color: '#0f766e' },
        { id: 'base_sales', name: 'Sales Pipeline', color: '#f97316' },
        { id: 'base_hr', name: 'Hiring Base', color: '#9333ea' },
      ],
    })
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    mocks.loadContext.mockResolvedValue({
      base: { id: 'base_sales', name: 'Sales Pipeline' },
      sheet: { id: 'sheet_sales', baseId: 'base_sales', name: 'Deals' },
      sheets: [{ id: 'sheet_sales', baseId: 'base_sales', name: 'Deals' }],
      views: [{ id: 'view_sales', sheetId: 'sheet_sales', name: 'Grid', type: 'grid' }],
      capabilities: {},
    })
    localStorage.setItem(FAVORITE_BASES_KEY, JSON.stringify(['base_hr']))

    const root = mountView()
    await flushUi()

    expect(readBaseCardNames(root)).toEqual(['Hiring Base', 'Ops Base', 'Sales Pipeline'])

    findCardButton(root, 'Sales Pipeline', '打开').click()
    await flushUi()

    expect(readBaseCardNames(root)).toEqual(['Hiring Base', 'Sales Pipeline', 'Ops Base'])
    expect(root.textContent).toContain('最近打开')
    expect(JSON.parse(localStorage.getItem(RECENT_BASES_KEY) ?? '[]')).toEqual([
      expect.objectContaining({ baseId: 'base_sales' }),
    ])
  })

  it('creates a base with a seeded sheet before opening multitable', async () => {
    mocks.listBases.mockResolvedValue({ bases: [] })
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    mocks.createBase.mockResolvedValue({ base: { id: 'base_new', name: 'Project Tracker' } })
    mocks.createSheet.mockResolvedValue({ sheet: { id: 'sheet_new', baseId: 'base_new', name: 'Sheet 1', seeded: true } })
    mocks.loadContext.mockResolvedValue({
      base: { id: 'base_new', name: 'Project Tracker' },
      sheet: { id: 'sheet_new', baseId: 'base_new', name: 'Sheet 1' },
      sheets: [{ id: 'sheet_new', baseId: 'base_new', name: 'Sheet 1' }],
      views: [{ id: 'view_new', sheetId: 'sheet_new', name: 'Grid', type: 'grid' }],
      capabilities: {},
    })

    const root = mountView()
    await flushUi()

    const input = root.querySelector('input[aria-label="Base name"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    ;(input as HTMLInputElement).value = 'Project Tracker'
    input?.dispatchEvent(new Event('input'))

    findButton(root, '创建并打开').click()
    await flushUi()

    expect(mocks.createBase).toHaveBeenCalledWith({ name: 'Project Tracker' })
    expect(mocks.createSheet).toHaveBeenCalledWith({ baseId: 'base_new', name: 'Sheet 1', seed: true })
    expect(mocks.loadContext).toHaveBeenCalledWith({ baseId: 'base_new', sheetId: 'sheet_new' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_new', viewId: 'view_new' },
      query: { baseId: 'base_new' },
    })
  })

  it('loads templates and opens an installed template base', async () => {
    mocks.listBases.mockResolvedValue({ bases: [] })
    mocks.listTemplates.mockResolvedValue({
      templates: [
        {
          id: 'project-tracker',
          name: 'Project Tracker',
          description: 'Track launch tasks and owners.',
          category: 'Project management',
          icon: 'P',
          color: '#2563eb',
          sheets: [
            {
              id: 'template-sheet',
              name: 'Tasks',
              fields: [],
              views: [
                { id: 'template-view-grid', name: 'Grid', type: 'grid' },
                { id: 'template-view-kanban', name: 'Kanban', type: 'kanban' },
              ],
            },
          ],
        },
      ],
    })
    mocks.installTemplate.mockResolvedValue({
      template: { id: 'project-tracker', name: 'Project Tracker' },
      base: { id: 'base_template', name: 'Project Tracker Base' },
      sheets: [{ id: 'sheet_template', baseId: 'base_template', name: 'Tasks' }],
      fields: [],
      views: [{ id: 'view_template', sheetId: 'sheet_template', name: 'Grid', type: 'grid' }],
    })

    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('Project Tracker')
    // MetaTemplateCard now renders 3 metrics: sheets · fields · views.
    // Project Tracker template has 1 sheet, 0 fields (mock), 2 views.
    expect(root.textContent).toContain('1 个 Sheet · 0 个字段 · 2 个视图')

    findButton(root, '使用模板').click()
    await flushUi()

    expect(mocks.installTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_template', viewId: 'view_template' },
      query: { baseId: 'base_template' },
    })
  })

  it('renders a link to the template center in the template section header', async () => {
    mocks.listBases.mockResolvedValue({ bases: [] })
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()

    const link = root.querySelector<HTMLElement>('[data-testid="multitable-home-template-center-link"]')
    expect(link).not.toBeNull()
    expect(link?.textContent?.trim()).toContain('查看全部模板')
    expect(link?.getAttribute('data-router-link-to')).toContain(AppRouteNames.MULTITABLE_TEMPLATES)
  })
})
