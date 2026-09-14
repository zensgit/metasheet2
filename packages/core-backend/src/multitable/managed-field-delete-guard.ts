/**
 * Field-delete guard for columns on MANAGED sheets — the field-level twin of sheet-delete-guard.ts.
 *
 * WHY THIS EXISTS (incident, 2026-09-14). On a plugin-provisioned target table (a stock-preparation
 * sandbox object provisioned by plugin-integration-core) an operator with schema authority opened the
 * "manage fields" dialog and deleted five template columns. `DELETE /fields/:fieldId` answered 200,
 * `dropFieldCascade` stripped every record's value for those keys and recorded the drop as an
 * ordinary config revision. Nothing on the plugin side knew: the plugin's `ensureObject` /
 * `ensureMissingObjectFields` re-insert the SAME deterministic field id with
 * `ON CONFLICT (id) DO NOTHING` (multitable/provisioning.ts), so the next install/upgrade recreates
 * an EMPTY column under the old id and the pipeline's `fieldIdMap` keeps pointing at it — the values
 * are gone and there is no plugin-side record that they ever went. The SAME table's
 * `DELETE /sheets/:sheetId` was already refused with 409 by `resolveSheetDeleteRefusal`; the field
 * route had no counterpart. This module is that counterpart.
 *
 * WHAT THIS DOES. `resolveManagedFieldDeleteRefusal(query, sheetId)` answers YES when the field's
 * sheet is registered in `plugin_multitable_object_registry`, and the route refuses the delete with
 * a coded 409 (`MANAGED_FIELD_DELETE_REFUSED`) BEFORE any write: no fence plan, no advisory lock,
 * no tombstone capture, no config revision, no `DELETE FROM meta_fields`, no record-data strip.
 *
 * WHICH SIGNAL IS AUTHORITATIVE — the registry row, read through `isPluginManagedSheet`
 * (sheet-delete-guard.ts). It is deliberately the SAME predicate the sheet-level refusal uses, so
 * "which sheets are managed" has exactly one answer in this codebase. That module's docblock carries
 * the argument for why the server-minted registry row is trustworthy and why the sheet-id shape or a
 * description marker is not.
 *
 * WHY EVERY FIELD ON A MANAGED SHEET, NOT ONLY THE PROVISIONED ONES. The host cannot PROVE that a
 * given field was provisioned by the plugin:
 *   - `meta_fields` carries no source/plugin/managed column; `POST /fields` and provisioning write the
 *     identical six columns (migration zzzz20260404153000_repair_meta_core_schema).
 *   - The registry row is keyed by sheet and carries NO field-level data. The only host tables with a
 *     `plugin_` prefix are the object registry, the automation-rule registry, the field-POLICY registry
 *     (an RBAC visibility/editability table keyed by field NAME, which `PATCH /fields` lets a user
 *     rename, and holding only fields that declare a role policy) and plugin_kv. None is a manifest of
 *     provisioned field ids.
 *   - A provisioned id is `getObjectFieldId(projectId, objectId, logicalId)` = `fld_` + sha1 prefix.
 *     `projectId`/`objectId` ARE recoverable from the registry row, but the logical ids are not (sha1
 *     is one-way and nothing persists the descriptor), so the image set cannot be enumerated.
 *   - Gating on the id SHAPE (`/^fld_[0-9a-f]{24}$/`) is a sound NECESSARY condition — no provisioned
 *     field escapes it, and forging the shape through `POST /fields {id}` only makes one's own column
 *     undeletable (fail-closed direction). But it has a real hole: the stock-preparation target adapter
 *     lets an operator point `objectConfig.fieldIdMap` at ARBITRARY physical field ids, so a hand-made
 *     `fld_<uuid>` column on a managed table can be load-bearing for the pipeline and the shape test
 *     would still let it be deleted.
 * Refusing every field on a registered sheet closes that hole and is the spec's own stated fallback.
 * The cost, stated plainly: a column a user added themselves to a plugin-managed table is no longer
 * deletable through this route. That is consistent with the sheet itself already being undeletable
 * by the same registry row — a plugin-owned table is plugin-owned end to end — and any escape hatch
 * must be a separate owner-gated path, never a relaxation of this predicate.
 *
 * ORDERING. The route calls this AFTER `capabilities.canManageFields` (an actor without schema
 * authority gets 403 and never learns the table is plugin-managed — the same disclosure property the
 * sheet route pins) and BEFORE `prepareFieldLinkDropFencePlan` / the transaction, mirroring
 * `DELETE /sheets/:sheetId` exactly.
 *
 * LOOKUP ERRORS PROPAGATE (same as `resolveSheetDeleteRefusal`, NOT the swallow-and-answer-managed
 * of the capability-layer fence): a registry read failure surfaces through the route's catch as
 * 503 DB_NOT_READY / 500, and no write has happened — that is already fail-closed for a DELETE.
 * Silently answering "managed" on a missing registry table would make every column on every sheet
 * undeletable on a database where the migration has not run, a far larger blast radius.
 *
 * VALUES-FREE. The message names no plugin, project, object, sheet or field: the registry answers a
 * YES/NO question here, never "which plugin" (plugin-scope.ts `isSheetOwnedByProject` explains why
 * the owner is not returned across a boundary — `project_id` encodes the tenant).
 *
 * NOT applied to the plugin's own paths: `ensureObject` / `ensureMissingObjectFields` call
 * provisioning.ts directly with a query function and never traverse this router, and no plugin
 * deprovision path removes multitable fields at all (the only `DELETE FROM meta_fields` in src is the
 * shared `dropFieldCascade`, reached from this route and from the config-restore un-create branch).
 */
import { isPluginManagedSheet, type SheetDeleteGuardQueryFn } from './sheet-delete-guard'

export type ManagedFieldDeleteGuardQueryFn = SheetDeleteGuardQueryFn

export const MANAGED_FIELD_DELETE_REFUSED_CODE = 'MANAGED_FIELD_DELETE_REFUSED'

/** Values-free: names no plugin, project, object, sheet or field. */
export const MANAGED_FIELD_DELETE_REFUSED_MESSAGE =
  'This column belongs to a table that is provisioned and owned by a plugin and cannot be deleted from the UI or the field API. Deleting it would strip its values without any plugin-side record and the plugin would recreate it empty on its next provisioning run; change the plugin\'s configuration or use the plugin\'s own flow instead.'

/**
 * Must a delete of a field on `sheetId` be refused? YES iff the sheet is plugin-managed — one
 * registry read, delegated to the sheet-level predicate; no second source of truth. Lookup errors
 * propagate (see module doc).
 */
export async function resolveManagedFieldDeleteRefusal(
  query: ManagedFieldDeleteGuardQueryFn,
  sheetId: string,
): Promise<boolean> {
  return isPluginManagedSheet(query, sheetId)
}

export function managedFieldDeleteRefusalBody(): {
  ok: false
  error: { code: string; message: string }
} {
  return {
    ok: false,
    error: { code: MANAGED_FIELD_DELETE_REFUSED_CODE, message: MANAGED_FIELD_DELETE_REFUSED_MESSAGE },
  }
}
