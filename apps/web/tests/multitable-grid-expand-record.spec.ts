/**
 * Record inspector v3 (2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md,
 * PR-A §1.1 explicit-open, §1.5 keyboard). Two new MetaGridTable.vue open-triggers for the record
 * inspector: the row-number expand icon (`data-test=grid-open-record`) and Shift+Space on a focused
 * row. Both emit the new `expand-record` event — distinct from `select-record` (cursor-move only,
 * unchanged) and from the pre-existing `toggle-group`/row-detail `expand`/`collapse` glyph
 * (`meta-grid__expand-btn`), which this PR does not touch.
 *
 * Pins the #5481 boundary explicitly: bare Space still starts type-to-edit (the positive control for
 * "Shift+Space is intercepted BEFORE the printable-key branch, not instead of it").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

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
const ROWS: MetaRecord[] = [
  { id: 'r0', version: 1, data: { title: 'Row 0' } },
  { id: 'r1', version: 1, data: { title: 'Row 1' } },
]

function mountGrid(propsOverride: Record<string, unknown> = {}): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(MetaGridTable, {
        rows: ROWS,
        visibleFields: [TITLE_FIELD],
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        selectedRecordId: null,
        canEdit: true,
        canDelete: true,
        ...propsOverride,
      })
    },
  })
  app.mount(container)
  return container
}

function gridEl(root: HTMLElement): HTMLElement {
  return root.querySelector('.meta-grid') as HTMLElement
}
function cellAt(root: HTMLElement, rowIndex: number, colIndex: number): HTMLElement {
  const rows = root.querySelectorAll('tbody tr.meta-grid__row')
  return rows[rowIndex]!.querySelectorAll('.meta-grid__cell')[colIndex] as HTMLElement
}
function openRecordBtn(root: HTMLElement, rowIndex: number): HTMLButtonElement {
  const rows = root.querySelectorAll('tbody tr.meta-grid__row')
  return rows[rowIndex]!.querySelector('[data-test="grid-open-record"]') as HTMLButtonElement
}

describe('MetaGridTable expand-record (row-number icon + Shift+Space)', () => {
  describe('row-number icon', () => {
    it('is present for every row, always in the a11y tree (aria-label, not display:none-gated)', () => {
      const root = mountGrid()
      const btn = openRecordBtn(root, 0)
      expect(btn).not.toBeNull()
      expect(btn.getAttribute('aria-label')).toBeTruthy()
      expect(btn.hasAttribute('hidden')).toBe(false)
    })

    it('click emits expand-record with THAT row\'s id and does not ALSO emit select-record (stopPropagation)', () => {
      const onExpand = vi.fn()
      const onSelect = vi.fn()
      const root = mountGrid({ onExpandRecord: onExpand, onSelectRecord: onSelect })
      openRecordBtn(root, 1).click()
      expect(onExpand).toHaveBeenCalledTimes(1)
      expect(onExpand).toHaveBeenCalledWith('r1')
      // Mutation target: removing `@click.stop` on this button would let the click ALSO bubble to
      // the row's own `@click="emit('select-record', ...)"` — this assertion is what goes red.
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  describe('Shift+Space', () => {
    it('on a focused row with no active cell editor emits expand-record for the focused row', () => {
      const onExpand = vi.fn()
      const root = mountGrid({ onExpandRecord: onExpand })
      cellAt(root, 0, 0).click() // sets focusRow=0, focusCol=0 (via onCellClick)
      gridEl(root).dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', shiftKey: true, bubbles: true, cancelable: true,
      }))
      expect(onExpand).toHaveBeenCalledTimes(1)
      expect(onExpand).toHaveBeenCalledWith('r0')
    })

    it('with an active cell editor emits nothing (guarded by the pre-existing editCell.value return above D1)', async () => {
      const onExpand = vi.fn()
      const root = mountGrid({ onExpandRecord: onExpand })
      const cell = cellAt(root, 0, 0)
      cell.click()
      cell.dispatchEvent(new (globalThis as any).MouseEvent('dblclick', { bubbles: true })) // opens the editor
      await flushUi()
      // Confirm the editor is genuinely open (not a vacuous guard check) before proving Shift+Space
      // is suppressed by it.
      expect(root.querySelector('.meta-cell-editor__input')).not.toBeNull()
      gridEl(root).dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', shiftKey: true, bubbles: true, cancelable: true,
      }))
      expect(onExpand).not.toHaveBeenCalled()
    })

    // #5481 positive control (design's own grounding-facts note: bare Space is type-to-edit on this
    // head, NOT an inspector-open chord — Proposal 1's bare-Space claim was stale against #5481 and
    // Shift+Space replaces it). Without this test, a mutation that deleted the Shift+Space branch's
    // `e.shiftKey` check (making BARE Space also emit expand-record) would go undetected.
    it('bare Space (no Shift) on a focused editable string cell still starts type-to-edit, not expand-record', async () => {
      const onExpand = vi.fn()
      const onPatch = vi.fn()
      const root = mountGrid({ onExpandRecord: onExpand, onPatchCell: onPatch })
      cellAt(root, 0, 0).click()
      const evt = new KeyboardEvent('keydown', { key: ' ', shiftKey: false, bubbles: true, cancelable: true })
      gridEl(root).dispatchEvent(evt)
      await flushUi()
      expect(onExpand).not.toHaveBeenCalled()
      expect(evt.defaultPrevented).toBe(true) // D1 consumes the keystroke (byte-identical #5481 behavior)
      // Type-to-edit seeded the editor with a space character — confirmed by the now-open editor
      // input's value, not by a patch call (D2 only commits on blur/Tab/Enter).
      const input = root.querySelector('.meta-cell-editor__input') as HTMLInputElement | null
      expect(input).not.toBeNull()
      expect(input!.value).toBe(' ')
    })
  })
})
