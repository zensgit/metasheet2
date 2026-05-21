export interface AttendanceRotationSequenceShiftLike {
  id: string
  name: string
  workStartTime: string
  workEndTime: string
  isOvernight?: boolean
}

export interface AttendanceRotationSequencePreviewItem {
  dayIndex: number
  shiftRef: string
  label: string
  schedule: string
  isKnown: boolean
  isOvernight: boolean
}

export interface AttendanceRotationSequencePreview {
  items: AttendanceRotationSequencePreviewItem[]
  missingRefs: string[]
}

export interface AttendanceRotationAssignmentRuleLike {
  id: string
  name: string
  shiftSequence: string[]
}

export interface AttendanceRotationAssignmentPreviewItem extends AttendanceRotationSequencePreviewItem {
  date: string
  sequenceIndex: number
}

export interface AttendanceRotationAssignmentPreview {
  ruleId: string
  ruleName: string
  items: AttendanceRotationAssignmentPreviewItem[]
  missingRefs: string[]
  isTruncated: boolean
  projectedDays: number
}

export interface BuildAttendanceRotationAssignmentPreviewInput {
  rotationRuleId: string | null | undefined
  rotationRules: AttendanceRotationAssignmentRuleLike[] | null | undefined
  shifts: AttendanceRotationSequenceShiftLike[] | null | undefined
  startDate: string | null | undefined
  endDate?: string | null
  maxDays?: number
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseDateKey(value: string | null | undefined): Date | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!DATE_KEY_PATTERN.test(text)) return null
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || formatDateKey(date) !== text ? null : date
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function inclusiveDayCount(startDate: Date, endDate: Date): number {
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1
}

function normalizeMaxDays(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 14
  return Math.min(Math.max(Math.floor(value), 1), 60)
}

export function parseAttendanceRotationSequenceInput(value: string | string[] | null | undefined): string[] {
  const source = Array.isArray(value) ? value.join(',') : value ?? ''
  return source
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

export function buildAttendanceRotationSequencePreview(
  value: string | string[] | null | undefined,
  shifts: AttendanceRotationSequenceShiftLike[] | null | undefined,
): AttendanceRotationSequencePreview {
  const sequence = parseAttendanceRotationSequenceInput(value)
  const shiftList = Array.isArray(shifts) ? shifts : []
  const hasShiftCatalog = shiftList.length > 0
  const shiftById = new Map(shiftList.map(shift => [shift.id, shift]))
  const missingRefs: string[] = []

  const items = sequence.map((shiftRef, index): AttendanceRotationSequencePreviewItem => {
    const shift = shiftById.get(shiftRef)
    if (!shift && hasShiftCatalog && !missingRefs.includes(shiftRef)) {
      missingRefs.push(shiftRef)
    }
    const label = shift ? `${shift.name} (${shift.id})` : shiftRef
    const schedule = shift ? `${shift.workStartTime} -> ${shift.workEndTime}` : ''
    return {
      dayIndex: index + 1,
      shiftRef,
      label,
      schedule,
      isKnown: Boolean(shift),
      isOvernight: Boolean(shift?.isOvernight),
    }
  })

  return { items, missingRefs }
}

export function buildAttendanceRotationAssignmentPreview({
  rotationRuleId,
  rotationRules,
  shifts,
  startDate,
  endDate,
  maxDays,
}: BuildAttendanceRotationAssignmentPreviewInput): AttendanceRotationAssignmentPreview {
  const selectedRuleId = typeof rotationRuleId === 'string' ? rotationRuleId.trim() : ''
  const ruleList = Array.isArray(rotationRules) ? rotationRules : []
  const rule = ruleList.find(item => item.id === selectedRuleId)
  const start = parseDateKey(startDate)
  const end = parseDateKey(endDate)
  const previewLimit = normalizeMaxDays(maxDays)
  const empty = {
    ruleId: selectedRuleId,
    ruleName: rule?.name ?? '',
    items: [],
    missingRefs: [],
    isTruncated: false,
    projectedDays: 0,
  }

  if (!rule || !start) return empty
  if (end && end < start) return empty

  const sequence = parseAttendanceRotationSequenceInput(rule.shiftSequence)
  if (sequence.length === 0) return empty

  const projectedDays = end ? inclusiveDayCount(start, end) : previewLimit
  const visibleDays = Math.min(projectedDays, previewLimit)
  const shiftList = Array.isArray(shifts) ? shifts : []
  const hasShiftCatalog = shiftList.length > 0
  const shiftById = new Map(shiftList.map(shift => [shift.id, shift]))
  const missingRefs: string[] = []

  const items = Array.from({ length: visibleDays }, (_, index): AttendanceRotationAssignmentPreviewItem => {
    const shiftRef = sequence[index % sequence.length] ?? ''
    const shift = shiftById.get(shiftRef)
    if (!shift && hasShiftCatalog && shiftRef && !missingRefs.includes(shiftRef)) {
      missingRefs.push(shiftRef)
    }
    return {
      date: formatDateKey(addDays(start, index)),
      dayIndex: index + 1,
      sequenceIndex: index % sequence.length,
      shiftRef,
      label: shift ? `${shift.name} (${shift.id})` : shiftRef,
      schedule: shift ? `${shift.workStartTime} -> ${shift.workEndTime}` : '',
      isKnown: Boolean(shift),
      isOvernight: Boolean(shift?.isOvernight),
    }
  })

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    items,
    missingRefs,
    isTruncated: projectedDays > visibleDays,
    projectedDays,
  }
}
