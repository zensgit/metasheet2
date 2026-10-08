import {
  AUTHORABLE_FIELD_TYPES,
  type AuthorableFieldType,
} from './templateAuthoring'

/**
 * F2 typed drag codec — RATIFIED approval-form-builder-parity delta §3.1
 * (approval-form-builder-parity-delta-design-20260811.md).
 *
 * Drag data is internal and type-limited. Contract:
 * - ONE application-specific MIME type for both payload kinds. `text/plain`
 *   (or any other type) is NEVER read back as a command — `read…` only calls
 *   `getData` with `APPROVAL_FORM_DRAG_MIME`.
 * - Decoding is a strict structured validator: unknown versions, kinds,
 *   extra/missing properties, non-allowlisted field types, blank local ids,
 *   non-JSON, and non-object JSON all decode to `null`, never to a command.
 * - Payloads carry NO persistent field id, form value, user value, credential,
 *   or label. The ephemeral `localId` of an existing field is the only
 *   identifier allowed (§8: in-page field-move payload / non-visible DOM data
 *   only — never ordinary-user copy, logs, or persistence).
 * - Transient drag state lives in an `ApprovalFormDragSession` whose explicit
 *   `clear()` the owning components wire to ALL of: successful/failed drop,
 *   `dragend`, Escape, route change (component unmount), and the read-only
 *   transition.
 *
 * This module is pure (no Vue, no Element Plus): components mirror the session
 * into their own reactive state via `subscribe`.
 */

/** The single application-specific drag MIME type (palette AND field moves). */
export const APPROVAL_FORM_DRAG_MIME = 'application/x-metasheet-approval-form'

export type ApprovalFormDragPayload =
  | { version: 1; kind: 'palette'; fieldType: AuthorableFieldType }
  | { version: 1; kind: 'field'; localId: string }

const AUTHORABLE_TYPE_SET: ReadonlySet<string> = new Set<string>(
  AUTHORABLE_FIELD_TYPES,
)

export function encodeApprovalFormDragPayload(
  payload: ApprovalFormDragPayload,
): string {
  return JSON.stringify(payload)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Strict structured validator (§3.1): returns the typed payload only for an
 * EXACT match — version 1, an allowlisted kind, the exact property set for
 * that kind, and an allowlisted `fieldType` / non-blank `localId`. Anything
 * else — foreign producers, truncated JSON, extra properties, unknown
 * versions/kinds/types — is `null`, never a command.
 */
export function decodeApprovalFormDragPayload(
  raw: string | null | undefined,
): ApprovalFormDragPayload | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainRecord(parsed)) return null
  if (parsed.version !== 1) return null
  const keys = Object.keys(parsed).sort()
  if (parsed.kind === 'palette') {
    if (keys.join(',') !== 'fieldType,kind,version') return null
    const fieldType = parsed.fieldType
    if (typeof fieldType !== 'string' || !AUTHORABLE_TYPE_SET.has(fieldType)) {
      return null
    }
    return {
      version: 1,
      kind: 'palette',
      fieldType: fieldType as AuthorableFieldType,
    }
  }
  if (parsed.kind === 'field') {
    if (keys.join(',') !== 'kind,localId,version') return null
    const localId = parsed.localId
    if (typeof localId !== 'string' || localId.trim().length === 0) return null
    return { version: 1, kind: 'field', localId }
  }
  return null
}

/**
 * Write the payload under the application MIME type ONLY. Deliberately no
 * `text/plain` mirror: a generic type must never round-trip into a command,
 * and not writing it keeps foreign drop targets from receiving draft content.
 */
export function writeApprovalFormDragPayload(
  dataTransfer: DataTransfer | null | undefined,
  payload: ApprovalFormDragPayload,
): void {
  if (!dataTransfer) return
  dataTransfer.setData(
    APPROVAL_FORM_DRAG_MIME,
    encodeApprovalFormDragPayload(payload),
  )
  try {
    dataTransfer.effectAllowed = payload.kind === 'field' ? 'move' : 'copy'
  } catch {
    // Some environments expose a readonly effectAllowed; the payload is set.
  }
}

/**
 * Read a payload back from a drop. Reads ONLY `APPROVAL_FORM_DRAG_MIME`; a
 * `text/plain` (or any other type) entry is never consulted, so a generic or
 * foreign drag can never become a command (§3.1).
 */
export function readApprovalFormDragPayload(
  dataTransfer: DataTransfer | null | undefined,
): ApprovalFormDragPayload | null {
  if (!dataTransfer) return null
  let raw = ''
  try {
    raw = dataTransfer.getData(APPROVAL_FORM_DRAG_MIME)
  } catch {
    return null
  }
  return decodeApprovalFormDragPayload(raw)
}

/**
 * `dragover`-time candidate check (§3.2): browsers do not expose trustworthy
 * payload CONTENT until `drop`, but the TYPE list is visible, so slots may
 * expand/highlight when the application MIME type is present. Full structured
 * validation still runs at `drop` before any command.
 */
export function dataTransferSignalsApprovalFormDrag(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false
  try {
    return Array.from(dataTransfer.types ?? []).includes(
      APPROVAL_FORM_DRAG_MIME,
    )
  } catch {
    return false
  }
}

/**
 * Transient drag-state store (§3.1). Pure observable holder: `begin` on
 * `dragstart`, `clear` on drop (success OR failure), `dragend`, Escape,
 * route change/unmount, and the read-only transition. `clear` is idempotent;
 * listeners fire only on actual transitions.
 */
export interface ApprovalFormDragSession {
  /** The payload of the in-flight drag, or null when no drag is active. */
  active(): ApprovalFormDragPayload | null
  begin(payload: ApprovalFormDragPayload): void
  clear(): void
  /** Subscribe to transitions; returns an unsubscribe function. */
  subscribe(
    listener: (active: ApprovalFormDragPayload | null) => void,
  ): () => void
}

export function createApprovalFormDragSession(): ApprovalFormDragSession {
  let current: ApprovalFormDragPayload | null = null
  const listeners = new Set<(active: ApprovalFormDragPayload | null) => void>()
  function notify(): void {
    listeners.forEach((listener) => listener(current))
  }
  return {
    active() {
      return current
    },
    begin(payload) {
      current = payload
      notify()
    },
    clear() {
      if (current === null) return
      current = null
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
