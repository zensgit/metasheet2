type Translate = (en: string, zh: string) => string

export interface AttendanceScheduleAssignmentLike {
  assignment: {
    id: string
    userId: string
    shiftId?: string
    startDate: string
    endDate: string | null
    isActive: boolean
  }
  shift?: {
    id?: string
    name?: string
  }
}

export interface AttendanceScheduleRotationAssignmentLike {
  assignment: {
    id: string
    userId: string
    rotationRuleId?: string
    startDate: string
    endDate: string | null
    isActive: boolean
  }
  rotation?: {
    id?: string
    name?: string
  }
}

export interface AttendanceScheduleAssignmentDraft {
  id?: string | null
  userId: string
  refId: string
  refLabel?: string
  startDate: string
  endDate: string | null
  isActive: boolean
}

export type AttendanceScheduleConflictDiagnosticCode =
  | 'shift_assignment_overlap'
  | 'rotation_assignment_overlap'
  | 'rotation_overrides_shift'

export interface AttendanceScheduleConflictDiagnostic {
  key: string
  code: AttendanceScheduleConflictDiagnosticCode
  severity: 'warning'
  userId: string
  primaryLabel: string
  secondaryLabel: string
  overlapStart: string
  overlapEnd: string | null
}

export interface BuildAttendanceScheduleConflictDiagnosticsInput {
  assignments?: AttendanceScheduleAssignmentLike[]
  rotationAssignments?: AttendanceScheduleRotationAssignmentLike[]
  assignmentDraft?: AttendanceScheduleAssignmentDraft | null
  rotationAssignmentDraft?: AttendanceScheduleAssignmentDraft | null
}

interface NormalizedScheduleInterval {
  id: string
  kind: 'shift' | 'rotation'
  userId: string
  refLabel: string
  startDate: string
  endDate: string | null
}

function dateKey(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function normalizeOpenEnd(value: unknown): string | null {
  const endDate = dateKey(value)
  return endDate || null
}

function overlaps(left: NormalizedScheduleInterval, right: NormalizedScheduleInterval): boolean {
  const leftEnd = left.endDate ?? '9999-12-31'
  const rightEnd = right.endDate ?? '9999-12-31'
  return left.startDate <= rightEnd && right.startDate <= leftEnd
}

function overlapStart(left: NormalizedScheduleInterval, right: NormalizedScheduleInterval): string {
  return left.startDate > right.startDate ? left.startDate : right.startDate
}

function overlapEnd(left: NormalizedScheduleInterval, right: NormalizedScheduleInterval): string | null {
  const leftEnd = left.endDate ?? '9999-12-31'
  const rightEnd = right.endDate ?? '9999-12-31'
  const endDate = leftEnd < rightEnd ? leftEnd : rightEnd
  return endDate === '9999-12-31' ? null : endDate
}

function normalizeInterval(input: {
  id?: string | null
  kind: 'shift' | 'rotation'
  userId?: string
  refId?: string
  refLabel?: string
  startDate?: string
  endDate?: string | null
  isActive?: boolean
}): NormalizedScheduleInterval | null {
  if (input.isActive === false) return null
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  const refId = typeof input.refId === 'string' ? input.refId.trim() : ''
  const startDate = dateKey(input.startDate)
  if (!userId || !refId || !startDate) return null
  const endDate = normalizeOpenEnd(input.endDate)
  if (endDate && endDate < startDate) return null
  return {
    id: input.id?.trim() || `draft:${input.kind}`,
    kind: input.kind,
    userId,
    refLabel: input.refLabel?.trim() || refId,
    startDate,
    endDate,
  }
}

function normalizeShiftIntervals(
  assignments: AttendanceScheduleAssignmentLike[] | undefined,
  draft: AttendanceScheduleAssignmentDraft | null | undefined,
): NormalizedScheduleInterval[] {
  const draftInterval = draft
    ? normalizeInterval({ ...draft, kind: 'shift' })
    : null
  const draftId = draftInterval?.id ?? null
  const intervals = (Array.isArray(assignments) ? assignments : [])
    .map((item) => normalizeInterval({
      id: item.assignment.id,
      kind: 'shift',
      userId: item.assignment.userId,
      refId: item.assignment.shiftId,
      refLabel: item.shift?.name || item.assignment.shiftId,
      startDate: item.assignment.startDate,
      endDate: item.assignment.endDate,
      isActive: item.assignment.isActive,
    }))
    .filter((item): item is NormalizedScheduleInterval => Boolean(item))
    .filter((item) => item.id !== draftId)
  if (draftInterval) intervals.push(draftInterval)
  return intervals
}

function normalizeRotationIntervals(
  assignments: AttendanceScheduleRotationAssignmentLike[] | undefined,
  draft: AttendanceScheduleAssignmentDraft | null | undefined,
): NormalizedScheduleInterval[] {
  const draftInterval = draft
    ? normalizeInterval({ ...draft, kind: 'rotation' })
    : null
  const draftId = draftInterval?.id ?? null
  const intervals = (Array.isArray(assignments) ? assignments : [])
    .map((item) => normalizeInterval({
      id: item.assignment.id,
      kind: 'rotation',
      userId: item.assignment.userId,
      refId: item.assignment.rotationRuleId,
      refLabel: item.rotation?.name || item.assignment.rotationRuleId,
      startDate: item.assignment.startDate,
      endDate: item.assignment.endDate,
      isActive: item.assignment.isActive,
    }))
    .filter((item): item is NormalizedScheduleInterval => Boolean(item))
    .filter((item) => item.id !== draftId)
  if (draftInterval) intervals.push(draftInterval)
  return intervals
}

function diagnosticKey(
  code: AttendanceScheduleConflictDiagnosticCode,
  left: NormalizedScheduleInterval,
  right: NormalizedScheduleInterval,
): string {
  return `${code}:${left.userId}:${left.id}:${right.id}:${overlapStart(left, right)}`
}

function pushOverlapDiagnostic(
  diagnostics: AttendanceScheduleConflictDiagnostic[],
  code: AttendanceScheduleConflictDiagnosticCode,
  left: NormalizedScheduleInterval,
  right: NormalizedScheduleInterval,
): void {
  diagnostics.push({
    key: diagnosticKey(code, left, right),
    code,
    severity: 'warning',
    userId: left.userId,
    primaryLabel: left.refLabel,
    secondaryLabel: right.refLabel,
    overlapStart: overlapStart(left, right),
    overlapEnd: overlapEnd(left, right),
  })
}

function collectSameKindOverlaps(
  diagnostics: AttendanceScheduleConflictDiagnostic[],
  code: 'shift_assignment_overlap' | 'rotation_assignment_overlap',
  intervals: NormalizedScheduleInterval[],
): void {
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    const left = intervals[leftIndex]
    if (!left) continue
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const right = intervals[rightIndex]
      if (!right) continue
      if (left.userId !== right.userId) continue
      if (!overlaps(left, right)) continue
      pushOverlapDiagnostic(diagnostics, code, left, right)
    }
  }
}

export function buildAttendanceScheduleConflictDiagnostics({
  assignments,
  rotationAssignments,
  assignmentDraft,
  rotationAssignmentDraft,
}: BuildAttendanceScheduleConflictDiagnosticsInput): AttendanceScheduleConflictDiagnostic[] {
  const shiftIntervals = normalizeShiftIntervals(assignments, assignmentDraft)
  const rotationIntervals = normalizeRotationIntervals(rotationAssignments, rotationAssignmentDraft)
  const diagnostics: AttendanceScheduleConflictDiagnostic[] = []

  collectSameKindOverlaps(diagnostics, 'shift_assignment_overlap', shiftIntervals)
  collectSameKindOverlaps(diagnostics, 'rotation_assignment_overlap', rotationIntervals)

  for (const rotation of rotationIntervals) {
    for (const shift of shiftIntervals) {
      if (rotation.userId !== shift.userId) continue
      if (!overlaps(rotation, shift)) continue
      pushOverlapDiagnostic(diagnostics, 'rotation_overrides_shift', shift, rotation)
    }
  }

  return diagnostics
}

export function formatAttendanceScheduleConflictDiagnostic(
  diagnostic: AttendanceScheduleConflictDiagnostic,
  tr: Translate,
): string {
  const range = diagnostic.overlapEnd
    ? `${diagnostic.overlapStart} - ${diagnostic.overlapEnd}`
    : `${diagnostic.overlapStart}+`
  if (diagnostic.code === 'rotation_overrides_shift') {
    return tr(
      `User ${diagnostic.userId}: rotation ${diagnostic.secondaryLabel} overlaps shift assignment ${diagnostic.primaryLabel} (${range}); rotation wins at runtime.`,
      `用户 ${diagnostic.userId}：轮班 ${diagnostic.secondaryLabel} 与固定排班 ${diagnostic.primaryLabel} 在 ${range} 重叠；运行时以轮班为准。`,
    )
  }
  if (diagnostic.code === 'rotation_assignment_overlap') {
    return tr(
      `User ${diagnostic.userId}: rotation assignments ${diagnostic.primaryLabel} and ${diagnostic.secondaryLabel} overlap (${range}); the backend picks the latest matching assignment.`,
      `用户 ${diagnostic.userId}：轮班分配 ${diagnostic.primaryLabel} 与 ${diagnostic.secondaryLabel} 在 ${range} 重叠；后端会选择最新命中的分配。`,
    )
  }
  return tr(
    `User ${diagnostic.userId}: shift assignments ${diagnostic.primaryLabel} and ${diagnostic.secondaryLabel} overlap (${range}); the backend picks the latest matching assignment.`,
    `用户 ${diagnostic.userId}：固定排班 ${diagnostic.primaryLabel} 与 ${diagnostic.secondaryLabel} 在 ${range} 重叠；后端会选择最新命中的分配。`,
  )
}
