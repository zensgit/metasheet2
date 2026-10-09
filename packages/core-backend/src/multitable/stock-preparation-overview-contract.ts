/**
 * 一个项目一张备料表 — S3 项目总览表, THE HOST HALF (ADR adr-stock-prep-project-sheets-20261008 §5
 * 「只读（Q5）」; owner ruling Q5 2026-10-08: 宿主级只读 + O1 + O2(a)).
 *
 * WHAT THE HOST GUARANTEES. The overview is ONE plugin-maintained sheet that summarizes every project
 * sheet of a tenant. People must be able to SEE it (it stays listed and readable for whoever the sheet
 * grants already let read it) and EXPORT it, but nobody — administrators included — may change it
 * through the ordinary multitable surface. Only the plugin's own records path writes it. Three parts:
 *
 *   1. A server-owned `meta_sheets.system_kind` stamp (`stock_prep_overview`, `system-sheet-predicate.ts`).
 *      Stamped by host provisioning at INSERT and only there (never an UPDATE of an existing row: the P1-a
 *      no-laundering rule), and only when the plugin-scope wrapper admitted the EXACT triple
 *      (plugin `plugin-integration-core`, this kind, the overview object id). Every other caller that
 *      names a `systemKind` is refused with `StockPreparationOverviewSystemKindError` before any IO.
 *      Being a recognized system kind also makes the sheet undeletable (`sheet-delete-guard.ts`) and
 *      refuses it as a copy source / retype target (`isSystemManagedSheet`), with no extra code.
 *   2. A capability clamp, `restrictStockPreparationOverviewCapabilities`, applied by EVERY host resolver
 *      that derives sheet capabilities for a person (REST `resolveSheetCapabilitiesForAccess`, the
 *      Yjs/collab/api-token `resolveSheetCapabilitiesForUser`, and the transaction-bound
 *      `resolveSheetCapabilitiesForUserOnQuery`). It keeps `canRead` and `canExport` EXACTLY as the
 *      grants resolved them and forces every other `can*` capability to false. It takes no admin
 *      parameter on purpose: the ADR says 「对所有人生效，含管理员」, so a caller cannot skip admins.
 *   3. `loadStockPreparationOverviewSheetIds`, the one lookup those resolvers use to decide (1) applies.
 *      Column-tolerant (`to_jsonb(meta_sheets) ->> 'system_kind'`), so a database without the column
 *      answers "not an overview" instead of 42703.
 *
 * WHAT IT DOES NOT DO. It does not hide the sheet, does not narrow who may READ it, and does not touch
 * the plugin SDK records path (`createPluginScopedMultitableApi` → `records.*`), which is a plugin write,
 * not a person's capability, and is how the plugin keeps the overview current.
 *
 * No heavy imports: this module must be requirable from the scope wrapper, provisioning and the three
 * capability resolvers without a load cycle.
 */
import { STOCK_PREP_OVERVIEW_SHEET_KIND } from './system-sheet-predicate'

/** The plugin's logical object id for the overview sheet (the sheet id is derived from it per project). */
export const STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID = 'plm_stock_preparation_project_overview'

/** The server-owned `meta_sheets.system_kind` the host stamps on the overview sheet. */
export const STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND = STOCK_PREP_OVERVIEW_SHEET_KIND

/** The ONE plugin whose scoped `ensureObject` may ask for the overview stamp (same posture as the G1 port). */
export const STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN = 'plugin-integration-core'

/** The capabilities the clamp leaves exactly as resolved. Everything else that starts with `can` → false. */
const OVERVIEW_KEPT_CAPABILITY_KEYS: ReadonlySet<string> = new Set(['canRead', 'canExport'])

/**
 * Pure. On an overview sheet keep `canRead` / `canExport` as they are and force EVERY other `can*` key of
 * the object to false — keyed by prefix, not by a list, so a capability added to `MultitableCapabilities`
 * later is denied here by default instead of silently passing through. Off an overview sheet the input is
 * returned unchanged (same object).
 */
export function restrictStockPreparationOverviewCapabilities<T extends { canRead: boolean; canExport: boolean }>(
  caps: T,
  isOverviewSheet: boolean,
): T {
  if (!isOverviewSheet) return caps
  const restricted: Record<string, unknown> = { ...caps }
  for (const key of Object.keys(restricted)) {
    if (key.startsWith('can') && !OVERVIEW_KEPT_CAPABILITY_KEYS.has(key)) restricted[key] = false
  }
  return restricted as T
}

export type StockPreparationOverviewQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * Of the given sheet ids, which carry the overview stamp. Empty input → empty set, no query. No
 * `deleted_at` filter on purpose (the approval-projection fence's posture): a soft-deleted overview is
 * still clamped, which can only refuse more.
 */
export async function loadStockPreparationOverviewSheetIds(
  query: StockPreparationOverviewQueryFn,
  sheetIds: string[],
): Promise<Set<string>> {
  if (!Array.isArray(sheetIds) || sheetIds.length === 0) return new Set()
  const result = await query(
    `SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2`,
    [sheetIds, STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND],
  )
  const ids = new Set<string>()
  for (const row of result.rows as Array<{ id?: unknown }>) {
    if (typeof row?.id === 'string') ids.add(row.id)
  }
  return ids
}

/**
 * The scope wrapper's refusal when a plugin asks `ensureObject` for a `systemKind` it may not stamp.
 * Values-free details: only which of the three conditions failed.
 */
export class StockPreparationOverviewSystemKindError extends Error {
  readonly status = 403
  readonly code = 'MULTITABLE_SYSTEM_KIND_FORBIDDEN'
  readonly details: { reason: 'plugin' | 'kind' | 'object' }

  constructor(reason: 'plugin' | 'kind' | 'object') {
    super('This caller may not stamp a system kind on a provisioned sheet')
    this.name = 'StockPreparationOverviewSystemKindError'
    this.details = { reason }
  }
}
