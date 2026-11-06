/**
 * The Tab trap of the task dialogs (the people picker, the record dispatch dialog and the list
 * members dialog): every Tab and Shift+Tab inside one of them is moved here, not only the ones at
 * the ends. macOS Safari leaves buttons out of its default Tab order, so a Tab left to the browser
 * could skip them or take focus out of the dialog.
 *
 * Two exceptions, both for date and time inputs, whose parts (Chromium: month, day, year) a Tab steps
 * through. A Tab inside one is left to the browser, and only a move that takes focus out of the dialog
 * is brought back, to the control after (or before) that input. A Tab INTO one is also left to the
 * browser, because only the browser's own move lands on the input's last part going back (a focus()
 * call always lands on the first); if that move takes focus out of the dialog, focus is put on the
 * input. A browser that leaves buttons out of its own move can pass over a button inside the dialog
 * there. jsdom has no such parts; the part-to-part move itself is for a browser walk.
 *
 * A third exception: a Tab the input method took while composing text (keyCode 229) is left to it,
 * neither moved nor held. A Tab during a composition that the input method passed on is still moved.
 */

/** The controls a Tab can land on. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/** Input types a browser may split into parts that a Tab steps through. */
const SEGMENTED_INPUT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week'])

function isSegmented(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && SEGMENTED_INPUT_TYPES.has(element.type)
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => !element.closest('[hidden]'))
}

/** The control a Tab (`backward`: Shift+Tab) from position `at` goes to; from outside the list (-1),
 *  the first (backward: the last). */
function stepIndex(at: number, length: number, backward: boolean): number {
  if (at === -1) return backward ? length - 1 : 0
  return (at + (backward ? -1 : 1) + length) % length
}

/** Leaves a Tab in a date or time input to the browser. A focusout from the input in this same turn
 *  is that Tab leaving it; once the browser's move is done, focus that ended outside the container is
 *  put on the next (previous) control. The listener goes with the turn, so a later click is left as is. */
function followSegmentedTab(container: HTMLElement, input: HTMLInputElement, backward: boolean): void {
  const onFocusout = () => {
    setTimeout(() => {
      if (!container.isConnected || container.contains(document.activeElement)) return
      const focusable = focusableWithin(container)
      if (focusable.length === 0) {
        container.focus()
        return
      }
      focusable[stepIndex(focusable.indexOf(input), focusable.length, backward)].focus()
    }, 0)
  }
  input.addEventListener('focusout', onFocusout, { once: true })
  setTimeout(() => input.removeEventListener('focusout', onFocusout), 0)
}

/** Counts the Tabs handled here. A check scheduled for one Tab is dropped once another came: Chromium
 *  runs key input ahead of timers, so the check can come after the next key. */
let tabCount = 0

/** Moves focus one step within `container` for a Tab (Shift+Tab: back) keydown, wrapping at the ends,
 *  and holds the browser's own move back (except in or into a date or time input, see above). A Tab
 *  the input method took (keyCode 229) is left alone. Controls inside a `[hidden]` element and
 *  disabled ones are skipped. From the container itself or from outside its controls, Tab goes to
 *  the first control and Shift+Tab to the last; with none, focus goes to the container. */
export function moveFocusWithin(container: HTMLElement, event: KeyboardEvent): void {
  // A Tab the input method took (keyCode 229) is its own: neither moved nor held here. A Tab during a
  // composition that the input method did not take (isComposing, but its own keyCode) is still moved
  // here: the browser would move it anyway, and Safari's own move can leave the dialog. An input
  // method's key can also arrive as key 'Process', which the callers' Tab check already leaves alone.
  if (event.keyCode === 229) return
  tabCount += 1
  const thisTab = tabCount
  const focusable = focusableWithin(container)
  const active = document.activeElement
  if (isSegmented(active) && focusable.includes(active)) {
    followSegmentedTab(container, active, event.shiftKey)
    return
  }
  if (focusable.length === 0) {
    event.preventDefault()
    container.focus()
    return
  }
  const target = focusable[stepIndex(focusable.indexOf(active as HTMLElement), focusable.length, event.shiftKey)]
  if (isSegmented(target)) {
    // Into a date or time input: the browser's move, which picks the part; the input only if that move
    // left the dialog.
    setTimeout(() => {
      if (thisTab !== tabCount || !target.isConnected) return
      const now = document.activeElement
      if (now && now !== document.body && container.contains(now)) return
      target.focus()
    }, 0)
    return
  }
  event.preventDefault()
  target.focus()
}

/** A key an input method may be using while it composes text: any key during a composition
 *  (isComposing), or one the input method took (keyCode 229; Safari marks the key that ends a
 *  composition only this way). A dialog's command keys act on neither: there Escape cancels the
 *  composition and Enter commits it. The Tab trap above checks keyCode 229 only, since a Tab the input
 *  method passed on still has to be moved inside the dialog. */
export function isInputMethodKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}
