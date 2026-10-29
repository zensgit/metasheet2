/**
 * 一个项目一张备料表 — STRUCTURE IS ADMIN-ONLY ON A REGISTERED PROJECT SHEET (owner option B, 2026-10-29;
 * register R-66 ②; ADR adr-stock-prep-project-sheets-20261008 §11.7, first known cost).
 *
 * WHAT IT GUARANTEES. On a REGISTERED stock-preparation project sheet every actor who is not a platform
 * administrator resolves `canManageFields = false` and `canManageViews = false` (view management: see ③ below) —
 * whatever the grants say:
 * the G1 floor role's `spreadsheet:write` row (which used to open field and view management on that one sheet,
 * permission-service.ts applyContextSheetSchemaWriteGrant), a sheet-level `spreadsheet:admin` grant, or a global
 * `multitable:manage-schema` code. EVERY other capability stays exactly as resolved: read, record create / edit /
 * delete (row deletion has its own rule), comments, notifications, export, access management, automations and
 * approval submit. Platform administrators (`isAdminRole`, the repository's single admin notion) are untouched.
 *
 * ③ VIEWS FOR 备料主管理员 (owner 2026-10-29, R78; register R-66 ③). One actor class keeps `canManageViews` AS
 * RESOLVED: a holder of `stock-prep:admin` ({@link STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE}; the role
 * template `stock-prep_admin` = 备料主管理员). The clamp does not take view management away from them; it never GIVES
 * it either — the bit is whatever the grants resolved (on a deployment whose G1 role list names `stock-prep_admin`,
 * the G1 `spreadsheet:write` row opens it through applyContextSheetSchemaWriteGrant; without a sheet grant or a
 * global `multitable:write` it stays false, exactly as on an ordinary sheet). `canManageFields` stays false for
 * them like for everyone else, and with it sheet rename, field permissions and the live re-seed.
 *
 * WHO COUNTS AS A HOLDER — two conditions, both required:
 *   1. the code is in the actor's EFFECTIVE codes, the namespace-admission-filtered list every resolver already
 *      holds (rbac/service.ts listUserPermissions → namespace-admission.ts filterPermissionCodesByNamespaceAdmission;
 *      the list the plugin's own `stock-prep:admin` gate reads): exact literal, no `stock-prep:*` / `*:*` wildcard
 *      (the plugin's satisfiesStockPrepAccess rule). An in-memory test, no statement;
 *   2. the code comes from one of the actor's ROLES ({@link STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL}).
 *      The admission filter alone would keep a DIRECT `user_permissions` row (or the legacy `users.permissions`
 *      column) once any role of the actor reaches the namespace; condition 2 refuses those. It is asked only when
 *      everything else already holds — a registered project sheet, a non-administrator, condition 1 true and a
 *      resolved `canManageViews` to keep — so an ordinary sheet, and every actor without the code, costs nothing.
 *      Errors propagate (fail the request), the lookup's posture.
 *
 * WHERE IT RUNS. Every host resolver that derives sheet capabilities for a person runs
 * {@link applyStockPreparationProjectSheetSchemaClamp}: REST `resolveSheetCapabilitiesForAccess`
 * (permission-service.ts; `/context` composes from it), `resolveSheetCapabilitiesForUser`
 * (sheet-capabilities.ts; the capability reads of collab rooms, the Yjs record bridge and API-token checks)
 * and the transaction-bound `resolveSheetCapabilitiesForUserOnQuery` (services/approval-record-link-txn-auth.ts).
 * The field / view / sheet-rename / field-permission / view-permission / form-share gates already read those two
 * bits. One route needed a change: `GET /view?seed=true` re-seeded a LIVE sheet (six fields, five demo records)
 * behind its canRead gate alone; a live re-seed now needs canManageFields && canCreateRecord (univer-meta.ts).
 * Base-level template routes read global capabilities, not these sheet ones, and are not covered here.
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
 * ③ (owner 2026-10-29, R78): the one code whose holder keeps view management on a project sheet — 备料主管理员
 * (role template `stock-prep_admin`, zzzz20261010124500_seed_stock_prep_role_templates.ts). Byte-equal to the
 * plugin's STOCK_PREP_ADMIN and the members port's STOCK_PREP_ADMIN_CODE (pinned by the unit suite).
 */
export const STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE = 'stock-prep:admin'

/**
 * ③ condition 2: does one of the actor's ROLES carry the code (`user_roles` → `role_permissions`)? A direct
 * `user_permissions` row and the legacy `users.permissions` column are not read. Exported so tests and fakes match
 * it exactly.
 */
export const STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL =
  `SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1 AND rp.permission_code = $2 LIMIT 1`

/**
 * Pure. ③ condition 1: does this EFFECTIVE (namespace-admission-filtered) code list carry the view-manager code?
 * Exact literal only; anything that is not an array of codes → false.
 */
export function holdsStockPreparationProjectSheetViewManagement(permissions: unknown): boolean {
  return Array.isArray(permissions) && permissions.includes(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE)
}

/** The actor the resolver is deciding for: its id and the effective code list it already holds. */
export type StockPreparationProjectSheetClampActor = {
  userId: string
  permissions: readonly string[]
}

/**
 * ③, both conditions. The role statement runs only when condition 1 holds and the actor has a non-blank id; the
 * caller asks only on a registered project sheet, for a non-administrator, with a resolved view bit to keep.
 */
async function keepsStockPreparationProjectSheetViewManagement(
  query: StockPreparationProjectSheetQueryFn,
  actor: StockPreparationProjectSheetClampActor,
): Promise<boolean> {
  if (!holdsStockPreparationProjectSheetViewManagement(actor?.permissions)) return false
  const userId = typeof actor?.userId === 'string' ? actor.userId.trim() : ''
  if (!userId) return false
  const result = await query(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL, [userId, STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE])
  return Array.isArray(result.rows) && result.rows.length > 0
}

/**
 * Pure. On a project sheet, for a non-administrator, force `canManageFields` false and `canManageViews` false —
 * except that a view manager (③) keeps `canManageViews` exactly as resolved (never raised) — and leave every other
 * key exactly as resolved. Otherwise return the input unchanged (same object).
 */
export function restrictStockPreparationProjectSheetSchemaCapabilities<
  T extends { canManageFields: boolean; canManageViews: boolean },
>(caps: T, isProjectSheet: boolean, isAdminRole: boolean, keepsViewManagement = false): T {
  if (!isProjectSheet || isAdminRole) return caps
  return { ...caps, canManageFields: false, canManageViews: keepsViewManagement === true ? caps.canManageViews : false }
}

/**
 * The resolvers' one call: look the sheet up (non-administrators only) and clamp. `actor` is the id and the
 * effective code list the resolver already holds (③). `clamped` is true only when the clamp acted (field
 * management is then always false; view management too unless ③ kept it) — the resolvers return it as the
 * `stockPrepProjectSheetSchemaClamped` marker.
 */
export async function applyStockPreparationProjectSheetSchemaClamp<
  T extends { canManageFields: boolean; canManageViews: boolean },
>(
  query: StockPreparationProjectSheetQueryFn,
  sheetId: string,
  capabilities: T,
  isAdminRole: boolean,
  actor: StockPreparationProjectSheetClampActor,
): Promise<{ capabilities: T; clamped: boolean }> {
  if (isAdminRole) return { capabilities, clamped: false }
  const isProjectSheet = (await loadStockPreparationProjectSheetIds(query, [sheetId])).has(sheetId)
  if (!isProjectSheet) return { capabilities, clamped: false }
  // ③: nothing to keep when the grants resolved no view management — no role statement then.
  const keepsViews = capabilities.canManageViews === true
    && (await keepsStockPreparationProjectSheetViewManagement(query, actor))
  return {
    capabilities: restrictStockPreparationProjectSheetSchemaCapabilities(capabilities, true, isAdminRole, keepsViews),
    clamped: true,
  }
}
