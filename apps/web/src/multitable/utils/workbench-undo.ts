/**
 * The workbench owns mod+z / mod+y / mod+shift+z: inside it, the browser's own undo never runs.
 *
 * Why: the browser's undo is page-wide (Chromium keeps one undo stack per page) and does not line up
 * with the workbench's fields. Left to the browser, Cmd+Z can revert ANOTHER field's earlier typing,
 * move focus there, and that field then saves the revert on blur — after a programmatic rewrite of
 * the focused field, when typing on both sides of a commit that keeps focus is merged into one step,
 * or after a mention inserted through a Range. So every one of these chords is default-prevented, in
 * every state, and handled here:
 *
 * - Typing in a text-entry control (a textarea, an editable contenteditable, a text-like input) is
 *   recorded per control, in bursts: a `beforeinput` takes a snapshot of the content (and selection)
 *   before it, unless it continues the current burst (same kind of edit, within `coalesceMs`).
 * - Undo restores the control's last snapshot while it has one; redo (shift+z, or ctrl+y) re-applies
 *   what undo took back. Once the control's own history is used up, the chord is the grid's undo or
 *   redo (which replays a recorded cell edit to the server), exactly as before.
 * - The history belongs to the control's own typing only. Content that no recorded `input` produced
 *   (a re-render after grid undo or a record switch, a mention chip inserted through a Range, a
 *   suggestion picked into the box) is a rewrite: the history is dropped and the chord is the grid's.
 * - A commit ends the history (a DOM `change`, or `commitWithin` from the workbench's own commit
 *   paths): after a commit the chord is the grid's again.
 * - During an input-method composition the chord is swallowed: neither restored nor the grid's.
 * - Date and time inputs, selects, checkboxes and the main area: always the grid's.
 * - Cmd+Y is grid redo, as before (on macOS it is not a text redo).
 */

/** Input types without a text undo of their own: the grid's undo/redo always runs from them. */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden',
  'date', 'time', 'datetime-local', 'month', 'week',
])

/** The text-entry control `target` is in, or null. */
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

interface Snapshot {
  content: string
  start: number | null
  end: number | null
}

interface History {
  undo: Snapshot[]
  redo: Snapshot[]
  /** The content the control's last recorded `input` (or restore) left. */
  known: string
  lastKind: string
  lastAt: number
}

function isPlainControl(host: HTMLElement): host is HTMLInputElement | HTMLTextAreaElement {
  return host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement
}

function contentOf(host: HTMLElement): string {
  return isPlainControl(host) ? host.value : host.innerHTML
}

function snapshotOf(host: HTMLElement): Snapshot {
  if (!isPlainControl(host)) return { content: host.innerHTML, start: null, end: null }
  let start: number | null = null
  let end: number | null = null
  try {
    start = host.selectionStart
    end = host.selectionEnd
  } catch {
    // some input types have no selection
  }
  return { content: host.value, start, end }
}

/** The kind of an edit for grouping into bursts: consecutive inserts or deletes of plain text group;
 *  a paste, a line break, a drop or a format change always starts its own step. */
function editKind(inputType: string): string {
  if (inputType === 'insertText' || inputType === 'insertCompositionText' || inputType === 'insertReplacementText') return 'insert'
  if (inputType.startsWith('delete')) return 'delete'
  return `own:${inputType}`
}

export type UndoKeyAction = 'none' | 'swallow' | 'restored' | 'grid-undo' | 'grid-redo'

export interface WorkbenchUndoOptions {
  coalesceMs?: number
  now?: () => number
}

export function createWorkbenchUndo(options: WorkbenchUndoOptions = {}) {
  const coalesceMs = options.coalesceMs ?? 800
  const now = options.now ?? (() => Date.now())
  const histories = new WeakMap<HTMLElement, History>()
  /** Set while a restore dispatches its own `input`, so the recorder does not take it as typing. */
  let restoring = false

  function fresh(host: HTMLElement): History {
    const history: History = { undo: [], redo: [], known: contentOf(host), lastKind: '', lastAt: 0 }
    histories.set(host, history)
    return history
  }

  function restore(host: HTMLElement, history: History, snapshot: Snapshot): void {
    restoring = true
    try {
      if (isPlainControl(host)) {
        // Through the browser's own editing (select all, then insert or delete), so the control counts
        // it as the user's edit: WebKit only fires `change` on blur — the drawer's commit — for an edit
        // the user made, never for a `value` set from script. The control's listeners get its `input`.
        // Where that is not available (jsdom), set the value and tell the listeners ourselves.
        let edited = false
        if (host.ownerDocument.activeElement === host && typeof host.ownerDocument.execCommand === 'function') {
          try {
            host.select()
            edited = snapshot.content === ''
              ? host.ownerDocument.execCommand('delete', false)
              : host.ownerDocument.execCommand('insertText', false, snapshot.content)
          } catch {
            edited = false
          }
        }
        if (!edited || host.value !== snapshot.content) {
          host.value = snapshot.content
          host.dispatchEvent(new Event('input', { bubbles: true }))
        }
        if (snapshot.start !== null && snapshot.end !== null) {
          try { host.setSelectionRange(snapshot.start, snapshot.end) } catch { /* no selection on this type */ }
        }
      } else {
        host.innerHTML = snapshot.content
        const selection = host.ownerDocument.getSelection()
        if (selection) {
          const range = host.ownerDocument.createRange()
          range.selectNodeContents(host)
          range.collapse(false)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        // The rich editor's onInput reads the restored content (it commits on its own blur).
        host.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } finally {
      restoring = false
    }
    history.known = contentOf(host)
    // The next typing starts a new step.
    history.lastKind = ''
    history.lastAt = 0
  }

  return {
    onBeforeInput(event: Event): void {
      if (restoring) return
      const host = textEntryHost(event.target)
      if (!host) return
      const inputType = (event as InputEvent).inputType ?? ''
      // The browser's own undo/redo never runs in the workbench (the chords are prevented); ignore it.
      if (inputType === 'historyUndo' || inputType === 'historyRedo') return
      let history = histories.get(host)
      if (!history || contentOf(host) !== history.known) history = fresh(host)
      const kind = editKind(inputType)
      const at = now()
      if (history.undo.length === 0 || kind !== history.lastKind || kind.startsWith('own:') || at - history.lastAt > coalesceMs) {
        history.undo.push(snapshotOf(host))
      }
      history.lastKind = kind
      history.lastAt = at
    },
    onInput(event: Event): void {
      if (restoring) return
      const host = textEntryHost(event.target)
      if (!host) return
      const history = histories.get(host)
      if (!history) return
      history.known = contentOf(host)
      history.redo = []
    },
    /** A control committed (DOM `change`): its history ends. */
    onChange(event: Event): void {
      const host = textEntryHost(event.target)
      if (host) histories.delete(host)
    },
    /** The workbench committed what the controls inside `container` hold (e.g. a drawer field whose
     *  commit comes without a DOM `change`, like the rich-text editor's Cmd/Ctrl+Enter). */
    commitWithin(container: Element | null): void {
      if (!container) return
      const hosts = [container, ...Array.from(container.querySelectorAll('textarea, input, [contenteditable]'))]
      for (const el of hosts) {
        const host = textEntryHost(el)
        if (host) histories.delete(host)
      }
    },
    /** What a keydown is. For anything but 'none' the caller must call preventDefault, then run the
     *  grid's undo/redo for 'grid-undo'/'grid-redo'; 'restored' and 'swallow' need nothing more. */
    decide(event: KeyboardEvent): UndoKeyAction {
      if (!event.metaKey && !event.ctrlKey) return 'none'
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      const undo = key === 'z' && !event.shiftKey
      const redo = key === 'y' || (key === 'z' && event.shiftKey)
      if (!undo && !redo) return 'none'
      if (event.isComposing || event.keyCode === 229) return 'swallow'
      const host = textEntryHost(event.target)
      const history = host ? histories.get(host) : undefined
      if (host && history) {
        const current = contentOf(host)
        // A step that would change nothing (a `beforeinput` no edit followed, e.g. Backspace in an empty
        // box or a cancelled edit) is skipped, so one press always does something.
        while (history.undo.length > 0 && history.undo[history.undo.length - 1].content === current) history.undo.pop()
        while (history.redo.length > 0 && history.redo[history.redo.length - 1].content === current) history.redo.pop()
        if (current !== history.known) {
          // A rewrite since the control's own last typing: its history no longer describes it.
          histories.delete(host)
        } else if (undo && history.undo.length > 0) {
          const snapshot = history.undo.pop()!
          history.redo.push(snapshotOf(host))
          restore(host, history, snapshot)
          return 'restored'
        } else if (redo && !(key === 'y' && event.metaKey) && history.redo.length > 0) {
          const snapshot = history.redo.pop()!
          history.undo.push(snapshotOf(host))
          restore(host, history, snapshot)
          return 'restored'
        }
      }
      return undo ? 'grid-undo' : 'grid-redo'
    },
  }
}
