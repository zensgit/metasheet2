/**
 * Task-feature-line M4 frontend — focus after an inline swap that is not a write (design §5.2
 * `[fe-49]`, §4.0 `[fe-50]`).
 *
 * A two-step confirmation or an inline form replaces the control that opened it (`v-if` / `v-else`),
 * and cancelling it brings that control back. Either way the control the viewer used is gone, so a
 * browser leaves focus on the page body: a keyboard user starts over from the top of the page, a
 * screen reader hears nothing about the prompt, and inside the members dialog (a modal) neither
 * Escape nor the Tab wrap is heard any more. After the swap, focus goes to the confirmation's
 * first control (or the form's input), and back to the control that comes back on cancel.
 */
import { nextTick } from 'vue'

/** The row a swap happened in: the element under the root whose `attr` attribute is `value`. */
export interface SwapRow {
  attr: string
  value: string
}

/**
 * Once the DOM has updated, focus the element with `data-testid="<testid>"` inside `root()` — or,
 * with `row`, inside that row of it (several rows carry the same control). Nothing happens when
 * the root, the row or the control is not there (the swap was undone first, or the section
 * unmounted).
 */
export async function focusAfterSwap(root: () => HTMLElement | null, testid: string, row?: SwapRow): Promise<void> {
  await nextTick()
  const base = root()
  if (base === null) return
  const scope =
    row === undefined
      ? base
      : Array.from(base.querySelectorAll<HTMLElement>(`[${row.attr}]`)).find((element) => element.getAttribute(row.attr) === row.value)
  scope?.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus()
}
