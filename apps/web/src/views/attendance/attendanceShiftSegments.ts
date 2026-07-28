export interface AttendanceShiftSegment {
  id?: string | null
  segmentIndex: number
  startTime: string
  startDayOffset: 0
  endTime: string
  endDayOffset: 0 | 1
}

export interface AttendanceShiftSegmentDraft {
  startTime: string
  startDayOffset: 0
  endTime: string
  endDayOffset: 0 | 1
}

export interface AttendanceShiftSegmentCapabilities {
  segmentCalculation?: {
    enabled?: boolean
    authoritativeResults?: boolean
    multiSegmentAuthoring?: 'preview_only' | 'enabled'
  }
}

export interface AttendanceShiftSegmentSource {
  workStartTime: string
  workEndTime: string
  segments?: AttendanceShiftSegment[]
  plannedMinutes?: number
  capabilities?: AttendanceShiftSegmentCapabilities
}

export interface AttendanceShiftSegmentAnalysis {
  errors: string[]
  plannedMinutes: number
  unpaidGapMinutes: number
  midnightCrossings: number
  flexEligible: boolean
  compatibilityEnvelope: string
}

type AttendanceShiftSegmentTranslate = (en: string, zh: string) => string

export function cloneAttendanceShiftSegmentDrafts(
  segments: AttendanceShiftSegmentDraft[],
): AttendanceShiftSegmentDraft[] {
  return segments.map(segment => ({
    startTime: segment.startTime,
    startDayOffset: 0,
    endTime: segment.endTime,
    endDayOffset: segment.endDayOffset === 1 ? 1 : 0,
  }))
}

export function normalizeAttendanceShiftSegments(
  shift: AttendanceShiftSegmentSource,
): AttendanceShiftSegmentDraft[] {
  if (Array.isArray(shift.segments) && shift.segments.length > 0) {
    return shift.segments
      .slice()
      .sort((left, right) => Number(left.segmentIndex) - Number(right.segmentIndex))
      .map(segment => ({
        startTime: segment.startTime,
        startDayOffset: 0,
        endTime: segment.endTime,
        endDayOffset: segment.endDayOffset === 1 ? 1 : 0,
      }))
  }
  return [{
    startTime: shift.workStartTime,
    startDayOffset: 0,
    endTime: shift.workEndTime,
    endDayOffset: shift.workEndTime <= shift.workStartTime ? 1 : 0,
  }]
}

export function parseAttendanceShiftClockMinutes(value: string): number | null {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function analyzeAttendanceShiftSegments(
  segments: AttendanceShiftSegmentDraft[],
  tr: AttendanceShiftSegmentTranslate,
): AttendanceShiftSegmentAnalysis {
  const errors: string[] = []
  if (segments.length < 1 || segments.length > 3) {
    errors.push(tr('A shift must contain 1 to 3 segments.', '一个班次必须包含 1 至 3 个时段。'))
  }

  let plannedMinutes = 0
  let unpaidGapMinutes = 0
  let midnightCrossings = 0
  let previousEnd: number | null = null

  segments.forEach((segment, index) => {
    const start = parseAttendanceShiftClockMinutes(segment.startTime)
    const end = parseAttendanceShiftClockMinutes(segment.endTime)
    const row = index + 1
    if (start === null || end === null) {
      errors.push(tr(`Segment ${row} must use HH:MM times.`, `时段 ${row} 必须使用 HH:MM 时间。`))
      return
    }
    const absoluteEnd = end + segment.endDayOffset * 1440
    if (absoluteEnd <= start) {
      errors.push(tr(`Segment ${row} must end after it starts.`, `时段 ${row} 的结束时间必须晚于开始时间。`))
      return
    }
    if (previousEnd !== null && start < previousEnd) {
      errors.push(tr(`Segment ${row} overlaps or is out of order.`, `时段 ${row} 与前一时段重叠或顺序错误。`))
    } else if (previousEnd !== null) {
      unpaidGapMinutes += start - previousEnd
    }
    plannedMinutes += absoluteEnd - start
    previousEnd = absoluteEnd
    if (segment.endDayOffset === 1) midnightCrossings += 1
  })

  if (midnightCrossings > 1) {
    errors.push(tr('At most one segment may cross midnight.', '最多只能有一个时段跨午夜。'))
  }
  if (plannedMinutes > 1440) {
    errors.push(tr('Total planned time cannot exceed 24 hours.', '计划总时长不能超过 24 小时。'))
  }

  const first = segments[0]
  const last = segments[segments.length - 1]
  return {
    errors: Array.from(new Set(errors)),
    plannedMinutes,
    unpaidGapMinutes,
    midnightCrossings,
    flexEligible: segments.length === 1,
    compatibilityEnvelope: first && last
      ? `${first.startTime} - ${last.endTime}${midnightCrossings > 0 ? tr(' (next day)', '（次日）') : ''}`
      : '--',
  }
}

export function formatAttendanceShiftSegments(
  shift: AttendanceShiftSegmentSource,
  tr: AttendanceShiftSegmentTranslate,
): string {
  return normalizeAttendanceShiftSegments(shift)
    .map(segment => `${segment.startTime}-${segment.endTime}${segment.endDayOffset === 1 ? tr(' next day', ' 次日') : ''}`)
    .join(' / ')
}

export function calculateAttendanceShiftPlannedMinutes(shift: AttendanceShiftSegmentSource): number {
  if (typeof shift.plannedMinutes === 'number' && Number.isFinite(shift.plannedMinutes)) {
    return shift.plannedMinutes
  }
  return normalizeAttendanceShiftSegments(shift).reduce((total, segment) => {
    const start = parseAttendanceShiftClockMinutes(segment.startTime)
    const end = parseAttendanceShiftClockMinutes(segment.endTime)
    if (start === null || end === null) return total
    return total + Math.max(0, end + segment.endDayOffset * 1440 - start)
  }, 0)
}

export function isAttendanceShiftPreviewOnly(shift: AttendanceShiftSegmentSource): boolean {
  if (normalizeAttendanceShiftSegments(shift).length <= 1) return false
  const capability = shift.capabilities?.segmentCalculation
  return capability?.authoritativeResults !== true || capability?.multiSegmentAuthoring !== 'enabled'
}
