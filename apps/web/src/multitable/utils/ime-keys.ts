/**
 * A key an input method (Chinese, Japanese, Korean...) may be using while it composes text: any key
 * during a composition (`isComposing`), a key the input method took (`keyCode` 229; per engine
 * behaviour, not reproduced in a real Safari here, Safari marks the key that ends a composition only
 * this way), or one reported as `key: 'Process'`. A command key acts on none of them: during a
 * composition Escape cancels the composition and Enter commits it, so a handler that closes,
 * reverts, commits or picks on those keys returns before doing anything, `preventDefault` included.
 * The same rule as MetaGridTable's guard (MetaCellEditor's omits 'Process'). The 'Process' clause only
 * matters to a caller that does not filter on the key name first; the drawer's handlers all do.
 */
export function isImeKeyEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === 'Process'
}
