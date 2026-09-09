import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// 整合切片 (2026-09-09): DataSourcesPanel is the extracted 外接数据源 surface, mounted BOTH as the
// standalone page (views/DataSourcesView.vue) and inside 数据工厂's 连接管理 section. `embedded` is
// the only difference between the two mountings, and it is PRESENTATION ONLY — this pins both
// halves of that claim: the chrome does change, and the controls do not.
const listDataSourcesMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listDataSourcesMock,
  getDataSource: vi.fn(),
  createDataSource: vi.fn(),
  updateDataSource: vi.fn(),
  rotateDataSourceCredentials: vi.fn(),
  deleteDataSource: vi.fn(),
  testDataSourceConnection: vi.fn(),
  testDataSourceDraftConnection: vi.fn(),
  getDataSourceSchema: vi.fn(),
  getDataSourceTableInfo: vi.fn(),
  previewDataSourceRows: vi.fn(),
}))

import DataSourcesPanel from '../src/components/data-sources/DataSourcesPanel.vue'

describe('DataSourcesPanel embedded presentation', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    listDataSourcesMock.mockResolvedValue([])
  })

  afterEach(() => {
    listDataSourcesMock.mockReset()
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountPanel(props: Record<string, unknown> = {}): Promise<HTMLElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(DataSourcesPanel as Component, props)
    app.use(createPinia())
    app.mount(container)
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
    return container
  }

  it('defaults to the standalone page presentation (h1 + English sub-title, page chrome class absent)', async () => {
    const el = await mountPanel()
    const root = el.querySelector('section.data-sources')
    expect(root).toBeTruthy()
    expect(root?.classList.contains('data-sources--embedded')).toBe(false)
    expect(el.querySelector('h1')?.textContent).toContain('外接数据源')
    expect(el.querySelector('.data-sources__sub')?.textContent).toContain('Data Sources')
    expect(el.querySelector('h3')).toBeNull()
  })

  it('demotes the heading and drops the English sub-title when embedded', async () => {
    const el = await mountPanel({ embedded: true })
    const root = el.querySelector('section.data-sources')
    expect(root?.classList.contains('data-sources--embedded')).toBe(true)
    expect(el.querySelector('h1')).toBeNull()
    expect(el.querySelector('h3')?.textContent).toContain('外接数据源')
    expect(el.querySelector('.data-sources__sub')).toBeNull()
  })

  it('hides no control when embedded — same testids as the standalone mounting', async () => {
    listDataSourcesMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: true }])
    const standalone = await mountPanel()
    const standaloneTestids = new Set(
      Array.from(standalone.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid') ?? ''),
    )
    if (app) app.unmount()
    container?.remove()
    app = null
    container = null

    const embedded = await mountPanel({ embedded: true })
    const embeddedTestids = new Set(
      Array.from(embedded.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid') ?? ''),
    )

    expect(embeddedTestids.has('ds-new-button')).toBe(true)
    expect([...standaloneTestids].sort()).toEqual([...embeddedTestids].sort())
  })
})
