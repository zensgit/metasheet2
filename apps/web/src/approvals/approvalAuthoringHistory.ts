import type { ApprovalCanvasSelection } from './approvalCanvasCommands'
import type { TemplateAuthoringDraft } from './templateAuthoring'

export type ApprovalAuthoringCommand =
  | { type: 'insert-node'; edgeKey: string; nodeType: string }
  | { type: 'insert-after'; nodeKey: string; nodeType: 'approval' | 'condition' | 'parallel' }
  | { type: 'add-branch'; nodeKey: string; branchType: 'condition' | 'parallel' }
  | { type: 'move-node'; nodeKey: string; edgeKey: string }
  | { type: 'reorder-condition-branches'; nodeKey: string }
  | { type: 'reorder-parallel-branches'; nodeKey: string }
  | { type: 'delete-node'; nodeKey: string }
  | { type: 'configure-node'; nodeKey: string; control: string }

export type ApprovalAuthoringFocus =
  | { kind: 'none' }
  | { kind: 'canvas' }
  | { kind: 'canvas-node'; nodeKey: string }
  | { kind: 'inspector'; nodeKey: string; controlTestId?: string }

export interface ApprovalAuthoringSnapshot {
  draft: TemplateAuthoringDraft
  selection: ApprovalCanvasSelection
  focus: ApprovalAuthoringFocus
}

export interface ApprovalAuthoringHistoryEntry {
  command: ApprovalAuthoringCommand
  before: ApprovalAuthoringSnapshot
  after: ApprovalAuthoringSnapshot
}

export interface ApprovalAuthoringHistory {
  draftKey: string
  undoStack: ApprovalAuthoringHistoryEntry[]
  redoStack: ApprovalAuthoringHistoryEntry[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function cloneApprovalAuthoringSnapshot(snapshot: ApprovalAuthoringSnapshot): ApprovalAuthoringSnapshot {
  return clone(snapshot)
}

export function createApprovalAuthoringHistory(draftKey: string): ApprovalAuthoringHistory {
  return { draftKey, undoStack: [], redoStack: [] }
}

export function recordApprovalAuthoringCommand(
  history: ApprovalAuthoringHistory,
  command: ApprovalAuthoringCommand,
  before: ApprovalAuthoringSnapshot,
  after: ApprovalAuthoringSnapshot,
): ApprovalAuthoringHistory {
  if (JSON.stringify(before) === JSON.stringify(after)) return history
  return {
    draftKey: history.draftKey,
    undoStack: [...history.undoStack, { command: clone(command), before: clone(before), after: clone(after) }],
    redoStack: [],
  }
}

export function undoApprovalAuthoringCommand(history: ApprovalAuthoringHistory): {
  history: ApprovalAuthoringHistory
  snapshot: ApprovalAuthoringSnapshot | null
} {
  const entry = history.undoStack.at(-1)
  if (!entry) return { history, snapshot: null }
  return {
    history: {
      draftKey: history.draftKey,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [entry, ...history.redoStack],
    },
    snapshot: clone(entry.before),
  }
}

export function redoApprovalAuthoringCommand(history: ApprovalAuthoringHistory): {
  history: ApprovalAuthoringHistory
  snapshot: ApprovalAuthoringSnapshot | null
} {
  const entry = history.redoStack[0]
  if (!entry) return { history, snapshot: null }
  return {
    history: {
      draftKey: history.draftKey,
      undoStack: [...history.undoStack, entry],
      redoStack: history.redoStack.slice(1),
    },
    snapshot: clone(entry.after),
  }
}

export function isApprovalHistoryShortcutBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
