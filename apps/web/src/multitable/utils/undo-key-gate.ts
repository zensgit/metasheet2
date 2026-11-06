/**
 * Who handles mod+z / mod+y / mod+shift+z in the workbench: the grid's undo/redo (which replays a
 * recorded cell edit to the server) or the focused text control's own undo/redo.
 *
 * The browser's own undo is page-wide (Chromium keeps one undo stack per page): left to the browser
 * from a control with nothing typed in it, Cmd+Z reverts ANOTHER field's earlier typing, moves focus
 * there, and that field saves the revert on blur. So the browser only gets the key while the focused
 * control has typing of its own that is not committed yet — then the top of the page's stack is that
 * typing. In every other case the key is the grid's, exactly as before:
 *
 * - The focused text-entry control (a textarea, an editable contenteditable, a text-like input) has a
 *   baseline: its content when it got focus, refreshed on every commit (a DOM `change`, or the
 *   workbench's own commit paths, which call `noteCommit`). Content different from the baseline is
 *   uncommitted typing.
 * - Undo (mod+z) with uncommitted typing: the control's. Otherwise: the grid's.
 * - Redo: the control's only for the chords that are a text control's redo (shift+z, and ctrl+y
 *   without meta) and only with uncommitted typing. Cmd+Y stays the grid's (on macOS it is the
 *   browser's History shortcut, not a redo).
 * - Date and time inputs have no text undo: always the grid's.
 * - No baseline recorded (focus came before this gate saw it): the control counts as committed.
 */

/** Input types without a native text undo: the grid's undo/redo always runs from them. */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden',
  'date', 'time', 'datetime-local', 'month', 'week',
])

export type UndoKeyAction = 'native' | 'grid-undo' | 'grid-redo' | 'none'

/** The text-entry control `target` is in, or null: a textarea, the editable contenteditable host,
 *  or a text-like input. */
export function textEntryHost(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null
  if (!el?.closest) return null
  const textarea = el.closest('textarea')
  if (textarea) return textarea
  const editable = el.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])')
  if (editable) return editable
  const input = el.closest('input')
  return input && !NON_TEXT_INPUT_TYPES.has(input.type) ? input : null
}

function contentOf(host: HTMLElement): string {
  if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement) return host.value
  return host.innerHTML
}

export function createUndoKeyGate() {
  const baselines = new WeakMap<HTMLElement, string>()

  function remember(target: EventTarget | null): void {
    const host = textEntryHost(target)
    if (host) baselines.set(host, contentOf(host))
  }

  return {
    /** A control got focus: what it holds now is its baseline. */
    noteFocus: remember,
    /** A control committed (DOM `change`, or a workbench commit path): what it holds now is committed. */
    noteCommit: remember,
    decide(event: KeyboardEvent): UndoKeyAction {
      if (!event.metaKey && !event.ctrlKey) return 'none'
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      const undo = key === 'z' && !event.shiftKey
      const redo = key === 'y' || (key === 'z' && event.shiftKey)
      if (!undo && !redo) return 'none'
      const host = textEntryHost(event.target)
      if (host) {
        if (!baselines.has(host)) baselines.set(host, contentOf(host))
        const uncommitted = contentOf(host) !== baselines.get(host)
        const textRedoChord = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey)
        if (uncommitted && (undo || textRedoChord)) return 'native'
      }
      return undo ? 'grid-undo' : 'grid-redo'
    },
  }
}
