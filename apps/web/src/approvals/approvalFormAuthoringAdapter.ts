import {
  addFormDetailColumn,
  addFormField,
  collectFormFieldDependencies,
  moveFormField,
  moveFormFieldByOffset,
  removeFormField,
  type FormCommandFailureReason,
  type FormCommandResult,
  type FormFieldDependency,
  type FormInsertionAnchor,
} from './approvalFormCommands'
import {
  canRedoFormHistory,
  canUndoFormHistory,
  createFormAuthoringHistory,
  pushFormSnapshot,
  redoFormHistory,
  undoFormHistory,
  type FormAuthoringHistory,
} from './approvalFormAuthoringHistory'
import {
  createOpaqueFormIdentityAllocator,
  type OpaqueFormIdentityAllocator,
} from './approvalFormIdentity'
import type {
  AuthorableFieldType,
  TemplateAuthoringDraft,
} from './templateAuthoring'

/**
 * F1 production form-authoring adapter — the ONE typed command path of RATIFIED
 * FB-D4 (approval-form-builder-parity-delta-design-20260811.md), consumed by
 * the F2/F3 `ApprovalFormBuilder` behind `approvalCanvasV2`. The flag-OFF
 * inline editor fallback does not route through this module (delta §5 F1:
 * additive-only, no production mount until F4).
 *
 * Contract:
 * - Every structural edit flows through `approvalFormCommands` + the form
 *   authoring history. The UI must never splice/filter the production field
 *   array directly for these actions.
 * - A value-changing successful command produces EXACTLY ONE history entry and
 *   one focus result; a value-identical boundary/no-op produces ZERO history
 *   entries; a rejected command produces ZERO draft and ZERO history mutation.
 * - Anchors (FB-D3) are re-resolved by the pure command against the CURRENT
 *   draft immediately before mutation — this adapter never captures or
 *   forwards an index. A stale anchor is a values-free no-op rejection.
 * - Identity (FB-D5 `OPAQUE_COLLISION_RESISTANT`): new field/detail-column
 *   identities come only from the injected opaque allocator. On
 *   `field_identity_conflict` the adapter retries with a FRESH candidate up to
 *   `maxIdentityAttempts`; exhaustion is the typed
 *   `identity_allocation_exhausted` failure with zero mutation. This adapter
 *   never calls the legacy length-derived `createEmptyFieldDraft` /
 *   `createEmptyDetailColumnDraft` helpers.
 * - References (FB-D6): the authoritative reference set is the current-draft
 *   set from `collectFormFieldDependencies`, complete by construction;
 *   `listFieldReferences` exposes it as the delete/retype reference provider.
 * - Failure surface is values-free: results carry only typed reasons and
 *   internal dependency kinds/locations — never form values, labels, or other
 *   user content.
 */

/** Immutable session snapshot: the current draft plus its structural history. */
export interface FormAuthoringSession {
  readonly draft: TemplateAuthoringDraft
  readonly history: FormAuthoringHistory
}

export type FormAdapterFailureReason =
  | FormCommandFailureReason
  /** Allocator retries exhausted without a collision-free candidate. */
  | 'identity_allocation_exhausted'
  /** Undo/redo requested on an empty stack. */
  | 'history_empty'

/**
 * Values-free adapter result. On failure the session is returned UNCHANGED —
 * callers keep using it; no partial draft or history mutation exists.
 */
export type FormAdapterResult =
  | {
      ok: true
      session: FormAuthoringSession
      focusLocalId: string | null
      /** True when a history entry was created (value-changing edit). */
      changed: boolean
    }
  | {
      ok: false
      reason: FormAdapterFailureReason
      dependencies: readonly FormFieldDependency[]
      session: FormAuthoringSession
    }

export interface FormAuthoringAdapterOptions {
  /** Identity authority; injected deterministic in tests (FB-D5 seam). */
  identityAllocator?: OpaqueFormIdentityAllocator
  /** Collision-retry budget per logical add; each attempt is a fresh candidate. */
  maxIdentityAttempts?: number
}

export const DEFAULT_IDENTITY_ALLOCATION_ATTEMPTS = 5

export interface FormAuthoringAdapter {
  /** Seed a session from a hydrated draft. Stacks start empty. */
  startSession(
    draft: TemplateAuthoringDraft,
    focusLocalId?: string | null,
  ): FormAuthoringSession
  /** Palette click (no anchor = append) and exact-slot drop (FB-D3 anchor). */
  addField(
    session: FormAuthoringSession,
    fieldType: AuthorableFieldType,
    anchor?: FormInsertionAnchor,
  ): FormAdapterResult
  /** Append one column to an existing detail field with an opaque identity. */
  addDetailColumn(
    session: FormAuthoringSession,
    fieldLocalId: string,
  ): FormAdapterResult
  /** Reference-aware delete; refuses last-field and referenced deletes. */
  removeField(session: FormAuthoringSession, localId: string): FormAdapterResult
  /** Semantic drag placement. */
  moveField(
    session: FormAuthoringSession,
    movingLocalId: string,
    targetLocalId: string,
    placement: 'before' | 'after',
  ): FormAdapterResult
  /** Keyboard 上移/下移; boundary is a zero-entry no-op. */
  moveFieldByOffset(
    session: FormAuthoringSession,
    localId: string,
    offset: -1 | 1,
  ): FormAdapterResult
  /**
   * FB-D6 reference provider: the complete-by-construction current-draft
   * reference set for the field, for inspector business copy. Empty when the
   * field does not exist.
   */
  listFieldReferences(
    session: FormAuthoringSession,
    localId: string,
  ): readonly FormFieldDependency[]
  undo(session: FormAuthoringSession): FormAdapterResult
  redo(session: FormAuthoringSession): FormAdapterResult
  canUndo(session: FormAuthoringSession): boolean
  canRedo(session: FormAuthoringSession): boolean
}

function failure(
  session: FormAuthoringSession,
  reason: FormAdapterFailureReason,
  dependencies: readonly FormFieldDependency[] = [],
): FormAdapterResult {
  return { ok: false, reason, dependencies, session }
}

/**
 * Commit one successful command result: push at most ONE history snapshot
 * (`pushFormSnapshot` returns the identical history for value-identical field
 * lists, so boundary no-ops create zero entries by construction).
 */
function commit(
  session: FormAuthoringSession,
  result: FormCommandResult,
): FormAdapterResult {
  if (!result.ok) {
    return failure(session, result.reason, result.dependencies)
  }
  const history = pushFormSnapshot(
    session.history,
    result.draft.fields,
    result.focusLocalId,
  )
  const changed =
    history.undoStack.length > session.history.undoStack.length
  return {
    ok: true,
    session: { draft: result.draft, history },
    focusLocalId: result.focusLocalId,
    changed,
  }
}

export function createFormAuthoringAdapter(
  options: FormAuthoringAdapterOptions = {},
): FormAuthoringAdapter {
  const allocator =
    options.identityAllocator ?? createOpaqueFormIdentityAllocator()
  const maxAttempts = Math.max(
    1,
    options.maxIdentityAttempts ?? DEFAULT_IDENTITY_ALLOCATION_ATTEMPTS,
  )

  return {
    startSession(draft, focusLocalId = null) {
      return {
        draft,
        history: createFormAuthoringHistory(draft.fields, focusLocalId),
      }
    },

    addField(session, fieldType, anchor) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // FRESH candidate per attempt — a rejected candidate is never reused.
        const identity = allocator.nextFieldIdentity(fieldType)
        const result = addFormField(session.draft, fieldType, identity, anchor)
        if (result.ok) return commit(session, result)
        if (result.reason !== 'field_identity_conflict') {
          return failure(session, result.reason, result.dependencies)
        }
      }
      return failure(session, 'identity_allocation_exhausted')
    },

    addDetailColumn(session, fieldLocalId) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const identity = allocator.nextDetailColumnIdentity()
        const result = addFormDetailColumn(
          session.draft,
          fieldLocalId,
          identity,
        )
        if (result.ok) return commit(session, result)
        if (result.reason !== 'field_identity_conflict') {
          return failure(session, result.reason, result.dependencies)
        }
      }
      return failure(session, 'identity_allocation_exhausted')
    },

    removeField(session, localId) {
      return commit(session, removeFormField(session.draft, localId))
    },

    moveField(session, movingLocalId, targetLocalId, placement) {
      return commit(
        session,
        moveFormField(session.draft, movingLocalId, targetLocalId, placement),
      )
    },

    moveFieldByOffset(session, localId, offset) {
      return commit(
        session,
        moveFormFieldByOffset(session.draft, localId, offset),
      )
    },

    listFieldReferences(session, localId) {
      const field = session.draft.fields.find(
        (candidate) => candidate.localId === localId,
      )
      if (!field) return []
      return collectFormFieldDependencies(session.draft, field.id)
    },

    undo(session) {
      const result = undoFormHistory(session.history)
      if (!result.ok) return failure(session, 'history_empty')
      return {
        ok: true,
        session: {
          draft: { ...session.draft, fields: result.fields },
          history: result.history,
        },
        focusLocalId: result.focusLocalId,
        changed: true,
      }
    },

    redo(session) {
      const result = redoFormHistory(session.history)
      if (!result.ok) return failure(session, 'history_empty')
      return {
        ok: true,
        session: {
          draft: { ...session.draft, fields: result.fields },
          history: result.history,
        },
        focusLocalId: result.focusLocalId,
        changed: true,
      }
    },

    canUndo(session) {
      return canUndoFormHistory(session.history)
    },

    canRedo(session) {
      return canRedoFormHistory(session.history)
    },
  }
}
