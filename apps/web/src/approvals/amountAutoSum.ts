import type { FormField, FormSchema, AmountConsistencyMapping } from '../types/approval'

// FE MIRROR of packages/core-backend/src/services/amount-total-check.ts (validateAmountTotalConsistency)
// — design-lock approval-detail-autosum-design-lock-20260624 (#3189), Decisions 4–6.
//
// apps/web imports nothing from packages/core-backend (no shared boundary), so the backend's scaled-int
// algorithm is DUPLICATED here. The duplication is kept honest by the parity tests in
// amountAutoSum.test.ts, which assert the auto-filled total always clears the backend comparison
// `round(total·10^scale) === Σ round(cell·10^scale)`. CRITICAL: this is round-each-cell-THEN-sum, never
// sum-then-round — otherwise the backend backstop would reject the system's own auto-filled value
// (e.g. 0.005 + 0.005 at scale 2 → 2 minor units, not the float 0.01 → 1). Any change to the backend's
// comparison MUST be mirrored here.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Mirror of the backend `numberFieldScale`: a number field's declared decimal scale (`props.precision`),
 *  integer clamped to 0..6; default 2. */
export function numberFieldScale(field: FormField | undefined): number {
  const precision = field?.props?.precision
  if (typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && precision <= 6) {
    return precision
  }
  return 2
}

/** One cell → scaled-integer minor units (`Math.round(cell·10^scale)`), mirroring the backend `toScaledInt`.
 *  A non-numeric / not-yet-filled cell counts as 0 so the LIVE total stays useful while the form is being
 *  filled — the backend still rejects a non-numeric cell at submit; this only keeps the derived total live. */
function cellToScaledInt(value: unknown, scale: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(value * 10 ** scale)
}

/** Compute the top-level total from the detail rows so it is GUARANTEED to clear the backend total-check.
 *  ROUND-EACH-CELL-THEN-SUM (identical to the backend's `Σ round(cell·10^scale)`), then divide back. */
export function computeConsistentTotal(rows: unknown, amountColumnId: string, scale: number): number {
  if (!Array.isArray(rows)) return 0
  let scaledSum = 0
  for (const row of rows) {
    const cell = isRecord(row) ? row[amountColumnId] : undefined
    scaledSum += cellToScaledInt(cell, scale)
  }
  return scaledSum / 10 ** scale
}

/** Resolve the amount-column scale from the schema (mirroring the backend's field resolution) and sum the
 *  detail rows into the consistent total. Returns the number to write into `formData[totalFieldId]`. */
export function autoSumTotalFromMapping(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  mapping: AmountConsistencyMapping,
): number {
  const detailField = formSchema.fields.find((field) => field.id === mapping.detailFieldId)
  const amountColumn = (detailField?.columns ?? []).find((column) => column.id === mapping.amountColumnId)
  const scale = numberFieldScale(amountColumn)
  return computeConsistentTotal(formData[mapping.detailFieldId], mapping.amountColumnId, scale)
}
