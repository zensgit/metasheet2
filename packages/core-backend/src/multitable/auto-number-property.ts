export type NormalizedAutoNumberProperty = {
  prefix: string
  digits: number
  start: number
  startAt: number
  readOnly: true
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finiteInteger(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(raw) ? Math.floor(raw) : fallback
}

export function normalizeAutoNumberProperty(property: unknown): NormalizedAutoNumberProperty {
  const obj = asRecord(property)
  const start = Math.max(1, finiteInteger(obj.start ?? obj.startAt, 1))
  const digits = Math.min(12, Math.max(0, finiteInteger(obj.digits, 0)))
  const prefix = typeof obj.prefix === 'string' ? obj.prefix.trim().slice(0, 32) : ''
  return {
    ...obj,
    prefix,
    digits,
    start,
    startAt: start,
    readOnly: true,
  }
}
