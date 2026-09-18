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

  it('freezes nothing when frozenLeftColumnIds is empty (header stays sticky-top only, #5863)', () => {
    const root = mountGrid({ frozenLeftColumnIds: [], enableMultiSelect: false })
    // The header row is always sticky-top (#5863); "not frozen" means no horizontal (left) stick.
    expect(headers(root)[0].style.left).toBe('')
  })

  it('frozen cell PRESERVES conditional-formatting background (not clobbered by the opaque #fff)', () => {
    const root = mountGrid({
      rows: [{ id: 'r1', version: 1, data: { f1: 'A' } }],
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: false,
      conditionalFormatting: {
        rules: [],
        byRecordId: new Map([['r1', { rowStyle: undefined, cellStyles: { f1: { backgroundColor: '#ffeeee' } }, matchedRuleIds: [] }]]),
      },
    })
    const cell = root.querySelector('.meta-grid__cell') as HTMLElement // r1/f1, frozen
    expect(cell.style.position).toBe('sticky')
    expect(cell.style.backgroundColor).toBe('rgb(255, 238, 238)') // #ffeeee preserved, NOT #fff
  })

  it('frozen cell WITHOUT conditional formatting falls back to opaque #fff', () => {
    const root = mountGrid({
      rows: [{ id: 'r1', version: 1, data: { f1: 'A' } }],
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: false,
    })
    const cell = root.querySelector('.meta-grid__cell') as HTMLElement
    expect(cell.style.backgroundColor).toBe('rgb(255, 255, 255)') // #fff
  })
})

describe('MetaGridTable — sticky header row (#5863)', () => {
  it('a non-frozen header cell is sticky-top, always on (no frozen columns needed)', () => {
    const root = mountGrid({ frozenLeftColumnIds: [], enableMultiSelect: false })
    const h = headers(root)[2] // f3, not frozen
    expect(h.style.position).toBe('sticky')
    expect(h.style.top).toBe('0px')
    expect(h.style.left).toBe('') // horizontal stickiness stays opt-in via freeze
  })

  it('a frozen header cell is sticky BOTH left and top, with a higher zIndex than a frozen body cell', () => {
    const root = mountGrid({
      rows: [{ id: 'r1', version: 1, data: { f1: 'A' } }],
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: false,
    })
    const h = headers(root)[0] // f1, frozen
    expect(h.style.position).toBe('sticky')
    expect(h.style.top).toBe('0px')
    expect(h.style.left).toBe('56px')
    const bodyCell = root.querySelector('.meta-grid__cell') as HTMLElement // r1/f1, frozen
    expect(Number(h.style.zIndex)).toBeGreaterThan(Number(bodyCell.style.zIndex))
  })

  it('a first-body-row frozen cell does NOT carry the header sticky-top (left only, no top)', () => {
    const root = mountGrid({
      rows: [{ id: 'r1', version: 1, data: { f1: 'A' } }],
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: false,
    })
    const bodyCell = root.querySelector('.meta-grid__cell') as HTMLElement
    expect(bodyCell.style.position).toBe('sticky')
    expect(bodyCell.style.left).toBe('56px')
    expect(bodyCell.style.top).toBe('') // never vertically sticky — only the header row is
  })
})

describe('MetaGridTable — frozen top rows (#5863c, frozenTopRowCount)', () => {
  const ROWS = [
    { id: 'r1', version: 1, data: { f1: 'A' } },
    { id: 'r2', version: 1, data: { f1: 'B' } },
    { id: 'r3', version: 1, data: { f1: 'C' } },
  ]

  it('with frozenTopRowCount=2, rows 0-1 carry the frozen-row class + sticky top; row 2 does not', () => {
    const root = mountGrid({ rows: ROWS, frozenTopRowCount: 2, enableMultiSelect: false })
    const rows = Array.from(root.querySelectorAll('.meta-grid__row')) as HTMLElement[]
    expect(rows).toHaveLength(3)
    expect(rows[0].classList.contains('meta-grid__row--frozen-top')).toBe(true)
    expect(rows[1].classList.contains('meta-grid__row--frozen-top')).toBe(true)
    expect(rows[2].classList.contains('meta-grid__row--frozen-top')).toBe(false)

    const cells = (r: HTMLElement) => r.querySelector('.meta-grid__cell') as HTMLElement
    expect(cells(rows[0]).style.position).toBe('sticky')
    expect(cells(rows[0]).style.top).not.toBe('')
    expect(cells(rows[1]).style.position).toBe('sticky')
    expect(cells(rows[1]).style.top).not.toBe('')
    expect(cells(rows[2]).style.top).toBe('') // row 2 is not frozen — no top stickiness
  })

  it('frozen-row + frozen-column cell has a higher zIndex than a frozen-row-only (non-frozen-column) cell', () => {
    const root = mountGrid({
      rows: ROWS,
      frozenTopRowCount: 1,
      frozenLeftColumnIds: ['f1'],
      columnWidths: { f1: 100 },
      enableMultiSelect: false,
    })
    const firstRow = root.querySelector('.meta-grid__row--frozen-top') as HTMLElement
    const bothAxesCell = firstRow.querySelector('.meta-grid__cell') as HTMLElement // f1: frozen row AND frozen column
    expect(bothAxesCell.style.position).toBe('sticky')
    expect(bothAxesCell.style.left).not.toBe('')
    expect(bothAxesCell.style.top).not.toBe('')

    // A frozen-row-only cell (no column freeze at all) for comparison.
    const rowOnlyRoot = mountGrid({ rows: ROWS, frozenTopRowCount: 1, enableMultiSelect: false })
    const rowOnlyCell = (rowOnlyRoot.querySelector('.meta-grid__row--frozen-top') as HTMLElement)
      .querySelector('.meta-grid__cell') as HTMLElement
    expect(rowOnlyCell.style.left).toBe('') // no column freeze

    expect(Number(bothAxesCell.style.zIndex)).toBeGreaterThan(Number(rowOnlyCell.style.zIndex))
  })

  it('the row-freeze pin toggles frozenTopRowCount via set-frozen-rows (capped at MAX)', () => {
    const onSetFrozenRows = vi.fn()
    const root = mountGrid({ rows: ROWS, frozenTopRowCount: 0, enableMultiSelect: false, onSetFrozenRows })
    const pins = Array.from(root.querySelectorAll('.meta-grid__row-pin')) as HTMLButtonElement[]
    pins[1].click() // freeze up to row index 1 (the 2nd row) → count = 2
    expect(onSetFrozenRows).toHaveBeenCalledWith(2)
  })

  it('clicking the current boundary row-pin unfreezes (0)', () => {
    const onSetFrozenRows = vi.fn()
    const root = mountGrid({ rows: ROWS, frozenTopRowCount: 2, enableMultiSelect: false, onSetFrozenRows })
    const pins = Array.from(root.querySelectorAll('.meta-grid__row-pin')) as HTMLButtonElement[]
    pins[1].click() // row index 1 is the current boundary (count=2) → unfreeze
    expect(onSetFrozenRows).toHaveBeenCalledWith(0)
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
