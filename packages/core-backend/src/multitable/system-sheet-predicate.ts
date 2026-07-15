import { isApprovalProjectionBaseId } from './approval-projection-constants'

/**
 * W0-1 (owner §6.1) — the ONE `isSystemSheet` predicate. System-regenerated read-models are excluded from
 * the user-history contiguity model as a SINGLE predicate, not scattered per-site exemptions:
 *
 *   isSystemSheet(sheet) = isApprovalProjectionBaseId(base_id) || isSystemPeopleSheetDescription(description)
 *
 * The approval-projection base and the system People directory sheet are both server-regenerated read
 * models (approval reprojection / people-directory sync). They legitimately carry NON-contiguous version
 * history — a reprojection can rewrite a row's `data` and bump `version` without a user-authored revision —
 * so the generation-aware contiguity precheck MUST NOT read that as a hole and refuse. They are not part of
 * the user's Time-Machine history model, so the precheck skips contiguity for them entirely.
 *
 * `SYSTEM_PEOPLE_SHEET_DESCRIPTION` + `isSystemPeopleSheetDescription` live HERE (the single source of
 * truth); `routes/univer-meta.ts` re-imports them so both the People-sheet list-filtering and this
 * history-exclusion key off the exact same sentinel.
 */

/** The sentinel `description` the system People directory sheet carries (system read-model). */
export const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'

/** True iff `description` marks the system People directory sheet. */
export function isSystemPeopleSheetDescription(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SYSTEM_PEOPLE_SHEET_DESCRIPTION
}

/**
 * W0-1 v3.7 §3/§8 — the server-owned `meta_sheets.system_kind` values. This column is set ONLY by internal
 * provisioning (never by a client create/update request), so it is the NON-FORGEABLE system-sheet signal that
 * hardens the historically user-writable `description` sentinel. `isSystemSheet` treats a recognized
 * `system_kind` as authoritative.
 */
export const SYSTEM_SHEET_KINDS = ['people_directory', 'approval_projection'] as const

/** True iff `value` is a recognized server-owned system-sheet kind (non-forgeable). */
export function isSystemSheetKind(value: unknown): boolean {
  return typeof value === 'string' && (SYSTEM_SHEET_KINDS as readonly string[]).includes(value)
}

/**
 * True iff the sheet is a system-regenerated read-model excluded from the user-history contiguity model.
 * Pure — the caller supplies the sheet's `systemKind` (the server-owned, non-forgeable signal — v3.7 §3),
 * plus `baseId` + `description` (retained: `baseId` is server-assigned and non-forgeable; the `description`
 * sentinel is the LEGACY fallback for rows provisioned before `system_kind` existed and not yet backfilled).
 * Once `system_kind` is universally set by provisioning + backfill, L4 hardening may drop the `description`
 * fallback entirely; it is kept here so this additive change regresses nothing.
 */
export function isSystemSheet(sheet: { baseId?: string | null; description?: unknown; systemKind?: unknown }): boolean {
  return (
    isSystemSheetKind(sheet.systemKind) ||
    isApprovalProjectionBaseId(sheet.baseId ?? null) ||
    isSystemPeopleSheetDescription(sheet.description)
  )
}
