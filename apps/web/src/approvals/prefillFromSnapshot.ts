import type { FormFieldType, FormSchema } from '../types/approval'

/**
 * Floating civil (date-only) calendar validation — strict `YYYY-MM-DD` with real leap-year
 * rules, checked lexically (never via `Date`/`Date.parse`, which define INSTANT semantics and
 * can shift the calendar day across timezones). Mirrors the backend contract
 * (`packages/core-backend/src/utils/calendar-date.ts`); duplicated locally because the web app
 * does not import backend sources.
 */
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

function isValidIsoCalendarDate(value: string): boolean {
  if (!ISO_CALENDAR_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}

/**
 * Runtime shape check for "does this stored snapshot value still fit the CURRENT field's declared
 * type" — the sole "compatible type" gate `prefillFromSnapshot` (below) relies on. `attachment` is
 * always incompatible (B2-28 stopgap — no working uploader yet, nothing legitimate to prefill);
 * `detail`/`multi-select` require an array (the row-array / multi-value shape); `date` requires a
 * strict real-calendar `YYYY-MM-DD` string (a floating civil date — a datetime or otherwise
 * invalid stored value must NOT repopulate a date input); `datetime` keeps instant semantics and
 * requires a value `Date` can actually parse; everything else requires the exact JS primitive type
 * the corresponding fill-view widget binds via `v-model`. `null`/`undefined` are never compatible —
 * there is nothing to prefill for an unset value; the field just keeps whatever `ApprovalNewView`'s
 * own default-seeding already gave it.
 */
function isCompatibleValue(type: FormFieldType, value: unknown): boolean {
  if (value === null || value === undefined) return false
  switch (type) {
    case 'attachment':
      return false
    case 'text':
    case 'textarea':
    case 'user':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'date':
      // Floating civil date only: a strict real-calendar `YYYY-MM-DD` string. A datetime or
      // epoch value stored by an older schema must NOT repopulate a date input.
      return typeof value === 'string' && isValidIsoCalendarDate(value)
    case 'datetime':
      // Instant semantics (unchanged): any Date-parseable string/number.
      if (typeof value !== 'string' && typeof value !== 'number') return false
      return !Number.isNaN(new Date(value).getTime())
    case 'select':
      return typeof value === 'string' || typeof value === 'number'
    case 'multi-select':
      return Array.isArray(value)
    case 'detail':
      return Array.isArray(value)
    case 'record-link':
      // FWB-0 Layer 2 fail-closed: resubmit snapshots carry only `{ recordId }` and no pin
      // metadata. Without a proven identical baseId+sheetId on the prior instance we cannot
      // know the value still targets the CURRENT field's pin — so never prefill record-link.
      return false
    default:
      return false
  }
}

/**
 * UX B2-13 (再次提交) — drift-safe prefill for a FRESH `ApprovalNewView` draft, seeded from a
 * REJECTED/REVOKED/CANCELLED instance's `formSnapshot` (the requester's own prior submission; see
 * `ApprovalDetailView`'s 「再次提交」button). The reject→fix→resubmit loop is the requester's
 * biggest-friction moment today — they hand-retype the whole form — so this prefills whatever of
 * the old answer still safely applies.
 *
 * Deliberately takes only the CURRENT template's `formSchema` (never the source instance's own
 * possibly-frozen one) plus the raw snapshot values — the source's original field TYPES are not
 * needed: "compatible type" is decided by checking whether the stored raw value's runtime SHAPE
 * still fits what the CURRENT field declares (`isCompatibleValue` above). A field the author
 * DROPPED since the original submission is skipped for free (this only ever looks up ids that
 * exist in the CURRENT schema); a field the author RETYPED (e.g. select → number) is caught
 * because the old stored value's shape no longer matches the new type's expectation. Either way:
 * no crash, no bad value ever lands in the fresh draft's `formData`.
 *
 * `attachment` fields are ALWAYS skipped — B2-28 disabled attachment authoring entirely, so there
 * is nothing legitimate to prefill there regardless of the stored value.
 *
 * `record-link` fields are ALWAYS skipped on resubmit prefill (FWB-0 Layer 2). Snapshots freeze
 * only `{ recordId }` and never the field's baseId/sheetId pin; if the author repinned the field
 * (or we simply cannot prove pin identity from existing snapshot data) reusing the old recordId
 * would target the wrong sheet. Fail closed: omit and let the filler re-pick.
 *
 * `detail` (子表/明细) fields prefill their WHOLE row array verbatim when the field still exists as
 * `type: 'detail'` and the stored value is an array — per-row/per-column drift is already handled
 * downstream for free by the existing submit-time pruning (`pruneHiddenFormDataWithDetail` /
 * `pruneHiddenDetailRow` in `detailField.ts`, driven by the CURRENT `columns`), so this does not
 * duplicate that column-level filtering here.
 *
 * Pure — no Vue/Element Plus dependency, no reads of `route`/stores — so the caller merges the
 * result into its own reactive `formData` (e.g. `Object.assign(formData, prefillFromSnapshot(...))`).
 * Returns `{}` when `snapshot` is missing/empty/not-an-object, or when the schema has no fields —
 * the caller can treat an empty result as "nothing to prefill, no notice to show".
 */
export function prefillFromSnapshot(
  formSchema: FormSchema,
  snapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!snapshot || typeof snapshot !== 'object') return result
  const fields = formSchema?.fields
  if (!Array.isArray(fields)) return result

  for (const field of fields) {
    // Not in the snapshot at all — either the original submission left it unset, or (irrelevant
    // here either way) it never existed back then. Nothing to carry over.
    if (!Object.prototype.hasOwnProperty.call(snapshot, field.id)) continue
    const value = snapshot[field.id]
    // Dropped-from-current-schema fields never reach this loop at all (it only iterates the
    // CURRENT schema's fields); a RETYPED field is caught here instead, by shape.
    if (!isCompatibleValue(field.type, value)) continue
    result[field.id] = value
  }
  return result
}
