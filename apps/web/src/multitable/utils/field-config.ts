import type { MetaField } from '../types'

export type NormalizedSelectOption = {
  value: string
  color?: string
}

export type NormalizedLinkFieldProperty = {
  foreignSheetId: string | null
  limitSingleRecord: boolean
  refKind: string | null
}

export type NormalizedLookupFieldProperty = {
  linkFieldId: string | null
  targetFieldId: string | null
  foreignSheetId: string | null
}

export type NormalizedRollupFieldProperty = {
  linkFieldId: string | null
  targetFieldId: string | null
  foreignSheetId: string | null
  aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max'
}

export type NormalizedFormulaFieldProperty = {
  expression: string
}

export type NormalizedAttachmentFieldProperty = {
  maxFiles: number | null
  acceptedMimeTypes: string[]
}

// MF2 batch-1 field types (currency / percent / rating / url / email / phone).
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
  return {
    linkFieldId: stringOrNull(property.linkFieldId ?? property.linkedFieldId ?? property.relatedLinkFieldId ?? property.sourceFieldId),
    targetFieldId: stringOrNull(property.targetFieldId ?? property.lookUpTargetFieldId ?? property.lookupTargetFieldId ?? property.lookupFieldId),
    foreignSheetId: stringOrNull(property.foreignSheetId ?? property.foreignDatasheetId ?? property.datasheetId),
    aggregation: aggregation === 'sum' || aggregation === 'avg' || aggregation === 'min' || aggregation === 'max'
      ? aggregation
      : 'count',
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

export function validateAttachmentSelection(field: MetaField, files: FileList | File[], existingCount: number): string | null {
  if (field.type !== 'attachment') return null
  const { maxFiles, acceptedMimeTypes } = resolveAttachmentFieldProperty(field.property)
  const fileList = Array.from(files)
  if (maxFiles && existingCount + fileList.length > maxFiles && !shouldReplaceAttachmentSelection(field, fileList, existingCount)) {
    return maxFiles === 1
      ? 'This field only allows one attachment. Clear the current file before adding another.'
      : `This field allows up to ${maxFiles} attachments.`
  }
  if (acceptedMimeTypes.length > 0) {
    const disallowed = fileList.find((file) => file.type && !acceptedMimeTypes.includes(file.type))
    if (disallowed) {
      return `File type not allowed: ${disallowed.type || disallowed.name}`
    }
  }
  return null
}
