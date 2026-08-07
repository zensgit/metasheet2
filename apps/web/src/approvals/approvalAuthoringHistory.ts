/**
 * Authoring-session history for Canvas V2 flow edits.
 *
 * - Typed canvas commands (move / reorder) go through `approvalCanvasCommands` so
 *   inverses stay algebraic and fail-closed (no partial apply).
 * - Other topology mutations (insert/remove/branch) record a graph snapshot pair
 *   after the pure topology helper has already produced a complete next graph.
 * - Selection is restored with the graph on undo/redo.
 *
 * The view is I/O only: it never invents a parallel graph model.
 */
import type { ApprovalGraph } from '../types/approval'
import {
  applyApprovalCanvasCommand,
  createApprovalCanvasHistory,
  executeApprovalCanvasCommand,
  type ApprovalCanvasCommand,
  type ApprovalCanvasCommandError,
  type ApprovalCanvasSelection,
} from './approvalCanvasCommands'
import {
  applyTopologyToDraft,
  buildApprovalGraph,
  type TemplateAuthoringDraft,
} from './templateAuthoring'

function cloneGraph(graph: ApprovalGraph): ApprovalGraph {
  return JSON.parse(JSON.stringify(graph)) as ApprovalGraph
}

function cloneSelection(selection: ApprovalCanvasSelection): ApprovalCanvasSelection {
  return JSON.parse(JSON.stringify(selection)) as ApprovalCanvasSelection
}

function graphsEqual(left: ApprovalGraph, right: ApprovalGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface CanvasCommandHistoryEntry {
  kind: 'canvas-command'
  command: ApprovalCanvasCommand
  inverse: ApprovalCanvasCommand
  selectionBefore: ApprovalCanvasSelection
  selectionAfter: ApprovalCanvasSelection
}

/** Snapshot entry for topology helpers that are not yet pure canvas commands. */
export interface TopologySnapshotEntry {
  kind: 'topology-snapshot'
  before: ApprovalGraph
  after: ApprovalGraph
  selectionBefore: ApprovalCanvasSelection
  selectionAfter: ApprovalCanvasSelection
}

export type AuthoringHistoryEntry = CanvasCommandHistoryEntry | TopologySnapshotEntry

export interface AuthoringSessionHistory {
  /** Effective graph after the last successful mutation (or initial seed). */
  graph: ApprovalGraph
  selection: ApprovalCanvasSelection
  /** Entries applied in order; undo pops from the end. */
  undoStack: AuthoringHistoryEntry[]
  redoStack: AuthoringHistoryEntry[]
}

export type AuthoringHistoryResult =
  | { ok: true; history: AuthoringSessionHistory }
  | { ok: false; error: ApprovalCanvasCommandError; history: AuthoringSessionHistory }

export function createAuthoringSessionHistory(
  graph: ApprovalGraph,
  selection: ApprovalCanvasSelection = { kind: 'none' },
): AuthoringSessionHistory {
  return {
    graph: cloneGraph(graph),
    selection: cloneSelection(selection),
    undoStack: [],
    redoStack: [],
  }
}

/**
 * Promote a linear (steps-only) draft into the single preservedGraph authoring model
 * without changing topology — identity graph from `buildApprovalGraph`.
 */
export function promoteLinearDraftToGraphAuthoring(
  draft: TemplateAuthoringDraft,
): TemplateAuthoringDraft {
  if (draft.preservedGraph) return draft
  return applyTopologyToDraft(draft, (graph) => cloneGraph(graph))
}

/**
 * Apply a typed canvas command (move/reorder). Failures leave history byte-identical
 * and never mutate the draft (caller only writes on ok).
 */
export function applyCanvasCommandToSession(
  history: AuthoringSessionHistory,
  command: ApprovalCanvasCommand,
  selectionBefore: ApprovalCanvasSelection = history.selection,
): AuthoringHistoryResult {
  const canvasHistory = createApprovalCanvasHistory(history.graph, selectionBefore)
  const applied = applyApprovalCanvasCommand(canvasHistory, command, selectionBefore)
  if (!applied.ok) {
    return { ok: false, error: applied.error, history }
  }
  const stackEntry = applied.history.undoStack[applied.history.undoStack.length - 1]
  if (!stackEntry) {
    return {
      ok: false,
      error: { code: 'empty-history', message: 'apply produced no history entry' },
      history,
    }
  }
  return {
    ok: true,
    history: {
      graph: applied.history.graph,
      selection: applied.history.selection,
      undoStack: [
        ...history.undoStack,
        {
          kind: 'canvas-command',
          command: stackEntry.command,
          inverse: stackEntry.inverse,
          selectionBefore: stackEntry.selectionBefore,
          selectionAfter: stackEntry.selectionAfter,
        },
      ],
      redoStack: [],
    },
  }
}

/**
 * Apply a pure topology op via `applyTopologyToDraft`. Records a snapshot pair so
 * undo restores the previous graph and selection. If the op throws or yields the
 * same graph, history is unchanged on throw; identity graphs are ok no-ops.
 */
export function applyTopologyOpToSession(
  history: AuthoringSessionHistory,
  draft: TemplateAuthoringDraft,
  op: (graph: ApprovalGraph) => ApprovalGraph,
  selectionAfter: ApprovalCanvasSelection = history.selection,
): {
  ok: boolean
  history: AuthoringSessionHistory
  draft: TemplateAuthoringDraft
  errorMessage?: string
} {
  // Always derive "before" from the live draft (not a possibly-stale session graph) so linear
  // promotion and external draft reloads stay fail-closed and undo-correct.
  const before = cloneGraph(buildApprovalGraph(draft))
  const selectionBefore = cloneSelection(history.selection)
  try {
    const nextDraft = applyTopologyToDraft(draft, op)
    const after = buildApprovalGraph(nextDraft)
    if (graphsEqual(before, after)) {
      return {
        ok: true,
        history: {
          ...history,
          graph: cloneGraph(after),
          selection: cloneSelection(selectionAfter),
        },
        draft: nextDraft,
      }
    }
    const entry: TopologySnapshotEntry = {
      kind: 'topology-snapshot',
      before,
      after: cloneGraph(after),
      selectionBefore,
      selectionAfter: cloneSelection(selectionAfter),
    }
    return {
      ok: true,
      draft: nextDraft,
      history: {
        graph: cloneGraph(after),
        selection: cloneSelection(selectionAfter),
        undoStack: [...history.undoStack, entry],
        redoStack: [],
      },
    }
  } catch {
    return {
      ok: false,
      history,
      draft,
      errorMessage: '该拓扑操作不适用于当前流程结构',
    }
  }
}

/** Reseed session history when a draft is loaded or externally replaced. */
export function reseedAuthoringSessionHistory(
  draft: TemplateAuthoringDraft,
  selection: ApprovalCanvasSelection = { kind: 'none' },
): AuthoringSessionHistory {
  return createAuthoringSessionHistory(buildApprovalGraph(draft), selection)
}

export function canUndoAuthoring(history: AuthoringSessionHistory): boolean {
  return history.undoStack.length > 0
}

export function canRedoAuthoring(history: AuthoringSessionHistory): boolean {
  return history.redoStack.length > 0
}

/**
 * Undo one session entry. Canvas-command units restore via algebraic inverse on the
 * current graph; topology snapshots restore the before graph.
 */
export function undoAuthoringSession(
  history: AuthoringSessionHistory,
): AuthoringHistoryResult {
  if (history.undoStack.length === 0) {
    return {
      ok: false,
      error: { code: 'empty-history', message: 'undo: nothing to undo' },
      history,
    }
  }
  const entry = history.undoStack[history.undoStack.length - 1]!
  if (entry.kind === 'topology-snapshot') {
    return {
      ok: true,
      history: {
        graph: cloneGraph(entry.before),
        selection: cloneSelection(entry.selectionBefore),
        undoStack: history.undoStack.slice(0, -1),
        redoStack: [entry, ...history.redoStack],
      },
    }
  }
  const result = executeApprovalCanvasCommand(
    history.graph,
    entry.inverse,
    history.selection,
  )
  if (!result.ok) {
    return { ok: false, error: result.error, history }
  }
  return {
    ok: true,
    history: {
      graph: result.graph,
      selection: cloneSelection(entry.selectionBefore),
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [entry, ...history.redoStack],
    },
  }
}

export function redoAuthoringSession(
  history: AuthoringSessionHistory,
): AuthoringHistoryResult {
  if (history.redoStack.length === 0) {
    return {
      ok: false,
      error: { code: 'empty-history', message: 'redo: nothing to redo' },
      history,
    }
  }
  const entry = history.redoStack[0]!
  if (entry.kind === 'topology-snapshot') {
    return {
      ok: true,
      history: {
        graph: cloneGraph(entry.after),
        selection: cloneSelection(entry.selectionAfter),
        undoStack: [...history.undoStack, entry],
        redoStack: history.redoStack.slice(1),
      },
    }
  }
  const result = executeApprovalCanvasCommand(
    history.graph,
    entry.command,
    entry.selectionBefore,
  )
  if (!result.ok) {
    return { ok: false, error: result.error, history }
  }
  return {
    ok: true,
    history: {
      graph: result.graph,
      selection: cloneSelection(entry.selectionAfter),
      undoStack: [...history.undoStack, entry],
      redoStack: history.redoStack.slice(1),
    },
  }
}

/**
 * Project session history graph back onto a draft (config maps re-seeded).
 * Used after undo/redo so the view's draft remains the single source of truth.
 */
export function draftFromSessionGraph(
  draft: TemplateAuthoringDraft,
  graph: ApprovalGraph,
): TemplateAuthoringDraft {
  return applyTopologyToDraft(draft, () => cloneGraph(graph))
}
