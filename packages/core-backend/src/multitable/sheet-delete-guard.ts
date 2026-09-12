/**
 * Sheet-delete guard for MANAGED sheets — sheets whose existence is owned by something other than
 * the user who is asking to delete them.
 *
 * WHY THIS EXISTS. `DELETE /sheets/:sheetId` soft-deletes (`deleted_at = now()`). Plugin-provisioned
 * sheets are created by `provisioning.ensureObject` with a DETERMINISTIC id
 * (`getObjectSheetId(projectId, objectId)`, provisioning.ts) through
 * `INSERT ... ON CONFLICT (id) DO NOTHING` and are read back with `deleted_at IS NULL`
 * (`loadActiveSheet`). A soft-deleted row therefore still OWNS the id: the next `ensure` inserts
 * nothing, reads back null and throws `Failed to ensure sheet` — the plugin (stock-preparation
 * target, after-sales objects, staging tables) is broken until someone calls the restore endpoint,
 * which has no UI. So a UI/API delete of a managed sheet is not "hide a table", it is "break the
 * plugin permanently". This guard refuses it with a coded 409 BEFORE the write.
 *
 * WHICH SIGNAL IS AUTHORITATIVE — `plugin_multitable_object_registry` (a row keyed by `sheet_id`):
 *   - It is written by EVERY plugin `ensureObject`: the host installs `ensureObjectInScope` for every
 *     plugin-scoped multitable API (index.ts, "this hook is the shipped host path for every plugin
 *     ensureObject"), and that hook calls `claimPluginObjectScope` right after the sheet is ensured.
 *     The three known provisioning chains (plugin-integration-core stock-preparation target +
 *     staging installer, plugin-after-sales installer) all go through
 *     `context.api.multitable.provisioning.ensureObject`, i.e. through that hook.
 *   - Pre-registry after-sales installs were backfilled (migration
 *     zzzz20260408160000_backfill_after_sales_plugin_multitable_object_registry).
 *   - It is server-owned: no client request can write it (`POST /sheets` accepts a caller-supplied
 *     `id` and a free-form `description`, so NEITHER the deterministic id shape nor a description
 *     marker is a trustworthy signal — a caller could forge or collide with both; the registry row
 *     is minted only inside the provisioning transaction).
 *   - It is the same table `isSheetOwnedByProject` / `assertPluginOwnsSheet` (plugin-scope.ts) already
 *     treat as the ONE record of "which plugin owns this sheet".
 *
 * SYSTEM sheets are refused on the same path: `meta_sheets.system_kind` is the server-owned,
 * non-forgeable system-sheet signal (system-sheet-predicate.ts), and the People directory sheet
 * additionally carries the `__metasheet_system:people__` description sentinel (older People sheets
 * predate `system_kind` and have no backfill — see the predicate module doc). Reading the sentinel
 * HERE is safe in the direction that matters: it can only make a sheet UNDELETABLE (fail-closed), it
 * never grants anything, so it does not re-enter the trust predicate the P1-a hardening protects.
 *
 * NOT applied to `POST /sheets/:sheetId/restore`: restoring a managed sheet is precisely what repairs
 * the broken state this guard prevents.
 */
import { isSystemPeopleSheetDescription, isSystemSheetKind } from './system-sheet-predicate'

export type SheetDeleteGuardQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>

export type SheetDeleteRefusal = 'plugin-managed' | 'system-managed'

export const SHEET_PLUGIN_MANAGED_CODE = 'SHEET_PLUGIN_MANAGED'
export const SHEET_SYSTEM_MANAGED_CODE = 'SHEET_SYSTEM_MANAGED'

/** Values-free: names no project, plugin or sheet. */
export const SHEET_PLUGIN_MANAGED_MESSAGE =
  'This sheet is provisioned and owned by a plugin and cannot be deleted from the UI or the sheet API. Deleting it would break the plugin\'s provisioning permanently; uninstall or reconfigure the plugin instead.'

export const SHEET_SYSTEM_MANAGED_MESSAGE =
  'This sheet is a system-managed read model and cannot be deleted.'

/**
 * Is `sheetId` registered to a plugin in `plugin_multitable_object_registry`? A YES/NO question —
 * never "which plugin" (see plugin-scope.ts `isSheetOwnedByProject` for why the owner is not
 * returned across a boundary).
 */
export async function isPluginManagedSheet(
  query: SheetDeleteGuardQueryFn,
  sheetId: string,
): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM plugin_multitable_object_registry
     WHERE sheet_id = $1
     LIMIT 1`,
    [sheetId],
  )
  return result.rows.length > 0
}

/**
 * Is `sheetId` a system-managed sheet (server-owned `system_kind`, or the People directory sentinel)?
 * Only ever used to REFUSE a delete — never as a trust/exclusion signal.
 */
export async function isSystemManagedSheet(
  query: SheetDeleteGuardQueryFn,
  sheetId: string,
): Promise<boolean> {
  const result = await query(
    'SELECT system_kind, description FROM meta_sheets WHERE id = $1',
    [sheetId],
  )
  const row = result.rows[0] as { system_kind?: unknown; description?: unknown } | undefined
  if (!row) return false
  return isSystemSheetKind(row.system_kind) || isSystemPeopleSheetDescription(row.description)
}

/**
 * Why a delete of `sheetId` must be refused, or `null` when it may proceed. Plugin ownership is
 * checked first: it is the case with the irreversible failure mode.
 */
export async function resolveSheetDeleteRefusal(
  query: SheetDeleteGuardQueryFn,
  sheetId: string,
): Promise<SheetDeleteRefusal | null> {
  if (await isPluginManagedSheet(query, sheetId)) return 'plugin-managed'
  if (await isSystemManagedSheet(query, sheetId)) return 'system-managed'
  return null
}

export function sheetDeleteRefusalBody(refusal: SheetDeleteRefusal): {
  ok: false
  error: { code: string; message: string }
} {
  return refusal === 'plugin-managed'
    ? { ok: false, error: { code: SHEET_PLUGIN_MANAGED_CODE, message: SHEET_PLUGIN_MANAGED_MESSAGE } }
    : { ok: false, error: { code: SHEET_SYSTEM_MANAGED_CODE, message: SHEET_SYSTEM_MANAGED_MESSAGE } }
}
