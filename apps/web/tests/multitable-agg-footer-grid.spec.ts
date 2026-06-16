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

  // ---- nested / multi-level grouping (collapse is CONTROLLED: driven by the collapsedGroupKeys prop) ----
  // The composite path separator the grid uses internally (U+0000 / NUL). Tests build collapse keys with
  // it so they exercise the EXACT controlled-collapse contract (parent emits → persists → prop back in).
  const SEP = '\u001f'
  const NESTED_FIELDS: MetaField[] = [
    { id: 'fld_qty', name: 'Qty', type: 'number' },
    { id: 'fld_region', name: 'Region', type: 'string' },
    { id: 'fld_city', name: 'City', type: 'string' },
  ]
  const NESTED_ROWS: MetaRecord[] = [
    { id: 'r1', version: 1, data: { fld_qty: 1, fld_region: 'East', fld_city: 'NYC' } },
    { id: 'r2', version: 1, data: { fld_qty: 2, fld_region: 'East', fld_city: 'BOS' } },
    { id: 'r3', version: 1, data: { fld_qty: 3, fld_region: 'West', fld_city: 'LA' } },
  ]
  const NESTED_GROUP_FIELDS: MetaField[] = [
    { id: 'fld_region', name: 'Region', type: 'string' },
    { id: 'fld_city', name: 'City', type: 'string' },
  ]
  // server tree mirrors the 2-level grouping; per-level subtotals are INDEPENDENT (not roll-ups)
  const NESTED_GROUPS = [
    {
      key: 'East', count: 2, aggregates: { fld_qty: { fn: 'sum', value: 700 } }, // level-1 East subtotal (server)
      children: [
        { key: 'NYC', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 100 } } },
        { key: 'BOS', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 200 } } },
      ],
    },
    {
      key: 'West', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 300 } },
      children: [
        { key: 'LA', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 300 } } },
      ],
    },
  ]

  it('NESTED 2-level: renders headers at each level (2 level-0 + 3 level-1) and per-level subtotals', () => {
    const root = mountGrid({
      rows: NESTED_ROWS,
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      collapsedGroupKeys: [],
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 1000 } },
      aggregateGroups: NESTED_GROUPS,
    })
    const headers = Array.from(root.querySelectorAll('[data-test="group-header"]')) as HTMLElement[]
    const l0 = headers.filter((h) => h.dataset.groupLevel === '0')
    const l1 = headers.filter((h) => h.dataset.groupLevel === '1')
    expect(l0.length).toBe(2) // East, West
    expect(l1.length).toBe(3) // NYC, BOS (under East) + LA (under West)
    // per-level subtotal values come ONLY from the server tree, by composite path
    const vals = Array.from(root.querySelectorAll('.meta-grid__group-subtotal .meta-grid__foot-value')).map((e) => e.textContent?.trim())
    expect(vals).toContain('700') // East level-1 subtotal
    expect(vals).toContain('100') // NYC level-2 subtotal
    expect(vals).toContain('200') // BOS level-2 subtotal
    expect(vals).toContain('300') // West / LA
    expect(vals).not.toContain('1') // never local qty
    expect(vals).not.toContain('2')
    expect(vals).not.toContain('3')
  })

  it('NESTED 3-level: buckets to 3 header levels and resolves the deepest subtotal by composite path', () => {
    const root = mountGrid({
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_region: 'East', fld_city: 'NYC', fld_team: 'Red' } },
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_region: 'East', fld_city: 'NYC', fld_team: 'Blue' } },
      ],
      visibleFields: [
        { id: 'fld_qty', name: 'Qty', type: 'number' },
        { id: 'fld_region', name: 'Region', type: 'string' },
        { id: 'fld_city', name: 'City', type: 'string' },
        { id: 'fld_team', name: 'Team', type: 'string' },
      ],
      groupFields: [
        { id: 'fld_region', name: 'Region', type: 'string' },
        { id: 'fld_city', name: 'City', type: 'string' },
        { id: 'fld_team', name: 'Team', type: 'string' },
      ],
      collapsedGroupKeys: [],
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 3 } },
      aggregateGroups: [
        { key: 'East', count: 2, aggregates: { fld_qty: { fn: 'sum', value: 900 } }, children: [
          { key: 'NYC', count: 2, aggregates: { fld_qty: { fn: 'sum', value: 900 } }, children: [
            { key: 'Red', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 400 } } },
            { key: 'Blue', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 500 } } },
          ] },
        ] },
      ],
    })
    const headers = Array.from(root.querySelectorAll('[data-test="group-header"]')) as HTMLElement[]
    expect(headers.filter((h) => h.dataset.groupLevel === '0').length).toBe(1) // East
    expect(headers.filter((h) => h.dataset.groupLevel === '1').length).toBe(1) // NYC
    expect(headers.filter((h) => h.dataset.groupLevel === '2').length).toBe(2) // Red, Blue
    const vals = Array.from(root.querySelectorAll('.meta-grid__group-subtotal .meta-grid__foot-value')).map((e) => e.textContent?.trim())
    expect(vals).toContain('400') // East→NYC→Red level-3 subtotal
    expect(vals).toContain('500') // East→NYC→Blue level-3 subtotal
    expect(vals).toContain('900') // East / East→NYC ancestor subtotals
  })

  it('COMPOSITE KEY: two level-2 groups sharing the SAME key string stay DISTINCT (no merge, independent subtotals)', () => {
    // Both East and West contain a city literally named "Central". Without composite path keys these
    // would collide; prove their level-2 subtotals resolve independently by composite path.
    const root = mountGrid({
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_region: 'East', fld_city: 'Central' } },
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_region: 'West', fld_city: 'Central' } },
      ],
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      collapsedGroupKeys: [],
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 3 } },
      aggregateGroups: [
        { key: 'East', count: 1, aggregates: {}, children: [{ key: 'Central', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 10 } } }] },
        { key: 'West', count: 1, aggregates: {}, children: [{ key: 'Central', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 20 } } }] },
      ],
    })
    const l1 = Array.from(root.querySelectorAll('[data-test="group-header"]')).filter((h) => (h as HTMLElement).dataset.groupLevel === '1') as HTMLElement[]
    // two SEPARATE "Central" level-1 headers with distinct composite paths (East-prefixed vs West-prefixed)
    expect(l1.length).toBe(2)
    const paths = l1.map((h) => h.dataset.groupPath).sort()
    expect(paths).toEqual([`East${SEP}Central`, `West${SEP}Central`])
    // each level-2 subtotal resolves to its OWN server value (10 vs 20), no cross-contamination
    const vals = Array.from(root.querySelectorAll('.meta-grid__group-subtotal .meta-grid__foot-value')).map((e) => e.textContent?.trim())
    expect(vals).toContain('10')
    expect(vals).toContain('20')
  })

  it('CONTROLLED collapse: collapsing East→Central via the prop hides ONLY that row (composite-key independence)', () => {
    const dataRowCount = (root: HTMLElement) => root.querySelectorAll('.meta-grid__row').length
    const props = {
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_region: 'East', fld_city: 'Central' } },
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_region: 'West', fld_city: 'Central' } },
      ],
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 3 } },
      aggregateGroups: [
        { key: 'East', count: 1, aggregates: {}, children: [{ key: 'Central', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 10 } } }] },
        { key: 'West', count: 1, aggregates: {}, children: [{ key: 'Central', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 20 } } }] },
      ],
    }
    // nothing collapsed → both rows visible
    expect(dataRowCount(mountGrid({ ...props, collapsedGroupKeys: [] }))).toBe(2)
    // collapse ONLY the East→Central composite path → only East's row hides; West's "Central" stays
    const root2 = mountGrid({ ...props, collapsedGroupKeys: [`East${SEP}Central`] })
    expect(dataRowCount(root2)).toBe(1)
  })

  it('CONTROLLED collapse: collapsing a PARENT path (level-0 East) hides all descendants', () => {
    const root = mountGrid({
      rows: NESTED_ROWS,
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      collapsedGroupKeys: ['East'], // collapse the level-0 East header
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 1000 } },
      aggregateGroups: NESTED_GROUPS,
    })
    // East's NYC + BOS data rows are hidden; only West's LA row remains
    expect(root.querySelectorAll('.meta-grid__row').length).toBe(1)
    // East's descendant level-1 headers (NYC/BOS) are gone too — no level-1 header under the East path
    const remainingL1 = Array.from(root.querySelectorAll('[data-test="group-header"]'))
      .filter((h) => (h as HTMLElement).dataset.groupLevel === '1') as HTMLElement[]
    expect(remainingL1.every((h) => !h.dataset.groupPath?.startsWith(`East${SEP}`))).toBe(true)
    // collapsing a parent emits the COMPOSITE path; the toggle on a level-0 header emits its bare key
  })

  it('CONTROLLED collapse: header click EMITS toggle-group with the COMPOSITE path (does not mutate locally)', () => {
    const onToggleGroup = vi.fn()
    const root = mountGrid({
      rows: NESTED_ROWS,
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      collapsedGroupKeys: [],
      onToggleGroup,
    })
    const eastNyc = Array.from(root.querySelectorAll('[data-test="group-header"]'))
      .find((h) => (h as HTMLElement).dataset.groupLevel === '1' && (h as HTMLElement).dataset.groupPath === `East${SEP}NYC`) as HTMLElement
    eastNyc.click()
    expect(onToggleGroup).toHaveBeenCalledWith(`East${SEP}NYC`)
    // controlled: with no prop change all 3 rows stay visible (no internal collapse ref took over)
    expect(root.querySelectorAll('.meta-grid__row').length).toBe(3)
  })

  it('SEPARATOR SAFETY: group values containing spaces do NOT forge a colliding composite path', () => {
    // The collision a printable (space) separator would cause: ["a b","c"] vs ["a","b c"] both → "a b c".
    // With the NUL separator these stay TWO distinct level-0 groups whose level-2 subtotals don't mix.
    const root = mountGrid({
      rows: [
        { id: 'r1', version: 1, data: { fld_qty: 1, fld_region: 'a b', fld_city: 'c' } },
        { id: 'r2', version: 1, data: { fld_qty: 2, fld_region: 'a', fld_city: 'b c' } },
      ],
      visibleFields: NESTED_FIELDS,
      groupFields: NESTED_GROUP_FIELDS,
      collapsedGroupKeys: [],
      aggregationConfig: { fld_qty: 'sum' },
      aggregates: { fld_qty: { fn: 'sum', value: 3 } },
      aggregateGroups: [
        { key: 'a b', count: 1, aggregates: {}, children: [{ key: 'c', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 11 } } }] },
        { key: 'a', count: 1, aggregates: {}, children: [{ key: 'b c', count: 1, aggregates: { fld_qty: { fn: 'sum', value: 22 } } }] },
      ],
    })
    // TWO distinct level-0 groups (would be ONE merged group under a space separator)
    const l0 = Array.from(root.querySelectorAll('[data-test="group-header"]')).filter((h) => (h as HTMLElement).dataset.groupLevel === '0') as HTMLElement[]
    expect(l0.length).toBe(2)
    // the two level-1 composite paths are distinct under NUL (would be the SAME "a b c" under a space)
    const l1Paths = Array.from(root.querySelectorAll('[data-test="group-header"]'))
      .filter((h) => (h as HTMLElement).dataset.groupLevel === '1')
      .map((h) => (h as HTMLElement).dataset.groupPath).sort()
    expect(l1Paths).toEqual([`a${SEP}b c`, `a b${SEP}c`])
    // each level-2 subtotal resolves to its OWN value, no cross-contamination from a forged shared path
    const vals = Array.from(root.querySelectorAll('.meta-grid__group-subtotal .meta-grid__foot-value')).map((e) => e.textContent?.trim())
    expect(vals).toContain('11')
    expect(vals).toContain('22')
  })
})
