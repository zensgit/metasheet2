import { describe, expect, it } from 'vitest'
import {
  formatPlmAuditDateTimeInputValue,
  normalizePlmAuditDateTimeTransport,
} from '../src/views/plmAuditDateTimeTransport'

function formatLocalDateTimeInput(value: string) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

describe('plmAuditDateTimeTransport', () => {
  it('normalizes datetime-local input into canonical ISO transport', () => {
    const localInput = '2026-03-11T15:00'

    expect(normalizePlmAuditDateTimeTransport(localInput)).toBe(new Date(localInput).toISOString())
  })

  it('keeps canonical ISO transport stable', () => {
    const transport = '2026-03-11T15:00:00.000Z'

    expect(normalizePlmAuditDateTimeTransport(transport)).toBe(transport)
  })

  it('formats canonical transport for datetime-local inputs', () => {
    const transport = '2026-03-11T15:00:00.000Z'

    expect(formatPlmAuditDateTimeInputValue(transport)).toBe(formatLocalDateTimeInput(transport))
  })

  it('drops invalid datetime values', () => {
    expect(normalizePlmAuditDateTimeTransport('not-a-date')).toBe('')
    expect(formatPlmAuditDateTimeInputValue('not-a-date')).toBe('')
  })
})
