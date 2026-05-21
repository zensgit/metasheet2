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
  calendar?: AttendanceRotationAssignmentCalendarLike
}

export interface AttendanceRotationAssignmentPreview {
  ruleId: string
  ruleName: string
  items: AttendanceRotationAssignmentPreviewItem[]
  missingRefs: string[]
  isTruncated: boolean
  projectedDays: number
}

export interface AttendanceRotationAssignmentCalendarLike {
  date: string
  isWorkingDay?: boolean
  label?: string | null
  source?: string
  sourceClass?: string
  tooltip?: string
  hasOverride?: boolean
}

export type AttendanceShiftAssignmentCalendarLike = AttendanceRotationAssignmentCalendarLike

export interface BuildAttendanceRotationAssignmentPreviewInput {
  rotationRuleId: string | null | undefined
  rotationRules: AttendanceRotationAssignmentRuleLike[] | null | undefined
  shifts: AttendanceRotationSequenceShiftLike[] | null | undefined
  startDate: string | null | undefined
  endDate?: string | null
  maxDays?: number
  calendarByDate?: Map<string, AttendanceRotationAssignmentCalendarLike>
}

export interface BuildAttendanceShiftAssignmentPreviewInput {
  shiftId: string | null | undefined
  shifts: AttendanceRotationSequenceShiftLike[] | null | undefined
  startDate: string | null | undefined
  endDate?: string | null
  maxDays?: number
  calendarByDate?: Map<string, AttendanceShiftAssignmentCalendarLike>
}

export interface AttendanceShiftAssignmentPreviewItem {
  date: string
  dayIndex: number
  shiftId: string
  label: string
  schedule: string
  isKnown: boolean
  isOvernight: boolean
  calendar?: AttendanceShiftAssignmentCalendarLike
}

export interface AttendanceShiftAssignmentPreview {
  shiftId: string
  shiftName: string
  items: AttendanceShiftAssignmentPreviewItem[]
  missingShiftId: string | null
  isTruncated: boolean
  projectedDays: number
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

export function buildAttendanceRotationAssignmentCalendarMap(
  items: AttendanceRotationAssignmentCalendarLike[] | null | undefined,
): Map<string, AttendanceRotationAssignmentCalendarLike> {
  const map = new Map<string, AttendanceRotationAssignmentCalendarLike>()
  if (!Array.isArray(items)) return map
  for (const item of items) {
    const date = typeof item.date === 'string' ? item.date.trim() : ''
    if (!DATE_KEY_PATTERN.test(date)) continue
    map.set(date, { ...item, date })
  }
  return map
}

export function buildAttendanceShiftAssignmentCalendarMap(
  items: AttendanceShiftAssignmentCalendarLike[] | null | undefined,
): Map<string, AttendanceShiftAssignmentCalendarLike> {
  return buildAttendanceRotationAssignmentCalendarMap(items)
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
  calendarByDate,
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
    const date = formatDateKey(addDays(start, index))
    if (!shift && hasShiftCatalog && shiftRef && !missingRefs.includes(shiftRef)) {
      missingRefs.push(shiftRef)
    }
    return {
      date,
      dayIndex: index + 1,
      sequenceIndex: index % sequence.length,
      shiftRef,
      label: shift ? `${shift.name} (${shift.id})` : shiftRef,
      schedule: shift ? `${shift.workStartTime} -> ${shift.workEndTime}` : '',
      isKnown: Boolean(shift),
      isOvernight: Boolean(shift?.isOvernight),
      calendar: calendarByDate?.get(date),
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

export function buildAttendanceShiftAssignmentPreview({
  shiftId,
  shifts,
  startDate,
  endDate,
  maxDays,
  calendarByDate,
}: BuildAttendanceShiftAssignmentPreviewInput): AttendanceShiftAssignmentPreview {
  const selectedShiftId = typeof shiftId === 'string' ? shiftId.trim() : ''
  const shiftList = Array.isArray(shifts) ? shifts : []
  const shift = shiftList.find(item => item.id === selectedShiftId)
  const start = parseDateKey(startDate)
  const end = parseDateKey(endDate)
  const previewLimit = normalizeMaxDays(maxDays)
  const empty = {
    shiftId: selectedShiftId,
    shiftName: shift?.name ?? '',
    items: [],
    missingShiftId: null,
    isTruncated: false,
    projectedDays: 0,
  }

  if (!selectedShiftId || !start) return empty
  if (end && end < start) return empty

  const projectedDays = end ? inclusiveDayCount(start, end) : previewLimit
  const visibleDays = Math.min(projectedDays, previewLimit)
  const label = shift ? `${shift.name} (${shift.id})` : selectedShiftId
  const schedule = shift ? `${shift.workStartTime} -> ${shift.workEndTime}` : ''
  const isKnown = Boolean(shift)
  const isOvernight = Boolean(shift?.isOvernight)
  const missingShiftId = !shift && shiftList.length > 0 ? selectedShiftId : null

  const items = Array.from({ length: visibleDays }, (_, index): AttendanceShiftAssignmentPreviewItem => {
    const date = formatDateKey(addDays(start, index))
    return {
      date,
      dayIndex: index + 1,
      shiftId: selectedShiftId,
      label,
      schedule,
      isKnown,
      isOvernight,
      calendar: calendarByDate?.get(date),
    }
  })

  return {
    shiftId: selectedShiftId,
    shiftName: shift?.name ?? selectedShiftId,
    items,
    missingShiftId,
    isTruncated: projectedDays > visibleDays,
    projectedDays,
  }
}
