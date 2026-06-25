import type { FormSchema, FormField } from '../types/approval-product'

// Server-side amount total-check (design-lock approval-amount-server-side-total-check-20260624) — Gate A:
// a PURE control (no DB) that an applicant-supplied top-level total equals the sum of that submission's
// detail-row amounts, on a money-safe SCALED-INTEGER representation (never raw IEEE float). The scale is
// DERIVED from the amount column's own declared precision (default 2) so the comparison is at the field's
// granularity. Returns an error message on mismatch / malformed input (fail-closed), else null. Runs ONLY
// when a template declares the mapping; never invoked without one.

export interface AmountConsistencyMapping {
  totalFieldId: string
  detailFieldId: string
  amountColumnId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number field's declared decimal scale (from `props.precision`), clamped to 0..6; default 2. */
function numberFieldScale(field: FormField | undefined): number {
  const precision = field?.props?.precision
  if (typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && precision <= 6) {
    return precision
  }
  return 2
}

/** Scale a finite number to integer minor units at `scale` decimals (rounded, so float drift can't leak); null if not a finite number. */
function toScaledInt(value: unknown, scale: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(value * 10 ** scale)
}

export function validateAmountTotalConsistency(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
  mapping: AmountConsistencyMapping,
): string | null {
  // 1. Resolve + type-check the mapped fields against the schema (fail-closed on missing / wrong type).
  const totalField = formSchema.fields.find((field) => field.id === mapping.totalFieldId)
  if (!totalField || totalField.type !== 'number') {
    return `金额一致性校验：总额字段 ${mapping.totalFieldId} 不存在或非数字类型`
  }
  const detailField = formSchema.fields.find((field) => field.id === mapping.detailFieldId)
  if (!detailField || detailField.type !== 'detail') {
    return `金额一致性校验：明细字段 ${mapping.detailFieldId} 不存在或非明细类型`
  }
  const amountColumn = (detailField.columns ?? []).find((column) => column.id === mapping.amountColumnId)
  if (!amountColumn || amountColumn.type !== 'number') {
    return `金额一致性校验：明细金额列 ${mapping.amountColumnId} 不存在或非数字类型`
  }

  // 2. Scale from the amount column's precision (default 2). Compare on integer minor units only.
  const scale = numberFieldScale(amountColumn)
  const total = toScaledInt(formData[mapping.totalFieldId], scale)
  if (total === null) {
    return `金额一致性校验：总额 ${mapping.totalFieldId} 缺失或非数字`
  }

  // 3. Sum the detail rows' amount cells (fail-closed on non-array / non-record row / non-numeric cell).
  const rows = formData[mapping.detailFieldId]
  if (!Array.isArray(rows)) {
    return `金额一致性校验：明细 ${mapping.detailFieldId} 不是有效的明细数组`
  }
  let sum = 0
  for (const row of rows) {
    if (!isRecord(row)) return `金额一致性校验：明细行格式非法`
    const cell = toScaledInt(row[mapping.amountColumnId], scale)
    if (cell === null) return `金额一致性校验：明细行金额 ${mapping.amountColumnId} 缺失或非数字`
    sum += cell
  }

  // 4. Exact comparison on the money-safe scaled integers.
  if (total !== sum) {
    const factor = 10 ** scale
    return `金额一致性校验：总额 ${total / factor} 与明细合计 ${sum / factor} 不一致`
  }
  return null
}
