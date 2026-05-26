import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null; useLocale().setLocale('en') })

const FIELDS: MetaField[] = [
  { id: 'fld_qty', name: 'Qty', type: 'number' },
  { id: 'fld_name', name: 'Name', type: 'string' },
]
// rows that would sum to 3 locally — used to prove the footer does NOT compute from rows
const ROWS: MetaRecord[] = [
  { id: 'r1', version: 1, data: { fld_qty: 1, fld_name: 'a' } },
  { id: 'r2', version: 1, data: { fld_qty: 2, fld_name: 'b' } },
]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div'); document.body.appendChild(container)
  app = createApp({ setup: () => () => h(MetaGridTable, {
    rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
    currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true, searchText: '', rowDensity: 'normal',
    ...props,
  }) })
  app.mount(container)
  return container
}
const footValues = (r: HTMLElement) => Array.from(r.querySelectorAll('.meta-grid__foot-value')).map((e) => e.textContent?.trim())

describe('MetaGridTable aggregation footer', () => {
  it('renders SERVER aggregate value — never computes from local rows', () => {
    const root = mountGrid({
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 999 } }, // server says 999; local rows would sum to 3
    })
    expect(root.querySelector('.meta-grid__foot')).not.toBeNull()
    expect(footValues(root)).toContain('999') // server value, NOT 3
    expect(footValues(root)).not.toContain('3')
  })

  it('shows no footer when nothing is configured and not too-large', () => {
    const root = mountGrid({ aggregationConfig: {}, aggregates: {} })
    expect(root.querySelector('.meta-grid__foot')).toBeNull()
  })

  it('shows the too-large state (no value, never a client-computed number)', () => {
    const root = mountGrid({ aggregationConfig: { fld_qty: 'sum' }, aggregates: {}, aggregateTooLarge: true })
    expect(root.querySelector('.meta-grid__foot-toolarge')).not.toBeNull()
    expect((root.querySelector('.meta-grid__foot-toolarge') as HTMLElement).textContent).toContain('Too many rows')
    expect(footValues(root).filter(Boolean)).toEqual([]) // no aggregate values shown
  })

  it('fn picker emits set-aggregation (config change → server reload, not local calc)', () => {
    const onSetAggregation = vi.fn()
    const root = mountGrid({ aggregationConfig: { fld_qty: 'sum' }, aggregates: { fld_qty: { fn: 'sum', value: 999 } }, onSetAggregation })
    const select = root.querySelector('.meta-grid__foot-fn') as HTMLSelectElement // first = fld_qty
    select.value = 'avg'
    select.dispatchEvent(new Event('change'))
    expect(onSetAggregation).toHaveBeenCalledWith({ fieldId: 'fld_qty', fn: 'avg' })
  })

  it('fn picker offers numeric fns for numeric fields, count-only for non-numeric', () => {
    const root = mountGrid({ aggregationConfig: { fld_qty: 'sum' }, aggregates: {} })
    const selects = Array.from(root.querySelectorAll('.meta-grid__foot-fn')) as HTMLSelectElement[]
    const optsOf = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value)
    expect(optsOf(selects[0])).toContain('sum') // fld_qty (number)
    expect(optsOf(selects[1])).not.toContain('sum') // fld_name (string) — no sum
    expect(optsOf(selects[1])).toContain('count')
  })

  // ---- #4-3b-2a group subtotals ----
  const GROUP_FIELDS: MetaField[] = [
    { id: 'fld_qty', name: 'Qty', type: 'number' },
    { id: 'fld_cat', name: 'Cat', type: 'string' },
  ]

  it('renders SERVER per-group subtotal rows — never computes group sums from local rows', () => {
    const root = mountGrid({
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_cat: 'A' } },
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_cat: 'B' } },
      ],
      visibleFields: GROUP_FIELDS,
      groupField: { id: 'fld_cat', name: 'Cat', type: 'string' },
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 1100 } }, // grand total (server)
      aggregateGroups: [
        { key: 'A', count: 10, aggregates: { fld_qty: { fn: 'sum', value: 500 } } },
        { key: 'B', count: 20, aggregates: { fld_qty: { fn: 'sum', value: 600 } } },
      ],
    })
    const subtotalRows = Array.from(root.querySelectorAll('.meta-grid__group-subtotal'))
    expect(subtotalRows.length).toBe(2) // one per rendered group
    const vals = subtotalRows.flatMap((r) => Array.from(r.querySelectorAll('.meta-grid__foot-value')).map((e) => e.textContent?.trim()))
    expect(vals).toContain('500') // server group A subtotal
    expect(vals).toContain('600') // server group B subtotal
    expect(vals).not.toContain('1') // never the local row qty
    expect(vals).not.toContain('2')
  })

  it('maps the server null-key group onto the client "(empty)" group', () => {
    const root = mountGrid({
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_cat: '' } }, // empty → client "__ungrouped__"
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_cat: 'A' } },
      ],
      visibleFields: GROUP_FIELDS,
      groupField: { id: 'fld_cat', name: 'Cat', type: 'string' },
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 3 } },
      aggregateGroups: [
        { key: 'A', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 222 } } },
        { key: null, count: 1, aggregates: { fld_qty: { fn: 'sum', value: 111 } } }, // null-key → "(empty)"
      ],
    })
    const vals = Array.from(root.querySelectorAll('.meta-grid__group-subtotal .meta-grid__foot-value')).map((e) => e.textContent?.trim())
    expect(vals).toContain('111') // server null-group value rendered under the empty client group
    expect(vals).toContain('222')
  })

  it('no subtotal rows when the server returned no groups', () => {
    const root = mountGrid({
      rows: [{ id: 'r1', version: 1, data: { fld_qty: 1, fld_cat: 'A' } }],
      visibleFields: GROUP_FIELDS,
      groupField: { id: 'fld_cat', name: 'Cat', type: 'string' },
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 1 } },
      aggregateGroups: [],
    })
    expect(root.querySelector('.meta-grid__group-subtotal')).toBeNull()
  })
})
