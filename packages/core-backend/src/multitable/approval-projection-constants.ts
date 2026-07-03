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
 * Read-guard: given resolved capabilities for a sheet that belongs to the projection base, downgrade every
 * read/export/write capability to false for a non-admin actor. Admins (and the system owner, which resolves
 * as admin-equivalent at the route layer) are unaffected. Pure — the caller decides `isProjectionSheet`
 * (via `loadApprovalProjectionSheetIds` or a base-id compare) and `isAdminRole`.
 */
export function restrictApprovalProjectionCapabilities<
  T extends { canRead: boolean; canExport?: boolean; canWrite?: boolean; canWriteOwn?: boolean; canManageSheetAccess?: boolean },
>(capabilities: T, isProjectionSheet: boolean, isAdminRole: boolean): T {
  if (!isProjectionSheet || isAdminRole) return capabilities
  return {
    ...capabilities,
    canRead: false,
    ...(capabilities.canExport !== undefined ? { canExport: false } : {}),
    ...(capabilities.canWrite !== undefined ? { canWrite: false } : {}),
    ...(capabilities.canWriteOwn !== undefined ? { canWriteOwn: false } : {}),
    ...(capabilities.canManageSheetAccess !== undefined ? { canManageSheetAccess: false } : {}),
  }
}
