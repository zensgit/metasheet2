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
