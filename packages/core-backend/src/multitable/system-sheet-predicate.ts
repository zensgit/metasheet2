/**
 * W0-1 (owner §6.1, hardened by v3.7 §3/§8 + the L5 P1-a correction) — the ONE `isSystemSheet` predicate.
 * System-regenerated read-models are excluded from the user-history contiguity model as a SINGLE predicate,
 * not scattered per-site exemptions.
 *
 * TRUST SIGNAL — `system_kind` ONLY (P1-a fix). The historically-trusted `description` sentinel and the
 * `base_id` disjunct were USER/REQUEST-influenceable: `POST /sheets` accepts a free-form `description`, so an
 * ordinary sheet could carry the People sentinel and be misclassified as a system sheet — excluding itself
 * from the strict/contiguity trust checks. The trust predicate now keys SOLELY off `meta_sheets.system_kind`,
 * a server-owned column set only by internal provisioning (never by a client create/update request) and
 * one-time-backfilled by the L5 migration for every pre-existing system sheet. It is the NON-FORGEABLE signal.
 *
 * `SYSTEM_PEOPLE_SHEET_DESCRIPTION` + `isSystemPeopleSheetDescription` still live HERE (single source of
 * truth) and remain exported for the People-sheet LIST-FILTERING display concern in `routes/univer-meta.ts`
 * (`filterVisibleSheetRows`) — that is a cosmetic "hide the system People sheet from a user's sheet list"
 * filter, NOT a trust boundary, so it may key off the description. The description must NEVER re-enter the
 * TRUST predicate (`isSystemSheet`) — the golden `system-identity is not forgeable` in
 * `multitable-history-trust-checkpoint-realdb.test.ts` reds if it does.
 */

/** The sentinel `description` the system People directory sheet carries (system read-model). DISPLAY/list
 *  filtering ONLY — NOT a trust signal (see the module doc comment; P1-a). */
export const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'

/** True iff `description` marks the system People directory sheet — used ONLY by list-filtering display, never
 *  by the trust predicate (`isSystemSheet`). A `description` is user-writable via `POST /sheets` (P1-a). */
export function isSystemPeopleSheetDescription(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SYSTEM_PEOPLE_SHEET_DESCRIPTION
}

/**
 * W0-1 v3.7 §3/§8 — the server-owned `meta_sheets.system_kind` values. This column is set ONLY by internal
 * provisioning (People-sheet preset + approval-projection `ensureFamilySheet`) and the L5 migration backfill,
 * NEVER by a client create/update request, so it is the NON-FORGEABLE system-sheet signal. `isSystemSheet`
 * treats a recognized `system_kind` as the ONLY authoritative trust signal.
 */
export const SYSTEM_SHEET_KINDS = ['people_directory', 'approval_projection'] as const

/** True iff `value` is a recognized server-owned system-sheet kind (non-forgeable). */
export function isSystemSheetKind(value: unknown): boolean {
  return typeof value === 'string' && (SYSTEM_SHEET_KINDS as readonly string[]).includes(value)
}

/**
 * True iff the sheet is a system-regenerated read-model excluded from the user-history contiguity model.
 * Pure — the caller supplies the sheet's `systemKind` (the server-owned, non-forgeable signal — v3.7 §3).
 *
 * P1-a: this is a TRUST boundary, so it keys SOLELY off `systemKind`. It intentionally does NOT read
 * `description` or `baseId` — both are reachable by a client create request and were the forgeable bypass. A
 * legitimate system sheet ALWAYS carries `system_kind` (provisioning sets it; the L5 migration backfilled
 * every pre-existing one). A sheet without a recognized `system_kind` is a user sheet and IS strict-checked.
 */
export function isSystemSheet(sheet: { systemKind?: unknown }): boolean {
  return isSystemSheetKind(sheet.systemKind)
}
