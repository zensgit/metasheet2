import type { MetaField } from '../types'

export type NormalizedSelectOption = {
  value: string
  color?: string
}

export type NormalizedLinkFieldProperty = {
  foreignSheetId: string | null
  // Cross-base opt-in (design 2026-06-14). Mirrors the backend codec
  // (`field-codecs.ts:208-239`): present only when a cross-base link is
  // authored; same-base links resolve this to `null`. Without carrying it
  // through here the picker would emit the field but read-back would drop it
  // and the link would silently revert to same-base on reload (the #1781
  // wire-vs-fixture trap).
  foreignBaseId: string | null
  limitSingleRecord: boolean
  refKind: string | null
}

export type NormalizedLookupFieldProperty = {
  linkFieldId: string | null
  targetFieldId: string | null
  foreignSheetId: string | null
}

export type RollupAggregation =
  | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'countall' | 'unique'
  | 'concatenate' | 'and' | 'or' | 'xor'

// The VALUE KIND a rollup aggregation produces (mirror of backend rollupResultType). Drives the FE
// operator map + numeric-metric gating so the UI matches what the backend will actually compute.
export function rollupResultType(aggregation: RollupAggregation): 'number' | 'string' | 'boolean' {
  if (aggregation === 'concatenate') return 'string'
  if (aggregation === 'and' || aggregation === 'or' || aggregation === 'xor') return 'boolean'
  return 'number'
}

// Slice 3b — a single rollup filter condition (field on the FOREIGN sheet, operator, optional value).
// Matches the backend MetaFilterCondition shape; value is omitted for isEmpty/isNotEmpty.
export type RollupFilterCondition = { fieldId: string; operator: string; value?: unknown }

export type NormalizedRollupFieldProperty = {
  linkFieldId: string | null
  targetFieldId: string | null
  foreignSheetId: string | null
  aggregation: RollupAggregation
  // Slice 3b rollup filter condition — now editable via the builder UI (no longer opaque). Normalized to
  // typed conditions so the field manager can hydrate/round-trip them; absent when no filter is set.
  filters?: RollupFilterCondition[]
  filterConjunction?: 'and' | 'or'
}

// Normalize raw stored filters (any of the backend aliases) into typed conditions, dropping malformed
// entries (need a non-empty string fieldId + operator). `value` preserved only when present.
export function normalizeRollupFilters(raw: unknown): RollupFilterCondition[] {
  if (!Array.isArray(raw)) return []
  const out: RollupFilterCondition[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const fieldId = typeof o.fieldId === 'string' ? o.fieldId.trim() : ''
    const operator = typeof o.operator === 'string' ? o.operator.trim() : ''
    if (!fieldId || !operator) continue
    out.push('value' in o ? { fieldId, operator, value: o.value } : { fieldId, operator })
  }
  return out
}

// Keep in lockstep with parseRollupAggregation in core-backend (routes/univer-meta.ts + field-codecs.ts):
// an aggregation this rejects gets silently shown/saved as 'count', corrupting a stored countall/unique.
const ROLLUP_AGGREGATIONS: readonly RollupAggregation[] = [
  'count', 'sum', 'avg', 'min', 'max', 'countall', 'unique',
  'concatenate', 'and', 'or', 'xor',
]
export function normalizeRollupAggregation(value: string | null | undefined): RollupAggregation {
  const a = (value ?? '').trim().toLowerCase()
  if (a === 'counta') return 'count'
  if (a === 'distinct' || a === 'uniquecount') return 'unique'
  if (a === 'concat') return 'concatenate'
  return (ROLLUP_AGGREGATIONS as readonly string[]).includes(a) ? (a as RollupAggregation) : 'count'
}

export type NormalizedFormulaFieldProperty = {
  expression: string
}

export type NormalizedAttachmentFieldProperty = {
  maxFiles: number | null
  acceptedMimeTypes: string[]
}

// MF2 batch-1 field types (currency / percent / rating / url / email / phone / barcode / location).
export type NormalizedCurrencyFieldProperty = {
  code: string
  decimals: number
}

export type NormalizedPercentFieldProperty = {
  decimals: number
}

export type NormalizedRatingFieldProperty = {
  max: number
}

// Native duration (时长) — supported display formats. The stored value is always
// seconds; the format only chooses presentation (h:mm vs mm:ss). Mirrors the
// backend codec (`DURATION_FORMATS` in field-codecs.ts). h:mm:ss deferred (v1).
export const DURATION_FORMATS = ['h:mm', 'mm:ss'] as const
export type DurationFormat = (typeof DURATION_FORMATS)[number]
export const DEFAULT_DURATION_FORMAT: DurationFormat = 'h:mm'

export type NormalizedDurationFieldProperty = {
  durationFormat: DurationFormat
}

export type NormalizedNumberFieldProperty = {
  decimals: number | null
  thousands: boolean
  unit: string
}

export type NormalizedAutoNumberFieldProperty = {
  prefix: string
  digits: number
  start: number
}

export type ButtonFieldVariant = 'primary' | 'secondary' | 'danger'
export type NormalizedButtonFieldProperty = {
  label: string
  variant: ButtonFieldVariant
  actionType: string
  /** Raw action config (opaque on the FE; authored/validated server-side). */
  actionConfig: Record<string, unknown> | null
  /** Confirm-before-run affordance. PARSED here but enforcement is deferred to
   *  the first side-effecting-action slice (see B1-S0 design-lock §3.4); B1-b
   *  renders + runs only the inert action, where confirming a no-op is pointless. */
  confirm: { enabled: boolean; message: string }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function resolveSelectFieldOptions(value: unknown): NormalizedSelectOption[] {
  const raw = asRecord(value).options
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const optionValue = item.value
      const color = stringOrNull(item.color)
      if (typeof optionValue !== 'string' && typeof optionValue !== 'number') return null
      return { value: String(optionValue), ...(color ? { color } : {}) }
    })
    .filter((item): item is NormalizedSelectOption => !!item)
}

export function resolveLinkFieldProperty(value: unknown): NormalizedLinkFieldProperty {
  const property = asRecord(value)
  return {
    foreignSheetId: stringOrNull(property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId),
    foreignBaseId: stringOrNull(property.foreignBaseId),
    limitSingleRecord: property.limitSingleRecord === true,
    refKind: stringOrNull(property.refKind),
  }
}

export function resolveLookupFieldProperty(value: unknown): NormalizedLookupFieldProperty {
  const property = asRecord(value)
  return {
    linkFieldId: stringOrNull(property.linkFieldId ?? property.relatedLinkFieldId ?? property.linkedFieldId ?? property.sourceFieldId),
    targetFieldId: stringOrNull(property.targetFieldId ?? property.lookUpTargetFieldId ?? property.lookupTargetFieldId ?? property.lookupFieldId),
    foreignSheetId: stringOrNull(property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId),
  }
}

export function resolveRollupFieldProperty(value: unknown): NormalizedRollupFieldProperty {
  const property = asRecord(value)
  const aggregation = stringOrNull(property.aggregation ?? property.agg ?? property.function ?? property.rollupFunction)
  // Align with the backend parser (parseRollupFieldConfig): accept the filters / conditions /
  // filterConditions aliases and a case-insensitive filterConjunction / conjunction. If the FE only
  // recognized a subset, an alias-authored rollup would lose its filter — or flip OR→AND — after an
  // unrelated Field Manager edit re-saved it in the FE's canonical shape.
  const filters = normalizeRollupFilters(property.filters ?? property.conditions ?? property.filterConditions)
  const conjunction = String(property.filterConjunction ?? property.conjunction ?? '').trim().toLowerCase()
  return {
    linkFieldId: stringOrNull(property.linkFieldId ?? property.linkedFieldId ?? property.relatedLinkFieldId ?? property.sourceFieldId),
    targetFieldId: stringOrNull(property.targetFieldId ?? property.lookUpTargetFieldId ?? property.lookupTargetFieldId ?? property.lookupFieldId),
    foreignSheetId: stringOrNull(property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId),
    aggregation: normalizeRollupAggregation(aggregation),
    ...(filters.length > 0
      ? { filters, filterConjunction: conjunction === 'or' ? 'or' : 'and' }
      : {}),
  }
}

export function resolveFormulaFieldProperty(value: unknown): NormalizedFormulaFieldProperty {
  const property = asRecord(value)
  return {
    expression: typeof property.expression === 'string' ? property.expression.trim() : '',
  }
}

export function resolveAttachmentFieldProperty(value: unknown): NormalizedAttachmentFieldProperty {
  const property = asRecord(value)
  const maxFilesRaw = property.maxFiles
  const maxFilesValue = typeof maxFilesRaw === 'number' ? maxFilesRaw : Number(maxFilesRaw)
  return {
    maxFiles: Number.isFinite(maxFilesValue) && maxFilesValue > 0 ? Math.round(maxFilesValue) : null,
    acceptedMimeTypes: normalizeStringArray(property.acceptedMimeTypes),
  }
}

export function attachmentAcceptAttr(field?: MetaField | null): string | undefined {
  if (!field || field.type !== 'attachment') return undefined
  const { acceptedMimeTypes } = resolveAttachmentFieldProperty(field.property)
  return acceptedMimeTypes.length > 0 ? acceptedMimeTypes.join(',') : undefined
}

export function shouldReplaceAttachmentSelection(field: MetaField, files: FileList | File[], existingCount: number): boolean {
  if (field.type !== 'attachment') return false
  const { maxFiles } = resolveAttachmentFieldProperty(field.property)
  const fileCount = Array.from(files).length
  return maxFiles === 1 && existingCount >= 1 && fileCount === 1
}

export function resolveCurrencyFieldProperty(value: unknown): NormalizedCurrencyFieldProperty {
  const property = asRecord(value)
  const codeRaw = typeof property.code === 'string' ? property.code.trim().toUpperCase() : ''
  const code = /^[A-Z]{3}$/.test(codeRaw) ? codeRaw : 'CNY'
  const decimalsRaw = typeof property.decimals === 'number' ? property.decimals : Number(property.decimals)
  const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
    ? Math.round(decimalsRaw)
    : 2
  return { code, decimals }
}

export function resolvePercentFieldProperty(value: unknown): NormalizedPercentFieldProperty {
  const property = asRecord(value)
  const decimalsRaw = typeof property.decimals === 'number' ? property.decimals : Number(property.decimals)
  const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
    ? Math.round(decimalsRaw)
    : 1
  return { decimals }
}

export function resolveRatingFieldProperty(value: unknown): NormalizedRatingFieldProperty {
  const property = asRecord(value)
  const maxRaw = typeof property.max === 'number' ? property.max : Number(property.max)
  const max = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 10 ? Math.round(maxRaw) : 5
  return { max }
}

export function resolveDurationFieldProperty(value: unknown): NormalizedDurationFieldProperty {
  const property = asRecord(value)
  const fmt = property.durationFormat
  const durationFormat: DurationFormat =
    typeof fmt === 'string' && (DURATION_FORMATS as readonly string[]).includes(fmt)
      ? (fmt as DurationFormat)
      : DEFAULT_DURATION_FORMAT
  return { durationFormat }
}

export function resolveNumberFieldProperty(value: unknown): NormalizedNumberFieldProperty {
  const property = asRecord(value)
  const decimalsRaw = typeof property.decimals === 'number' ? property.decimals : Number(property.decimals)
  const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
    ? Math.round(decimalsRaw)
    : null
  const unit = typeof property.unit === 'string' ? property.unit.trim().slice(0, 24) : ''
  return {
    decimals,
    thousands: property.thousands === true,
    unit,
  }
}

export function resolveAutoNumberFieldProperty(value: unknown): NormalizedAutoNumberFieldProperty {
  const property = asRecord(value)
  const prefix = typeof property.prefix === 'string' ? property.prefix.trim().slice(0, 32) : ''
  const digitsRaw = typeof property.digits === 'number' ? property.digits : Number(property.digits)
  const digits = Number.isFinite(digitsRaw) && digitsRaw >= 0 && digitsRaw <= 12
    ? Math.floor(digitsRaw)
    : 0
  const startRaw = typeof property.start === 'number' ? property.start : Number(property.start ?? property.startAt)
  const start = Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : 1
  return { prefix, digits, start }
}

const BUTTON_VARIANTS: ReadonlySet<ButtonFieldVariant> = new Set(['primary', 'secondary', 'danger'])
export function resolveButtonFieldProperty(value: unknown): NormalizedButtonFieldProperty {
  const property = asRecord(value)
  const label = typeof property.label === 'string' ? property.label.trim() : ''
  const variant = typeof property.variant === 'string' && BUTTON_VARIANTS.has(property.variant as ButtonFieldVariant)
    ? (property.variant as ButtonFieldVariant)
    : 'secondary'
  const actionType = typeof property.actionType === 'string' ? property.actionType.trim() : ''
  const actionConfig = property.actionConfig && typeof property.actionConfig === 'object' && !Array.isArray(property.actionConfig)
    ? (property.actionConfig as Record<string, unknown>)
    : null
  const confirmRaw = asRecord(property.confirm)
  const confirm = {
    enabled: confirmRaw.enabled === true,
    message: typeof confirmRaw.message === 'string' ? confirmRaw.message.trim() : '',
  }
  return { label, variant, actionType, actionConfig, confirm }
}

const CURRENCY_SYMBOL_BY_CODE: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
  AUD: 'A$',
  CAD: 'CA$',
  SGD: 'S$',
}

export function currencySymbolFor(code: string): string {
  const upper = code.trim().toUpperCase()
  if (CURRENCY_SYMBOL_BY_CODE[upper]) return CURRENCY_SYMBOL_BY_CODE[upper]
  return upper
}

export function formatCurrencyValue(value: number, code: string, decimals: number): string {
  const symbol = currencySymbolFor(code)
  try {
    const formatted = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
    return `${symbol}${formatted}`
  } catch {
    return `${symbol}${value.toFixed(decimals)}`
  }
}

export function formatPercentValue(value: number, decimals: number): string {
  try {
    const formatted = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
    return `${formatted}%`
  } catch {
    return `${value.toFixed(decimals)}%`
  }
}

// ---------------------------------------------------------------------------
// Duration (时长) format / parse pair — seconds-backed, format-aware.
// The codec stores SECONDS; these convert between seconds and the displayed
// "h:mm" / "mm:ss" text. Behaviour is defined explicitly (and locked by tests):
//   - format truncates sub-unit seconds (h:mm drops leftover seconds; never rounds up)
//   - the leading unit (hours for h:mm, minutes for mm:ss) is UNBOUNDED ("25:30", "90:00")
//   - the trailing unit is zero-padded to 2 digits
//   - parse accepts "H:MM" / "M:SS" (trailing part normalized: ≥60 carries over) and a
//     bare number (interpreted as the LEADING unit, e.g. "2" in h:mm → 2h = 7200s)
//   - parse returns null for empty/invalid input; negatives are rejected (null)
// ---------------------------------------------------------------------------

/** Format an integer number of seconds as "h:mm" or "mm:ss" (leading unit unbounded). */
export function formatDurationValue(totalSeconds: number, format: DurationFormat): string {
  if (!Number.isFinite(totalSeconds)) return ''
  const sign = totalSeconds < 0 ? '-' : ''
  const abs = Math.trunc(Math.abs(totalSeconds))
  if (format === 'mm:ss') {
    const minutes = Math.trunc(abs / 60)
    const seconds = abs % 60
    return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`
  }
  // h:mm — drop leftover seconds (truncate to the whole minute).
  const totalMinutes = Math.trunc(abs / 60)
  const hours = Math.trunc(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${sign}${hours}:${String(minutes).padStart(2, '0')}`
}

/**
 * Parse a "h:mm" / "mm:ss" (or bare-number) string into an integer number of
 * seconds. Returns null on empty/invalid/negative input. The caller emits this
 * number to the server (the server never parses formatted strings).
 */
export function durationSecondsFromInput(input: string, format: DurationFormat): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('-')) return null
  const secondsPerLeadingUnit = format === 'mm:ss' ? 60 : 3600
  // Bare number → leading unit (hours for h:mm, minutes for mm:ss).
  if (/^\d+$/.test(trimmed)) {
    const lead = Number(trimmed)
    return Number.isFinite(lead) ? lead * secondsPerLeadingUnit : null
  }
  const match = /^(\d+):(\d+)$/.exec(trimmed)
  if (!match) return null
  const lead = Number(match[1])
  const trail = Number(match[2])
  if (!Number.isFinite(lead) || !Number.isFinite(trail)) return null
  // The trailing unit is sub-60 (minutes-in-hour, or seconds-in-minute); a value
  // ≥60 carries over into the leading unit instead of being rejected (lenient).
  const trailSeconds = format === 'mm:ss' ? trail : trail * 60
  return lead * secondsPerLeadingUnit + trailSeconds
}

function splitFixedNumber(value: number, decimals: number | null): { sign: string; integer: string; fraction: string } {
  const raw = decimals === null ? String(value) : value.toFixed(decimals)
  const sign = raw.startsWith('-') ? '-' : ''
  const unsigned = sign ? raw.slice(1) : raw
  const [integer = '0', fraction = ''] = unsigned.split('.')
  return { sign, integer, fraction }
}

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatNumberValue(value: number, property: unknown): string {
  const { decimals, thousands, unit } = resolveNumberFieldProperty(property)
  if (decimals === null && !thousands && !unit) return String(value)
  const { sign, integer, fraction } = splitFixedNumber(value, decimals)
  const whole = thousands ? groupThousands(integer) : integer
  const numeric = fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
  return unit ? `${numeric} ${unit}` : numeric
}

const URL_REGEX = /^https?:\/\/[^\s]+$/i
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_REGEX = /^[+\d][\d\s\-().]{4,23}$/

export function isValidUrlValue(value: unknown): boolean {
  return typeof value === 'string' && URL_REGEX.test(value.trim())
}

export function isValidEmailValue(value: unknown): boolean {
  return typeof value === 'string' && EMAIL_REGEX.test(value.trim())
}

export function isValidPhoneValue(value: unknown): boolean {
  return typeof value === 'string' && PHONE_REGEX.test(value.trim())
}

export function validateAttachmentSelection(field: MetaField, files: FileList | File[], existingCount: number, isZh = false): string | null {
  if (field.type !== 'attachment') return null
  const { maxFiles, acceptedMimeTypes } = resolveAttachmentFieldProperty(field.property)
  const fileList = Array.from(files)
  if (maxFiles && existingCount + fileList.length > maxFiles && !shouldReplaceAttachmentSelection(field, fileList, existingCount)) {
    if (maxFiles === 1) {
      return isZh
        ? '该字段只允许一个附件。添加新文件前请先清除当前文件。'
        : 'This field only allows one attachment. Clear the current file before adding another.'
    }
    return isZh
      ? `该字段最多允许 ${maxFiles} 个附件。`
      : `This field allows up to ${maxFiles} attachments.`
  }
  if (acceptedMimeTypes.length > 0) {
    const disallowed = fileList.find((file) => file.type && !acceptedMimeTypes.includes(file.type))
    if (disallowed) {
      const rejectedType = disallowed.type || disallowed.name
      return isZh ? `不允许的文件类型：${rejectedType}` : `File type not allowed: ${rejectedType}`
    }
  }
  return null
}
