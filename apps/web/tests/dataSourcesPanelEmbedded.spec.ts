import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

// 整合切片 (2026-09-09): DataSourcesPanel is the extracted 外接数据源 surface, mounted BOTH as the
// standalone page (views/DataSourcesView.vue) and inside 数据工厂's 连接管理 section. `embedded` is
// the only difference between the two mountings, and it is PRESENTATION ONLY — this pins both
// halves of that claim: the chrome does change, and the controls do not.
const listDataSourcesMock = vi.hoisted(() => vi.fn())
const getSchemaMock = vi.hoisted(() => vi.fn())
const deleteDataSourceMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listDataSourcesMock,
  getDataSource: vi.fn(),
  createDataSource: vi.fn(),
  updateDataSource: vi.fn(),
  rotateDataSourceCredentials: vi.fn(),
  deleteDataSource: deleteDataSourceMock,
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

// ── 被引用 N 列 (2026-09-10) ───────────────────────────────────────────────────
// The listing now carries `referenceCount` — how many 数据工厂 bindings hold each source, the same
// number the server's DELETE guard enforces. Three states, not two: undefined means the server
// could not count, and painting that as 未被引用 would promise a delete that may still be refused.

describe('DataSourcesPanel 被引用 column', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    listDataSourcesMock.mockReset()
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountWith(
    items: Array<Record<string, unknown>>,
    props: Record<string, unknown> = {},
  ): Promise<HTMLElement> {
    listDataSourcesMock.mockResolvedValue(items)
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

  it('N > 0 renders "N 个绑定" and a 去看绑定 link', async () => {
    const el = await mountWith([
      { id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 3 },
    ])
    expect(el.querySelector('[data-testid="ds-reference-count"]')?.textContent?.trim()).toBe('3 个绑定')
    expect(el.querySelector('[data-testid="ds-reference-goto"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="ds-reference-none"]')).toBeNull()
    expect(el.querySelector('[data-testid="ds-reference-unknown"]')).toBeNull()
    // The column header exists so the number is attributable to a column, not floating text.
    expect(Array.from(el.querySelectorAll('th')).map((th) => th.textContent)).toContain('被引用')
  })

  it('N === 0 renders 未被引用 with no 去看绑定 link', async () => {
    const el = await mountWith([
      { id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 0 },
    ])
    expect(el.querySelector('[data-testid="ds-reference-none"]')?.textContent?.trim()).toBe('未被引用')
    expect(el.querySelector('[data-testid="ds-reference-count"]')).toBeNull()
    expect(el.querySelector('[data-testid="ds-reference-goto"]')).toBeNull()
  })

  it('an ABSENT count renders 未知 — never 未被引用 (unknown is not zero)', async () => {
    const el = await mountWith([{ id: 'a', name: 'A', type: 'postgres', connected: true }])
    expect(el.querySelector('[data-testid="ds-reference-unknown"]')?.textContent?.trim()).toBe('未知')
    expect(el.querySelector('[data-testid="ds-reference-none"]')).toBeNull()
    expect(el.querySelector('[data-testid="ds-reference-count"]')).toBeNull()
  })

  it('each row gets its OWN count (the batch fills per source, not one number for the page)', async () => {
    const el = await mountWith([
      { id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 2 },
      { id: 'b', name: 'B', type: 'postgres', connected: true, referenceCount: 0 },
      { id: 'c', name: 'C', type: 'postgres', connected: true, referenceCount: 7 },
    ])
    const cells = Array.from(el.querySelectorAll('[data-testid="ds-reference-cell"]')).map((c) =>
      (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
    )
    expect(cells[0]).toContain('2 个绑定')
    expect(cells[1]).toContain('未被引用')
    expect(cells[2]).toContain('7 个绑定')
  })

  it('embedded: 去看绑定 asks the host to reveal them and does NOT navigate away', async () => {
    const showBindings = vi.fn()
    const el = await mountWith(
      [{ id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 1 }],
      { embedded: true, onShowBindings: showBindings },
    )
    const link = el.querySelector('[data-testid="ds-reference-goto"]') as HTMLAnchorElement
    // In-page anchor at the 连接管理 section the panel is embedded in.
    expect(link.getAttribute('href')).toBe('#int-sec-connection')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    await nextTick()
    expect(showBindings).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('standalone: 去看绑定 is a real navigation into the workbench anchor, uninterupted', async () => {
    const showBindings = vi.fn()
    const el = await mountWith(
      [{ id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 1 }],
      { onShowBindings: showBindings },
    )
    const link = el.querySelector('[data-testid="ds-reference-goto"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/integrations/workbench#int-sec-connection')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    await nextTick()
    // Nothing to reveal in this mounting: the browser is taking them to the workbench.
    expect(showBindings).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('DataSourcesPanel delete confirmation and the 409 refusal', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let confirmSpy: ReturnType<typeof vi.spyOn> | null = null

  afterEach(() => {
    listDataSourcesMock.mockReset()
    deleteDataSourceMock.mockReset()
    confirmSpy?.mockRestore()
    confirmSpy = null
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountWith(items: Array<Record<string, unknown>>): Promise<HTMLElement> {
    listDataSourcesMock.mockResolvedValue(items)
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(DataSourcesPanel as Component, {})
    app.use(createPinia())
    app.mount(container)
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
    return container
  }

  async function clickDelete(el: HTMLElement): Promise<void> {
    ;(el.querySelector('[data-testid="ds-delete"]') as HTMLButtonElement).click()
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  it('a REFERENCED source: the confirm names the count and says the server will refuse', async () => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const el = await mountWith([
      { id: 'a', name: '客户 ERP', type: 'postgres', connected: true, referenceCount: 3 },
    ])
    await clickDelete(el)

    const text = String(confirmSpy.mock.calls[0]?.[0] ?? '')
    expect(text).toContain('3 个绑定')
    expect(text).toContain('409')
    expect(text).toContain('客户 ERP')
    // No force affordance is advertised: force=true is a platform-admin API action this UI
    // deliberately does not expose.
    expect(text).not.toContain('force')
    // Declining sends nothing.
    expect(deleteDataSourceMock).not.toHaveBeenCalled()
  })

  it('an UNREFERENCED source keeps the original confirm text verbatim', async () => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const el = await mountWith([
      { id: 'a', name: '客户 ERP', type: 'postgres', connected: true, referenceCount: 0 },
    ])
    await clickDelete(el)
    expect(confirmSpy.mock.calls[0]?.[0]).toBe('删除数据源「客户 ERP」?此操作不可撤销。')
  })

  it('an UNKNOWN count falls back to the plain confirm — no refusal we cannot predict', async () => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const el = await mountWith([{ id: 'a', name: '客户 ERP', type: 'postgres', connected: true }])
    await clickDelete(el)
    expect(confirmSpy.mock.calls[0]?.[0]).toBe('删除数据源「客户 ERP」?此操作不可撤销。')
  })

  it('the 409 refusal is rendered in 人话 with the count, not the server English prose', async () => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    deleteDataSourceMock.mockRejectedValue(
      Object.assign(
        new Error(
          "Data source 'a' is referenced by 3 external system(s) " +
            '(integration_external_systems.config.dataSourceId) and deleting it would leave dangling ' +
            'references. A platform admin may repeat the request with force=true to break the reference ' +
            'deliberately.',
        ),
        { code: 'DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS', referenceCount: 3 },
      ),
    )
    const el = await mountWith([
      { id: 'a', name: '客户 ERP', type: 'postgres', connected: true, referenceCount: 3 },
    ])
    await clickDelete(el)

    const shown = el.querySelector('[data-testid="ds-error"]')?.textContent?.trim() ?? ''
    expect(shown).toContain('3 个绑定')
    expect(shown).toContain('409')
    expect(shown).toContain('已配置连接')
    // The English prose, the internal table name and the admin-only escape hatch stay off screen.
    expect(shown).not.toContain('external system')
    expect(shown).not.toContain('integration_external_systems')
    expect(shown).not.toContain('force=true')
  })

  it('any OTHER delete failure still shows the server message unchanged', async () => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    deleteDataSourceMock.mockRejectedValue(new Error('Failed to delete data source (500 Internal Server Error)'))
    const el = await mountWith([
      { id: 'a', name: 'A', type: 'postgres', connected: true, referenceCount: 0 },
    ])
    await clickDelete(el)
    expect(el.querySelector('[data-testid="ds-error"]')?.textContent?.trim()).toBe(
      'Failed to delete data source (500 Internal Server Error)',
    )
  })
})
