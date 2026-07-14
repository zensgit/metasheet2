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
 * True iff the sheet is a system-regenerated read-model excluded from the user-history contiguity model.
 * Pure — the caller supplies the sheet's `baseId` + `description` (both nullable to tolerate legacy rows).
 */
export function isSystemSheet(sheet: { baseId?: string | null; description?: unknown }): boolean {
  return isApprovalProjectionBaseId(sheet.baseId ?? null) || isSystemPeopleSheetDescription(sheet.description)
}
