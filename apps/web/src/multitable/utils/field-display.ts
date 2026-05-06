import type { LinkedRecordSummary, MetaAttachment, MetaField } from '../types'
import {
  formatCurrencyValue,
  formatNumberValue,
  formatPercentValue,
  resolveCurrencyFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
} from './field-config'
import { isSystemFieldType } from './system-fields'

function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function summarizeLinkCount(field: MetaField, count: number): string {
  if (count <= 0) return '—'
  if (field.property?.refKind === 'user') return count === 1 ? '1 person' : `${count} people`
  return count === 1 ? '1 linked record' : `${count} linked records`
}

function summarizeAttachmentCount(count: number): string {
  if (count <= 0) return '—'
  return count === 1 ? '1 attachment' : `${count} attachments`
}

export function locationAddressValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const rawAddress = obj.address ?? obj.name ?? obj.fullAddress
    if (rawAddress !== null && rawAddress !== undefined && String(rawAddress).trim().length > 0) {
      return String(rawAddress)
    }
    const latitude = obj.latitude ?? obj.lat
    const longitude = obj.longitude ?? obj.lng ?? obj.lon
    if (latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined) {
      return `${latitude}, ${longitude}`
    }
  }
  return String(value)
}

export function locationValueFromAddress(address: string): { address: string } | null {
  const trimmed = address.trim()
  return trimmed ? { address: trimmed } : null
}

export function formatFieldDisplay(params: {
  field: MetaField
  value: unknown
  linkSummaries?: LinkedRecordSummary[] | null
  attachmentSummaries?: MetaAttachment[] | null
}): string {
  const { field, value, linkSummaries, attachmentSummaries } = params
  if (value === null || value === undefined || value === '') return '—'

  if (field.type === 'date') return formatDate(value)
  if (field.type === 'createdTime' || field.type === 'modifiedTime') return formatDateTime(value)
  if (isSystemFieldType(field.type)) return String(value)
  if (field.type === 'boolean') return value ? 'Yes' : 'No'

  if (field.type === 'number') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    return formatNumberValue(num, field.property)
  }

  if (field.type === 'currency') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { code, decimals } = resolveCurrencyFieldProperty(field.property)
    return formatCurrencyValue(num, code, decimals)
  }

  if (field.type === 'percent') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { decimals } = resolvePercentFieldProperty(field.property)
    return formatPercentValue(num, decimals)
  }

  if (field.type === 'rating') {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return String(value)
    const { max } = resolveRatingFieldProperty(field.property)
    const filled = Math.max(0, Math.min(max, Math.round(num)))
    return `${'★'.repeat(filled)}${'☆'.repeat(max - filled)}`
  }

  if (field.type === 'location') {
    const location = locationAddressValue(value).trim()
    return location.length > 0 ? location : '—'
  }

  if (field.type === 'select' || field.type === 'multiSelect') {
    const rawValues = Array.isArray(value) ? value : [value]
    const displayValues = rawValues
      .filter((item) => item !== null && item !== undefined && String(item).trim().length > 0)
      .map((item) => String(item))
    return displayValues.length > 0 ? displayValues.join(', ') : '—'
  }

  if (field.type === 'link') {
    if (linkSummaries?.length) {
      return linkSummaries
        .map((summary) => summary.display || summary.id)
        .filter((item) => item.trim().length > 0)
        .join(', ')
    }
    const count = Array.isArray(value) ? value.length : value ? 1 : 0
    return summarizeLinkCount(field, count)
  }

  if (field.type === 'attachment') {
    if (attachmentSummaries?.length) {
      return attachmentSummaries
        .map((attachment) => attachment.filename)
        .filter((item) => item.trim().length > 0)
        .join(', ')
    }
    const count = Array.isArray(value) ? value.length : value ? 1 : 0
    return summarizeAttachmentCount(count)
  }

  if (Array.isArray(value)) {
    const displayValues = value
      .filter((item) => item !== null && item !== undefined && String(item).trim().length > 0)
      .map((item) => String(item))
    return displayValues.length > 0 ? displayValues.join(', ') : '—'
  }

  return String(value)
}
