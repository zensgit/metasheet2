import type { FormField, FormSchema } from '../types/approval'
import { getVisibleFormFields } from './fieldVisibility'
import { numberFieldScale } from './amountAutoSum'

// Per-row line-subtotal derivation (design-lock #3203, Gate A). The declaration rides on the TARGET
// column's props (`props.derivedFrom`), which round-trips through the backend wholesale (no backend
// change). Because the backend does NOT validate this key, the FE is the sole validator: a malformed /
// partial / wrong-typed declaration parses to null and the column stays a normal manual column.

export interface RowDerivation {
  operandColumnIds: string[]
  operation: 'product'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a column's `props.derivedFrom`. Defensive: returns null (→ manual column) on anything invalid. */
export function columnDerivation(column: FormField | undefined): RowDerivation | null {
  const decl = column?.props?.derivedFrom
  if (!isRecord(decl)) return null
  const ops = decl.operandColumnIds
  if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => typeof op === 'string' && op.length > 0)) {
    return null
  }
  if (decl.operation !== 'product') return null
  return { operandColumnIds: ops as string[], operation: 'product' }
}

/** True iff the column declares a valid derivation → rendered read-only in the fill UI. */
export function isDerivedColumn(column: FormField | undefined): boolean {
  return columnDerivation(column) !== null
}

/** Compute a row's derived value: the product of the operand cells, rounded to the target column scale.
 *  That scale is the amount column's precision — the SAME scale that governs the total chain — so the
 *  derived value composes exactly with computeConsistentTotal. Returns null if ANY operand is
 *  non-numeric / missing (→ leave the cell manual; never derive from a partial operand set). */
export function computeRowDerivation(row: Record<string, unknown>, decl: RowDerivation, scale: number): number | null {
  let product = 1
  for (const columnId of decl.operandColumnIds) {
    const value = row[columnId]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    product *= value
  }
  return Math.round(product * 10 ** scale) / 10 ** scale
}

/** A declared target is active for a row only when the target and ALL operands are visible for that
 *  row. This is the shared guard for both mutation and UI read-only: hidden operands mean "manual
 *  row", visible-but-empty operands mean "read-only until the user fills the operands". */
export function isRowDerivationActive(
  columns: FormField[] | undefined,
  targetColumn: FormField | undefined,
  row: Record<string, unknown>,
): boolean {
  if (!columns || !targetColumn) return false
  const decl = columnDerivation(targetColumn)
  if (!decl) return false
  const visibleIds = new Set(getVisibleFormFields({ fields: columns }, row).map((column) => column.id))
  return visibleIds.has(targetColumn.id) && decl.operandColumnIds.every((id) => visibleIds.has(id))
}

/** Derive every row's amount column IN-PLACE from its operands, for one declared detail field. No-op if
 *  the amount column declares no derivation. Reuses the detail table's own per-row column visibility:
 *  hidden target / hidden operand rows stay manual, and visible-but-not-yet-numeric operands leave the
 *  current amount untouched until the operands are filled. */
export function applyRowDerivations(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  detailFieldId: string,
  amountColumnId: string,
): void {
  const detailField = formSchema.fields.find((field) => field.id === detailFieldId)
  const columns = detailField?.columns
  const amountColumn = columns?.find((column) => column.id === amountColumnId)
  const decl = columnDerivation(amountColumn)
  if (!decl) return
  const scale = numberFieldScale(amountColumn)
  const rows = formData[detailFieldId]
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (!isRowDerivationActive(columns, amountColumn, row)) continue
    const derived = computeRowDerivation(row, decl, scale)
    if (derived !== null) row[amountColumnId] = derived
  }
}
