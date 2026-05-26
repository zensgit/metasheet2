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
