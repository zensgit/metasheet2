import { isApprovalProjectionBaseId } from './approval-projection-constants'

/**
 * W0-1 (corrected) §3 Class B — the system-owned people-directory sheet's `description` marker. Moved
 * here from `routes/univer-meta.ts` (it was a private module-level const there) so the generation-aware
 * contiguity check (`history-integrity-precheck.ts`) can share the EXACT SAME predicate `univer-meta.ts`
 * already uses for the people-sheet, without a circular import — `univer-meta.ts` already imports FROM
 * `history-integrity-precheck.ts` (`precheckSheetHistoryIntegrity`), so a reverse import would cycle.
 * This module has zero side effects and zero imports from either of those two, so both can depend on it.
 */
export const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'

/** True iff `value` is the people-directory system sheet's `description` marker. */
export function isSystemPeopleSheetDescription(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SYSTEM_PEOPLE_SHEET_DESCRIPTION
}

/**
 * W0-1 §3 Class B — the unified system-sheet predicate: a sheet is "system" (structurally excluded from
 * strict history contiguity — design-lock §2/§3 — BEFORE any contiguity assertion) iff it is the
 * approval-projection base's sheet OR the people-directory sync sheet. Both are trusted,
 * regenerable/derived surfaces whose existing (OD-6-classified `revision-exempt`) writers bump
 * `meta_records.version` with NO matching `meta_record_revisions` row BY DESIGN
 * (`approval-record-projection-service.ts` `version = meta_records.version + 1` ON CONFLICT;
 * `routes/univer-meta.ts` people-sync INSERT/UPDATE) — never a user-content edit that generation-aware
 * contiguity reasoning should apply to. Excluding them keeps the strict check from false-refusing a
 * healthy system sheet on every sync cycle.
 */
export function isSystemSheet(sheet: { baseId?: string | null; description?: unknown }): boolean {
  return isApprovalProjectionBaseId(sheet.baseId ?? null) || isSystemPeopleSheetDescription(sheet.description)
}
