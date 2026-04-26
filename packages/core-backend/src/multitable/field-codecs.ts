import { fieldTypeRegistry } from './field-type-registry'

export type MultitableFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'select'
  | 'link'
  | 'lookup'
  | 'rollup'
  | 'attachment'
  | 'currency'
  | 'percent'
  | 'rating'
  | 'url'
  | 'email'
  | 'phone'

export type MultitableField = {
  id: string
  name: string
  type: MultitableFieldType
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isPlainObject(parsed)) return parsed
    } catch {
      return {}
    }
  }
  return {}
}

export function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return ''
      })
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizeJsonArray(parsed)
    } catch {
      return []
    }
  }
  return []
}

export function mapFieldType(type: string): MultitableFieldType | string {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'date' || normalized === 'datetime') return 'date'
  if (normalized === 'formula') return 'formula'
  if (normalized === 'select' || normalized === 'multiselect') return 'select'
  if (normalized === 'link') return 'link'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  if (normalized === 'currency') return 'currency'
  if (normalized === 'percent') return 'percent'
  if (normalized === 'rating') return 'rating'
  if (normalized === 'url') return 'url'
  if (normalized === 'email') return 'email'
  if (normalized === 'phone') return 'phone'
  if (fieldTypeRegistry.has(normalized)) return normalized
  return 'string'
}

export function extractSelectOptions(
  property: unknown,
): Array<{ value: string; color?: string }> | undefined {
  const obj = normalizeJson(property)
  const raw = obj.options
  if (!Array.isArray(raw)) return undefined

  const options: Array<{ value: string; color?: string }> = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const value = item.value
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const color = typeof item.color === 'string' ? item.color : undefined
    options.push({ value: String(value), ...(color ? { color } : {}) })
  }

  return options.length > 0 ? options : undefined
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parseRollupAggregation(value: unknown): 'count' | 'sum' | 'avg' | 'min' | 'max' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'counta') return 'count'
  if (
    normalized === 'count' ||
    normalized === 'sum' ||
    normalized === 'avg' ||
    normalized === 'min' ||
    normalized === 'max'
  ) {
    return normalized as 'count' | 'sum' | 'avg' | 'min' | 'max'
  }
  return null
}

export function sanitizeFieldProperty(
  type: MultitableFieldType | string,
  property: unknown,
): Record<string, unknown> {
  const obj = normalizeJson(property)
  if (type === 'select') {
    const options = extractSelectOptions(obj) ?? []
    return { ...obj, options }
  }

  if (type === 'link') {
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    return {
      ...obj,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId } : {}),
      limitSingleRecord: obj.limitSingleRecord === true,
      ...(typeof obj.refKind === 'string' && obj.refKind.trim().length > 0
        ? { refKind: obj.refKind.trim() }
        : {}),
    }
  }

  if (type === 'lookup') {
    const linkFieldId =
      typeof (obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId) ===
      'string'
        ? String(
            obj.linkFieldId ??
              obj.relatedLinkFieldId ??
              obj.linkedFieldId ??
              obj.sourceFieldId,
          ).trim()
        : ''
    const targetFieldId =
      typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) ===
      'string'
        ? String(
            obj.targetFieldId ??
              obj.lookUpTargetFieldId ??
              obj.lookupTargetFieldId ??
              obj.lookupFieldId,
          ).trim()
        : ''
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, relatedLinkFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId, lookUpTargetFieldId: targetFieldId } : {}),
      ...(foreignSheetId
        ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId }
        : {}),
    }
  }

  if (type === 'rollup') {
    const linkFieldId =
      typeof (obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId) ===
      'string'
        ? String(
            obj.linkFieldId ??
              obj.linkedFieldId ??
              obj.relatedLinkFieldId ??
              obj.sourceFieldId,
          ).trim()
        : ''
    const targetFieldId =
      typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) ===
      'string'
        ? String(
            obj.targetFieldId ??
              obj.lookUpTargetFieldId ??
              obj.lookupTargetFieldId ??
              obj.lookupFieldId,
          ).trim()
        : ''
    const foreignSheetId =
      typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
        ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
        : ''
    const aggregation =
      parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction) ??
      'count'
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, linkedFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId } : {}),
      aggregation,
      ...(foreignSheetId
        ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId }
        : {}),
    }
  }

  if (type === 'formula') {
    return {
      ...obj,
      expression: typeof obj.expression === 'string' ? obj.expression.trim() : '',
    }
  }

  if (type === 'attachment') {
    const maxFiles = typeof obj.maxFiles === 'number' ? obj.maxFiles : Number(obj.maxFiles)
    return {
      ...obj,
      ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles: Math.round(maxFiles) } : {}),
      acceptedMimeTypes: sanitizeStringArray(obj.acceptedMimeTypes),
    }
  }

  if (type === 'currency') {
    const codeRaw = typeof obj.code === 'string' ? obj.code.trim().toUpperCase() : ''
    const code = /^[A-Z]{3}$/.test(codeRaw) ? codeRaw : 'CNY'
    const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
    const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
      ? Math.round(decimalsRaw)
      : 2
    return { ...obj, code, decimals }
  }

  if (type === 'percent') {
    const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
    const decimals = Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6
      ? Math.round(decimalsRaw)
      : 1
    return { ...obj, decimals }
  }

  if (type === 'rating') {
    const maxRaw = typeof obj.max === 'number' ? obj.max : Number(obj.max)
    const max = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 10 ? Math.round(maxRaw) : 5
    return { ...obj, max }
  }

  if (type === 'url' || type === 'email' || type === 'phone') {
    return obj
  }

  const customDef = fieldTypeRegistry.get(type)
  if (customDef) {
    return customDef.sanitizeProperty(property)
  }

  return obj
}

export function serializeFieldRow(row: any): MultitableField {
  const rawType = String(row.type ?? 'string')
  const mappedType = mapFieldType(rawType)
  const property = sanitizeFieldProperty(mappedType, row.property)
  const order = Number(row.order ?? 0)
  return {
    id: String(row.id),
    name: String(row.name),
    type: mappedType as MultitableFieldType,
    ...(mappedType === 'select' ? { options: extractSelectOptions(property) } : {}),
    order: Number.isFinite(order) ? order : 0,
    property,
  }
}

// ---------------------------------------------------------------------------
// MF2 field-types batch 1: currency / percent / rating / url / email / phone
// ---------------------------------------------------------------------------
//
// Validation regex chosen to match Feishu's lenient client-side checks and
// keep the server free of external deps. Coercion functions normalize the
// value before it lands in the JSON `data` column. Coercion failures throw
// an `Error` that the caller surfaces as a `RecordValidationError`.

// Permissive ASCII URL: protocol required to differentiate from plain text.
export const URL_REGEX = /^https?:\/\/[^\s]+$/i
// Standard "local@domain.tld" email shape; Unicode in the local part is OK.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Lenient phone: digits + optional separators, 6–24 chars total. Leading +, digit, or ( all allowed.
export const PHONE_REGEX = /^[+\d(][\d\s\-().]{4,23}$/

export function coerceNumericValue(
  value: unknown,
  fieldId: string,
  label: string,
): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} value must be a finite number for ${fieldId}`)
    }
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} value must be numeric for ${fieldId}: ${value}`)
    }
    return parsed
  }
  throw new Error(`${label} value must be a number for ${fieldId}`)
}

export function coerceCurrencyValue(value: unknown, fieldId: string): number | null {
  return coerceNumericValue(value, fieldId, 'Currency')
}

export function coercePercentValue(value: unknown, fieldId: string): number | null {
  return coerceNumericValue(value, fieldId, 'Percent')
}

export function coerceRatingValue(
  value: unknown,
  fieldId: string,
  max: number,
): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = coerceNumericValue(value, fieldId, 'Rating')
  if (num === null) return null
  if (!Number.isInteger(num)) {
    throw new Error(`Rating value must be an integer for ${fieldId}`)
  }
  if (num < 0 || num > max) {
    throw new Error(`Rating value must be between 0 and ${max} for ${fieldId}`)
  }
  return num
}

export function validateUrlValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`URL value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!URL_REGEX.test(trimmed)) {
    throw new Error(`Invalid URL for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

export function validateEmailValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`Email value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new Error(`Invalid email for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

export function validatePhoneValue(value: unknown, fieldId: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new Error(`Phone value must be a string for ${fieldId}`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!PHONE_REGEX.test(trimmed)) {
    throw new Error(`Invalid phone number for ${fieldId}: ${trimmed}`)
  }
  return trimmed
}

/**
 * Coerce / validate a value for one of the MF2 batch-1 field types and
 * return the normalized form to persist. Returns the original value if
 * the field type is not in the batch.
 */
export function coerceBatch1Value(
  fieldType: string,
  property: Record<string, unknown> | undefined,
  fieldId: string,
  value: unknown,
): unknown {
  if (fieldType === 'currency') return coerceCurrencyValue(value, fieldId)
  if (fieldType === 'percent') return coercePercentValue(value, fieldId)
  if (fieldType === 'rating') {
    const sanitized = sanitizeFieldProperty('rating', property ?? {})
    const max = Number(sanitized.max)
    return coerceRatingValue(value, fieldId, Number.isFinite(max) && max > 0 ? max : 5)
  }
  if (fieldType === 'url') return validateUrlValue(value, fieldId)
  if (fieldType === 'email') return validateEmailValue(value, fieldId)
  if (fieldType === 'phone') return validatePhoneValue(value, fieldId)
  return value
}

export const BATCH1_FIELD_TYPES: ReadonlySet<string> = new Set([
  'currency',
  'percent',
  'rating',
  'url',
  'email',
  'phone',
])
