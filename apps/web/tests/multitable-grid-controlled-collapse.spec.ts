import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'f_status', name: 'Status', type: 'string' },
  { id: 'f_title', name: 'Title', type: 'string' },
]
const GROUP_FIELD = FIELDS[0]
const ROWS: MetaRecord[] = [
  { id: 'r1', version: 1, data: { f_status: 'todo', f_title: 'A' } },
  { id: 'r2', version: 1, data: { f_status: 'todo', f_title: 'B' } },
  { id: 'r3', version: 1, data: { f_status: 'done', f_title: 'C' } },
]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
        currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
        searchText: '', rowDensity: 'normal', groupField: GROUP_FIELD,
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

const dataRows = (root: HTMLElement) => Array.from(root.querySelectorAll('.meta-grid__row')) as HTMLElement[]
const groupHeaders = (root: HTMLElement) => Array.from(root.querySelectorAll('.meta-grid__group-header')) as HTMLElement[]
const toggles = (root: HTMLElement) => Array.from(root.querySelectorAll('.meta-grid__group-toggle')) as HTMLElement[]

describe('MetaGridTable group-collapse — controlled from parent', () => {
  it('renders all rows when no group is collapsed', () => {
    const root = mountGrid({ collapsedGroupKeys: [] })
    expect(groupHeaders(root)).toHaveLength(2) // todo + done
    expect(dataRows(root)).toHaveLength(3)
    // expanded glyph (▼) for both groups
    expect(toggles(root).map((t) => t.textContent?.trim())).toEqual(['▼', '▼'])
  })

  it('hides the rows of a group whose key is in collapsedGroupKeys', () => {
    const root = mountGrid({ collapsedGroupKeys: ['todo'] })
    // only the "done" group's single row remains visible
    expect(dataRows(root)).toHaveLength(1)
    // collapsed group shows ▶, expanded shows ▼
    expect(toggles(root).map((t) => t.textContent?.trim())).toEqual(['▶', '▼'])
  })

  it('emits toggle-group with the group key on header click (does NOT mutate locally)', () => {
    const onToggleGroup = vi.fn()
    const root = mountGrid({ collapsedGroupKeys: [], onToggleGroup })
    groupHeaders(root)[0].click() // "todo" group header
    expect(onToggleGroup).toHaveBeenCalledWith('todo')
    // Controlled: with no prop change, rows stay visible (no internal collapse ref took over)
    expect(dataRows(root)).toHaveLength(3)
  })

  it('groups null/empty values under __ungrouped__ and can collapse it', () => {
    const root = mountGrid({
      rows: [{ id: 'rx', version: 1, data: { f_title: 'X' } }],
      collapsedGroupKeys: ['__ungrouped__'],
    })
    expect(dataRows(root)).toHaveLength(0) // the sole ungrouped row is collapsed away
  })

  it('keyboard nav (displayRows/flatIndex) skips a collapsed group with the controlled prop set', () => {
    // collapse the "todo" group (r1,r2): the flat nav list must contain ONLY r3 (the "done" group),
    // so the first ArrowDown selects r3 — proving displayRows/flatIndex read the controlled set.
    const onSelectRecord = vi.fn()
    const root = mountGrid({ collapsedGroupKeys: ['todo'], onSelectRecord })
    const gridEl = root.querySelector('.meta-grid') as HTMLElement
    gridEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(onSelectRecord).toHaveBeenLastCalledWith('r3')
    // a second ArrowDown stays on r3 (collapsed rows are not in the nav list, so no overshoot)
    gridEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(onSelectRecord).toHaveBeenLastCalledWith('r3')
  })
})
