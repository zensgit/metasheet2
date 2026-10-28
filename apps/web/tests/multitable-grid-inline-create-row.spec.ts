import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const TITLE_FIELD: MetaField = { id: 'title', name: 'Title', type: 'string' }
const ONE_ROW: MetaRecord[] = [{ id: 'r1', version: 1, data: { title: 'Alpha' } }]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: ONE_ROW,
        visibleFields: [TITLE_FIELD],
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        searchText: '',
        rowDensity: 'normal',
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaGridTable inline create row', () => {
  const btnText = (root: HTMLElement) =>
    (root.querySelector('.meta-grid__add-row-btn')?.textContent ?? '').replace(/\s+/g, ' ').trim()

  it('renders the "+" add-row when canCreate and rows exist (single + glyph, no duplicate)', () => {
    const root = mountGrid({ canCreate: true, rows: ONE_ROW })
    expect(root.querySelector('.meta-grid__add-row-btn')).not.toBeNull()
    // exact normalized text — guards against the "+ +" glyph/label duplication
    expect(btnText(root)).toBe('+ New record')
  })

  it('localizes the add-row label in zh-CN (single + glyph)', () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ canCreate: true, rows: ONE_ROW })
    expect(btnText(root)).toBe('+ 新建记录')
  })

  it('hides the add-row when canCreate is false (capability gate)', () => {
    const root = mountGrid({ canCreate: false, rows: ONE_ROW })
    expect(root.querySelector('.meta-grid__add-row-btn')).toBeNull()
  })

  it('hides the add-row when there are no rows (empty-state CTA owns that case)', () => {
    const root = mountGrid({ canCreate: true, rows: [] })
    expect(root.querySelector('.meta-grid__add-row-btn')).toBeNull()
    // empty state still shown
    expect(root.textContent ?? '').toContain('No records yet')
  })

  it('emits create-record on click (wired to the gated create path)', async () => {
    const onCreateRecord = vi.fn()
    const root = mountGrid({ canCreate: true, rows: ONE_ROW, onCreateRecord })
    const btn = root.querySelector('.meta-grid__add-row-btn') as HTMLButtonElement
    btn.click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
  })
})

// 客户反馈 2026-10-27 (R74): 「页面拉到底才有新增记录，如有1000行，我一定要拉到1000行后才可以新增」. The inline row above
// only appears once every row is loaded (the flat grid appends as it scrolls), so the footer — outside the scroll
// area, always on screen — carries its own 「+ 新建记录」, under the same canCreate gate (which the workbench already
// turns off when a sheet's required columns are PLM-locked, R68).
describe('MetaGridTable footer add-record entry', () => {
  const footerBtn = (root: HTMLElement) => root.querySelector('[data-testid="grid-footer-add-record"]') as HTMLButtonElement | null
  const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

  it('is in the footer on a one-page sheet with no pager or page-size select, and emits create-record', () => {
    const onCreateRecord = vi.fn()
    const root = mountGrid({ canCreate: true, rows: ONE_ROW, onCreateRecord })
    const btn = footerBtn(root)
    expect(btn).not.toBeNull()
    expect(btn!.closest('.meta-grid__pagination')).not.toBeNull()
    expect(btn!.closest('.meta-grid__table-wrap')).toBeNull()
    expect(text(btn)).toBe('+ New record')
    btn!.click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
  })

  it('stays in the footer while the flat grid has more rows to scroll-load (where the inline row is not reachable yet)', () => {
    const root = mountGrid({ canCreate: true, rows: ONE_ROW, canLoadMore: true, infiniteScroll: true, totalPages: 20, currentPage: 1, totalRows: 1000, pageSize: 50 })
    expect(footerBtn(root)).not.toBeNull()
  })

  it('is hidden when canCreate is false (the workbench passes false for a PLM-locked sheet and for readers)', () => {
    const root = mountGrid({ canCreate: false, rows: ONE_ROW })
    expect(footerBtn(root)).toBeNull()
    expect(root.querySelector('.meta-grid__pagination')).toBeNull()
  })

  it('is hidden on an empty sheet (the empty state owns that case)', () => {
    const root = mountGrid({ canCreate: true, rows: [] })
    expect(footerBtn(root)).toBeNull()
  })

  it('zh: 「+ 新建记录」', () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ canCreate: true, rows: ONE_ROW })
    expect(text(footerBtn(root))).toBe('+ 新建记录')
  })
})
