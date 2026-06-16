/**
 * Duplicate / clone record (design 2026-06-16) — grid right-click affordance.
 * Right-clicking a row emits `duplicate-record` (the workbench owns the gated create + clone-open). The
 * affordance is gated on `canCreate` and suppressed while a cell is being edited (so the native copy/paste
 * menu still works inside the editor). NO front-end permission mirror — the server re-enforces canCreateRecord.
 */
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

function rightClickRow(root: HTMLElement): { event: MouseEvent; defaultPrevented: boolean } {
  const row = root.querySelector('.meta-grid__row') as HTMLElement
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  row.dispatchEvent(event)
  return { event, defaultPrevented: event.defaultPrevented }
}

describe('MetaGridTable duplicate context affordance', () => {
  it('emits duplicate-record with the row id on right-click when canCreate', () => {
    const onDuplicateRecord = vi.fn()
    const root = mountGrid({ canCreate: true, rows: ONE_ROW, onDuplicateRecord })
    const { defaultPrevented } = rightClickRow(root)
    expect(onDuplicateRecord).toHaveBeenCalledTimes(1)
    expect(onDuplicateRecord).toHaveBeenCalledWith('r1')
    // suppresses the native menu so the row affordance is the menu
    expect(defaultPrevented).toBe(true)
  })

  it('does NOT emit and does NOT suppress the native menu when canCreate is false (capability gate)', () => {
    const onDuplicateRecord = vi.fn()
    const root = mountGrid({ canCreate: false, rows: ONE_ROW, onDuplicateRecord })
    const { defaultPrevented } = rightClickRow(root)
    expect(onDuplicateRecord).not.toHaveBeenCalled()
    expect(defaultPrevented).toBe(false)
  })
})
