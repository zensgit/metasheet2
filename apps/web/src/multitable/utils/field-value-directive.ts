import type { Directive } from 'vue'

type ValueBox = HTMLInputElement | HTMLTextAreaElement

/** What the directive last wrote into the box, as the box holds it (a box rewrites some values: an input drops
 *  line breaks, a textarea turns CRLF into LF, a number box keeps only what it can read), and from what value
 *  (null once the box committed what it held: the next value is written, its echo or a rejected commit's
 *  rollback). */
const written = new WeakMap<ValueBox, { held: string; from: string | null }>()
/** A value that arrived while the box held typing of its own: shown once the box is left with no net typing. */
const pending = new WeakMap<ValueBox, string>()

function write(el: ValueBox, text: string) {
  el.value = text
  written.set(el, { held: el.value, from: text })
  pending.delete(el)
}

function heldTyping(el: ValueBox): boolean {
  return el.value !== written.get(el)?.held
}

function onFocusOut(event: Event) {
  const el = event.target as ValueBox
  const next = pending.get(el)
  if (next === undefined) return
  pending.delete(el)
  if (!heldTyping(el)) write(el, next)
}

/** The box committed what it holds (its `change`): that is no longer typing of its own, and it supersedes a value
 *  that arrived meanwhile. */
function onChange(event: Event) {
  const el = event.target as ValueBox
  written.set(el, { held: el.value, from: null })
  pending.delete(el)
}

/**
 * `v-field-value="[value, record id]"` on the record drawer's editable boxes, in place of `:value`.
 * - A value that arrives while the box is focused and holds typing of its own (the box's own commit, still in
 *   flight then and accepted now, or someone else's change) does not overwrite the typing: the next blur commits
 *   the typing, which wins, as in the rich text editor. Left with no net typing (typed, then undone), the box shows
 *   that value then.
 * - Once the box commits what it holds, the next value is written: the commit's echo, or its rollback when the
 *   server rejects it.
 * - A move to another record always writes the value, also when it reads the same: that clears a draft the box
 *   could not read (a number box's "-", which reads "").
 * - Otherwise the box shows the value, as `:value` does.
 */
export const vFieldValue: Directive<ValueBox, readonly [string, string | undefined]> = {
  mounted(el, { value: [text] }) {
    write(el, text)
    el.addEventListener('change', onChange)
    el.addEventListener('focusout', onFocusOut)
  },
  updated(el, { value: [text, recordId], oldValue }) {
    if (oldValue && recordId !== oldValue[1]) {
      write(el, text)
      return
    }
    if (el.ownerDocument.activeElement === el && heldTyping(el)) {
      pending.set(el, text)
      return
    }
    if (heldTyping(el) || written.get(el)?.from !== text) write(el, text)
  },
  beforeUnmount(el) {
    el.removeEventListener('change', onChange)
    el.removeEventListener('focusout', onFocusOut)
  },
}
