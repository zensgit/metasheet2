/**
 * FWB target-schema authority — meta_fields is the sole source of type/options/precision.
 *
 * Action config may only list {formFieldId, targetFieldId}. targetType / selectOptions in config
 * are NOT authority and are ignored when resolving. Missing/unsupported types fail closed.
 * D7/Q5: number values use exact fixed-decimal string validation (no Number() precision loss,
 * no rounding — over-precision REJECT).
 */
import type { AutomationDeps } from './automation-executor'
import type { FwbFieldMapping, FwbMappingErrorCode, FwbTargetFieldType } from './approval-form-value-mapping'
import { extractSelectOptions } from './field-codecs'

const SUPPORTED: ReadonlySet<string> = new Set(['text', 'number', 'date', 'select'])

export interface ResolvedTargetField {
  id: string
  type: FwbTargetFieldType
  selectOptions?: readonly string[]
  /** number field precision (fractional digits); undefined = no fractional limit beyond safe integer path. */
  decimals?: number
}

export type ResolveTargetResult =
  | { ok: true; fields: Map<string, ResolvedTargetField> }
  | { ok: false; code: 'field_missing' | 'unsupported_type'; fieldId?: string }

export async function loadTargetFieldsFromMeta(
  queryFn: AutomationDeps['queryFn'],
  sheetId: string,
  targetFieldIds: readonly string[],
): Promise<ResolveTargetResult> {
  if (targetFieldIds.length === 0) return { ok: true, fields: new Map() }
  const res = await queryFn(
    `SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])`,
    [sheetId, [...targetFieldIds]],
  )
  const byId = new Map<string, ResolvedTargetField>()
  for (const raw of res.rows as Array<{ id: string; type: string; property: unknown }>) {
    const type = normalizeFieldType(raw.type)
    if (!type || !SUPPORTED.has(type)) {
      return { ok: false, code: 'unsupported_type', fieldId: raw.id }
    }
    const property = (raw.property && typeof raw.property === 'object' && !Array.isArray(raw.property))
      ? raw.property as Record<string, unknown>
      : {}
    const field: ResolvedTargetField = { id: raw.id, type }
    if (type === 'select') {
      const opts = extractSelectOptions(property)
      field.selectOptions = opts ? opts.map((o) => o.value) : []
    }
    if (type === 'number') {
      const d = property.decimals
      if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 20) field.decimals = d
      else if (typeof d === 'string' && /^\d+$/.test(d.trim())) {
        const n = Number.parseInt(d.trim(), 10)
        if (n >= 0 && n <= 20) field.decimals = n
      }
    }
    byId.set(raw.id, field)
  }
  for (const id of targetFieldIds) {
    if (!byId.has(id)) return { ok: false, code: 'field_missing', fieldId: id }
  }
  return { ok: true, fields: byId }
}

function normalizeFieldType(raw: string): FwbTargetFieldType | null {
  if (raw === 'text' || raw === 'singleLineText' || raw === 'longText') return 'text'
  if (raw === 'number') return 'number'
  if (raw === 'date') return 'date'
  if (raw === 'select' || raw === 'singleSelect') return 'select'
  return null
}

/** Build executor mappings from identifier pairs + resolved meta_fields (server authority). */
export function buildAuthoritativeMappings(
  pairs: readonly { formFieldId: string; targetFieldId: string }[],
  fields: Map<string, ResolvedTargetField>,
): FwbFieldMapping[] {
  return pairs.map((p) => {
    const f = fields.get(p.targetFieldId)!
    return {
      formFieldId: p.formFieldId,
      targetFieldId: p.targetFieldId,
      targetType: f.type,
      ...(f.selectOptions ? { selectOptions: f.selectOptions } : {}),
      ...(f.decimals !== undefined ? { numberPrecision: f.decimals } : {}),
    } as FwbFieldMapping & { numberPrecision?: number }
  })
}

/**
 * D7/Q5 exact fixed-decimal validation without Number()/float.
 * Accepts integer or decimal string; rejects over-precision, non-decimal, empty.
 * Returns a canonical decimal string (no scientific notation).
 */
export function coerceExactDecimal(
  raw: unknown,
  maxFractionalDigits: number | undefined,
): { ok: true; v: string } | { ok: false; code: FwbMappingErrorCode } {
  let s: string
  if (typeof raw === 'string') s = raw.trim()
  else if (typeof raw === 'number' && Number.isFinite(raw) && !String(raw).includes('e') && !String(raw).includes('E')) {
    // Only accept finite numbers that stringify without scientific notation (safe small ints).
    s = String(raw)
  } else {
    return { ok: false, code: 'not_a_number' }
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return { ok: false, code: 'not_a_number' }
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [intPart, fracPart = ''] = body.split('.')
  if (!/^\d+$/.test(intPart)) return { ok: false, code: 'not_a_number' }
  if (fracPart && !/^\d+$/.test(fracPart)) return { ok: false, code: 'not_a_number' }
  // Strip trailing zeros first (canonical length) — trailing zeros are not precision; do NOT round.
  let frac = fracPart
  while (frac.endsWith('0')) frac = frac.slice(0, -1)
  if (maxFractionalDigits !== undefined && frac.length > maxFractionalDigits) {
    return { ok: false, code: 'number_precision_exceeded' as FwbMappingErrorCode }
  }
  const canon = frac.length > 0 ? `${neg ? '-' : ''}${intPart}.${frac}` : `${neg ? '-' : ''}${intPart}`
  return { ok: true, v: canon }
}
