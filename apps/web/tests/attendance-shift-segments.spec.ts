import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import AttendanceShiftFlexPolicyEditor from '../src/views/attendance/AttendanceShiftFlexPolicyEditor.vue'
import {
  analyzeAttendanceShiftFlexPolicy,
  analyzeAttendanceShiftSegments,
  calculateAttendanceShiftPlannedMinutes,
  isAttendanceShiftPreviewOnly,
  normalizeAttendanceShiftFlexPolicy,
  normalizeAttendanceShiftSegments,
  parseAttendanceShiftClockMinutes,
  type AttendanceShiftFlexPolicy,
  type AttendanceShiftSegmentDraft,
} from '../src/views/attendance/attendanceShiftSegments'

const tr = (en: string): string => en

function segment(
  startTime: string,
  endTime: string,
  endDayOffset: 0 | 1 = 0,
): AttendanceShiftSegmentDraft {
  return {
    startTime,
    startDayOffset: 0,
    endTime,
    endDayOffset,
  }
}

describe('attendance shift segment analysis', () => {
  it('accepts only strict minute-resolution wall-clock values', () => {
    expect(parseAttendanceShiftClockMinutes('00:00')).toBe(0)
    expect(parseAttendanceShiftClockMinutes('23:59')).toBe(1439)
    expect(parseAttendanceShiftClockMinutes('9:00')).toBeNull()
    expect(parseAttendanceShiftClockMinutes('09:00:00')).toBeNull()
    expect(parseAttendanceShiftClockMinutes('24:00')).toBeNull()
    expect(parseAttendanceShiftClockMinutes('12:60')).toBeNull()
  })

  it('sums paid segments without counting the gap and blocks multi-segment flex', () => {
    const result = analyzeAttendanceShiftSegments([
      segment('08:00', '12:00'),
      segment('13:00', '17:00'),
    ], tr)

    expect(result).toEqual({
      errors: [],
      plannedMinutes: 480,
      unpaidGapMinutes: 60,
      midnightCrossings: 0,
      flexEligible: false,
      compatibilityEnvelope: '08:00 - 17:00',
    })
  })

  it('validates W5 flex policy, core coverage, and rejects multi-segment flex without silent reset', () => {
    expect(normalizeAttendanceShiftFlexPolicy(undefined)).toEqual({ mode: 'strict' })
    // 09:00 ±60 covers core 10:00-15:00 with required 480.
    const ok = analyzeAttendanceShiftFlexPolicy({
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 60,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }, 1, tr, '09:00')
    expect(ok.errors).toEqual([])
    expect(ok.plannedMinutes).toBe(480)

    // after=120 => latest start 11:00 > coreStart 10:00 (duration-only would pass)
    const uncoveredLatest = analyzeAttendanceShiftFlexPolicy({
      mode: 'flex_required_duration',
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 60,
      arrivalWindowAfterMinutes: 120,
      coreStartTime: '10:00',
      coreEndTime: '15:00',
    }, 1, tr, '09:00')
    expect(uncoveredLatest.errors.some((error) => error.includes('Core hours must be covered'))).toBe(true)

    // earliest+required cannot reach core end (duration-only would pass: 360>=360)
    const uncoveredEarliest = analyzeAttendanceShiftFlexPolicy({
      mode: 'flex_required_duration',
      requiredMinutes: 360,
      arrivalWindowBeforeMinutes: 120,
      arrivalWindowAfterMinutes: 0,
      coreStartTime: '09:00',
      coreEndTime: '15:00',
    }, 1, tr, '09:00')
    expect(uncoveredEarliest.errors.some((error) => error.includes('Core hours must be covered'))).toBe(true)

    // Multi-segment flex: preserve policy intent in the analyzer input; surface error
    // (UI must not silently rewrite flexPolicy to strict — save is blocked instead).
    const multiPolicy = {
      mode: 'flex_required_duration' as const,
      requiredMinutes: 480,
      arrivalWindowBeforeMinutes: 0,
      arrivalWindowAfterMinutes: 0,
      coreStartTime: null,
      coreEndTime: null,
    }
    const multi = analyzeAttendanceShiftFlexPolicy(multiPolicy, 2, tr)
    expect(multi.errors).toContain(
      'Flexible required-duration mode is available only for a one-segment shift.',
    )
    expect(multiPolicy.mode).toBe('flex_required_duration')
  })

  it('keeps the selected flex policy visible when segments become ineligible and allows an explicit reset', async () => {
    const policy = ref<AttendanceShiftFlexPolicy>({ mode: 'strict' })
    const flexEligible = ref(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      setup() {
        return () => h(AttendanceShiftFlexPolicyEditor, {
          policy: policy.value,
          'onUpdate:policy': (next: AttendanceShiftFlexPolicy) => {
            policy.value = next
          },
          flexEligible: flexEligible.value,
          analysis: analyzeAttendanceShiftFlexPolicy(
            policy.value,
            flexEligible.value ? 1 : 2,
            tr,
            '09:00',
          ),
        })
      },
    })

    try {
      app.mount(container)
      const mode = container.querySelector<HTMLSelectElement>('[data-attendance-shift-flex-mode]')!
      mode.value = 'flex_required_duration'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()

      expect(policy.value).toEqual({
        mode: 'flex_required_duration',
        requiredMinutes: 480,
        arrivalWindowBeforeMinutes: 60,
        arrivalWindowAfterMinutes: 120,
        coreStartTime: null,
        coreEndTime: null,
      })

      flexEligible.value = false
      await nextTick()
      expect(policy.value.mode).toBe('flex_required_duration')
      expect(mode.value).toBe('flex_required_duration')
      expect(container.querySelector('[data-attendance-shift-flex-errors]')?.textContent)
        .toContain('Flexible required-duration mode is available only for a one-segment shift.')

      mode.value = 'strict'
      mode.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(policy.value).toEqual({ mode: 'strict' })
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it('keeps one final cross-midnight segment on the originating shift day', () => {
    const result = analyzeAttendanceShiftSegments([
      segment('20:00', '22:00'),
      segment('23:00', '02:00', 1),
    ], tr)

    expect(result.errors).toEqual([])
    expect(result.plannedMinutes).toBe(300)
    expect(result.unpaidGapMinutes).toBe(60)
    expect(result.midnightCrossings).toBe(1)
    expect(result.compatibilityEnvelope).toBe('20:00 - 02:00 (next day)')
  })

  it('rejects missing, excess, non-positive, overlapping, and non-terminal midnight segments', () => {
    expect(analyzeAttendanceShiftSegments([], tr).errors).toContain(
      'A shift must contain 1 to 3 segments.',
    )
    expect(analyzeAttendanceShiftSegments([
      segment('08:00', '09:00'),
      segment('10:00', '11:00'),
      segment('12:00', '13:00'),
      segment('14:00', '15:00'),
    ], tr).errors).toContain('A shift must contain 1 to 3 segments.')
    expect(analyzeAttendanceShiftSegments([
      segment('09:00', '09:00'),
    ], tr).errors).toContain('Segment 1 must end after it starts.')
    expect(analyzeAttendanceShiftSegments([
      segment('08:00', '12:00'),
      segment('11:00', '17:00'),
    ], tr).errors).toContain('Segment 2 overlaps or is out of order.')
    expect(analyzeAttendanceShiftSegments([
      segment('22:00', '02:00', 1),
      segment('03:00', '04:00', 1),
    ], tr).errors).toEqual(expect.arrayContaining([
      'Segment 2 overlaps or is out of order.',
      'At most one segment may cross midnight.',
    ]))
  })

  it('rejects aggregate planned time above the 24-hour ceiling', () => {
    const result = analyzeAttendanceShiftSegments([
      segment('00:00', '23:59'),
      segment('00:00', '23:59'),
      segment('00:00', '23:59'),
    ], tr)

    expect(result.plannedMinutes).toBe(4317)
    expect(result.errors).toContain('Total planned time cannot exceed 24 hours.')
  })

  it('normalizes persisted order and synthesizes a legacy overnight segment', () => {
    expect(normalizeAttendanceShiftSegments({
      workStartTime: '08:00',
      workEndTime: '17:00',
      segments: [
        { segmentIndex: 1, startTime: '13:00', startDayOffset: 0, endTime: '17:00', endDayOffset: 0 },
        { segmentIndex: 0, startTime: '08:00', startDayOffset: 0, endTime: '12:00', endDayOffset: 0 },
      ],
    })).toEqual([
      segment('08:00', '12:00'),
      segment('13:00', '17:00'),
    ])
    expect(normalizeAttendanceShiftSegments({
      workStartTime: '22:00',
      workEndTime: '06:00',
    })).toEqual([segment('22:00', '06:00', 1)])
  })

  it('uses an authoritative finite planned total and otherwise falls back to segment sums', () => {
    const shift = {
      workStartTime: '08:00',
      workEndTime: '17:00',
      segments: [
        { segmentIndex: 0, ...segment('08:00', '12:00') },
        { segmentIndex: 1, ...segment('13:00', '17:00') },
      ],
    }

    expect(calculateAttendanceShiftPlannedMinutes({ ...shift, plannedMinutes: 475 })).toBe(475)
    expect(calculateAttendanceShiftPlannedMinutes({ ...shift, plannedMinutes: Number.NaN })).toBe(480)
  })

  it('fails closed to preview-only unless multi-segment calculation is authoritative', () => {
    const shift = {
      workStartTime: '08:00',
      workEndTime: '17:00',
      segments: [
        { segmentIndex: 0, ...segment('08:00', '12:00') },
        { segmentIndex: 1, ...segment('13:00', '17:00') },
      ],
    }

    expect(isAttendanceShiftPreviewOnly(shift)).toBe(true)
    expect(isAttendanceShiftPreviewOnly({
      ...shift,
      capabilities: {
        segmentCalculation: {
          authoritativeResults: true,
          multiSegmentAuthoring: 'enabled' as const,
        },
      },
    })).toBe(false)
    expect(isAttendanceShiftPreviewOnly({
      workStartTime: '09:00',
      workEndTime: '18:00',
    })).toBe(false)
  })
})
