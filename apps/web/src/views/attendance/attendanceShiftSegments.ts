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

export type AttendanceShiftFlexMode = 'strict' | 'flex_required_duration'

export interface AttendanceShiftFlexPolicyStrict {
  mode: 'strict'
}

export interface AttendanceShiftFlexPolicyRequiredDuration {
  mode: 'flex_required_duration'
  requiredMinutes: number
  arrivalWindowBeforeMinutes: number
  arrivalWindowAfterMinutes: number
  coreStartTime: string | null
  coreEndTime: string | null
}

export type AttendanceShiftFlexPolicy =
  | AttendanceShiftFlexPolicyStrict
  | AttendanceShiftFlexPolicyRequiredDuration

export interface AttendanceShiftSegmentAnalysis {
  errors: string[]
  plannedMinutes: number
  unpaidGapMinutes: number
  midnightCrossings: number
  flexEligible: boolean
  compatibilityEnvelope: string
}

export interface AttendanceShiftFlexAnalysis {
  errors: string[]
  explain: string[]
  plannedMinutes: number | null
}

const FLEX_MAX_REQUIRED_MINUTES = 1440
const FLEX_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

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

export function defaultAttendanceShiftFlexPolicy(): AttendanceShiftFlexPolicyStrict {
  return { mode: 'strict' }
}

export function normalizeAttendanceShiftFlexPolicy(
  value: unknown,
): AttendanceShiftFlexPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultAttendanceShiftFlexPolicy()
  }
  const record = value as Record<string, unknown>
  if (record.mode === 'flex_required_duration') {
    return {
      mode: 'flex_required_duration',
      requiredMinutes: typeof record.requiredMinutes === 'number'
        ? record.requiredMinutes
        : Number.NaN,
      arrivalWindowBeforeMinutes: typeof record.arrivalWindowBeforeMinutes === 'number'
        ? record.arrivalWindowBeforeMinutes
        : Number.NaN,
      arrivalWindowAfterMinutes: typeof record.arrivalWindowAfterMinutes === 'number'
        ? record.arrivalWindowAfterMinutes
        : Number.NaN,
      coreStartTime: typeof record.coreStartTime === 'string' ? record.coreStartTime : null,
      coreEndTime: typeof record.coreEndTime === 'string' ? record.coreEndTime : null,
    }
  }
  return defaultAttendanceShiftFlexPolicy()
}

/**
 * Authoring guarantee mirrored from backend: every allowed clamped expected-start
 * covers optional core hours (latest start <= coreStart and earliest start +
 * requiredMinutes >= coreEnd). No runtime reasonCode is invented for core.
 */
export function flexCoreHoursCoveredByAllClampedIntervals(input: {
  segmentStartMinutes: number
  arrivalWindowBeforeMinutes: number
  arrivalWindowAfterMinutes: number
  requiredMinutes: number
  coreStartMinutes: number
  coreEndMinutes: number
}): boolean {
  if (!(input.coreEndMinutes > input.coreStartMinutes)) return false
  if (!(input.requiredMinutes > 0)) return false
  if (input.arrivalWindowBeforeMinutes < 0 || input.arrivalWindowAfterMinutes < 0) return false
  const earliest = input.segmentStartMinutes - input.arrivalWindowBeforeMinutes
  const latest = input.segmentStartMinutes + input.arrivalWindowAfterMinutes
  return latest <= input.coreStartMinutes
    && earliest + input.requiredMinutes >= input.coreEndMinutes
}

/**
 * Client-side flex policy validation (mirrors backend §3.3). Multi-segment flex
 * is rejected. Grace fields are intentionally not part of flex.
 */
export function analyzeAttendanceShiftFlexPolicy(
  policy: AttendanceShiftFlexPolicy,
  segmentCount: number,
  tr: AttendanceShiftSegmentTranslate,
  segmentStartTime: string | null = null,
): AttendanceShiftFlexAnalysis {
  const errors: string[] = []
  const explain: string[] = []

  if (policy.mode === 'strict') {
    explain.push(tr(
      'Strict mode: expected start/end follow the paid segment times. Grace only moves late/early thresholds.',
      '严格模式：期望上下班时间跟随计薪时段。宽限只移动迟到/早退阈值，不是弹性。',
    ))
    return { errors, explain, plannedMinutes: null }
  }

  if (segmentCount !== 1) {
    errors.push(tr(
      'Flexible required-duration mode is available only for a one-segment shift.',
      '弹性应工时模式仅支持单时段班次。',
    ))
  }

  if (
    !Number.isInteger(policy.requiredMinutes)
    || policy.requiredMinutes <= 0
    || policy.requiredMinutes > FLEX_MAX_REQUIRED_MINUTES
  ) {
    errors.push(tr(
      'Required minutes must be an integer from 1 to 1440.',
      '应工时分钟必须是 1 到 1440 的整数。',
    ))
  }
  if (!Number.isInteger(policy.arrivalWindowBeforeMinutes) || policy.arrivalWindowBeforeMinutes < 0) {
    errors.push(tr(
      'Arrival window before minutes must be a non-negative integer.',
      '到岗窗口提前分钟必须是非负整数。',
    ))
  }
  if (!Number.isInteger(policy.arrivalWindowAfterMinutes) || policy.arrivalWindowAfterMinutes < 0) {
    errors.push(tr(
      'Arrival window after minutes must be a non-negative integer.',
      '到岗窗口延后分钟必须是非负整数。',
    ))
  }

  const coreStart = policy.coreStartTime
  const coreEnd = policy.coreEndTime
  if ((coreStart == null) !== (coreEnd == null)) {
    errors.push(tr(
      'Core hours must set both start and end, or leave both empty.',
      '核心时段必须同时设置开始和结束，或全部留空。',
    ))
  } else if (coreStart != null && coreEnd != null) {
    if (!FLEX_TIME_PATTERN.test(coreStart) || !FLEX_TIME_PATTERN.test(coreEnd)) {
      errors.push(tr('Core hours must use HH:MM times.', '核心时段必须使用 HH:MM 时间。'))
    } else {
      const coreStartMin = parseAttendanceShiftClockMinutes(coreStart)
      const coreEndMin = parseAttendanceShiftClockMinutes(coreEnd)
      const segmentStartMin = segmentStartTime
        ? parseAttendanceShiftClockMinutes(segmentStartTime)
        : null
      if (coreStartMin == null || coreEndMin == null || coreEndMin <= coreStartMin) {
        errors.push(tr(
          'Core hours must be a positive same-day interval.',
          '核心时段必须是当日正时长区间。',
        ))
      } else if (segmentStartMin == null) {
        errors.push(tr(
          'Core hours require a single-segment start time.',
          '核心时段需要单时段开始时间。',
        ))
      } else if (!flexCoreHoursCoveredByAllClampedIntervals({
        segmentStartMinutes: segmentStartMin,
        arrivalWindowBeforeMinutes: policy.arrivalWindowBeforeMinutes,
        arrivalWindowAfterMinutes: policy.arrivalWindowAfterMinutes,
        requiredMinutes: policy.requiredMinutes,
        coreStartMinutes: coreStartMin,
        coreEndMinutes: coreEndMin,
      })) {
        errors.push(tr(
          'Core hours must be covered by every allowed clamped arrival (latest start ≤ core start; earliest start + required minutes ≥ core end).',
          '核心时段必须被每一个允许的夹取到岗覆盖（最晚到岗 ≤ 核心开始；最早到岗 + 应工时 ≥ 核心结束）。',
        ))
      }
    }
  }

  explain.push(tr(
    'Flex mode: expected start is the first valid arrival clamped to the arrival window around segment start; expected end is expected start plus required minutes. Grace applies only after that resolution.',
    '弹性模式：期望上班时间是首次有效到岗时间并夹取到以时段开始为锚点的到岗窗口；期望下班 = 期望上班 + 应工时。宽限只在弹性期望解析之后生效。',
  ))
  if (coreStart && coreEnd) {
    explain.push(tr(
      `Optional core hours ${coreStart}-${coreEnd} are validated at save so every allowed arrival still covers them.`,
      `可选核心时段 ${coreStart}-${coreEnd} 在保存时校验，确保每一个允许的到岗仍覆盖核心时段。`,
    ))
  }

  return {
    errors: Array.from(new Set(errors)),
    explain,
    plannedMinutes: Number.isInteger(policy.requiredMinutes) ? policy.requiredMinutes : null,
  }
}

export function formatAttendanceShiftFlexPolicy(
  policy: AttendanceShiftFlexPolicy | null | undefined,
  tr: AttendanceShiftSegmentTranslate,
): string {
  const normalized = normalizeAttendanceShiftFlexPolicy(policy)
  if (normalized.mode === 'strict') {
    return tr('Strict', '严格')
  }
  const core = normalized.coreStartTime && normalized.coreEndTime
    ? tr(
        `, core ${normalized.coreStartTime}-${normalized.coreEndTime}`,
        `，核心 ${normalized.coreStartTime}-${normalized.coreEndTime}`,
      )
    : ''
  return tr(
    `Flex ${normalized.requiredMinutes}m (arrival -${normalized.arrivalWindowBeforeMinutes}/+${normalized.arrivalWindowAfterMinutes})${core}`,
    `弹性 ${normalized.requiredMinutes} 分钟（到岗 -${normalized.arrivalWindowBeforeMinutes}/+${normalized.arrivalWindowAfterMinutes}）${core}`,
  )
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
