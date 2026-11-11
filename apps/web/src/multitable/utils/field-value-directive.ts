import type { Directive } from 'vue'

type ValueBox = HTMLInputElement | HTMLTextAreaElement

/** What the directive last wrote into the box, as the box holds it (a box rewrites some values: an input drops
 *  line breaks, a textarea turns CRLF into LF, a number box keeps only what it can read), and from what value;
 *  or what the box last committed. */
const written = new WeakMap<ValueBox, { held: string; from: string }>()
/** A value that arrived while the box held typing of its own: shown once the box is left with no net typing. */
const pending = new WeakMap<ValueBox, string>()

function write(el: ValueBox, text: string) {
  el.value = text
  written.set(el, { held: el.value, from: text })
  pending.delete(el)
}

function heldTyping(el: ValueBox): boolean {
  // A draft the box cannot read (a number box's "-", a half-typed date: `validity.badInput`, whose value then
  // reads "") is typing of its own too.
  return el.value !== written.get(el)?.held || (el instanceof HTMLInputElement && el.validity.badInput)
}

function onFocusOut(event: Event) {
  const el = event.target as ValueBox
  const next = pending.get(el)
  if (next === undefined) return
  pending.delete(el)
  if (!heldTyping(el)) write(el, next)
}

/** The box committed what it holds (its `change`): that is no longer typing of its own, and it supersedes a value
 *  that arrived meanwhile. A next value that reads the same (the commit's echo, a redraw) leaves the box alone: a
 *  date box commits while it is still being typed in. One that differs (a rejected commit's rollback, a newer
 *  value) is written. */
function onChange(event: Event) {
  const el = event.target as ValueBox
  written.set(el, { held: el.value, from: el.value })
  pending.delete(el)
}

/** Drop the box's own typing without a commit (the title's Escape): it shows what it last held as written or
 *  committed, or a value that landed meanwhile; not the record's value, which can still lag behind a commit. */
export function revertFieldValue(el: ValueBox) {
  const next = pending.get(el)
  if (next !== undefined) {
    write(el, next)
    return
  }
  const last = written.get(el)
  if (last) el.value = last.held
}

/**
 * `v-field-value="[value, record id]"` on the record drawer's editable boxes, in place of `:value`.
 * - A value that arrives while the box is focused and holds typing of its own (the box's own commit, still in
 *   flight then and accepted now, or someone else's change) does not overwrite the typing: the next blur commits
 *   the typing, which wins, as in the rich text editor. Left with no net typing (typed, then undone), the box shows
 *   that value then.
 * - Once the box commits what it holds, a next value that reads the same leaves it alone, and one that differs
 *   (its rollback when the server rejects it, a newer value) is written.
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
