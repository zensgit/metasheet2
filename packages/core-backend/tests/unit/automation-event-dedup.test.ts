import { describe, expect, it } from 'vitest'

import {
  buildAutomationEventDedupKey,
  eventDedupRetentionCutoffIso,
  EVENT_DEDUP_RETENTION_DAYS,
  newAutomationEventId,
  withAutomationEventId,
} from '../../src/multitable/automation-event-dedup'

describe('automation event dedup helpers', () => {
  it('builds event-type scoped dedup keys from stamped event ids', () => {
    expect(buildAutomationEventDedupKey('multitable.record.updated', { _eventId: 'evt_1' })).toBe(
      'multitable.record.updated:evt_1',
    )
    expect(buildAutomationEventDedupKey('multitable.record.created', { _eventId: ' evt_2 ' })).toBe(
      'multitable.record.created:evt_2',
    )
  })

  it('fails open when the event id is absent or invalid', () => {
    expect(buildAutomationEventDedupKey('multitable.record.updated', {})).toBeNull()
    expect(buildAutomationEventDedupKey('multitable.record.updated', { _eventId: '' })).toBeNull()
    expect(buildAutomationEventDedupKey('multitable.record.updated', { _eventId: 42 })).toBeNull()
    expect(buildAutomationEventDedupKey('multitable.record.updated', null)).toBeNull()
    expect(buildAutomationEventDedupKey('multitable.record.updated', undefined)).toBeNull()
    expect(buildAutomationEventDedupKey('multitable.record.updated', [])).toBeNull()
  })

  it('stamps payloads with fresh event ids', () => {
    const a = withAutomationEventId({ sheetId: 'sheet_1', recordId: 'rec_1' })
    const b = withAutomationEventId({ sheetId: 'sheet_1', recordId: 'rec_1' })
    expect(a).toMatchObject({ sheetId: 'sheet_1', recordId: 'rec_1', _eventId: expect.any(String) })
    expect(a._eventId).not.toBe(b._eventId)
    expect(newAutomationEventId()).toEqual(expect.any(String))
  })

  it('computes the seven-day ledger retention cutoff', () => {
    const now = Date.parse('2026-07-01T12:00:00.000Z')
    expect(EVENT_DEDUP_RETENTION_DAYS).toBe(7)
    expect(eventDedupRetentionCutoffIso(now)).toBe('2026-06-24T12:00:00.000Z')
  })
})
