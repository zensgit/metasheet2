/**
 * While the workbench is mounted it owns mod+z / mod+y / mod+shift+z: the browser's own undo never runs
 * on the page.
 *
 * Why: the browser's undo is page-wide (Chromium keeps one undo stack per page) and does not line up
 * with the workbench's fields. Left to the browser, Cmd+Z can revert ANOTHER field's earlier typing,
 * move focus there, and that field then saves the revert on blur — after a programmatic rewrite of the
 * focused field, when typing on both sides of a commit that keeps focus is merged into one step, after
 * a mention inserted through a Range, or from a popover or dialog teleported out of the workbench. So
 * the listeners sit on the document in the capture phase (a control that stops propagation of every
 * key, like the comment affordance buttons, cannot get past them), and every one of these chords is
 * default-prevented, in every state, wherever focus is. An Edit-menu undo (`beforeinput` historyUndo /
 * historyRedo) is cancelled too, and is the focused control's own step when it has one.
 *
 * - Typing in a text-entry control (a textarea, an editable contenteditable, a text-like input) is
 *   recorded per control, in bursts: a `beforeinput` takes a snapshot of the content (and selection)
 *   before it, unless it continues the current burst (same kind of edit, within `coalesceMs`). An edit
 *   made through the editor's own editing commands (the rich-text editor's paste, drop and toolbar use
 *   `execCommand`, which fires `input` with no `beforeinput`) is a step of its own, back to the content
 *   the control had just before (kept current on focus, paste, drop, cut and mousedown).
 * - An input-method composition is one step, back to the content before it; the marked text it shows
 *   on the way is never a step.
 * - Undo restores the control's last snapshot while it has one; redo (shift+z, or ctrl+y) re-applies
 *   what undo took back.
 * - The history belongs to the control's own edits only. Content no recorded edit produced (a re-render
 *   after grid undo or a record switch, a suggestion picked into the box, a revert) is a rewrite: the
 *   history is dropped.
 * - A saved commit ends the history (`beginCommit` from the workbench's drawer commit, settled once the
 *   server accepted it). A DOM `change` is not a commit: most boxes' `change` saves nothing.
 * - When the control has no step left, the chord is the grid's undo / redo (which replays a recorded
 *   cell edit to the server) if focus is inside the workbench or on the page itself, except for an
 *   auto-repeated key in a text control; outside the workbench (a teleported dialog or popover) it
 *   does nothing.
 * - During an input-method composition the chord does nothing.
 * - Date and time inputs, selects, checkboxes and other non-text controls: the grid's inside the
 *   workbench, nothing outside it. A number box holding a draft it cannot report (`validity.badInput`,
 *   e.g. a lone "-") does nothing.
 * - Cmd+Y is grid redo (on macOS it is not a text redo).
 */

/** Input types without a text undo of their own. */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden',
  'date', 'time', 'datetime-local', 'month', 'week',
])

/** At most this many steps are kept per control, each way. */
const MAX_STEPS = 100

const COMPOSITION_INPUT_TYPES = new Set(['insertCompositionText', 'deleteCompositionText', 'insertFromComposition', 'deleteByComposition'])

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

/**
 * The drawer controls a commit of `fieldId` covers: the field's row in the fields panel and, when it is
 * the record's primary field, the title input above it (it commits through the same `patch`).
 */
export function drawerCommitContainers(fieldId: string, primaryFieldId: string | null | undefined, doc: Document = document): Element[] {
  const rows = Array.from(doc.querySelectorAll<HTMLElement>('.meta-record-drawer__field')).filter((el) => el.dataset.fieldId === fieldId)
  const title = primaryFieldId === fieldId ? Array.from(doc.querySelectorAll('.meta-record-drawer__title-input')) : []
  return [...rows, ...title]
}

interface Snapshot {
  content: string
  start: number | null
  end: number | null
}

interface History {
  undo: Snapshot[]
  redo: Snapshot[]
  /** The content the control's last recorded edit (or restore) left. */
  known: string
  lastKind: string
  lastAt: number
  /** A `beforeinput` was seen and its `input` has not arrived yet. */
  pendingBefore: boolean
  composing: boolean
}

function isPlainControl(host: HTMLElement): host is HTMLInputElement | HTMLTextAreaElement {
  return host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement
}

function contentOf(host: HTMLElement): string {
  return isPlainControl(host) ? host.value : host.innerHTML
}

/** A number box whose draft its `value` cannot report ("-", "1e"): its content reads as "". */
function hasUnreportableDraft(host: HTMLElement): boolean {
  return host instanceof HTMLInputElement && host.type === 'number' && host.validity?.badInput === true
}

/** The selection inside a contenteditable host, as text offsets from its start. */
function editableSelection(host: HTMLElement): { start: number; end: number } | null {
  const selection = host.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null
  const offsetOf = (node: Node, offset: number): number => {
    const before = host.ownerDocument.createRange()
    before.selectNodeContents(host)
    before.setEnd(node, offset)
    return before.toString().length
  }
  return { start: offsetOf(range.startContainer, range.startOffset), end: offsetOf(range.endContainer, range.endOffset) }
}

/** Put a contenteditable's selection back at text offsets; past its text (or unknown), at its end. */
function restoreEditableSelection(host: HTMLElement, start: number | null, end: number | null): void {
  const selection = host.ownerDocument.getSelection()
  if (!selection) return
  const range = host.ownerDocument.createRange()
  range.selectNodeContents(host)
  range.collapse(false)
  if (start !== null && end !== null) {
    const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    let seen = 0
    let startNode: Node | null = null
    let startOffset = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (!startNode && start <= seen + length) {
        startNode = node
        startOffset = start - seen
      }
      if (startNode && end <= seen + length) {
        range.setStart(startNode, startOffset)
        range.setEnd(node, end - seen)
        break
      }
      seen += length
    }
  }
  selection.removeAllRanges()
  selection.addRange(range)
}

function snapshotOf(host: HTMLElement): Snapshot {
  if (!isPlainControl(host)) {
    const selection = editableSelection(host)
    return { content: host.innerHTML, start: selection?.start ?? null, end: selection?.end ?? null }
  }
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
  if (inputType === 'insertText' || inputType === 'insertReplacementText') return 'insert'
  if (inputType.startsWith('delete')) return 'delete'
  return `own:${inputType}`
}

/** The letter of a chord: its `key`, or for a layout whose key is not a Latin letter (e.g. 'я') the
 *  key's position (`code`). */
function chordLetter(event: KeyboardEvent): string {
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
  if (/^[a-z]$/.test(key)) return key
  const code = typeof event.code === 'string' ? /^Key([A-Z])$/.exec(event.code) : null
  return code ? code[1].toLowerCase() : key
}

function pushCapped(stack: Snapshot[], snapshot: Snapshot): void {
  stack.push(snapshot)
  if (stack.length > MAX_STEPS) stack.splice(0, stack.length - MAX_STEPS)
}

export type UndoKeyAction = 'none' | 'swallow' | 'restored' | 'grid-undo' | 'grid-redo'

export interface WorkbenchUndoOptions {
  coalesceMs?: number
  now?: () => number
  /** Whether `target` is inside the workbench, or is the page itself (nothing focused). */
  isWorkbenchTarget?: (target: EventTarget | null) => boolean
}

export function createWorkbenchUndo(options: WorkbenchUndoOptions = {}) {
  const coalesceMs = options.coalesceMs ?? 800
  const now = options.now ?? (() => Date.now())
  const isWorkbenchTarget = options.isWorkbenchTarget ?? (() => true)
  const histories = new WeakMap<HTMLElement, History>()
  /** Set while a restore runs, so the recorder does not take its own edit as one. */
  let restoring = false

  function fresh(host: HTMLElement): History {
    const history: History = { undo: [], redo: [], known: contentOf(host), lastKind: '', lastAt: 0, pendingBefore: false, composing: false }
    histories.set(host, history)
    return history
  }

  /** The control's history; dropped and started again when its content changed with no recorded edit. */
  function current(host: HTMLElement): History {
    const history = histories.get(host)
    if (history && contentOf(host) === history.known) return history
    return fresh(host)
  }

  function restore(host: HTMLElement, history: History, snapshot: Snapshot): void {
    restoring = true
    try {
      if (isPlainControl(host)) {
        // Through the browser's own editing (select all, then insert or delete), so the control counts it
        // as the user's edit: Safari only fires `change` on blur — the drawer's commit — after an edit
        // the user made, never after a `value` set from script (measured, Safari 26.6). The control's
        // listeners get its `input`. Where that is not available (jsdom), set the value and tell the
        // listeners ourselves.
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
        restoreEditableSelection(host, snapshot.start, snapshot.end)
        // The rich editor's onInput reads the restored content (it commits on its own blur).
        host.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } finally {
      restoring = false
    }
    history.known = contentOf(host)
    history.pendingBefore = false
    // The next edit starts a new step.
    history.lastKind = ''
    history.lastAt = 0
  }

  /** Undo or redo one step of the control's own history; false when it has none for it. */
  function step(host: HTMLElement, undo: boolean): boolean {
    const history = histories.get(host)
    if (!history) return false
    const content = contentOf(host)
    if (content !== history.known) {
      // A rewrite since the control's own last edit: its history no longer describes it.
      histories.delete(host)
      return false
    }
    const from = undo ? history.undo : history.redo
    // An undo step that would change nothing (a `beforeinput` no edit followed, e.g. Backspace in an
    // empty box or a cancelled edit) is skipped, so one press always does something. (A redo step
    // always differs: it is what the undo before it replaced.)
    while (undo && from.length > 0 && from[from.length - 1].content === content) from.pop()
    const snapshot = from.pop()
    if (!snapshot) return false
    pushCapped(undo ? history.redo : history.undo, snapshotOf(host))
    restore(host, history, snapshot)
    return true
  }

  return {
    /** What a keydown is. For anything but 'none' the caller must call preventDefault, then run the
     *  grid's undo / redo for 'grid-undo' / 'grid-redo'; 'restored' and 'swallow' need nothing more. */
    decide(event: KeyboardEvent): UndoKeyAction {
      if (!event.metaKey && !event.ctrlKey) return 'none'
      const letter = chordLetter(event)
      const undo = letter === 'z' && !event.shiftKey
      const redo = letter === 'y' || (letter === 'z' && event.shiftKey)
      if (!undo && !redo) return 'none'
      if (event.isComposing || event.keyCode === 229) return 'swallow'
      const host = textEntryHost(event.target)
      if (host && hasUnreportableDraft(host)) return 'swallow'
      if (host && !(letter === 'y' && event.metaKey) && step(host, undo)) return 'restored'
      if (!isWorkbenchTarget(event.target)) return 'swallow'
      // Holding the key in a text control must not walk the grid's history back on the server, one
      // write per auto-repeat, once the control's own steps are used up.
      if (event.repeat && host) return 'swallow'
      return undo ? 'grid-undo' : 'grid-redo'
    },
    onBeforeInput(event: Event): void {
      if (restoring) return
      const host = textEntryHost(event.target)
      if (!host) return
      const inputType = (event as InputEvent).inputType ?? ''
      if (inputType === 'historyUndo' || inputType === 'historyRedo') {
        // The Edit menu's (or a context menu's) undo: never the browser's own. It is the control's own
        // step when it has one, and never reaches the grid.
        event.preventDefault()
        step(host, inputType === 'historyUndo')
        return
      }
      const history = current(host)
      history.pendingBefore = true
      if (history.composing || (event as InputEvent).isComposing || COMPOSITION_INPUT_TYPES.has(inputType)) return
      if (hasUnreportableDraft(host)) return
      const kind = editKind(inputType)
      const at = now()
      if (history.undo.length === 0 || kind !== history.lastKind || kind.startsWith('own:') || at - history.lastAt > coalesceMs) {
        pushCapped(history.undo, snapshotOf(host))
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
      if (!history.pendingBefore && !history.composing && history.known !== contentOf(host)) {
        // An edit with no `beforeinput` (the editor's own execCommand: paste, drop, toolbar) is a step of
        // its own, back to the content the control had just before.
        pushCapped(history.undo, { content: history.known, start: null, end: null })
        history.lastKind = ''
        history.lastAt = 0
      }
      history.pendingBefore = false
      history.known = contentOf(host)
      history.redo = []
    },
    onCompositionStart(event: Event): void {
      const host = textEntryHost(event.target)
      if (!host) return
      const history = current(host)
      // The content before the composition is its one step; nothing it shows on the way is.
      pushCapped(history.undo, snapshotOf(host))
      history.composing = true
    },
    onCompositionEnd(event: Event): void {
      const host = textEntryHost(event.target)
      const history = host ? histories.get(host) : undefined
      if (!host || !history) return
      // (Its content was synced by the composition's last `input`, which comes before or after this.)
      history.composing = false
      history.lastKind = ''
      history.lastAt = 0
    },
    /** `target`'s control may be edited next by something other than typing (it got focus; a paste,
     *  drop or cut; a press on its editor's toolbar): make sure its history exists and describes its
     *  content right now, so an edit with no `beforeinput` goes back to the right content. */
    onCheckpoint(target: EventTarget | null): void {
      const host = textEntryHost(target)
      if (host) current(host)
    },
    /** The workbench is committing what the controls in `containers` hold. Call the returned function
     *  once the server accepted it: their history then ends at the commit (edits made since stay
     *  undoable, back to the committed content). A rejected commit keeps it all. */
    beginCommit(containers: Element[]): () => void {
      const marks: Array<{ host: HTMLElement; history: History; floor: number }> = []
      for (const container of containers) {
        for (const el of [container, ...Array.from(container.querySelectorAll('textarea, input, [contenteditable]'))]) {
          const host = textEntryHost(el)
          const history = host ? histories.get(host) : undefined
          if (host && history && !marks.some((mark) => mark.host === host)) marks.push({ host, history, floor: history.undo.length })
        }
      }
      return () => {
        for (const { host, history, floor } of marks) {
          if (histories.get(host) !== history) continue
          history.undo.splice(0, floor)
          history.redo = []
        }
      }
    },
  }
}

export type WorkbenchUndo = ReturnType<typeof createWorkbenchUndo>

/** Put the workbench's undo on `doc` (capture phase); returns the function that takes it off. */
export function installWorkbenchUndo(undo: WorkbenchUndo, grid: { undo: () => void; redo: () => void }, doc: Document = document): () => void {
  const onKeydown = (event: Event) => {
    const action = undo.decide(event as KeyboardEvent)
    if (action === 'none') return
    event.preventDefault()
    if (action === 'grid-undo') grid.undo()
    else if (action === 'grid-redo') grid.redo()
  }
  const onTarget = (event: Event) => undo.onCheckpoint(event.target)
  // A press on an editor's toolbar keeps focus in the editor: checkpoint what has focus.
  const onPress = () => undo.onCheckpoint(doc.activeElement)
  const listeners: Array<[string, (event: Event) => void]> = [
    ['keydown', onKeydown],
    ['beforeinput', undo.onBeforeInput],
    ['input', undo.onInput],
    ['compositionstart', undo.onCompositionStart],
    ['compositionend', undo.onCompositionEnd],
    ['focusin', onTarget],
    ['paste', onTarget],
    ['drop', onTarget],
    ['cut', onTarget],
    ['mousedown', onPress],
  ]
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, true)
  return () => {
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true)
  }
}
