function readTransportString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function padDateTimePart(value: number) {
  return String(value).padStart(2, '0')
}

export function normalizePlmAuditDateTimeTransport(value: unknown) {
  const raw = readTransportString(value)
  if (!raw) return ''

  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''

  return date.toISOString()
}

export function formatPlmAuditDateTimeInputValue(value: unknown) {
  const normalized = normalizePlmAuditDateTimeTransport(value)
  if (!normalized) return ''

  const date = new Date(normalized)
  return `${date.getFullYear()}-${padDateTimePart(date.getMonth() + 1)}-${padDateTimePart(date.getDate())}T${padDateTimePart(date.getHours())}:${padDateTimePart(date.getMinutes())}`
}
