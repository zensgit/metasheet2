import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// 整合切片 (2026-09-09): DataSourcesPanel is the extracted 外接数据源 surface, mounted BOTH as the
// standalone page (views/DataSourcesView.vue) and inside 数据工厂's 连接管理 section. `embedded` is
// the only difference between the two mountings, and it is PRESENTATION ONLY — this pins both
// halves of that claim: the chrome does change, and the controls do not.
const listDataSourcesMock = vi.hoisted(() => vi.fn())
const getSchemaMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listDataSourcesMock,
  getDataSource: vi.fn(),
  createDataSource: vi.fn(),
  updateDataSource: vi.fn(),
  rotateDataSourceCredentials: vi.fn(),
  deleteDataSource: vi.fn(),
  testDataSourceConnection: vi.fn(),
  testDataSourceDraftConnection: vi.fn(),
  getDataSourceSchema: getSchemaMock,
  getDataSourceTableInfo: vi.fn(),
  previewDataSourceRows: vi.fn(),
}))

import DataSourcesPanel from '../src/components/data-sources/DataSourcesPanel.vue'

describe('DataSourcesPanel embedded presentation', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    listDataSourcesMock.mockResolvedValue([])
    getSchemaMock.mockResolvedValue({ tables: [], views: [] })
  })

  afterEach(() => {
    listDataSourcesMock.mockReset()
    getSchemaMock.mockReset()
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

  async function flush(turns = 4): Promise<void> {
    for (let i = 0; i < turns; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  /** Drop the current mounting so a second one can be made inside the same test. */
  function unmountPanel(): void {
    if (app) app.unmount()
    container?.remove()
    app = null
    container = null
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

  // 终审 (2026-09-09): the embedded mounting prints NO title of its own. Its host section already
  // renders 「外接数据源（物理连接与凭据）」 directly above it, and two headings with the same
  // name read as two nested surfaces. The lead sentence stays: it carries facts the host's
  // one-liner does not.
  it('renders no title of its own when embedded (the host section supplies it), and keeps the lead', async () => {
    const el = await mountPanel({ embedded: true })
    const root = el.querySelector('section.data-sources')
    expect(root?.classList.contains('data-sources--embedded')).toBe(true)
    expect(el.querySelector('h1')).toBeNull()
    expect(el.querySelector('h2')).toBeNull()
    expect(el.querySelector('h3')).toBeNull()
    expect(el.querySelector('.data-sources__sub')).toBeNull()
    expect(el.querySelector('.data-sources__lead')?.textContent).toContain('凭据加密落库')
  })

  // The in-panel section headings are the other half of the seam: under the standalone page's h1
  // they are h2s, under the host section's h3 they must not outrank their own container.
  it('demotes the in-panel section headings to h4 when embedded, and leaves them h2 standalone', async () => {
    listDataSourcesMock.mockResolvedValue([{ id: 'pg', name: 'PG', type: 'postgres', connected: true }])

    const standalone = await mountPanel()
    ;(standalone.querySelector('[data-testid="ds-schema"]') as HTMLButtonElement).click()
    await flush()
    ;(standalone.querySelector('[data-testid="ds-preview"]') as HTMLButtonElement).click()
    await flush()
    expect(standalone.querySelector('[data-testid="ds-schema-panel"] h2')?.textContent).toContain('库表结构')
    expect(standalone.querySelector('[data-testid="ds-preview-panel"] h2')?.textContent).toContain('只读数据预览')
    expect(standalone.querySelectorAll('h4').length).toBe(0)
    unmountPanel()

    const embedded = await mountPanel({ embedded: true })
    ;(embedded.querySelector('[data-testid="ds-schema"]') as HTMLButtonElement).click()
    await flush()
    ;(embedded.querySelector('[data-testid="ds-preview"]') as HTMLButtonElement).click()
    await flush()
    expect(embedded.querySelector('[data-testid="ds-schema-panel"] h4')?.textContent).toContain('库表结构')
    expect(embedded.querySelector('[data-testid="ds-preview-panel"] h4')?.textContent).toContain('只读数据预览')
    // The words are unchanged — only the level moved.
    expect(embedded.querySelectorAll('h2').length).toBe(0)
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
