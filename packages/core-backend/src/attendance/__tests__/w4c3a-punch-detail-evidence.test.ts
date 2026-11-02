import { describe, expect, it } from 'vitest'
import {
  computeRawImportEvidenceDigestV1,
  parseRawImportEvidenceV1,
} from '../w4c3a-legacy-execution-plan'
import { expandAttendancePunchDetailEvidenceV1 } from '../w4c3a-punch-detail-evidence'

const batch = 'b62fe9a4-821f-4a2c-b917-0380dd12bd98'
function input() {
  return {
    inputKind: 'punch_events_v1',
    userId: 'synthetic-employee',
    workDate: '2025-11-02',
    timezone: 'America/New_York',
    punches: [
      { direction: 'check_in', occurredAt: '2025-11-02T04:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T04:45:00.000Z' },
      { direction: 'check_in', occurredAt: '2025-11-02T05:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T08:00:00.000Z' },
    ],
  }
}

describe('punch-detail physical evidence expansion', () => {
  it('preserves all four instants and generates distinct existing-kernel evidence refs', () => {
    const raw = expandAttendancePunchDetailEvidenceV1(input(), batch)
    expect(raw.flatMap((item) => item.punches)).toEqual(input().punches)
    expect(raw.map((item) => item.sourceOrdinal)).toEqual([0, 1, 2, 3])
    expect(raw.map((item) => 'import:' + batch + ':' + item.sourceOrdinal + ':' + item.punches[0].direction)).toEqual([
      'import:' + batch + ':0:check_in',
      'import:' + batch + ':1:check_out',
      'import:' + batch + ':2:check_in',
      'import:' + batch + ':3:check_out',
    ])
    expect(raw.map((item) => item.provenance.sourceRef)).toEqual(
      [0, 1, 2, 3].map((ordinal) => 'attendance-import:' + batch + ':punch_events_v1:' + ordinal),
    )
    expect(raw.map(parseRawImportEvidenceV1)).toEqual(raw)
  })

  it('records only the actual endpoint and no imported daily metrics or status', () => {
    const raw = expandAttendancePunchDetailEvidenceV1(input(), batch)
    for (const [index, item] of raw.entries()) {
      const event = input().punches[index]
      const absent = { present: false, value: null }
      expect(item.fields).toEqual({
        userId: { present: true, value: input().userId },
        workDate: { present: true, value: input().workDate },
        timezone: { present: true, value: input().timezone },
        firstInAt: event.direction === 'check_in' ? { present: true, value: event.occurredAt } : absent,
        lastOutAt: event.direction === 'check_out' ? { present: true, value: event.occurredAt } : absent,
        status: absent,
        isWorkday: absent,
      })
      expect(item.metrics).toEqual({
        workMinutes: absent, lateMinutes: absent, earlyLeaveMinutes: absent,
        leaveMinutes: absent, overtimeMinutes: absent,
      })
    }
  })

  it('binds the second pair to the existing immutable raw-evidence digest', () => {
    const raw = expandAttendancePunchDetailEvidenceV1(input(), batch)
    const changed = input()
    changed.punches[2].occurredAt = '2025-11-02T05:31:00.000Z'
    const other = expandAttendancePunchDetailEvidenceV1(changed, batch)
    const digest = (items: typeof raw) => computeRawImportEvidenceDigestV1(items.map((rawEvidence, ordinal) => ({
      kind: 'apply' as const,
      ordinal,
      semanticOrdinal: ordinal,
      itemId: '00000000-0000-4000-8000-' + String(ordinal).padStart(12, '0'),
      targetRef: JSON.stringify(['synthetic-org', input().userId, input().workDate]),
      previewSnapshot: { inputKind: 'punch_events_v1', event: input().punches[ordinal] },
      recordWriteRef: 'synthetic-target',
      rawEvidence,
    })))
    expect(digest(raw)).not.toBe(digest(other))
    expect(digest(raw)).not.toBe(digest(raw.slice(0, 2)))
  })

  it('does not broaden V1 to admit the whole four-event input as a daily row', () => {
    const raw = expandAttendancePunchDetailEvidenceV1(input(), batch)
    expect(() => parseRawImportEvidenceV1({ ...raw[0], punches: input().punches }))
      .toThrowError('W4C3A_RAW_IMPORT_EVIDENCE_INVALID')
  })

  it('retains a single checkout as one raw partial without synthesizing a pair', () => {
    const request = { ...input(), punches: [input().punches[3]] }
    const raw = expandAttendancePunchDetailEvidenceV1(request, batch)
    expect(raw).toHaveLength(1)
    expect(raw[0].punches).toEqual(request.punches)
    expect(raw[0].fields.firstInAt).toEqual({ present: false, value: null })
  })

  it.each(['', 'other-batch', batch.toUpperCase()])('rejects a noncanonical server batch identity', (id) => {
    expect(() => expandAttendancePunchDetailEvidenceV1(input(), id))
      .toThrowError('ATTENDANCE_PUNCH_DETAIL_INPUT_INVALID')
  })
})
