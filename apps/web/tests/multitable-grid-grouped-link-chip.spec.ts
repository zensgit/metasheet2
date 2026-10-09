import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type VNode } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import type { MetaField, MetaRecordContext } from '../src/multitable/types'

// A3 regression (review block #1 + #2): MetaGridTable renders THREE
// MetaCellRenderer instances — flat rows (line ~230), GROUPED rows (line ~101),
// and the expand-row detail (line ~259, intentionally excluded per #2708). The
// `fetchRecord` callback that makes a linked-record chip clickable must thread
// to BOTH visible-grid paths (flat AND grouped). The A3 unit specs hand-mount
// MetaCellRenderer and pass fetchRecord directly, so they cannot catch a missing
// passthrough prop on the grouped instance. This spec mounts the REAL grid with
// grouping ON and asserts the chip is clickable through the workbench→grid→
// renderer wire — closing the wire-vs-fixture drift blind spot.

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
})

const FIELDS: MetaField[] = [
  { id: 'status', name: 'Status', type: 'string' },
  { id: 'vendor', name: 'Vendor', type: 'link' },
]

const ROWS = [
  { id: 'r1', version: 1, data: { status: 'Open', vendor: ['vendor_1'] } },
  { id: 'r2', version: 1, data: { status: 'Done', vendor: ['vendor_2'] } },
]

// linkSummaries are keyed [rowId][fieldId] → real foreign ids (NOT the
// __link_summary__ sentinel), so the chip resolves to a clickable button.
const LINK_SUMMARIES: Record<string, Record<string, Array<{ id: string; display: string }>>> = {
  r1: { vendor: [{ id: 'vendor_1', display: 'Acme Supply' }] },
  r2: { vendor: [{ id: 'vendor_2', display: 'Beacon Labs' }] },
}

function foreignContext(recordId: string): MetaRecordContext {
  return {
    sheet: { id: 'sheet_vendors', name: 'Vendors' },
    fields: [{ id: 'fld_name', name: 'Vendor Name', type: 'string' }],
    record: { id: recordId, data: { fld_name: 'Acme Supply' } } as MetaRecordContext['record'],
    capabilities: {} as MetaRecordContext['capabilities'],
    commentsScope: {} as MetaRecordContext['commentsScope'],
  }
}

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
        currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
        searchText: '', rowDensity: 'normal', linkSummaries: LINK_SUMMARIES,
        // groupField switches the grid into the grouped <tbody> render path.
        groupField: FIELDS[0],
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaGridTable — A3 fetch-record threads to GROUPED rows', () => {
  it('renders clickable linked-record chips in grouped rows when fetchRecord is provided', async () => {
    const fetchRecord = vi.fn(async (id: string) => foreignContext(id))
    const root = mountGrid({ fetchRecord })
    await nextTick()

    // Grouping is on: the grouped <tbody> must be the render path used.
    expect(root.querySelectorAll('.meta-grid__group-header').length).toBeGreaterThan(0)
    // The regression: the grouped-row renderer must have received :fetch-record,
    // so the chips are clickable buttons (not plain non-clickable spans).
    const chips = root.querySelectorAll('[data-test="link-chip"]')
    expect(chips.length).toBe(2)
  })

  it('keeps grouped chips non-clickable when no fetchRecord prop is supplied (renderer stays pure)', async () => {
    const root = mountGrid({})
    await nextTick()

    expect(root.querySelectorAll('.meta-grid__group-header').length).toBeGreaterThan(0)
    expect(root.querySelector('[data-test="link-chip"]')).toBeNull()
    // Summaries still render as read-only text.
    expect(root.textContent).toContain('Acme Supply')
  })
})

// #5795 refuter round: the grid hands the host's server-side mention search to BOTH of its MetaCellEditor
// instances (flat rows and GROUPED rows), the same two-path shape as the fetchRecord wire above. Only
// MetaCellEditor's rich-longText branch consumes it, and the grid's EDITABLE set does not include
// `longText` today, so no typed `@term` can reach it through the grid yet; this pins the prop hand-off
// itself (the REAL editor instance's props), so the wire is not silently lost before that changes.
function findComponentProps(vnode: VNode | null | undefined, target: unknown): Record<string, unknown> | null {
  if (!vnode) return null
  if (vnode.type === target && vnode.component) return vnode.component.props as Record<string, unknown>
  if (vnode.component) return findComponentProps(vnode.component.subTree, target)
  if (Array.isArray(vnode.children)) {
    for (const child of vnode.children) {
      const found = findComponentProps(child as VNode, target)
      if (found) return found
    }
  }
  return null
}

describe('MetaGridTable — #5795 mentionSearch threads to the cell editor on BOTH render paths', () => {
  const EDIT_FIELDS: MetaField[] = [{ id: 'status', name: 'Status', type: 'string' }]
  const EDIT_ROWS = [{ id: 'r1', version: 1, data: { status: 'Open' } }]

  async function openEditor(grouped: boolean, mentionSearch: unknown) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(MetaGridTable, {
          rows: EDIT_ROWS, visibleFields: EDIT_FIELDS, sortRules: [], loading: false,
          currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
          searchText: '', rowDensity: 'normal',
          ...(grouped ? { groupField: EDIT_FIELDS[0] } : {}),
          mentionSearch,
        })
      },
    })
    app.mount(container)
    await nextTick()
    expect(container.querySelectorAll('.meta-grid__group-header').length > 0).toBe(grouped)
    const cell = container.querySelector('tr.meta-grid__row .meta-grid__cell') as HTMLElement
    cell.click()
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    await nextTick()
    return findComponentProps(app._instance?.subTree, MetaCellEditor)
  }

  for (const grouped of [false, true]) {
    it(`${grouped ? 'grouped' : 'flat'} rows: the mounted MetaCellEditor receives the host's mentionSearch`, async () => {
      const search = vi.fn(async () => ({ items: [], requiresQuery: false, hasMore: false }))
      const props = await openEditor(grouped, search)
      expect(props).not.toBeNull()
      expect(props!.mentionSearch).toBe(search)
    })
  }
})
