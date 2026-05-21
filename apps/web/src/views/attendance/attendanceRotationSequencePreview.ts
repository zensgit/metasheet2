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
