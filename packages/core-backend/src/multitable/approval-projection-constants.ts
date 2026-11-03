/**
 * Side-effect-free constants + read-guard for the T3-6 approval read-model projection base.
 *
 * This module is imported by the multitable permission path (`permission-service.ts` /
 * `sheet-capabilities.ts`), so it MUST stay import-side-effect-free — no `eventBus`, no `pool`, no
 * scheduler. The projection SERVICE (`approval-record-projection-service.ts`) re-exports
 * `APPROVAL_PROJECTION_BASE_ID` from here so the id has a single source of truth without dragging the
 * service's event-subscription surface into the permission hot path.
 *
 * A (2026-07-03): the projection base holds materialized approval outcomes (requester/approver/status).
 * By default it is **admin-only readable** — a non-admin, even with global `multitable:read`, must not read
 * the base, its sheets, or its records, and it must not appear in their listings. Per-row `visibility_scope`
 * inheritance is a separate, later slice.
 */

/** The system-owned base that holds every per-template-family approval projection sheet (T3-6 §5). */
export const APPROVAL_PROJECTION_BASE_ID = 'base_apr_projection'

/** True iff `baseId` is the approval projection system base. */
export function isApprovalProjectionBaseId(baseId: string | null | undefined): boolean {
  return baseId === APPROVAL_PROJECTION_BASE_ID
}

/**
 * Delimiter `deriveProjectionFieldId` uses to namespace a projection record's per-column data keys
 * by their OWN sheet id (the projection is one sheet per template family, so a bare column name
 * would collide across sheets sharing the base). Kept private — every reader that needs to
 * reconstruct the same key goes through `approvalProjectionParticipantPredicateSql` below, never by
 * re-spelling `'__'` at the call site.
 */
const PROJECTION_FIELD_ID_DELIMITER = '__'

/**
 * THE single derivation of a projection record's per-column data-key id, namespaced by the row's
 * OWN sheet id. Moved here (from `approval-record-projection-service.ts`, which re-exports it
 * unchanged for its existing importers) so this side-effect-free module can be the ONE place both
 * the WRITER (via that re-export) and every READER (via `approvalProjectionParticipantPredicateSql`)
 * derive the key from — they can no longer drift into reading a bare column name the writer never
 * stores under (the T36-1 review P1 defect this module now closes).
 */
export function deriveProjectionFieldId(sheetId: string, columnKey: string): string {
  return `${sheetId}${PROJECTION_FIELD_ID_DELIMITER}${columnKey}`
}

const REQUESTER_ID_COLUMN_KEY = 'requesterId'
const APPROVER_ID_COLUMN_KEY = 'approverId'

/**
 * THE single spelling of "does this approval-projection row identify `userId` as a PARTICIPANT"
 * (the row's own requester, or its terminal decider) — a SQL boolean-expression fragment, not a
 * JS predicate, because every caller needs it embedded in a query (a multi-sheet JOIN for the
 * listing carve-out, a single-sheet scan for the per-row deny arms, an EXISTS probe for the
 * Yjs/API-token capability choke) and re-deriving it per call site is exactly the drift this
 * function exists to close.
 *
 * Reads the SAME namespaced key `deriveProjectionFieldId` writes — derived IN SQL from
 * `sheetIdExpr` (the row's own `sheet_id`, since one projection BASE holds one sheet per template
 * family and each sheet's rows are namespaced by ITS OWN id, never a hardcoded literal) — so it can
 * never drift from what the writer actually stored, regardless of which sheet a row belongs to.
 *
 * `dataExpr` / `sheetIdExpr` are CALLER-SUPPLIED SQL identifiers or `$n` placeholders (e.g.
 * `'r.data'` + `'r.sheet_id'`, or `'data'` + `'$1'` when the sheet id is already a bound
 * parameter) — never raw user input — so the string interpolation here carries no injection risk;
 * `userIdParam` is likewise a `$n` placeholder the caller binds normally, never a literal value.
 *
 * Always COALESCE'd to `''`: a row missing a participant field yields SQL NULL, and in a bare
 * `NOT (a OR b)` deny-arm context `NOT (NULL OR NULL)` is NULL (three-valued logic), which a `WHERE`
 * clause treats as false — the corrupt row would silently escape a deny set (fail-OPEN). COALESCE
 * makes a missing field compare against `''`, which never equals a real (non-empty) `userIdParam`,
 * so corrupt rows are always excluded from a positive "is participant" match AND always included in
 * a `NOT(...)` deny set — fail-closed in both polarities the callers use this in.
 */
export function approvalProjectionParticipantPredicateSql(
  dataExpr: string,
  sheetIdExpr: string,
  userIdParam: string,
): string {
  const requesterKey = `${PROJECTION_FIELD_ID_DELIMITER}${REQUESTER_ID_COLUMN_KEY}`
  const approverKey = `${PROJECTION_FIELD_ID_DELIMITER}${APPROVER_ID_COLUMN_KEY}`
  return (
    `(COALESCE(${dataExpr}->>(${sheetIdExpr} || '${requesterKey}'), '') = ${userIdParam}`
    + ` OR COALESCE(${dataExpr}->>(${sheetIdExpr} || '${approverKey}'), '') = ${userIdParam})`
  )
}

/**
 * Admin-only capability fence: for a non-admin actor on a projection-base sheet, downgrade EVERY sensitive
 * `MultitableCapabilities` boolean to false — not just read. The projection base is a system read-model; a
 * non-admin (even with `multitable:write`/workflow perms) must get zero read/write/manage capability on it, or
 * write paths that gate on `canEditRecord`/`canDeleteRecord`/`canManageViews`/`canManageAutomation`/… would
 * still let them mutate it. Admins (and the system owner, admin-equivalent at the route layer) are unaffected.
 * Pure — the caller decides `isProjectionSheet` (via `loadApprovalProjectionSheetIds`) and `isAdminRole`.
 * Keyed by name so it only touches capability booleans that exist on the passed object.
 */
const PROJECTION_DENY_CAPABILITY_KEYS = [
  'canRead',
  'canExport',
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canManageViews',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
  'canSubmitApproval',
] as const

export function restrictApprovalProjectionCapabilities<T extends { canRead: boolean }>(
  capabilities: T,
  isProjectionSheet: boolean,
  isAdminRole: boolean,
): T {
  if (!isProjectionSheet || isAdminRole) return capabilities
  const denied: Record<string, unknown> = { ...capabilities }
  for (const key of PROJECTION_DENY_CAPABILITY_KEYS) {
    if (key in denied) denied[key] = false
  }
  return denied as T
}

/**
 * T36-1 (per-row visibility lock, RATIFIED Plan A): the read-plane capability keys a PARTICIPANT
 * (projection row carries their id as requesterId or approverId) keeps on a projection sheet.
 * Export stays read-parity (the W1-2 G-7 export⊆read differential holds because export rides the
 * same row-deny choke). Everything else — write / fields / views / comments / automation — stays
 * denied for every non-admin: the projection is a system-owned read model.
 */
const PROJECTION_PARTICIPANT_READ_KEYS = new Set(['canRead', 'canExport'])

/**
 * Participant-aware variant of the fence: admins unaffected; non-admin PARTICIPANTS keep the
 * read plane (rows are then narrowed to their own by the row-deny choke); non-admin
 * NON-participants get the original full fence (no drift from the ratified admin-only behavior —
 * they never learn the sheet exists). Pure — the caller decides participant status (via
 * `loadApprovalProjectionParticipantSheetIds`, fail-closed to non-participant on any error).
 */
export function restrictApprovalProjectionCapabilitiesPerRow<T extends { canRead: boolean }>(
  capabilities: T,
  isProjectionSheet: boolean,
  isAdminRole: boolean,
  isParticipant: boolean,
): T {
  if (!isProjectionSheet || isAdminRole) return capabilities
  const denied: Record<string, unknown> = { ...capabilities }
  for (const key of PROJECTION_DENY_CAPABILITY_KEYS) {
    if (key in denied) denied[key] = isParticipant && PROJECTION_PARTICIPANT_READ_KEYS.has(key) ? denied[key] : false
  }
  return denied as T
}
