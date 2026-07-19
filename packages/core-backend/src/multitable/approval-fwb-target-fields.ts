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
import { extractSelectOptions, isRichLongTextProperty } from './field-codecs'

const SUPPORTED: ReadonlySet<string> = new Set(['text', 'number', 'date', 'dateTime', 'select'])

export interface ResolvedTargetField {
  id: string
  type: FwbTargetFieldType
  /** The source meta_field is a longText field with property.rich === true. */
  richLongText?: boolean
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
    if (raw.type === 'longText' && isRichLongTextProperty(property)) {
      field.richLongText = true
    }
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
  if (raw === 'dateTime' || raw === 'datetime') return 'dateTime'
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
      ...(f.richLongText ? { richLongText: true } : {}),
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
  else if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    // Fractional JS numbers and unsafe integers have already crossed a lossy IEEE-754 boundary.
    // The production UI/API sends exact decimal strings; keep safe integers for compatibility.
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

/**
 * Exact canonical decimal comparison without JS Number (safe above 2^53).
 * Accepts D7-shaped strings / finite non-scientific numbers; returns null when either side is non-decimal.
 * Trailing zeros are insignificant (`12.50` === `12.5`).
 */
export function compareExactDecimal(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const coerceComparable = (raw: unknown) => {
    if (typeof raw !== 'number') return coerceExactDecimal(raw, undefined)
    if (!Number.isFinite(raw) || (Number.isInteger(raw) && !Number.isSafeInteger(raw))) {
      return { ok: false as const, code: 'not_a_number' as FwbMappingErrorCode }
    }
    return coerceExactDecimal(String(raw), undefined)
  }
  const ca = coerceComparable(a)
  const cb = coerceComparable(b)
  if (!ca.ok || !cb.ok) return null
  const pa = parseCanonicalDecimalParts(ca.v)
  const pb = parseCanonicalDecimalParts(cb.v)
  if (!pa || !pb) return null
  if (pa.sign !== pb.sign) {
    // +0 and -0 compare equal after coerce (both become "0")
    if (pa.intDigits === '0' && pa.fracDigits === '' && pb.intDigits === '0' && pb.fracDigits === '') return 0
    return pa.sign < pb.sign ? -1 : 1
  }
  let cmp: -1 | 0 | 1 = 0
  if (pa.intDigits.length !== pb.intDigits.length) {
    cmp = pa.intDigits.length < pb.intDigits.length ? -1 : 1
  } else if (pa.intDigits !== pb.intDigits) {
    cmp = pa.intDigits < pb.intDigits ? -1 : 1
  } else {
    const maxFrac = Math.max(pa.fracDigits.length, pb.fracDigits.length)
    const aFrac = pa.fracDigits.padEnd(maxFrac, '0')
    const bFrac = pb.fracDigits.padEnd(maxFrac, '0')
    if (aFrac !== bFrac) cmp = aFrac < bFrac ? -1 : 1
  }
  if (cmp === 0) return 0
  return (pa.sign < 0 ? -cmp : cmp) as -1 | 0 | 1
}

function parseCanonicalDecimalParts(
  canon: string,
): { sign: 1 | -1; intDigits: string; fracDigits: string } | null {
  const neg = canon.startsWith('-')
  const body = neg ? canon.slice(1) : canon
  const [intPart, fracPart = ''] = body.split('.')
  if (!/^\d+$/.test(intPart)) return null
  if (fracPart && !/^\d+$/.test(fracPart)) return null
  // Strip leading zeros from integer digits but keep a single 0.
  let intDigits = intPart.replace(/^0+(?=\d)/, '')
  if (intDigits === '') intDigits = '0'
  return { sign: neg ? -1 : 1, intDigits, fracDigits: fracPart }
}

/**
 * True when a D7 decimal string is exactly representable as a JS IEEE-754 number for ordinary
 * arithmetic (formula engine). High-precision values that would silently lose low bits return false
 * so callers can fail closed instead of computing a wrong numeric result.
 */
export function isExactlyRepresentableAsJsNumber(raw: unknown): boolean {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return false
    return !Number.isInteger(raw) || Number.isSafeInteger(raw)
  }
  const c = coerceExactDecimal(raw, undefined)
  if (!c.ok) return false
  const n = Number(c.v)
  if (!Number.isFinite(n)) return false
  // Integers beyond safe range lose low bits.
  if (!c.v.includes('.') && (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER)) {
    return false
  }
  // Round-trip: Number → fixed decimal must compare exact to the original canonical form.
  // Use toPrecision carefully: reconstruct from the same Number path the formula engine uses.
  if (Object.is(n, -0)) return c.v === '0' || c.v === '-0'
  const viaNumber = coerceExactDecimal(String(n), undefined)
  if (!viaNumber.ok) return false
  return compareExactDecimal(c.v, viaNumber.v) === 0
}

/** Strict real calendar date YYYY-MM-DD (rejects 2026-02-30, month 13, etc.). */
export function isStrictCalendarDate(raw: string): boolean {
  const s = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  // UTC noon avoids DST edge cases; verify Y/M/D round-trip on a real calendar.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return (
    dt.getUTCFullYear() === y
    && dt.getUTCMonth() === m - 1
    && dt.getUTCDate() === d
  )
}

/**
 * Datetime with explicit Z or numeric offset only — never guess host timezone.
 * Canonicalizes to UTC ISO-8601 with millisecond precision (`...Z`).
 */
export function canonicalizeDatetimeToUtcIso(
  raw: string,
): { ok: true; v: string } | { ok: false } {
  const s = raw.trim()
  // Require explicit Z or ±HH:MM / ±HHMM offset — bare local datetimes are rejected.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return { ok: false }
  }
  // Extract calendar date prefix and validate it is a real calendar day (UTC components of the
  // offset-applied instant may differ; validate the written calendar date portion first).
  const datePart = s.slice(0, 10)
  if (!isStrictCalendarDate(datePart)) return { ok: false }
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return { ok: false }
  return { ok: true, v: new Date(t).toISOString() }
}

/**
 * FWB record-link fail-closed pin: props.sheetId must exist, props.baseId must be non-blank and
 * exactly equal the non-deleted meta_sheets.base_id (claim == truth).
 */
export async function resolvePinnedRecordLinkTarget(
  queryFn: AutomationDeps['queryFn'],
  props: { sheetId?: unknown; baseId?: unknown },
): Promise<
  | { ok: true; sheetId: string; baseId: string }
  | { ok: false; code: 'record_link_invalid' }
> {
  const sheetId = typeof props.sheetId === 'string' ? props.sheetId.trim() : ''
  const baseId = typeof props.baseId === 'string' ? props.baseId.trim() : ''
  if (!sheetId || !baseId) return { ok: false, code: 'record_link_invalid' }
  const res = await queryFn(
    `SELECT base_id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL`,
    [sheetId],
  )
  const row = res.rows[0] as { base_id?: unknown } | undefined
  if (!row || typeof row.base_id !== 'string' || row.base_id !== baseId) {
    return { ok: false, code: 'record_link_invalid' }
  }
  return { ok: true, sheetId, baseId }
}
