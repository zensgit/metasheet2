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
 * historyRedo) is cancelled too, and is the focused control's own step when it has one (an unfocused
 * control is left alone: restoring it without a focus would never be saved).
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
 * - A text-entry control never hands the chord on: with no step of its own left, the chord does
 *   nothing. The grid's undo / redo (which replays a recorded cell edit to the server) runs only from a
 *   non-text target inside the workbench (the grid, a button, a date input, a select…), or from the page
 *   itself (nothing focused, e.g. after Enter committed the title) when the last press or focus was on a
 *   grid surface (`isGridSurface`; the workbench's is `isWorkbenchGridSurface`: the grid itself and its
 *   cells, and the drawer's title and fields, whose edits are cell patches). A button, link or file input
 *   there, or anything inside one (a section toggle, a comment anchor, an upload), the grid's footer and
 *   bars (Delete selected), the drawer's comments (Send, Resolve), history, approval, task or attachments
 *   panels, a rename in the rail or a manager, a picker, or a press in a dialog does not make the page
 *   itself the grid's. Outside the workbench (a teleported dialog or popover, the app shell) nothing runs.
 * - The history belongs to the control's own edits only. Content no recorded edit produced (a re-render
 *   after grid undo, a suggestion picked into the box, a revert, a rejected commit snapping back) is a
 *   rewrite: the history is dropped. `reset` drops every history: the workbench calls it when the drawer
 *   shows another record (its controls are reused, and may hold equal content in both), or the sheet or
 *   view changes.
 * - A saved commit ends the history (`beginCommit` from the workbench's drawer commit, settled once the
 *   server accepted it): only edits made since stay undoable, back to the committed content, also when
 *   the control was undone (and redone) while the patch was in flight, or redone after it was accepted,
 *   with or without a key that changed nothing (Backspace at the start) in between.
 *   A DOM `change` is not a commit: most boxes' `change` saves nothing.
 * - During an input-method composition the chord does nothing. A number box holding a draft it cannot
 *   report (`validity.badInput`: "-", "1." read as "") does nothing on the chord and takes no snapshot
 *   while it holds one: its value would be misread.
 * - With Alt held the chord is not ours: on Windows AltGr is Ctrl+Alt, and AltGr+Z / AltGr+Y type letters
 *   (Polish ż, Latvian ž).
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

/** The parts of the workbench whose edits are the grid's cell patches: the grid's cells, and in the record
 *  drawer the title and the fields panel (not the grid's footer or bars, nor the drawer's comments,
 *  history, approval, task or attachments panels). */
const CELL_EDIT_SURFACES = '.meta-grid__cell, .meta-record-drawer__titleblock, .meta-record-drawer__fields'
/** Controls on those parts whose action is not a cell patch (a section toggle, a comment anchor, a link…),
 *  or not yet one (a file input: its patch comes once the upload ends). One that disables or removes itself
 *  when pressed leaves focus on the page itself. */
const NOT_CELL_EDITS = 'button, [role="button"], [role="menuitem"], a[href], input[type="file"]'

/** The workbench's `isGridSurface`: whether, after a press or focus on `node`, a chord on the page itself
 *  is the grid's. */
export function isWorkbenchGridSurface(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement
  if (!el) return false
  // The grid itself has focus while you move between its cells.
  if (el.classList.contains('meta-grid')) return true
  return !!el.closest(CELL_EDIT_SURFACES) && !el.closest(NOT_CELL_EDITS)
}

interface Snapshot {
  content: string
  start: number | null
  end: number | null
  /** Where the step sits in the control's history: a new step takes the next number; the step an undo
   *  or redo moves to the other stack keeps the number of the one it replaced, so a commit's mark still
   *  covers it after an undo and a redo. */
  seq: number
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
  /** The `reset` generation it belongs to; an older one is dropped. */
  generation: number
  /** The last step number handed out. */
  seq: number
  /** The step number of the last accepted commit: an undo never goes back to a step at or below it. */
  floor: number
}

function isPlainControl(host: HTMLElement): host is HTMLInputElement | HTMLTextAreaElement {
  return host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement
}

function contentOf(host: HTMLElement): string {
  return isPlainControl(host) ? host.value : host.innerHTML
}

/** A number box whose draft its `value` cannot report ("-", "1."): its content reads as "". */
function hasUnreportableDraft(host: HTMLElement): boolean {
  return host instanceof HTMLInputElement && host.type === 'number' && host.validity?.badInput === true
}

/** The page itself rather than a control: what a key event targets when nothing has focus. */
function isPageItself(target: EventTarget | null): boolean {
  const doc = (target as Node | null)?.ownerDocument ?? (target as Document | null)
  return !target || target === doc || target === doc?.documentElement || target === doc?.body
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

function snapshotOf(host: HTMLElement, seq: number): Snapshot {
  if (!isPlainControl(host)) {
    const selection = editableSelection(host)
    return { content: host.innerHTML, start: selection?.start ?? null, end: selection?.end ?? null, seq }
  }
  let start: number | null = null
  let end: number | null = null
  try {
    start = host.selectionStart
    end = host.selectionEnd
  } catch {
    // some input types have no selection
  }
  return { content: host.value, start, end, seq }
}

/** The kind of an edit for grouping into bursts: consecutive inserts or deletes of plain text group;
 *  a paste, a line break, a drop or a format change always starts its own step. */
function editKind(inputType: string): string {
  if (inputType === 'insertText' || inputType === 'insertReplacementText') return 'insert'
  if (inputType.startsWith('delete')) return 'delete'
  return `own:${inputType}`
}

/** The letter of a chord: its `key` when that is a Latin letter (so QWERTZ's z is z), else, for a
 *  layout whose letters are not Latin (e.g. 'я'), the key's position (`code`). */
function chordLetter(event: KeyboardEvent): string {
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
  if (/^[a-z]$/.test(key)) return key
  const code = typeof event.code === 'string' ? /^Key([A-Z])$/.exec(event.code) : null
  return code ? code[1].toLowerCase() : key
}

/** Drop the steps on top of `stack` that would change nothing (their content is the control's `content`). */
function dropNoOpSteps(stack: Snapshot[], content: string): void {
  while (stack.length > 0 && stack[stack.length - 1].content === content) stack.pop()
}

function pushCapped(stack: Snapshot[], snapshot: Snapshot): void {
  stack.push(snapshot)
  if (stack.length > MAX_STEPS) stack.splice(0, stack.length - MAX_STEPS)
}

export type UndoKeyAction = 'none' | 'swallow' | 'restored' | 'grid-undo' | 'grid-redo'

export interface WorkbenchUndoOptions {
  coalesceMs?: number
  now?: () => number
  /** Whether `node` is inside the workbench (the page itself is decided here, not by this). */
  isInsideWorkbench?: (node: Node) => boolean
  /** Whether `node` is on a surface whose edits are the grid's undo history (`isWorkbenchGridSurface`):
   *  only after a press or focus there is a chord on the page itself the grid's. */
  isGridSurface?: (node: Node) => boolean
}

export function createWorkbenchUndo(options: WorkbenchUndoOptions = {}) {
  const coalesceMs = options.coalesceMs ?? 800
  const now = options.now ?? (() => Date.now())
  const isInsideWorkbench = options.isInsideWorkbench ?? (() => true)
  const isGridSurface = options.isGridSurface ?? (() => true)
  const histories = new WeakMap<HTMLElement, History>()
  let generation = 0
  /** Set while a restore runs, so the recorder does not take its own edit as one. */
  let restoring = false
  /** Whether the last press or focus landed on a grid surface. A chord on the page itself is the grid's
   *  only then: after a rename in the rail or a manager, or a press in a dialog or popover (in the
   *  workbench or teleported out of it), it is not, and the grid's history is not what the user meant. */
  let lastPressOnGrid = true

  function live(host: HTMLElement): History | undefined {
    const history = histories.get(host)
    return history && history.generation === generation ? history : undefined
  }

  function fresh(host: HTMLElement): History {
    const history: History = { undo: [], redo: [], known: contentOf(host), lastKind: '', lastAt: 0, pendingBefore: false, composing: false, generation, seq: 0, floor: 0 }
    histories.set(host, history)
    return history
  }

  /** The control's history; dropped and started again when its content changed with no recorded edit. */
  function current(host: HTMLElement): History {
    const history = live(host)
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
    const history = live(host)
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
    // always differs: it is what the undo before it replaced.) So is one from before an accepted commit:
    // a redo after the commit can bring one back (an undo in flight moved it to the redo stack).
    while (undo && from.length > 0 && (from[from.length - 1].content === content || from[from.length - 1].seq <= history.floor)) from.pop()
    const snapshot = from.pop()
    if (!snapshot) return false
    // A redo puts the current content back under the redone step's own number: the steps on top that would
    // change nothing (taken since the undo, by a `beforeinput` no edit followed) go first. Their numbers are
    // newer, so left in place they would sit under the redone step, and the commit floor counts on the
    // stack being in step order.
    if (!undo) dropNoOpSteps(history.undo, content)
    pushCapped(undo ? history.redo : history.undo, snapshotOf(host, snapshot.seq))
    restore(host, history, snapshot)
    return true
  }

  return {
    /** What a keydown is. For anything but 'none' the caller must call preventDefault, then run the
     *  grid's undo / redo for 'grid-undo' / 'grid-redo'; 'restored' and 'swallow' need nothing more. */
    decide(event: KeyboardEvent): UndoKeyAction {
      if (!event.metaKey && !event.ctrlKey) return 'none'
      if (event.altKey) return 'none'
      const letter = chordLetter(event)
      const undo = letter === 'z' && !event.shiftKey
      const redo = letter === 'y' || (letter === 'z' && event.shiftKey)
      if (!undo && !redo) return 'none'
      if (event.isComposing || event.keyCode === 229) return 'swallow'
      const host = textEntryHost(event.target)
      if (host) {
        // A text-entry control's chord is its own: a step of its own, or nothing. Cmd+Y is never a text
        // redo (on macOS it is not one).
        if (hasUnreportableDraft(host)) return 'swallow'
        if (!(letter === 'y' && event.metaKey) && step(host, undo)) return 'restored'
        return 'swallow'
      }
      const target = event.target as Node | null
      const grids = isPageItself(target) ? lastPressOnGrid : !!target && isInsideWorkbench(target)
      if (!grids) return 'swallow'
      return undo ? 'grid-undo' : 'grid-redo'
    },
    onBeforeInput(event: Event): void {
      if (restoring) return
      const host = textEntryHost(event.target)
      if (!host) return
      const inputType = (event as InputEvent).inputType ?? ''
      if (inputType === 'historyUndo' || inputType === 'historyRedo') {
        // The Edit menu's (or a context menu's) undo: never the browser's own. It is the focused control's
        // own step when it has one, and never reaches the grid. A control without focus is left as it is
        // (restored without focus it would never blur, so never be saved).
        event.preventDefault()
        const focused = host.ownerDocument.activeElement
        if (focused === host || (!!focused && host.contains(focused))) step(host, inputType === 'historyUndo')
        return
      }
      const history = current(host)
      history.pendingBefore = true
      if (history.composing || (event as InputEvent).isComposing || COMPOSITION_INPUT_TYPES.has(inputType)) return
      // The box holds a draft its value cannot report ("1." reads ""): a snapshot now would be wrong.
      if (hasUnreportableDraft(host)) return
      const kind = editKind(inputType)
      const at = now()
      if (history.undo.length === 0 || kind !== history.lastKind || kind.startsWith('own:') || at - history.lastAt > coalesceMs) {
        pushCapped(history.undo, snapshotOf(host, ++history.seq))
      }
      history.lastKind = kind
      history.lastAt = at
    },
    onInput(event: Event): void {
      if (restoring) return
      const host = textEntryHost(event.target)
      if (!host) return
      const history = live(host)
      if (!history) return
      if (!history.pendingBefore && !history.composing && history.known !== contentOf(host)) {
        // An edit with no `beforeinput` (the editor's own execCommand: paste, drop, toolbar) is a step of
        // its own, back to the content the control had just before.
        pushCapped(history.undo, { content: history.known, start: null, end: null, seq: ++history.seq })
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
      pushCapped(history.undo, snapshotOf(host, ++history.seq))
      history.composing = true
    },
    onCompositionEnd(event: Event): void {
      const host = textEntryHost(event.target)
      const history = host ? live(host) : undefined
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
    /** A press or focus landed on `target`: remember whether it was on a grid surface. */
    onPress(target: EventTarget | null): void {
      if (isPageItself(target)) return
      const node = target as Node
      lastPressOnGrid = isInsideWorkbench(node) && isGridSurface(node)
    },
    /** Drop every control's history (the drawer shows another record; the sheet or view changed). */
    reset(): void {
      generation += 1
    },
    /** The workbench is committing what the controls in `containers` hold. Call the returned function
     *  once the server accepted it: their history then ends at the commit, so only edits made since stay
     *  undoable, back to the committed content. A rejected commit keeps it all (a rejection that snaps
     *  the control back to the saved value is a rewrite, which drops it anyway). */
    beginCommit(containers: Element[]): () => void {
      const marks = new Map<HTMLElement, { history: History; mark: number }>()
      for (const container of containers) {
        for (const el of [container, ...Array.from(container.querySelectorAll('textarea, input, [contenteditable]'))]) {
          const host = textEntryHost(el)
          const history = host ? live(host) : undefined
          if (!host || !history || marks.has(host)) continue
          // Steps on top that would change nothing (a `beforeinput` no edit followed, after an undo) go first:
          // their newer numbers would put the mark above a step a redo in flight brings back, and that redo
          // would then not be undoable back to the committed content.
          dropNoOpSteps(history.undo, contentOf(host))
          // The highest step number, not the top one's (the order is kept by `step` and the line above;
          // this does not depend on it).
          marks.set(host, { history, mark: history.undo.reduce((top, snapshot) => Math.max(top, snapshot.seq), 0) })
          // Typing after the commit is a step of its own, back to the committed content.
          history.lastKind = ''
          history.lastAt = 0
        }
      }
      return () => {
        for (const [host, { history, mark }] of marks) {
          if (live(host) !== history) continue
          // Every step taken before the commit goes (an undo and a redo in flight keep a step's number;
          // `step` drops them, also one a redo brings back); what was typed since stays.
          history.floor = Math.max(history.floor, mark)
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
  const onFocusIn = (event: Event) => {
    undo.onPress(event.target)
    undo.onCheckpoint(event.target)
  }
  const onTarget = (event: Event) => undo.onCheckpoint(event.target)
  const onPress = (event: Event) => {
    undo.onPress(event.target)
    // A press on an editor's toolbar keeps focus in the editor: checkpoint what has focus.
    undo.onCheckpoint(doc.activeElement)
  }
  const listeners: Array<[string, (event: Event) => void]> = [
    ['keydown', onKeydown],
    ['beforeinput', undo.onBeforeInput],
    ['input', undo.onInput],
    ['compositionstart', undo.onCompositionStart],
    ['compositionend', undo.onCompositionEnd],
    ['focusin', onFocusIn],
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
