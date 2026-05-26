import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'f1', name: 'F1', type: 'string' },
  { id: 'f2', name: 'F2', type: 'string' },
  { id: 'f3', name: 'F3', type: 'string' },
]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: [], visibleFields: FIELDS, sortRules: [], loading: false,
        currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
        searchText: '', rowDensity: 'normal',
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

const headers = (root: HTMLElement) => Array.from(root.querySelectorAll('.meta-field-header')) as HTMLElement[]
const pins = (root: HTMLElement) => Array.from(root.querySelectorAll('.meta-field-header__pin')) as HTMLButtonElement[]

describe('MetaGridTable frozen columns — offsets', () => {
  it('applies cumulative sticky left to the frozen prefix (no multi-select)', () => {
    const root = mountGrid({
      frozenLeftColumnIds: ['f1', 'f2'],
      columnWidths: { f1: 100, f2: 120 },
      enableMultiSelect: false,
    })
    const h = headers(root)
    // base = 0 (no check-col) + 56 (row-num)
    expect(h[0].style.left).toBe('56px') // f1 at base
    expect(h[0].style.position).toBe('sticky')
    expect(h[1].style.left).toBe('156px') // f2 at base + f1 width(100)
    expect(h[2].style.left).toBe('') // f3 not frozen
  })

  it('adds check-col width (36) to the base + fixes row-num offset when multi-select on', () => {
    const root = mountGrid({
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: true,
    })
    // row-num base-fix: sits after the 36px check-col
    expect((root.querySelector('.meta-grid__row-num') as HTMLElement).style.left).toBe('36px')
    // f1 frozen at base = 36 (check) + 56 (row-num) = 92
    expect(headers(root)[0].style.left).toBe('92px')
  })

  it('uses FROZEN_DEFAULT_WIDTH (160) for a frozen column without an explicit width', () => {
    const root = mountGrid({
      frozenLeftColumnIds: ['f1', 'f2'],
      columnWidths: {}, // f1 has no explicit width → default 160
      enableMultiSelect: false,
    })
    expect(headers(root)[1].style.left).toBe('216px') // 56 + 160
  })

  it('freezes nothing when frozenLeftColumnIds is empty', () => {
    const root = mountGrid({ frozenLeftColumnIds: [], enableMultiSelect: false })
    expect(headers(root)[0].style.position).not.toBe('sticky')
  })
})

describe('MetaGridTable frozen columns — pin interaction', () => {
  it('clicking a non-boundary pin emits set-frozen with the left prefix', () => {
    const onSetFrozen = vi.fn()
    const root = mountGrid({ frozenLeftColumnIds: [], enableMultiSelect: false, onSetFrozen })
    pins(root)[1].click() // freeze up to f2
    expect(onSetFrozen).toHaveBeenCalledWith(['f1', 'f2'])
  })

  it('clicking the current boundary pin unfreezes ([])', () => {
    const onSetFrozen = vi.fn()
    const root = mountGrid({ frozenLeftColumnIds: ['f1', 'f2'], enableMultiSelect: false, onSetFrozen })
    pins(root)[1].click() // f2 is the boundary → unfreeze
    expect(onSetFrozen).toHaveBeenCalledWith([])
  })

  it('pin click does NOT bubble into sort (@click.stop)', () => {
    const onSetFrozen = vi.fn()
    const onToggleSort = vi.fn()
    const root = mountGrid({ frozenLeftColumnIds: [], enableMultiSelect: false, onSetFrozen, onToggleSort })
    pins(root)[0].click()
    expect(onSetFrozen).toHaveBeenCalledTimes(1)
    expect(onToggleSort).not.toHaveBeenCalled()
  })
})
