import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableTemplateCenterView from '../src/views/MultitableTemplateCenterView.vue'
import { AppRouteNames } from '../src/router/types'
import { useLocale } from '../src/composables/useLocale'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listTemplates: vi.fn(),
  installTemplate: vi.fn(),
}))

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
    listTemplates: mocks.listTemplates,
    installTemplate: mocks.installTemplate,
  },
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeTemplate(overrides: {
  id: string
  name: string
  description?: string
  category?: string
  icon?: string
  color?: string
  sheets?: number
  fields?: number
  views?: number
}) {
  const sheets = Array.from({ length: overrides.sheets ?? 1 }, (_, i) => ({
    id: `${overrides.id}-sheet-${i}`,
    name: `Sheet ${i + 1}`,
    fields: Array.from({ length: overrides.fields ?? 3 }, (__, j) => ({ id: `f${j}` })),
    views: Array.from({ length: overrides.views ?? 2 }, (__, k) => ({
      id: `v${k}`,
      name: `View ${k + 1}`,
      type: 'grid',
    })),
  }))
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? '',
    category: overrides.category ?? 'Project management',
    icon: overrides.icon ?? overrides.name.slice(0, 1),
    color: overrides.color ?? '#2563eb',
    sheets,
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

function findCategoryButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('.multitable-templates__category-btn'))
    .find((node) => (node.textContent ?? '').includes(label))
  if (!btn) throw new Error(`Category tab not found: ${label}`)
  return btn
}

function readCardNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.meta-template-card__name'))
    .map((n) => n.textContent?.trim() ?? '')
}

describe('MultitableTemplateCenterView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  // MetaTemplateCard is now locale-aware (T2 i18n); pin zh-CN so the Chinese
  // product-copy assertions hold (jsdom default would be 'en').
  beforeEach(() => {
    useLocale().setLocale('zh-CN')
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MultitableTemplateCenterView as Component)
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

  it('loads templates on mount and renders cards', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 'project-tracker', name: 'Project Tracker', category: 'Project management' }),
        makeTemplate({ id: 'sales-crm', name: 'Sales CRM', category: 'Sales' }),
      ],
    })

    const root = mountView()
    await flushUi()

    expect(mocks.listTemplates).toHaveBeenCalledTimes(1)
    expect(readCardNames(root)).toEqual(['Project Tracker', 'Sales CRM'])
    expect(root.querySelector('[data-testid="multitable-template-center"]')).not.toBeNull()
  })

  it('filters templates by category tab', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 't1', name: 'Tasks', category: 'Project management' }),
        makeTemplate({ id: 't2', name: 'Deals', category: 'Sales' }),
        makeTemplate({ id: 't3', name: 'Sprint', category: 'Project management' }),
      ],
    })

    const root = mountView()
    await flushUi()
    expect(readCardNames(root)).toHaveLength(3)

    findCategoryButton(root, 'CRM').click() // Sales -> CRM via translation
    await flushUi()
    expect(readCardNames(root)).toEqual(['Deals'])

    findCategoryButton(root, '项目管理').click()
    await flushUi()
    expect(readCardNames(root).sort()).toEqual(['Sprint', 'Tasks'])

    findCategoryButton(root, '全部').click()
    await flushUi()
    expect(readCardNames(root)).toHaveLength(3)
  })

  it('filters templates by search input matching name / description / category (raw + translated)', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 't1', name: 'Project Tracker', description: 'Track project tasks', category: 'Project management' }),
        makeTemplate({ id: 't2', name: 'Sales CRM', description: 'Customer relationships', category: 'Sales' }),
        makeTemplate({ id: 't3', name: 'Issue Tracker', description: 'Bug triage', category: 'Engineering' }),
      ],
    })

    const root = mountView()
    await flushUi()

    const searchInput = root.querySelector<HTMLInputElement>('.multitable-templates__search input')
    if (!searchInput) throw new Error('Search input not found')

    // match by name
    searchInput.value = 'project'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    expect(readCardNames(root)).toEqual(['Project Tracker'])

    // match by description
    searchInput.value = 'customer'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    expect(readCardNames(root)).toEqual(['Sales CRM'])

    // match by raw category string
    searchInput.value = 'engineering'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    expect(readCardNames(root)).toEqual(['Issue Tracker'])

    // match by translated category label (Sales -> CRM)
    searchInput.value = 'CRM'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()
    expect(readCardNames(root)).toEqual(['Sales CRM'])
  })

  it('install success navigates to the new base sheet/view', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [
        makeTemplate({ id: 'project-tracker', name: 'Project Tracker' }),
      ],
    })
    mocks.installTemplate.mockResolvedValue({
      template: { id: 'project-tracker', name: 'Project Tracker' },
      base: { id: 'base_new', name: 'Project Tracker Base' },
      sheets: [{ id: 'sheet_new', baseId: 'base_new', name: 'Tasks' }],
      fields: [],
      views: [{ id: 'view_new', sheetId: 'sheet_new', name: 'Grid', type: 'grid' }],
    })

    const root = mountView()
    await flushUi()

    findButton(root, '使用模板').click()
    await flushUi()

    expect(mocks.installTemplate).toHaveBeenCalledWith('project-tracker', { baseName: 'Project Tracker Base' })
    expect(mocks.push).toHaveBeenCalledWith({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: 'sheet_new', viewId: 'view_new' },
      query: { baseId: 'base_new' },
    })
  })

  it('install failure surfaces error and does not navigate', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 'project-tracker', name: 'Project Tracker' })],
    })
    mocks.installTemplate.mockRejectedValue(new Error('boom'))

    const root = mountView()
    await flushUi()

    findButton(root, '使用模板').click()
    await flushUi()

    expect(mocks.push).not.toHaveBeenCalled()
    expect(root.textContent).toContain('boom')
  })

  it('load failure shows a retryable error banner', async () => {
    mocks.listTemplates.mockRejectedValueOnce(new Error('网络断了'))

    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('网络断了')
    const retry = findButton(root, '重试', { exact: true })

    mocks.listTemplates.mockResolvedValueOnce({
      templates: [makeTemplate({ id: 'project-tracker', name: 'Project Tracker' })],
    })
    retry.click()
    await flushUi()

    expect(mocks.listTemplates).toHaveBeenCalledTimes(2)
    expect(readCardNames(root)).toEqual(['Project Tracker'])
  })

  it('shows empty state when server returns no templates', async () => {
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()

    expect(root.textContent).toContain('暂无可用模板')
  })

  it('shows filtered-empty state when search/category narrows to zero', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate({ id: 't1', name: 'Project Tracker' })],
    })

    const root = mountView()
    await flushUi()

    const searchInput = root.querySelector<HTMLInputElement>('.multitable-templates__search input')
    if (!searchInput) throw new Error('Search input not found')

    searchInput.value = 'no-such-template-zzzzz'
    searchInput.dispatchEvent(new Event('input'))
    await flushUi()

    expect(root.textContent).toContain('没有匹配的模板')
  })

  it('hero shows a link back to multitable home', async () => {
    mocks.listTemplates.mockResolvedValue({ templates: [] })

    const root = mountView()
    await flushUi()

    const backLink = root.querySelector<HTMLElement>('.multitable-templates__back')
    expect(backLink).not.toBeNull()
    expect(backLink?.textContent?.trim()).toContain('返回多维表首页')
    expect(backLink?.getAttribute('data-router-link-to')).toContain(AppRouteNames.MULTITABLE_HOME)
  })
})
