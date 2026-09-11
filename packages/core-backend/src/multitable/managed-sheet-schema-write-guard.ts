/**
 * Managed-sheet SCHEMA-WRITE fence — a plugin-provisioned sheet's COLUMN SET is owned by the plugin
 * that provisioned it, not by whoever holds a write grant on the sheet.
 *
 * WHY THIS EXISTS. Sheet-scoped authority and SCHEMA authority are the same tier on an ordinary
 * sheet: `applyContextSheetSchemaWriteGrant` (permission-service.ts) lifts `canManageFields` to true
 * for any sheet grant with `scope.canRead && scope.canWrite`, and every schema route in
 * routes/univer-meta.ts gates on exactly that capability. For a sheet a plugin provisioned, that
 * equivalence is wrong in one direction that matters: the plugin re-runs `ensureObject` /
 * `ensureMissingObjectFields` on every install/upgrade with deterministic ids and
 * `ON CONFLICT (id) DO NOTHING` (multitable/provisioning.ts), and `meta_fields` carries no
 * `(sheet_id, name)` uniqueness. A hand-made column that merely SHARES A NAME with a template column
 * therefore does not collide with the template's row — the table ends up with two columns of the same
 * display name, one written by the plugin pipeline and one that no pipeline ever fills, with no error
 * anywhere. The person most likely to create it is the operator who legitimately writes DATA on that
 * sheet: the import flow offers "create the unmatched headers as columns", one click away from a
 * normal data import.
 *
 * WHAT THIS DOES. For a NON-admin actor on a sheet registered in `plugin_multitable_object_registry`,
 * `canManageFields` is forced to false. It is a pure narrowing of one capability bit — no other
 * capability is touched, so the DATA plane (create/edit/delete records, comment, export, views) is
 * exactly what it was. Applied in the capability layer rather than per-route, so every schema route
 * that already asks `capabilities.canManageFields` is covered by construction and no route file has
 * to be edited to add (or remember to add) a check.
 *
 * WHICH SIGNAL IS AUTHORITATIVE. `plugin_multitable_object_registry`, read through
 * `isPluginManagedSheet` (multitable/sheet-delete-guard.ts) — the SAME predicate the sheet-delete
 * refusal already uses, so "which sheets are managed" has one answer in this codebase, not two. That
 * module's docblock carries the full argument for why the registry row (server-minted inside the
 * provisioning transaction, never client-writable) is the trustworthy signal and why the sheet id
 * shape or a description marker is not.
 *
 * FAIL-CLOSED ON LOOKUP ERRORS. If the registry cannot be read, the sheet is treated as managed and
 * the non-admin loses `canManageFields` — the same direction the approval-projection participant
 * lookup takes (permission-service.ts, "fail-closed on lookup errors"). The cost of the closed
 * direction is a capability a non-admin temporarily does not have; the cost of the open direction is
 * an unreviewable schema write on a plugin-owned table. Stated plainly: on a database where the
 * registry table is absent entirely, non-admins hold no `canManageFields` on any sheet.
 *
 * ADMINS ARE NOT FENCED, matching `restrictApprovalProjectionCapabilitiesPerRow`'s admin exemption
 * (NOT `restrictElearningProjectionCapabilities`, which denies its write plane to admins too): an
 * admin repairing a managed table is the escape hatch this gate deliberately leaves open, and the
 * plugin's own provisioning path does not go through the capability layer at all.
 */
import { isPluginManagedSheet, type SheetDeleteGuardQueryFn } from './sheet-delete-guard'

export type ManagedSheetGuardQueryFn = SheetDeleteGuardQueryFn

/**
 * Is `sheetId` plugin-managed, answered FAIL-CLOSED: any lookup failure answers YES (managed), so a
 * broken/absent registry cannot open the schema plane. Never throws.
 */
export async function isPluginManagedSheetFailClosed(
  query: ManagedSheetGuardQueryFn,
  sheetId: string,
): Promise<boolean> {
  try {
    return await isPluginManagedSheet(query, sheetId)
  } catch {
    return true
  }
}

/**
 * Drop `canManageFields` for a non-admin on a plugin-managed sheet. Pure — the caller decides
 * managed status (via {@link isPluginManagedSheetFailClosed}), exactly as the approval/e-learning
 * projection restrictions take their predicate from the caller.
 */
export function restrictManagedSheetSchemaWriteCapabilities<T extends { canManageFields: boolean }>(
  capabilities: T,
  isManagedSheet: boolean,
  isAdminRole: boolean,
): T {
  if (!isManagedSheet || isAdminRole) return capabilities
  return { ...capabilities, canManageFields: false }
}
