/**
 * grid-commit-reliability (D1-D4): MetaGridTable's cell edit lifecycle used to lose data silently.
 *
 *   D1 — no type-to-edit: a printable keystroke on a focused, editable cell did nothing (editing only
 *        started via dblclick or Enter).
 *   D2 — click-away / Tab did not commit: clicking a different cell (or Tab-ing out) left the editor
 *        mounted holding an uncommitted draft ("dangling editor") — the value was lost on reload.
 *   D3 — Enter committed, then immediately re-opened the editor (the same keydown bubbled to the grid
 *        root's onKeydown after confirmEdit cleared editCell, whose Enter case re-called startEdit).
 *   D4 — no IME guard: an Enter/Escape fired while an IME composition was in progress could prematurely
 *        commit/close a cell.
 *
 * Each `it` below is a DISCRIMINATING test for one specific mechanism (see the per-test comment for which
 * mutation it catches) — not a generic "the feature works" smoke test. Several deliberately dispatch the
 * key/focus event directly on the editor's <input> (not the grid root) because that is the only way to
 * exercise the editor-side stopPropagation / isComposing / blur-relatedTarget guards; dispatching on the
 * grid root instead would make the corresponding mutation (see the PR's mutation ledger) vacuous.
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
})

// Column 0 = string (type-to-edit unrestricted), column 1 = number (type-to-edit digit-gated — see the
// D1 number-gating test below for why).
const FIELDS: MetaField[] = [
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'score', name: 'Score', type: 'number' },
]

function makeRows(): MetaRecord[] {
  return [
    { id: 'r0', version: 1, data: { title: 'Row 0', score: 10 } },
    { id: 'r1', version: 1, data: { title: 'Row 1', score: 20 } },
  ]
}

function mountGrid(rows: MetaRecord[], onPatchCell: (...args: unknown[]) => void): HTMLDivElement {
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
function editorInput(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector('.meta-cell-editor__input') as HTMLInputElement | null
}
/** Column index (within its row's `.meta-grid__cell` siblings) of the currently keyboard-focused
 * cell, or -1 if none. Used to prove Tab actually MOVED focus (and moved it the right direction) —
 * not just that the editor closed, which a broken stopPropagation could still leave true (see the
 * D2 Tab-variant test below for why this matters). */
function focusedColIndex(root: HTMLElement): number {
  const focused = root.querySelector('.meta-grid__cell--focused')
  if (!focused) return -1
  const row = focused.parentElement
  return Array.from(row?.querySelectorAll('.meta-grid__cell') ?? []).indexOf(focused)
}

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

/** click() then dblclick — mirrors the two real click events a browser fires before a dblclick, which
 * is what actually sets focusRow/focusCol via onCellClick (a bare synthetic 'dblclick' does not). */
function clickThenDblclick(cell: HTMLElement) {
  cell.click()
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MetaGridTable cell-edit commit reliability (D1-D4)', () => {
  // ── D1: type-to-edit ────────────────────────────────────────────────────────────────────────
  it('D1: a single click only focuses (no editor); a printable key then opens the editor seeded with exactly that character', async () => {
    // CONTRACT CHANGE (round 3, P3-1): the `title` column here is a plain
    // `string` field AND this fixture's non-grouped MetaGridTable render
    // path wires `:record-id="row.id"` — the exact condition that now makes
    // a cell "Yjs-binding-eligible" (see MetaGridTable's D1 doc comment /
    // `isYjsTextEligible`), regardless of whether the Yjs feature flag is
    // actually on. P3-1 carves Yjs-eligible cells OUT of the seed-with-e.key
    // rule this test exercises: the editor still opens on the SAME printable
    // keydown, but empty rather than pre-seeded with 'a' (see the round-2
    // spec's dedicated P3-1 test for the full rationale + `defaultPrevented`
    // assertion). The number column below (D1 number-gating) is UNAFFECTED —
    // P3-1 only applies to `string` fields.
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    cellAt(root, 0, 0).click()
    await flushUi()
    // Single click must NOT start editing (that stays dblclick/Enter's job) — MUTATION: removing the
    // D1 printable-key branch would make this whole test vacuous by making BOTH assertions pass for the
    // wrong reason; the keydown assertion below is the one that actually catches its removal.
    expect(editorInput(root)).toBeNull()

    gridEl(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    await flushUi()

    const input = editorInput(root)
    expect(input).toBeTruthy()
    // Empty, not 'a' — see the CONTRACT CHANGE note above (P3-1).
    expect(input!.value).toBe('')
    expect(patchSpy).not.toHaveBeenCalled()
  })

  it('D1 (number gating): a digit seeds a number cell as a Number; a non-digit letter does not open it', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    cellAt(root, 0, 1).click() // score (number), column 1
    await flushUi()

    gridEl(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true }))
    await flushUi()
    // A letter is not numeric-leading — must not open the editor (would otherwise seed a string draft
    // into a numeric column; see the onKeydown D1 comment for why number seeding is digit-only).
    expect(editorInput(root)).toBeNull()

    gridEl(root).dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }))
    await flushUi()
    const input = editorInput(root)
    expect(input).toBeTruthy()
    expect(input!.value).toBe('7')
  })

  // ── D2: click-away / Tab must commit; Escape must not ──────────────────────────────────────
  it('D2: typing then clicking a DIFFERENT cell commits exactly once and leaves no dangling editor', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    typeInto(editorInput(root)!, 'hello')
    await flushUi()

    // A plain single click on a different cell — this does NOT itself open a new editor.
    cellAt(root, 1, 0).click()
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
    expect(editorInput(root)).toBeNull()
  })

  it('D2 (Tab variant): Tab commits the draft, closes the editor, does not open the next cell\'s editor, and moves focus to the adjacent (score) column', async () => {
    // Asserting focus movement (not just "editor closed") matters: without MetaCellEditor's
    // stopPropagation on Tab, the SAME keydown would bubble to the grid root's onKeydown (editCell
    // is already null by then) and its own `case 'ArrowRight': case 'Tab':` would move focus a
    // SECOND time — one patch-cell, editor closed either way, but focus lands one column further
    // than it should. That regression would be invisible to a test that only checks the editor
    // closed and the patch count.
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0)) // title, column 0
    await flushUi()
    expect(focusedColIndex(root)).toBe(0)
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
    expect(editorInput(root)).toBeNull()
    expect(focusedColIndex(root)).toBe(1) // moved to score (column 1), not two columns over
  })

  it('D2 (Shift+Tab variant): moves focus to the PREVIOUS column (proves the !shiftKey inversion, not just that Tab moves forward)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 1)) // score, column 1
    await flushUi()
    expect(focusedColIndex(root)).toBe(1)
    typeInto(editorInput(root)!, '5')
    await flushUi()

    editorInput(root)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    await flushUi()

    expect(editorInput(root)).toBeNull()
    expect(focusedColIndex(root)).toBe(0) // moved BACK to title (column 0)
  })

  it('D2 (Escape variant): Escape discards the draft — no patch-cell', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
    expect(editorInput(root)).toBeNull()
  })

  it('D2 (blur-commit discriminator): a genuine blur to something outside the grid commits the pending draft', async () => {
    // Dispatches a raw `blur` FocusEvent straight at the editor's <input> — the ONLY test that
    // exercises MetaCellEditor's onTextBlur/shouldIgnoreBlur path directly (the "click another cell"
    // test above passes via MetaGridTable's onCellClick guard instead, since jsdom's synthetic .click()
    // never transfers real DOM focus — so it would stay green even if blur-commit were removed).
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
    expect(editorInput(root)).toBeNull()
    outside.remove()
  })

  it('no patch-cell when the draft is unchanged on blur (editor still closes)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    // no typing — draft stays the original 'Row 0'

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
    expect(editorInput(root)).toBeNull()
    outside.remove()
  })

  it('switching editor cells via startEdit commits the previously open editor first (never two drafts)', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    typeInto(editorInput(root)!, 'hello')
    await flushUi()

    // dblclick a DIFFERENT cell directly — no intervening click — so this exercises startEdit's own
    // commit-previous guard specifically, not onCellClick's.
    cellAt(root, 1, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
    const reopened = editorInput(root)
    expect(reopened).toBeTruthy()
    expect(reopened!.value).toBe('Row 1') // the NEW editor, seeded with row 1's own existing value
  })

  // ── D3: Enter commits once and must not re-open ────────────────────────────────────────────
  it('D3: Enter commits exactly once and closes without re-opening; a fresh second Enter does reopen', async () => {
    // Dispatched on the <input> itself (bubbles: true) — dispatching on the grid root instead would
    // never reach MetaCellEditor's stopPropagation, making the "remove stopPropagation" mutation vacuous.
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
    expect(editorInput(root)).toBeNull() // committed AND closed, not reopened by the same keydown

    // A SECOND, independent Enter keydown (proving the guard is scoped to the single confirming event,
    // not a standing "Enter never reopens this cell" flag) still opens the editor normally.
    gridEl(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushUi()
    expect(editorInput(root)).toBeTruthy()
  })

  // ── D4: IME composition guard ───────────────────────────────────────────────────────────────
  it('D4: an Enter fired mid-IME-composition does not commit and leaves the editor open', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true } as KeyboardEventInit)
    input.dispatchEvent(composingEnter)
    await flushUi()

    expect(patchSpy).not.toHaveBeenCalled()
    expect(editorInput(root)).toBeTruthy() // still mounted — composition did not commit or close it
  })

  it('D4 (positive control): the identical Enter with isComposing=false does commit', async () => {
    const patchSpy = vi.fn()
    const root = mountGrid(makeRows(), patchSpy)
    await flushUi()

    clickThenDblclick(cellAt(root, 0, 0))
    await flushUi()
    const input = editorInput(root)!
    typeInto(input, 'hello')
    await flushUi()

    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: false } as KeyboardEventInit)
    input.dispatchEvent(plainEnter)
    await flushUi()

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(editorInput(root)).toBeNull()
  })
})
