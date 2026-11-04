/**
 * Grid right-click on a row (customer feedback 2026-10-27, 「在某行 右击 就出现 记录已复制」).
 *
 * Until 2026-10-27 a right-click on a row emitted `duplicate-record` instantly (design 2026-06-16): the
 * workbench POSTed `/records/:id/duplicate`, a NEW record was created on every right-click, and the toast
 * 「记录已复制」 read as "copied to the clipboard". On a sheet whose rows a plugin maintains, the copy cloned the
 * row's idempotency key and held the next pull. The grid now binds NO contextmenu handler: the browser's own
 * menu shows, nothing is emitted, nothing is requested. Duplicating is the record drawer's explicit 复制 action,
 * behind a confirm (multitable-workbench-drawer-button-wiring.spec.ts).
 *
 * TRIPWIRE: re-binding the old instant duplicate on either row renderer (flat or grouped) reds this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
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
  vi.unstubAllGlobals()
})

const TITLE_FIELD: MetaField = { id: 'title', name: 'Title', type: 'string' }
const KIND_FIELD: MetaField = { id: 'kind', name: 'Kind', type: 'string' }
const ROWS: MetaRecord[] = [
  { id: 'r1', version: 1, data: { title: 'Alpha', kind: 'A' } },
  { id: 'r2', version: 1, data: { title: 'Beta', kind: 'B' } },
]

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: ROWS,
        visibleFields: [TITLE_FIELD, KIND_FIELD],
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

function rightClick(target: HTMLElement): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function dataRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.meta-grid__row'))
}

describe('MetaGridTable right-click creates nothing (customer feedback 2026-10-27)', () => {
  it('flat rows: right-click on a row or a cell emits nothing, requests nothing, and leaves the native menu', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onDuplicateRecord = vi.fn()
    const onCreateRecord = vi.fn()
    const root = mountGrid({ canCreate: true, onDuplicateRecord, onCreateRecord })
    await nextTick()

    const rows = dataRows(root)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(rightClick(row)).toBe(false)
      const cell = row.querySelector<HTMLElement>('td:last-child')
      expect(cell).not.toBeNull()
      expect(rightClick(cell!)).toBe(false)
    }
    await nextTick()

    expect(onDuplicateRecord).not.toHaveBeenCalled()
    expect(onCreateRecord).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('grouped rows: right-click emits nothing and leaves the native menu either', async () => {
    const onDuplicateRecord = vi.fn()
    const root = mountGrid({ canCreate: true, groupField: KIND_FIELD, onDuplicateRecord })
    await nextTick()

    // The grouped renderer is the one under test: group header rows are present.
    expect(root.querySelectorAll('[data-test="group-header"]').length).toBe(2)
    const rows = dataRows(root)
    expect(rows.length).toBe(2)
    for (const row of rows) expect(rightClick(row)).toBe(false)
    await nextTick()

    expect(onDuplicateRecord).not.toHaveBeenCalled()
  })

  it('canCreate false: still nothing (unchanged)', async () => {
    const onDuplicateRecord = vi.fn()
    const root = mountGrid({ canCreate: false, onDuplicateRecord })
    await nextTick()

    expect(rightClick(dataRows(root)[0])).toBe(false)
    expect(onDuplicateRecord).not.toHaveBeenCalled()
  })
})
