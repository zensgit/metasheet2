import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField } from '../src/multitable/types'
import { buildFieldScaleMap, sanitizeScaleRule } from '../src/multitable/utils/conditional-formatting'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'amount', name: 'Amount', type: 'number' },
  { id: 'label', name: 'Label', type: 'string' },
]

const ROWS = [
  { id: 'r1', version: 1, data: { amount: 0, label: 'a' } },
  { id: 'r2', version: 1, data: { amount: 50, label: 'b' } },
  { id: 'r3', version: 1, data: { amount: 100, label: 'c' } },
]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
        currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
        searchText: '', rowDensity: 'normal', ...props,
      })
    },
  })
  app.mount(container)
  return container
}

// The Amount cell is the 1st `.meta-grid__cell` of each row; with 3 rows the
// data cells are [r1.amount, r1.label, r2.amount, r2.label, r3.amount, ...].
function dataCells(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('tbody .meta-grid__cell')) as HTMLElement[]
}

const scaleFor = (over: Record<string, unknown> = {}) =>
  buildFieldScaleMap([sanitizeScaleRule({ id: 's1', fieldId: 'amount', kind: 'dataBar', order: 0, range: { mode: 'auto' }, dataBar: { color: '#2196f3' }, ...over })!], ROWS)

describe('MetaGridTable — data-bar conditional formatting (A5-1c render)', () => {
  it('renders a left-anchored gradient on the numeric cell scaled to the value', () => {
    const root = mountGrid({ conditionalFormattingScale: scaleFor() })
    const cells = dataCells(root)
    // r1.amount = 0 → 0% ; r2.amount = 50 → 50% ; r3.amount = 100 → 100%
    expect(cells[0].style.backgroundImage).toContain('0%')
    expect(cells[2].style.backgroundImage).toContain('linear-gradient')
    expect(cells[2].style.backgroundImage).toContain('50%')
    expect(cells[4].style.backgroundImage).toContain('100%')
  })

  it('does not put a bar on a non-scaled field (Label)', () => {
    const root = mountGrid({ conditionalFormattingScale: scaleFor() })
    const cells = dataCells(root)
    expect(cells[1].style.backgroundImage).toBe('') // r1.label — no scale rule
  })

  it('renders no gradient at all when no scale map is provided', () => {
    const root = mountGrid({})
    expect(dataCells(root)[0].style.backgroundImage).toBe('')
  })

  it('data bar takes the background but keeps an operator-rule textColor', () => {
    const root = mountGrid({
      conditionalFormattingScale: scaleFor(),
      conditionalFormatting: {
        rules: [],
        byRecordId: new Map([['r2', { rowStyle: undefined, cellStyles: { amount: { backgroundColor: '#ffeeee', textColor: '#111111' } }, matchedRuleIds: [] }]]),
      },
    })
    const cells = dataCells(root)
    // r2.amount: bar present, operator backgroundColor dropped, textColor kept
    expect(cells[2].style.backgroundImage).toContain('linear-gradient')
    expect(cells[2].style.backgroundColor).toBe('') // operator bg dropped under the bar
    expect(cells[2].style.color).toBe('rgb(17, 17, 17)') // textColor preserved
  })

  // Trap E regression: a colorScale / iconSet presentation has no barPct, so the
  // grid's data-bar render must NOT build a `linear-gradient(… undefined% …)`.
  // (A5-2/A5-3 have their own browser-gated render; the grid only draws bars.)
  it('does NOT render a data-bar gradient for a colorScale presentation', () => {
    const colorScale = buildFieldScaleMap([
      sanitizeScaleRule({
        id: 'cs1', fieldId: 'amount', kind: 'colorScale', order: 0, range: { mode: 'auto' },
        colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
      })!,
    ], ROWS)
    const root = mountGrid({ conditionalFormattingScale: colorScale })
    const cells = dataCells(root)
    for (const idx of [0, 2, 4]) {
      expect(cells[idx].style.backgroundImage).toBe('')
      expect(cells[idx].style.backgroundImage).not.toContain('undefined')
    }
  })

  it('does NOT render a data-bar gradient for an iconSet presentation', () => {
    const iconSet = buildFieldScaleMap([
      sanitizeScaleRule({
        id: 'is1', fieldId: 'amount', kind: 'iconSet', order: 0, range: { mode: 'auto' },
        iconSet: { set: 'arrows3', thresholds: [10, 20] },
      })!,
    ], ROWS)
    const root = mountGrid({ conditionalFormattingScale: iconSet })
    const cells = dataCells(root)
    for (const idx of [0, 2, 4]) {
      expect(cells[idx].style.backgroundImage).toBe('')
      expect(cells[idx].style.backgroundImage).not.toContain('undefined')
    }
  })
})

describe('MetaGridTable — color scale (A5-2) + icon set (A5-3) render', () => {
  it('paints the cell background with the colorScale color (no gradient)', () => {
    const colorScale = buildFieldScaleMap([
      sanitizeScaleRule({
        id: 'cs1', fieldId: 'amount', kind: 'colorScale', order: 0, range: { mode: 'auto' },
        colorScale: { stops: [{ at: 'min', color: '#000000' }, { at: 'max', color: '#ffffff' }] },
      })!,
    ], ROWS)
    const root = mountGrid({ conditionalFormattingScale: colorScale })
    const cells = dataCells(root)
    // amount 0 → min stop #000000, 100 → max stop #ffffff, 50 → #808080
    expect(cells[0].style.backgroundColor).toBe('rgb(0, 0, 0)')
    expect(cells[2].style.backgroundColor).toBe('rgb(128, 128, 128)')
    expect(cells[4].style.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(cells[2].style.backgroundImage).toBe('') // colorScale is a solid fill, not a bar
  })

  it('renders an icon glyph for each bucket of an iconSet rule', () => {
    const iconSet = buildFieldScaleMap([
      sanitizeScaleRule({
        id: 'is1', fieldId: 'amount', kind: 'iconSet', order: 0, range: { mode: 'auto' },
        iconSet: { set: 'arrows3', thresholds: [10, 20] },
      })!,
    ], ROWS)
    const root = mountGrid({ conditionalFormattingScale: iconSet })
    const cells = dataCells(root)
    // amount 0 (<10) → index 0 ↓ ; 50 (>=20) → index 2 ↑ ; 100 (>=20) → index 2 ↑
    const icon = (cell: HTMLElement) => cell.querySelector('[data-test="cell-scale-icon"]')
    expect(icon(cells[0])?.textContent).toBe('↓')
    expect(icon(cells[2])?.textContent).toBe('↑')
    expect(icon(cells[4])?.textContent).toBe('↑')
  })

  it('renders no icon on a field with no scale rule', () => {
    const iconSet = buildFieldScaleMap([
      sanitizeScaleRule({
        id: 'is1', fieldId: 'amount', kind: 'iconSet', order: 0, range: { mode: 'auto' },
        iconSet: { set: 'arrows3', thresholds: [10, 20] },
      })!,
    ], ROWS)
    const root = mountGrid({ conditionalFormattingScale: iconSet })
    const cells = dataCells(root)
    // cells[1] is r1.label (no scale rule) → no icon
    expect(cells[1].querySelector('[data-test="cell-scale-icon"]')).toBeNull()
  })
})
