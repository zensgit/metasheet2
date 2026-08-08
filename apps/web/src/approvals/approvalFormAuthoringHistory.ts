/**
 * Session history for approval template form-field authoring.
 *
 * Scope is the field list + optional focused field `localId` only — canvas /
 * topology history stays in `approvalAuthoringHistory`. Snapshots are deep-cloned
 * via JSON so later in-place Vue edits cannot corrupt the stacks.
 *
 * `localId` is a view-model selection key only; it is never shown as ordinary-user
 * input and is not a persisted identity API.
 */

import type { FieldAuthoringDraft } from './templateAuthoring'

/** Default cap on undo (and redo) depth for a single authoring session. */
export const FORM_AUTHORING_HISTORY_MAX_STACK = 100

export interface FormAuthoringHistory {
  /** Current field list tip (cloned). */
  fields: FieldAuthoringDraft[]
  /** Focused field localId, or null when none. */
  focusLocalId: string | null
  /** Prior tips; undo pops from the end. */
  undoStack: FormAuthoringSnapshot[]
  /** Tips restored by undo; redo pops from the end. */
  redoStack: FormAuthoringSnapshot[]
  maxStack: number
}

export interface FormAuthoringSnapshot {
  fields: FieldAuthoringDraft[]
  focusLocalId: string | null
}

export type FormAuthoringHistoryResult =
  | {
      ok: true
      history: FormAuthoringHistory
      fields: FieldAuthoringDraft[]
      focusLocalId: string | null
    }
  | {
      ok: false
      reason: 'empty-undo' | 'empty-redo'
      history: FormAuthoringHistory
      fields: FieldAuthoringDraft[]
      focusLocalId: string | null
    }

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function cloneFields(fields: readonly FieldAuthoringDraft[]): FieldAuthoringDraft[] {
  return cloneJson(fields)
}

function fieldsEqual(
  left: readonly FieldAuthoringDraft[],
  right: readonly FieldAuthoringDraft[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function tipSnapshot(history: FormAuthoringHistory): FormAuthoringSnapshot {
  return {
    fields: cloneFields(history.fields),
    focusLocalId: history.focusLocalId,
  }
}

function trimStack(
  stack: FormAuthoringSnapshot[],
  maxStack: number,
): FormAuthoringSnapshot[] {
  if (stack.length <= maxStack) return stack
  return stack.slice(stack.length - maxStack)
}

/**
 * Seed a new form authoring session from the current field list.
 * Stacks start empty (nothing to undo/redo).
 */
export function createFormAuthoringHistory(
  fields: readonly FieldAuthoringDraft[],
  focusLocalId: string | null = null,
  maxStack: number = FORM_AUTHORING_HISTORY_MAX_STACK,
): FormAuthoringHistory {
  const cap = maxStack > 0 ? maxStack : FORM_AUTHORING_HISTORY_MAX_STACK
  return {
    fields: cloneFields(fields),
    focusLocalId,
    undoStack: [],
    redoStack: [],
    maxStack: cap,
  }
}

/** True when at least one structural snapshot is on the undo stack. */
export function canUndoFormHistory(history: FormAuthoringHistory): boolean {
  return history.undoStack.length > 0
}

/** True when at least one snapshot is on the redo stack. */
export function canRedoFormHistory(history: FormAuthoringHistory): boolean {
  return history.redoStack.length > 0
}

/**
 * Push a new field-list tip. When `nextFields` is byte-identical to the current tip,
 * history is returned unchanged (no stack entry, redo preserved). On real change,
 * the previous tip is pushed to undo, redo is cleared, and stacks are capped.
 */
export function pushFormSnapshot(
  history: FormAuthoringHistory,
  nextFields: readonly FieldAuthoringDraft[],
  nextFocus: string | null = history.focusLocalId,
): FormAuthoringHistory {
  if (fieldsEqual(history.fields, nextFields)) {
    // Focus-only changes do not create history entries (structural scope only).
    if (history.focusLocalId === nextFocus) return history
    return {
      ...history,
      focusLocalId: nextFocus,
    }
  }
  const previous = tipSnapshot(history)
  const undoStack = trimStack([...history.undoStack, previous], history.maxStack)
  return {
    fields: cloneFields(nextFields),
    focusLocalId: nextFocus,
    undoStack,
    redoStack: [],
    maxStack: history.maxStack,
  }
}

/**
 * Undo one structural snapshot. Fail-closed when the undo stack is empty
 * (returns `ok: false` with unchanged history).
 */
export function undoFormHistory(
  history: FormAuthoringHistory,
): FormAuthoringHistoryResult {
  if (history.undoStack.length === 0) {
    return {
      ok: false,
      reason: 'empty-undo',
      history,
      fields: history.fields,
      focusLocalId: history.focusLocalId,
    }
  }
  const previous = history.undoStack[history.undoStack.length - 1]!
  const current = tipSnapshot(history)
  const nextHistory: FormAuthoringHistory = {
    fields: cloneFields(previous.fields),
    focusLocalId: previous.focusLocalId,
    undoStack: history.undoStack.slice(0, -1),
    redoStack: trimStack([...history.redoStack, current], history.maxStack),
    maxStack: history.maxStack,
  }
  return {
    ok: true,
    history: nextHistory,
    fields: nextHistory.fields,
    focusLocalId: nextHistory.focusLocalId,
  }
}

/**
 * Redo one structural snapshot. Fail-closed when the redo stack is empty.
 */
export function redoFormHistory(
  history: FormAuthoringHistory,
): FormAuthoringHistoryResult {
  if (history.redoStack.length === 0) {
    return {
      ok: false,
      reason: 'empty-redo',
      history,
      fields: history.fields,
      focusLocalId: history.focusLocalId,
    }
  }
  const next = history.redoStack[history.redoStack.length - 1]!
  const current = tipSnapshot(history)
  const nextHistory: FormAuthoringHistory = {
    fields: cloneFields(next.fields),
    focusLocalId: next.focusLocalId,
    undoStack: trimStack([...history.undoStack, current], history.maxStack),
    redoStack: history.redoStack.slice(0, -1),
    maxStack: history.maxStack,
  }
  return {
    ok: true,
    history: nextHistory,
    fields: nextHistory.fields,
    focusLocalId: nextHistory.focusLocalId,
  }
}
