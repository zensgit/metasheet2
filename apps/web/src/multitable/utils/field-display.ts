import type { LinkedRecordSummary, MetaAttachment, MetaField } from '../types'

function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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

export function formatFieldDisplay(params: {
  field: MetaField
  value: unknown
  linkSummaries?: LinkedRecordSummary[] | null
  attachmentSummaries?: MetaAttachment[] | null
}): string {
  const { field, value, linkSummaries, attachmentSummaries } = params
  if (value === null || value === undefined || value === '') return '—'

  if (field.type === 'date') return formatDate(value)
  if (field.type === 'boolean') return value ? 'Yes' : 'No'

  if (field.type === 'select') {
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
