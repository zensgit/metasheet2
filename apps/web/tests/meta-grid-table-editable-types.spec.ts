/**
 * EDITABLE whitelist expansion (矩阵 #4/#7): MetaGridTable's inline cell editor used to hard-exclude
 * `person` / `multiSelect` / `dateTime` from the EDITABLE set — dblclick on those columns did nothing
 * (isEditable() returned false, startEdit() no-opped). This PR opens exactly those three (the other 12
 * non-EDITABLE types are out of scope). Each `it` below is discriminating for ONE of:
 *   - EDITABLE gaining the type (dblclick now mounts MetaCellEditor with the matching DOM branch)
 *   - pasteFocusedCell's early-return for person/multiSelect (array-valued fields — raw clipboard text
 *     would 400 server-side; see record-write-service.ts field validation)
 *   - the dateTime branch's D2 commit wiring, ONE handler per test: @keydown.tab (Tab case) and
 *     @blur (the two blur cases) are asserted separately, because a test that only fires Tab stays
 *     green when @blur alone is deleted, and vice versa
 *
 * Mirrors the mount helper from multitable-grid-cell-edit-commit.spec.ts (createApp + h, no
 * @vue/test-utils in this codebase).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { dateTimeValueFromLocalInput } from '../src/multitable/utils/field-display'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

// jsdom has no navigator.clipboard by default — pasteFocusedCell's `await
// navigator.clipboard.readText()` would throw synchronously into its own try/catch and never reach
// `emit('patch-cell', ...)` regardless of whether the person/multiSelect early-return guard exists,
// which would make the Ctrl+V tests below pass for the WRONG reason (a vacuous "guard" that never ran).
// Stubbing clipboard.readText to actually resolve text makes those tests discriminating: without the
// guard, this text WOULD reach emit('patch-cell', ...).
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { readText: vi.fn().mockResolvedValue('pasted text') },
    configurable: true,
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

// Column 0 = person, column 1 = multiSelect, column 2 = dateTime — the three types this PR opens.
const FIELDS: MetaField[] = [
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'tags', name: 'Tags', type: 'multiSelect', options: [{ value: 'Alpha' }, { value: 'Beta' }] },
  { id: 'visit', name: 'Visit', type: 'dateTime' },
]

function makeRows(): MetaRecord[] {
  return [{ id: 'r0', version: 1, data: { owner: [], tags: [], visit: null } }]
}

function mountGrid(
  rows: MetaRecord[],
  onPatchCell: (...args: unknown[]) => void,
  extraListeners: Record<string, unknown> = {},
): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(MetaGridTable, {
        rows,
        visibleFields: FIELDS,
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        selectedRecordId: null,
        canEdit: true,
        canDelete: true,
        onPatchCell,
        ...extraListeners,
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
function clickThenDblclick(cell: HTMLElement) {
  cell.click()
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}
async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('MetaGridTable EDITABLE whitelist: person / multiSelect / dateTime (矩阵 #4/#7)', () => {
  it('person: dblclick opens the native person picker button (not a plain text input)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()

    const pickerBtn = root.querySelector('[data-test="person-picker-open"]') as HTMLButtonElement | null
    expect(pickerBtn).toBeTruthy()
    expect(pickerBtn!.tagName).toBe('BUTTON')
    // Zero selected people (row seeded with []) — EN default locale copy per link-fields.ts.
    expect(pickerBtn!.textContent).toContain('Choose people')
    // No plain text input rendered for this branch (would indicate the string fallback, not the
    // dedicated person branch).
    expect(root.querySelector('.meta-cell-editor__input')).toBeNull()
  })

  it('person: clicking the picker button forwards open-person-picker to the host as { recordId, field } (the grid-side wiring this PR first makes reachable)', async () => {
    // Discriminator for MetaGridTable's own `@open-person-picker="openPersonPickerFromCell(...)"`
    // forwarding (both the grouped-row and flat-row editor slots). The render-only person test above
    // stays green if that forwarding is deleted — the button still renders, it just goes nowhere and
    // the user can never actually pick a person, which is exactly the user-visible bug this PR fixes.
    const patchSpy = vi.fn()
    const pickerSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy, { onOpenPersonPicker: pickerSpy })
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()

    const pickerBtn = root.querySelector('[data-test="person-picker-open"]') as HTMLButtonElement | null
    expect(pickerBtn).toBeTruthy()
    pickerBtn!.click()
    await flushUi()

    expect(pickerSpy).toHaveBeenCalledTimes(1)
    expect(pickerSpy).toHaveBeenCalledWith({ recordId: 'r0', field: FIELDS[0] })
    // openPersonPickerFromCell cancels the inline edit before emitting, so no editor is left dangling
    // behind the picker dialog the host opens.
    expect(root.querySelector('[data-test="person-picker-open"]')).toBeNull()
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('person (GROUPED rows): the grouped render path forwards open-person-picker as well', async () => {
    // MetaGridTable renders data rows through TWO independent template branches (`v-if="groupedRows"`
    // and the flat `v-else` tbody), each with its own `@open-person-picker="openPersonPickerFromCell(...)"`.
    // The flat-path test above stays green when the GROUPED forward is deleted, so grouping is asserted
    // separately — otherwise "person is editable" would silently only hold for ungrouped views.
    const patchSpy = vi.fn()
    const pickerSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy, { groupFields: [FIELDS[2]], onOpenPersonPicker: pickerSpy })
    await flushUi()
    // Sanity: we really are on the grouped branch, not silently back on the flat one.
    expect(root.querySelector('[data-test="group-header"]')).toBeTruthy()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()

    const pickerBtn = root.querySelector('[data-test="person-picker-open"]') as HTMLButtonElement | null
    expect(pickerBtn).toBeTruthy()
    pickerBtn!.click()
    await flushUi()

    expect(pickerSpy).toHaveBeenCalledTimes(1)
    expect(pickerSpy).toHaveBeenCalledWith({ recordId: 'r0', field: FIELDS[0] })
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('multiSelect: dblclick opens a native multi-select <select multiple> with the field options', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 1))
    await flushUi()

    const select = root.querySelector('select.meta-cell-editor__select--multi') as HTMLSelectElement | null
    expect(select).toBeTruthy()
    expect(select!.multiple).toBe(true)
    const optionValues = Array.from(select!.options).map((o) => o.value)
    expect(optionValues).toEqual(['Alpha', 'Beta'])
  })

  it('dateTime: dblclick opens a datetime-local input', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 2))
    await flushUi()

    const input = root.querySelector('input[type="datetime-local"]') as HTMLInputElement | null
    expect(input).toBeTruthy()
  })

  it('dateTime: Tab commits and closes the editor (D2 parity — the dateTime branch was missing @keydown.tab/@blur before this fix)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 2))
    await flushUi()

    const input = root.querySelector('input[type="datetime-local"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = '2026-05-06T10:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'visit', dateTimeValueFromLocalInput('2026-05-06T10:30'), 1)
    // No dangling editor after Tab-commit.
    expect(root.querySelector('input[type="datetime-local"]')).toBeNull()
  })

  it('dateTime: a genuine blur to something outside the grid commits the pending draft (D2 — @blur was the OTHER half missing from this branch)', async () => {
    // Discriminator for `@blur="onScalarBlur"` on the dateTime branch SPECIFICALLY. The Tab test
    // above stays green if only @blur is deleted (it never fires a FocusEvent), so without this
    // case the blur half of the D2 fix would be untested. A raw `blur` FocusEvent is dispatched at
    // the <input> because jsdom's synthetic .click() never transfers real DOM focus — a
    // click-another-cell test would pass via MetaGridTable's own onCellClick commit guard instead
    // and stay green with blur-commit removed. `relatedTarget` is an element OUTSIDE the editor so
    // MetaCellEditor's shouldIgnoreBlur (in-editor focus move) does not swallow it.
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 2))
    await flushUi()

    const input = root.querySelector('input[type="datetime-local"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = '2026-05-06T10:30'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'visit', dateTimeValueFromLocalInput('2026-05-06T10:30'), 1)
    // No dangling editor after blur-commit — the D2 symptom this PR fixes.
    expect(root.querySelector('input[type="datetime-local"]')).toBeNull()
    outside.remove()
  })

  it('dateTime: no patch-cell when the draft is unchanged on blur (editor still closes)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 2))
    await flushUi()
    const input = root.querySelector('input[type="datetime-local"]') as HTMLInputElement
    expect(input).toBeTruthy()
    // no typing — the staged draft stays the row's original `null`

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
    // Closing on an unchanged blur is still the fix's job: without @blur the editor would hang open.
    expect(root.querySelector('input[type="datetime-local"]')).toBeNull()
    outside.remove()
  })

  it('person: Ctrl+V on the focused cell does NOT emit patch-cell (array-valued field — raw clipboard text would 400 server-side)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    // Single click focuses the person cell WITHOUT opening the editor (pasteFocusedCell's target is
    // the focused, non-editing cell — same precondition as the existing D2 paste tests).
    cellAt(root, 0, 0).click()
    await flushUi()
    expect(root.querySelector('[data-test="person-picker-open"]')).toBeNull()

    const pasteEvt = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    gridEl(root).dispatchEvent(pasteEvt)
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('multiSelect: Ctrl+V on the focused cell does NOT emit patch-cell (same array-valued guard as person)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    cellAt(root, 0, 1).click()
    await flushUi()

    const pasteEvt = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    gridEl(root).dispatchEvent(pasteEvt)
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
  })
})
