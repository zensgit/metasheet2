// Pure state helpers for the attendance approval-flow structured step editor
// (approval-flow-editor A1 design-lock). Kept dependency-free so the editor's
// add/remove/reorder/round-trip logic is unit-testable in isolation. The step
// shape is the existing attendance_approval_flows.steps model — this layer only
// upgrades authoring, never the runtime engine.

export interface AttendanceApprovalStep {
  name?: string
  approverUserIds?: string[]
  approverRoleIds?: string[]
  // Any other keys an existing flow carries are preserved verbatim (fail-closed
  // round-trip): the editor never silently drops config it does not model.
  [key: string]: unknown
}

/** All request types the backend approval-flow endpoint accepts (REQUEST_TYPES). */
export const ATTENDANCE_APPROVAL_REQUEST_TYPES = [
  'missed_check_in',
  'missed_check_out',
  'time_correction',
  'leave',
  'overtime',
  'outdoor_punch',
  'shift_swap',
  'schedule_dispatch',
] as const

export type AttendanceApprovalRequestType = (typeof ATTENDANCE_APPROVAL_REQUEST_TYPES)[number]

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item ?? '').trim()).filter(Boolean)
}

/** Normalize a raw step (from the backend) into the editor's working shape,
 *  preserving any keys the editor does not model. */
export function normalizeStep(raw: unknown): AttendanceApprovalStep {
  const source = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  const step: AttendanceApprovalStep = { ...source }
  step.name = typeof source.name === 'string' ? source.name : ''
  step.approverUserIds = asStringArray(source.approverUserIds)
  step.approverRoleIds = asStringArray(source.approverRoleIds)
  return step
}

export function normalizeSteps(raw: unknown): AttendanceApprovalStep[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeStep)
}

export function makeEmptyStep(): AttendanceApprovalStep {
  return { name: '', approverUserIds: [], approverRoleIds: [] }
}

export function addStep(steps: readonly AttendanceApprovalStep[]): AttendanceApprovalStep[] {
  return [...steps, makeEmptyStep()]
}

export function removeStep(steps: readonly AttendanceApprovalStep[], index: number): AttendanceApprovalStep[] {
  return steps.filter((_, i) => i !== index)
}

/** Move the step at `index` by `delta` (-1 up / +1 down); no-op at the ends. */
export function moveStep(steps: readonly AttendanceApprovalStep[], index: number, delta: number): AttendanceApprovalStep[] {
  const target = index + delta
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return [...steps]
  const next = [...steps]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export function setStepField(
  steps: readonly AttendanceApprovalStep[],
  index: number,
  patch: Partial<AttendanceApprovalStep>,
): AttendanceApprovalStep[] {
  return steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
}

export function addApproverUser(steps: readonly AttendanceApprovalStep[], index: number, userId: string): AttendanceApprovalStep[] {
  const id = String(userId ?? '').trim()
  if (!id) return [...steps]
  return steps.map((step, i) => {
    if (i !== index) return step
    const current = asStringArray(step.approverUserIds)
    if (current.includes(id)) return step
    return { ...step, approverUserIds: [...current, id] }
  })
}

export function removeApproverUser(steps: readonly AttendanceApprovalStep[], index: number, userId: string): AttendanceApprovalStep[] {
  return steps.map((step, i) =>
    i === index ? { ...step, approverUserIds: asStringArray(step.approverUserIds).filter(id => id !== userId) } : step,
  )
}

/** Parse a free-form role input (commas / spaces / CJK commas / newlines) into role IDs. */
export function parseRoleInput(value: string): string[] {
  return Array.from(new Set(String(value ?? '').split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)))
}

export function addApproverRoles(steps: readonly AttendanceApprovalStep[], index: number, rawInput: string): AttendanceApprovalStep[] {
  const incoming = parseRoleInput(rawInput)
  if (incoming.length === 0) return [...steps]
  return steps.map((step, i) => {
    if (i !== index) return step
    const current = asStringArray(step.approverRoleIds)
    const merged = Array.from(new Set([...current, ...incoming]))
    return { ...step, approverRoleIds: merged }
  })
}

export function removeApproverRole(steps: readonly AttendanceApprovalStep[], index: number, roleId: string): AttendanceApprovalStep[] {
  return steps.map((step, i) =>
    i === index ? { ...step, approverRoleIds: asStringArray(step.approverRoleIds).filter(id => id !== roleId) } : step,
  )
}

/** A step with neither an approver user nor a role — the "empty approver /
 *  fallback-admin" risk the editor surfaces at authoring time. */
export function stepHasNoApprover(step: AttendanceApprovalStep): boolean {
  return asStringArray(step.approverUserIds).length === 0 && asStringArray(step.approverRoleIds).length === 0
}

export interface ApprovalStepsAuthoringWarning {
  code: 'no_steps' | 'empty_approver'
  stepIndex?: number
}

export function collectAuthoringWarnings(steps: readonly AttendanceApprovalStep[]): ApprovalStepsAuthoringWarning[] {
  const warnings: ApprovalStepsAuthoringWarning[] = []
  if (steps.length === 0) {
    warnings.push({ code: 'no_steps' })
    return warnings
  }
  steps.forEach((step, index) => {
    if (stepHasNoApprover(step)) warnings.push({ code: 'empty_approver', stepIndex: index })
  })
  return warnings
}

/** The payload steps to persist — trims names, drops empty approver arrays would
 *  change shape, so keep arrays but preserve any unknown keys verbatim. */
export function toPayloadSteps(steps: readonly AttendanceApprovalStep[]): AttendanceApprovalStep[] {
  return steps.map(step => {
    const out: AttendanceApprovalStep = { ...step }
    out.name = typeof step.name === 'string' ? step.name.trim() : ''
    out.approverUserIds = asStringArray(step.approverUserIds)
    out.approverRoleIds = asStringArray(step.approverRoleIds)
    return out
  })
}

export function stepsPreviewJson(steps: readonly AttendanceApprovalStep[]): string {
  return JSON.stringify(toPayloadSteps(steps), null, 2)
}
