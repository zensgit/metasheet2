// Pure state helpers for the attendance approval-flow structured step editor
// (approval-flow-editor A1 + S7-5 design-lock). Kept dependency-free so the
// editor's add/remove/reorder/kind/round-trip logic is unit-testable in isolation.
// The step shape is the existing attendance_approval_flows.steps model — this
// layer only upgrades authoring, never the runtime engine.
//
// Fail-closed discipline (S7-1 / review P2-1): never silently repair malformed
// discriminated-union shapes (mixed static+dynamic keys, non-string/blank kind,
// missing/fractional/out-of-range level). Those must reach the backend authoring
// gate as-is so it can return its distinct 422 codes.

/** S7-5 authoring kinds offered by the step-kind selector (OD-S7-2: continuous_managers OUT). */
export const ATTENDANCE_DYNAMIC_STEP_KINDS = [
  'direct_manager',
  'dept_head',
  'manager_at_level',
] as const

export type AttendanceDynamicStepKind = (typeof ATTENDANCE_DYNAMIC_STEP_KINDS)[number]

/** Selector values: legacy static OR one of the three supported dynamic kinds. */
export type AttendanceStepKindSelection = 'static' | AttendanceDynamicStepKind

/**
 * Plugin-attendance's effective org when the authoring field is blank
 * (`const DEFAULT_ORG_ID = 'default'` in plugin-attendance/index.cjs). Fixture-
 * sync tests lock the literal; the readiness composable uses this so blank
 * Attendance org input still probes the same org the plugin routes to.
 */
export const ATTENDANCE_DEFAULT_ORG_ID = 'default'

export interface AttendanceApprovalStep {
  name?: string
  approverUserIds?: string[]
  approverRoleIds?: string[]
  kind?: string
  level?: number
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

function hasOwn(step: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(step, key)
}

/** Non-empty trimmed kind string, or null when absent / blank / non-string. */
export function getApprovalStepKind(step: AttendanceApprovalStep | null | undefined): string | null {
  if (!step || typeof step !== 'object') return null
  const kind = typeof step.kind === 'string' ? step.kind.trim() : ''
  return kind.length > 0 ? kind : null
}

/** True when the step carries a `kind` KEY at all (even blank / non-string) — fail-closed marker. */
export function stepHasKindKey(step: AttendanceApprovalStep): boolean {
  return hasOwn(step, 'kind')
}

export function isSupportedDynamicKind(kind: string | null | undefined): kind is AttendanceDynamicStepKind {
  return typeof kind === 'string' && (ATTENDANCE_DYNAMIC_STEP_KINDS as readonly string[]).includes(kind)
}

/**
 * True when the step carries a kind key that is not a clean supported selection
 * (unsupported string like continuous_managers, blank, or non-string).
 */
export function isUnsupportedDynamicStep(step: AttendanceApprovalStep): boolean {
  if (!stepHasKindKey(step)) return false
  const kind = getApprovalStepKind(step)
  return kind === null || !isSupportedDynamicKind(kind)
}

/** Clean supported dynamic kind (non-empty recognized string). Mixed keys may still be present. */
export function isDynamicStep(step: AttendanceApprovalStep): boolean {
  return isSupportedDynamicKind(getApprovalStepKind(step))
}

/**
 * Map a working step to the selector value.
 * - no kind key → static
 * - supported non-empty kind → that kind
 * - kind key present but blank / non-string / unsupported → null (never coerce to static)
 */
export function getStepKindSelection(step: AttendanceApprovalStep): AttendanceStepKindSelection | null {
  if (!stepHasKindKey(step)) return 'static'
  const kind = getApprovalStepKind(step)
  if (isSupportedDynamicKind(kind)) return kind
  return null
}

/** Static approver editors are only live for true kind-less static steps. */
export function isEditableStaticStep(step: AttendanceApprovalStep): boolean {
  return getStepKindSelection(step) === 'static'
}

/**
 * Normalize a raw step into the editor's working shape WITHOUT repairing
 * discriminated-union violations. Mixed kind+arrays, blank/non-string kind,
 * missing/fractional level are all preserved for the backend 422 gate.
 */
export function normalizeStep(raw: unknown): AttendanceApprovalStep {
  const source = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  const step: AttendanceApprovalStep = { ...source }
  step.name = typeof source.name === 'string' ? source.name : ''

  // Kind key present (any value) → fail-closed: keep kind, level, static arrays,
  // and every other key exactly as loaded. Do NOT strip arrays or default level.
  if (hasOwn(source, 'kind')) {
    return step
  }

  // Kind-less static path only: materialize approver arrays for the editor UX.
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

/**
 * Intentional user kind switch — the ONLY place that clears incompatible fields.
 * - static → drop kind/level; empty approver arrays
 * - dynamic → set kind; drop static approver KEYS; manager_at_level initializes level=1
 * - manager_at_level requires a known host max; if max is unknown/null, no-op (fail-closed)
 * Unknown keys outside the union fields are dropped on switch (fresh closed shape).
 */
export function setStepKind(
  steps: readonly AttendanceApprovalStep[],
  index: number,
  selection: AttendanceStepKindSelection,
  options?: { maxManagerChainLevels?: number | null },
): AttendanceApprovalStep[] {
  return steps.map((step, i) => {
    if (i !== index) return step
    const name = typeof step.name === 'string' ? step.name : ''

    if (selection === 'static') {
      return { name, approverUserIds: [], approverRoleIds: [] }
    }

    if (selection === 'manager_at_level') {
      const max = options?.maxManagerChainLevels
      // Fail-closed while host max is unknown — do not invent a level bound or default path.
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
        return step
      }
      // Intentional user switch may initialize level=1 (design-allowed); never copy a
      // previously malformed level into the new clean step.
      return { name, kind: 'manager_at_level', level: 1 }
    }

    return { name, kind: selection }
  })
}

/**
 * Store the raw level the user entered — no trunc, no clamp, no default.
 * Invalid / out-of-range values must remain so the backend can 422 them.
 * No-op when the step is not manager_at_level or when host max is unknown
 * (editing disabled until the readiness seam returns).
 */
export function setManagerLevel(
  steps: readonly AttendanceApprovalStep[],
  index: number,
  level: number,
  maxManagerChainLevels?: number | null,
): AttendanceApprovalStep[] {
  if (typeof maxManagerChainLevels !== 'number' || !Number.isInteger(maxManagerChainLevels) || maxManagerChainLevels < 1) {
    return [...steps]
  }
  return steps.map((step, i) => {
    if (i !== index) return step
    if (getApprovalStepKind(step) !== 'manager_at_level') return step
    // Preserve the exact numeric value (fractional, 0, MAX+1, …) — never repair.
    return { ...step, level }
  })
}

export function addApproverUser(steps: readonly AttendanceApprovalStep[], index: number, userId: string): AttendanceApprovalStep[] {
  const id = String(userId ?? '').trim()
  if (!id) return [...steps]
  return steps.map((step, i) => {
    if (i !== index) return step
    if (!isEditableStaticStep(step)) return step
    const current = asStringArray(step.approverUserIds)
    if (current.includes(id)) return step
    return { ...step, approverUserIds: [...current, id] }
  })
}

export function removeApproverUser(steps: readonly AttendanceApprovalStep[], index: number, userId: string): AttendanceApprovalStep[] {
  return steps.map((step, i) => {
    if (i !== index) return step
    if (!isEditableStaticStep(step)) return step
    return { ...step, approverUserIds: asStringArray(step.approverUserIds).filter(id => id !== userId) }
  })
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
    if (!isEditableStaticStep(step)) return step
    const current = asStringArray(step.approverRoleIds)
    const merged = Array.from(new Set([...current, ...incoming]))
    return { ...step, approverRoleIds: merged }
  })
}

export function removeApproverRole(steps: readonly AttendanceApprovalStep[], index: number, roleId: string): AttendanceApprovalStep[] {
  return steps.map((step, i) => {
    if (i !== index) return step
    if (!isEditableStaticStep(step)) return step
    return { ...step, approverRoleIds: asStringArray(step.approverRoleIds).filter(id => id !== roleId) }
  })
}

/** A kind-less static step with neither user nor role — empty-approver soft warning. */
export function stepHasNoApprover(step: AttendanceApprovalStep): boolean {
  if (!isEditableStaticStep(step)) return false
  return asStringArray(step.approverUserIds).length === 0 && asStringArray(step.approverRoleIds).length === 0
}

export function stepHasSupportedDynamicKind(step: AttendanceApprovalStep): boolean {
  return isSupportedDynamicKind(getApprovalStepKind(step))
}

export interface ApprovalStepsAuthoringWarning {
  code: 'no_steps' | 'empty_approver' | 'directory_not_ready'
  stepIndex?: number
}

/**
 * Soft authoring warnings (never hard-block save). OD-S7-6: when any supported
 * dynamic step is present and the org has no linked directory accounts, surface
 * `directory_not_ready`. `hasLinkedDirectoryAccounts === null/undefined` means
 * readiness is unknown — do not invent a warning.
 */
export function collectAuthoringWarnings(
  steps: readonly AttendanceApprovalStep[],
  options?: { hasLinkedDirectoryAccounts?: boolean | null },
): ApprovalStepsAuthoringWarning[] {
  const warnings: ApprovalStepsAuthoringWarning[] = []
  if (steps.length === 0) {
    warnings.push({ code: 'no_steps' })
    return warnings
  }
  steps.forEach((step, index) => {
    if (stepHasNoApprover(step)) warnings.push({ code: 'empty_approver', stepIndex: index })
  })
  if (
    options?.hasLinkedDirectoryAccounts === false
    && steps.some(stepHasSupportedDynamicKind)
  ) {
    warnings.push({ code: 'directory_not_ready' })
  }
  return warnings
}

function carriesStaticApproverKey(step: AttendanceApprovalStep): boolean {
  return step.approverUserIds !== undefined || step.approverRoleIds !== undefined
}

/** Closed per-kind param union — mirrors assertApprovalStepsContract allowedDynamicKeys. */
function allowedDynamicKeys(kind: AttendanceDynamicStepKind): readonly string[] {
  return kind === 'manager_at_level' ? ['name', 'kind', 'level'] : ['name', 'kind']
}

/**
 * True when a supported dynamic step carries any non-undefined key outside its
 * exact allowed set. Backend rejects those with APPROVAL_STEP_PARAMS_INVALID;
 * we must not strip them in the payload (fail-closed).
 */
function hasExtraDynamicParams(step: AttendanceApprovalStep, kind: AttendanceDynamicStepKind): boolean {
  const allowed = new Set(allowedDynamicKeys(kind))
  for (const key of Object.keys(step)) {
    if ((step as Record<string, unknown>)[key] === undefined) continue
    if (!allowed.has(key)) return true
  }
  return false
}

/**
 * Payload steps to persist. Fail-closed for malformed shapes:
 * - mixed kind + static arrays → preserved as-is
 * - non-string / blank kind → preserved as-is (kind key not deleted)
 * - supported kind with extra non-undefined keys (futureParam, level on
 *   param-less kinds, …) → preserved as-is so backend returns
 *   APPROVAL_STEP_PARAMS_INVALID (never silently drop the extra key)
 * - manager_at_level missing / non-integer level → preserved (no default to 1)
 * - integer level including 0 and MAX+1 → emitted as-is (backend 422s out-of-range)
 * Clean intentional shapes (from setStepKind / clean authoring) emit the closed union.
 */
export function toPayloadSteps(steps: readonly AttendanceApprovalStep[]): AttendanceApprovalStep[] {
  return steps.map(step => {
    const name = typeof step.name === 'string' ? step.name.trim() : ''

    if (stepHasKindKey(step)) {
      const rawKind = step.kind
      const kind = typeof rawKind === 'string' ? rawKind.trim() : ''

      // Malformed / mixed / unsupported / extra params — preserve verbatim (only trim string name).
      if (
        typeof rawKind !== 'string'
        || kind.length === 0
        || !isSupportedDynamicKind(kind)
        || carriesStaticApproverKey(step)
        || hasExtraDynamicParams(step, kind)
      ) {
        return { ...step, name, kind: rawKind as string }
      }

      if (kind === 'manager_at_level') {
        // Missing or non-integer level: preserve raw — never default to 1.
        if (typeof step.level !== 'number' || !Number.isInteger(step.level)) {
          return { ...step, name, kind }
        }
        // Integer level (0, 1..N, N+1, negative) — closed shape; backend validates range.
        return { name, kind: 'manager_at_level', level: step.level }
      }

      // Clean supported param-less dynamic kinds ({name, kind} only).
      return { name, kind }
    }

    // Kind-less static: keep unknown keys; do not invent a kind key.
    const out: AttendanceApprovalStep = { ...step }
    delete out.kind
    delete out.level
    out.name = name
    out.approverUserIds = asStringArray(step.approverUserIds)
    out.approverRoleIds = asStringArray(step.approverRoleIds)
    return out
  })
}

export function stepsPreviewJson(steps: readonly AttendanceApprovalStep[]): string {
  return JSON.stringify(toPayloadSteps(steps), null, 2)
}
