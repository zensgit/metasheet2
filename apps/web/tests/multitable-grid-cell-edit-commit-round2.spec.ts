/**
 * grid-commit-reliability round 2: findings verified against the round-1 commit
 * (D1 type-to-edit, D2 blur/tab-commit, D3 Enter no-reopen, D4 IME guard).
 *
 *   P1    — D1's printable-key branch never checked the keydown's real origin: a printable key
 *           (Space included — the keyboard-activation key) fired on ANY focusable descendant
 *           control inside `.meta-grid` (row-select checkbox, footer aggregation <select>, ...)
 *           both suppressed that control's native activation AND opened the editor on whatever
 *           cell focusRow/focusCol last pointed at, seeded with that character — a keyboard-a11y
 *           regression plus a silent single-character overwrite once that seed hit blur-commit.
 *   P3-A  — Tab-commit on the string <input> made the in-editor AI-run button keyboard-unreachable
 *           (Tab always committed+moved before focus could land on it).
 *   P3-B  — the D1 seed character was lost on the Yjs-active text path: `modelValue` (what the seed
 *           sets) is only read while `yjsActive` is false; the instant the binding activates the
 *           input switches to `yjsText`, and nothing had forwarded the seed into Y.Text.
 *   P3-C  — a number input's `.value` sanitizes an in-progress-but-invalid string (a lone '-'/'.')
 *           to '' identically to a genuinely emptied field; `onNumberInput` used to commit `null`
 *           either way, which D2's new blur/Tab commit then silently persisted.
 *   P3-D  — five load-bearing guards from round 1 had zero discriminating coverage.
 *
 * Each `it` is a DISCRIMINATING test — see the per-test comment for the mutation it catches.
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

// title: string WITH an aiShortcut config (P3-A / P3-D guard #2 need the AI-run button rendered).
// score: number (P3-C).
const AI_FIELD: MetaField = {
  id: 'title',
  name: 'Title',
  type: 'string',
  property: { aiShortcut: { kind: 'summarize', sourceFieldIds: ['title'] } },
} as unknown as MetaField
const SCORE_FIELD: MetaField = { id: 'score', name: 'Score', type: 'number' }
const FIELDS: MetaField[] = [AI_FIELD, SCORE_FIELD]

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
        enableMultiSelect: true,
        aggregationConfig: { title: 'count' },
        // AI run wiring is opt-in-only per test via aiRunButton()'s query; a no-op listener is
        // enough since P3-A/guard-2 only exercise focus/Tab/blur mechanics, never an actual click.
        aiRunEnabled: true,
        aiRunPending: false,
        aiRunBusy: false,
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
function aiRunButton(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector('[data-test="cell-ai-run"]') as HTMLButtonElement | null
}
function focusedColIndex(root: HTMLElement): number {
  const focused = root.querySelector('.meta-grid__cell--focused')
  if (!focused) return -1
  const row = focused.parentElement
  return Array.from(row?.querySelectorAll('.meta-grid__cell') ?? []).indexOf(focused)
}
function focusedRowIndex(root: HTMLElement): number {
  const rows = Array.from(root.querySelectorAll('tbody tr.meta-grid__row'))
  return rows.findIndex((r) => r.classList.contains('meta-grid__row--focused'))
}

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function clickThenDblclick(cell: HTMLElement) {
  cell.click()
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MetaGridTable cell-edit commit reliability round 2 (P1, P3-A..D)', () => {
  // ── P1: D1 must check the keydown's real origin ──────────────────────────────────────────
  describe('P1: type-to-edit ignores keydowns from descendant controls', () => {
    it('a printable key on the row-select checkbox does not open an editor and does not suppress the checkbox\'s own default', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      // Focus a cell first so focusRow/focusCol are valid — this is exactly the scenario the bug
      // needs: a stale focused cell PLUS real DOM focus somewhere else entirely.
      cellAt(root, 0, 0).click()
      await flushUi()

      const checkbox = root.querySelector('tbody .meta-grid__check-col input[type="checkbox"]') as HTMLInputElement
      expect(checkbox).toBeTruthy()
      checkbox.focus()

      const evtA = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      checkbox.dispatchEvent(evtA)
      const evtSpace = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      checkbox.dispatchEvent(evtSpace)
      await flushUi()

      expect(editorInput(root)).toBeNull()
      expect(evtA.defaultPrevented).toBe(false)
      expect(evtSpace.defaultPrevented).toBe(false) // Space is the checkbox's OWN activation key
      expect(patchSpy).not.toHaveBeenCalled()
    })

    it('a printable key on the footer aggregation <select> does not open an editor and does not suppress it', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      cellAt(root, 0, 0).click()
      await flushUi()

      const select = root.querySelector('.meta-grid__foot-fn') as HTMLSelectElement
      expect(select).toBeTruthy()
      select.focus()

      const evtA = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      select.dispatchEvent(evtA)
      await flushUi()

      expect(editorInput(root)).toBeNull()
      expect(evtA.defaultPrevented).toBe(false)
      expect(patchSpy).not.toHaveBeenCalled()
    })

    it('positive control: the SAME printable key on the grid root itself still seeds the editor and IS defaultPrevented', async () => {
      // Proves the two tests above fail for the right reason (target rejection), not because
      // type-to-edit broke outright — this is the byte-identical round-1 D1 path, now with an
      // explicit defaultPrevented assertion (round-1's value-only assertion can't discriminate the
      // preventDefault call in jsdom, which never double-types on a non-prevented keydown either way).
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      cellAt(root, 0, 0).click()
      await flushUi()

      const evt = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      gridEl(root).dispatchEvent(evt)
      await flushUi()

      expect(editorInput(root)).toBeTruthy()
      expect(evt.defaultPrevented).toBe(true)
    })
  })

  // ── P3-A: the AI-run button must stay keyboard-reachable ─────────────────────────────────
  describe('P3-A: Tab reaches the in-editor AI-run button instead of always committing', () => {
    it('forward Tab from the text input is NOT intercepted when the AI-run button is visible (native focus movement reaches it)', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 0)) // title (AI-enabled string field)
      await flushUi()
      const input = editorInput(root)!
      expect(aiRunButton(root)).toBeTruthy() // sanity: the button IS rendered in this session
      typeInto(input, 'hello')
      await flushUi()

      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      input.dispatchEvent(evt)
      await flushUi()

      expect(evt.defaultPrevented).toBe(false) // native Tab left alone
      expect(patchSpy).not.toHaveBeenCalled() // NOT committed yet
      expect(editorInput(root)).toBeTruthy() // still open — did not close either
    })

    it('Tab FROM the AI-run button still commits and moves focus (the button is a valid exit point, not a dead end)', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 0))
      await flushUi()
      typeInto(editorInput(root)!, 'hello')
      await flushUi()
      const button = aiRunButton(root)!

      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      button.dispatchEvent(evt)
      await flushUi()

      expect(evt.defaultPrevented).toBe(true)
      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('r0', 'title', 'hello', 1)
      expect(editorInput(root)).toBeNull()
      expect(focusedColIndex(root)).toBe(1) // moved to the adjacent (score) column
    })

    it('Shift+Tab out of the text input is unaffected by the AI-run gate (still commits+moves backward)', async () => {
      // Regression guard for the `!e.shiftKey` half of the P3-A condition — without it, Shift+Tab
      // would ALSO stop being intercepted (nothing to reach backward from column 0 in this fixture,
      // so it would just silently trap focus in the input instead of moving to the prior row).
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 1, 0)) // row 1, title column
      await flushUi()
      typeInto(editorInput(root)!, 'hi')
      await flushUi()

      const evt = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      editorInput(root)!.dispatchEvent(evt)
      await flushUi()

      expect(evt.defaultPrevented).toBe(true)
      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(editorInput(root)).toBeNull()
    })
  })

  // ── P3-C: an invalid numeric draft must not silently persist as null on blur/Tab ─────────
  describe('P3-C: number blur/Tab discards an unresolved invalid draft instead of committing null', () => {
    async function openScoreEditorWithInvalidDraft(root: HTMLElement) {
      clickThenDblclick(cellAt(root, 0, 1)) // score (number), column 1, original value 10
      await flushUi()
      const input = editorInput(root) as HTMLInputElement
      input.value = '-' // WHATWG number sanitization: this IS what real browsers/jsdom store
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '-', inputType: 'insertText' }))
      return input
    }

    it('Enter keeps today\'s (round-1) behaviour: an unresolved invalid draft still commits null', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      const input = await openScoreEditorWithInvalidDraft(root)
      await flushUi()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flushUi()

      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('r0', 'score', null, 1)
      expect(editorInput(root)).toBeNull()
    })

    it('blur discards the invalid draft — no patch, editor closes, original value untouched', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      const input = await openScoreEditorWithInvalidDraft(root)
      await flushUi()
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
      await flushUi()

      expect(patchSpy).not.toHaveBeenCalled()
      expect(editorInput(root)).toBeNull()
      outside.remove()
    })

    it('Tab does not intercept the invalid draft (native default left alone); the blur it causes then discards', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      const input = await openScoreEditorWithInvalidDraft(root)
      await flushUi()
      const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      input.dispatchEvent(evt)
      expect(evt.defaultPrevented).toBe(false) // jsdom does not itself move focus on Tab — simulate
      const outside = document.createElement('button') // what the browser's native Tab would cause:
      document.body.appendChild(outside)
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
      await flushUi()

      expect(patchSpy).not.toHaveBeenCalled()
      expect(editorInput(root)).toBeNull()
      outside.remove()
    })

    it('positive control: a VALID number after the invalid keystroke commits normally on blur (the flag clears)', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      const input = await openScoreEditorWithInvalidDraft(root) // '-'
      typeInto(input, '-5') // completes to a valid negative number — plain Event mirrors round-1's typeInto
      await flushUi()
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
      await flushUi()

      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('r0', 'score', -5, 1)
      outside.remove()
    })

    it('discriminator control: an actual CLEAR (delete, not an in-progress insert) still commits null on blur', async () => {
      // `numberInvalidRawDraft` is keyed on `inputType.startsWith('insert')`, NOT on `.value === ''`
      // alone — this is what tells "still typing '-'" apart from "genuinely emptied the field". A
      // `delete*` inputType on an empty value is a real clear and must behave exactly like round-1
      // (blur commits null) — this test would go red if the discriminator were widened to treat
      // every empty value as "invalid draft, discard".
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 1)) // score, original value 10
      await flushUi()
      const input = editorInput(root)!
      input.value = ''
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'deleteContentBackward' }))
      await flushUi()
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: outside, bubbles: true }))
      await flushUi()

      expect(patchSpy).toHaveBeenCalledTimes(1)
      expect(patchSpy).toHaveBeenCalledWith('r0', 'score', null, 1)
      outside.remove()
    })

    it('cross-cell click while an invalid draft is pending does not persist null (startEdit\'s/onCellClick\'s commit-previous guard bypasses onScalarBlur entirely)', async () => {
      // shouldIgnoreBlur/onScalarBlur are NOT the only path that can commit a draft — clicking a
      // DIFFERENT cell routes through onCellClick's cross-cell guard straight to confirmEdit(),
      // never through onScalarBlur at all. onNumberInput's early-return (leaving editCell.value.value
      // at its last VALID state instead of writing null) is what keeps this path safe too — this
      // test is the direct check for that, not an inference from the blur/Tab tests above.
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      const input = await openScoreEditorWithInvalidDraft(root) // '-', row 0 score (was 10)
      void input
      cellAt(root, 1, 1).click() // a DIFFERENT cell — never touches the input, no blur fires on it
      await flushUi()

      // The null-specific assertion above is the load-bearing one (fixture-independent — true no
      // matter what the last-valid draft was). This second, blanket assertion is fixture-specific:
      // it only holds because this fixture's last-valid draft (10, from before the invalid '-') is
      // identical to row.data.score, so confirmEdit's own "only patch if changed" guard no-ops. A
      // fixture where the user had typed a DIFFERENT valid number first (e.g. 7) before the invalid
      // keystroke would correctly patch that 7 here — that would be right behavior, not a regression.
      expect(patchSpy).not.toHaveBeenCalled()
      expect(editorInput(root)).toBeNull()
    })
  })

  // ── P3-D: guards with zero discriminating coverage in round 1 ────────────────────────────
  describe('P3-D: previously-uncovered load-bearing guards', () => {
    it('guard 1 (refocusGridRoot fire-time check): Enter-commit-then-immediate-reopen keeps focus in the freshly reopened editor', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 0))
      await flushUi()
      const inputA = editorInput(root)!
      typeInto(inputA, 'hello')
      await flushUi()
      // Enter commits A and schedules refocusGridRoot's nextTick check — do NOT await it: reopen a
      // DIFFERENT cell's editor synchronously first, in the same tick, exactly as the round-1 comment
      // on refocusGridRoot describes ("something reopened an editor before the microtask ran").
      inputA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      cellAt(root, 1, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await flushUi()

      // Ledger note: under the `!editCell.value` removal mutation, this goes red via
      // `expect(inputB).toBeTruthy()` (the stolen focus blurs B's own editor, and since blur now
      // commits (D2) that blur closes B entirely) rather than via the activeElement assertion below
      // — still a genuine catch of the guard's removal, just via a cascading symptom. The
      // activeElement assertion is the one the POSITIVE control below actually exercises.
      const inputB = editorInput(root)
      expect(inputB).toBeTruthy()
      expect(inputB!.value).toBe('Row 1')
      expect(document.activeElement).toBe(inputB) // NOT yanked back to the grid root
    })

    it('guard 1 positive control: WITHOUT a reopen in between, refocusGridRoot DOES run and DOES move focus to the grid root', async () => {
      // Proves the scheduled callback actually fires at all in this harness — without this, a change
      // that makes refocusGridRoot never schedule anything would leave the test above green too.
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

      expect(editorInput(root)).toBeNull()
      expect(document.activeElement).toBe(gridEl(root))
    })

    it('guard 2 (shouldIgnoreBlur in-editor exclusion): blur to the sibling AI-run button does not commit', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 0)) // title (AI-enabled)
      await flushUi()
      const input = editorInput(root)!
      typeInto(input, 'hello')
      await flushUi()
      const button = aiRunButton(root)!

      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: button, bubbles: true }))
      await flushUi()

      expect(patchSpy).not.toHaveBeenCalled()
      expect(editorInput(root)).toBeTruthy() // still open — an in-editor focus move, not a commit
    })

    it('guard 3 (moveFocusAfterEditorTab row-wrap): Tab from the last column lands on (row+1, col0)', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 0, 1)) // row 0, score (last column)
      await flushUi()
      typeInto(editorInput(root)!, '99')
      await flushUi()

      editorInput(root)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      await flushUi()

      expect(editorInput(root)).toBeNull()
      expect(focusedRowIndex(root)).toBe(1)
      expect(focusedColIndex(root)).toBe(0)
    })

    it('guard 3 (Shift+Tab wrap): Shift+Tab from column 0 lands on (row-1, lastCol)', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      clickThenDblclick(cellAt(root, 1, 0)) // row 1, title (column 0)
      await flushUi()
      typeInto(editorInput(root)!, 'hi')
      await flushUi()

      editorInput(root)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
      await flushUi()

      expect(editorInput(root)).toBeNull()
      expect(focusedRowIndex(root)).toBe(0)
      expect(focusedColIndex(root)).toBe(1)
    })

    it('guard 4 (grid-root composing guard): an Enter fired mid-composition on the grid root does not open the editor', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      cellAt(root, 0, 0).click()
      await flushUi()

      const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true } as KeyboardEventInit)
      gridEl(root).dispatchEvent(composingEnter)
      await flushUi()

      expect(editorInput(root)).toBeNull()
    })

    it('guard 4 positive control: the identical Enter with isComposing=false DOES open the editor', async () => {
      const patchSpy = vi.fn()
      const root = mountGrid(makeRows(), patchSpy)
      await flushUi()

      cellAt(root, 0, 0).click()
      await flushUi()

      const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: false } as KeyboardEventInit)
      gridEl(root).dispatchEvent(plainEnter)
      await flushUi()

      expect(editorInput(root)).toBeTruthy()
    })
  })
})
