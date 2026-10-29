/**
 * 一个项目一张备料表 — STRUCTURE IS ADMIN-ONLY ON A REGISTERED PROJECT SHEET (owner option B, 2026-10-29;
 * register R-66 ②; ADR adr-stock-prep-project-sheets-20261008 §11.7, first known cost).
 *
 * WHAT IT GUARANTEES. On a REGISTERED stock-preparation project sheet every actor who is not a platform
 * administrator resolves `canManageFields = false` and `canManageViews = false` — whatever the grants say:
 * the G1 floor role's `spreadsheet:write` row (which used to open field and view management on that one sheet,
 * permission-service.ts applyContextSheetSchemaWriteGrant), a sheet-level `spreadsheet:admin` grant, or a global
 * `multitable:manage-schema` code. EVERY other capability stays exactly as resolved: read, record create / edit /
 * delete (row deletion has its own rule), comments, notifications, export, access management, automations and
 * approval submit. Platform administrators (`isAdminRole`, the repository's single admin notion) are untouched.
 *
 * WHERE IT RUNS. Every host resolver that derives sheet capabilities for a person runs
 * {@link applyStockPreparationProjectSheetSchemaClamp}: REST `resolveSheetCapabilitiesForAccess`
 * (permission-service.ts; `/context` composes from it), the Yjs / collab / API-token
 * `resolveSheetCapabilitiesForUser` (sheet-capabilities.ts) and the transaction-bound
 * `resolveSheetCapabilitiesForUserOnQuery` (services/approval-record-link-txn-auth.ts). The routes need no
 * change: every field / view / sheet-rename / field-permission / view-permission / form-share / save-as-template
 * gate already reads those two bits.
 *
 * WHAT IS A REGISTERED PROJECT SHEET. A `plugin_multitable_object_registry` row (server-owned, minted only inside
 * the provisioning transaction — sheet-delete-guard.ts) whose `plugin_name` is `plugin-integration-core` and whose
 * `object_id` matches the project-sheet shape of the G1 grant contract
 * (`STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN`, `plm_stock_preparation_sandbox_p_<24 hex>`). The canonical
 * main table, the overview and every other plugin's sheet do not match and are untouched.
 *
 * WHAT IT DOES NOT TOUCH. The plugin's own structure writes (ensureObject / ensureMissingObjectFields /
 * patchObjectFieldProperty / ensureView through plugin-scope.ts → provisioning.ts) never consult a person's
 * capabilities, so provisioning and repair keep working; the G1 port keeps writing `spreadsheet:write` rows.
 *
 * THE LOOKUP ({@link loadStockPreparationProjectSheetIds}):
 *   - ID-PREFILTERED: a project sheet is plugin-provisioned, so its id is always the host-derived
 *     `sheet_` + 24 lowercase hex (stock-preparation-overview-contract.ts `isStockPreparationOverviewSheetIdCandidate`);
 *     an id outside that shape issues NO statement;
 *   - asked for non-administrators only (an administrator is never clamped, so the answer could not matter);
 *   - errors PROPAGATE (fail the request), the posture of the overview / closure stamps lookup.
 *
 * No heavy imports: required by the three capability resolvers.
 */
import {
  STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN,
  isStockPreparationOverviewSheetIdCandidate,
} from './stock-preparation-overview-contract'
import { isStockPreparationProjectSheetObjectId } from './stock-preparation-project-sheet-grant-contract'

/** The plugin whose registry rows can name a project sheet (the G1 port's plugin). */
export const STOCK_PREPARATION_PROJECT_SHEET_PLUGIN = STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN

/** The lookup statement, exported so tests and fakes match it exactly. */
export const STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL =
  `SELECT sheet_id, object_id FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[]) AND plugin_name = $2`

export type StockPreparationProjectSheetQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Of the given sheet ids, which are registered stock-preparation project sheets. Ids outside the derived-id shape
 * are dropped BEFORE the statement; no candidate left → empty set, no query. The object-id shape is checked in
 * memory against the one pattern definition (grant contract).
 */
export async function loadStockPreparationProjectSheetIds(
  query: StockPreparationProjectSheetQueryFn,
  sheetIds: readonly unknown[],
): Promise<Set<string>> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) return new Set()
  const candidates = [...new Set(sheetIds.filter(isStockPreparationOverviewSheetIdCandidate))]
  if (candidates.length === 0) return new Set()
  const result = await query(STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL, [candidates, STOCK_PREPARATION_PROJECT_SHEET_PLUGIN])
  const ids = new Set<string>()
  for (const row of result.rows as Array<{ sheet_id?: unknown; object_id?: unknown }>) {
    if (typeof row?.sheet_id === 'string' && candidates.includes(row.sheet_id) && isStockPreparationProjectSheetObjectId(row.object_id)) {
      ids.add(row.sheet_id)
    }
  }
  return ids
}

/**
 * Pure. On a project sheet, for a non-administrator, force `canManageFields` and `canManageViews` false and leave
 * every other key exactly as resolved. Otherwise return the input unchanged (same object).
 */
export function restrictStockPreparationProjectSheetSchemaCapabilities<
  T extends { canManageFields: boolean; canManageViews: boolean },
>(caps: T, isProjectSheet: boolean, isAdminRole: boolean): T {
  if (!isProjectSheet || isAdminRole) return caps
  return { ...caps, canManageFields: false, canManageViews: false }
}

/**
 * The resolvers' one call: look the sheet up (non-administrators only) and clamp. `clamped` is true only when the
 * clamp acted — the resolvers return it as the `stockPrepProjectSheetSchemaClamped` marker.
 */
export async function applyStockPreparationProjectSheetSchemaClamp<
  T extends { canManageFields: boolean; canManageViews: boolean },
>(
  query: StockPreparationProjectSheetQueryFn,
  sheetId: string,
  capabilities: T,
  isAdminRole: boolean,
): Promise<{ capabilities: T; clamped: boolean }> {
  if (isAdminRole) return { capabilities, clamped: false }
  const isProjectSheet = (await loadStockPreparationProjectSheetIds(query, [sheetId])).has(sheetId)
  if (!isProjectSheet) return { capabilities, clamped: false }
  return {
    capabilities: restrictStockPreparationProjectSheetSchemaCapabilities(capabilities, true, isAdminRole),
    clamped: true,
  }
}
