// W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED): pure discriminator for the seven-step
// setup-readiness aggregate (`GET /api/attendance-admin/setup-readiness`). This module ONLY turns
// the aggregate response (or a whole-endpoint 403/503) into the seven-step judgement matrix — zero
// DOM, zero fetch, zero Vue reactivity. The wizard shell (`AttendanceSetupReadiness.vue`) and its
// fetch/section-registration wiring belong to W4-1, not this slice (§7 "父层 AttendanceView：
// readiness 加载/聚合调用..."; §2 W4-0 scope = "纯逻辑模块 attendanceSetupReadiness.ts（判别矩阵
// 完整，分支不埋 template）").
//
// Design lock: docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md §3/§4/§7.
//
// KNOWN SCOPE GAP (flagged for owner ruling, not decided here — see PR body): §3③ conditions
// rotation-rule readiness on "排班制组存在" (a scheduled_shift-type group exists), but §4.2's
// response key set is explicitly locked and carries no group-type signal. This module therefore
// treats step③ readiness as `shiftCount > 0` alone (informational-only `rotationRuleCount` /
// `hasRotationRules`, never gating) until the owner picks: (a) add a `hasScheduledShiftGroups`
// signal to the locked response shape, or (b) defer the AND-with-rotation-rules gating to W4-1
// where group-type breakdown is already loaded by the wizard shell.

export type AttendanceSetupReadinessStatus = 'ready' | 'missing' | 'forbidden' | 'unknown' | 'db_not_ready'

export type AttendanceSetupReadinessEffectiveTimePosture =
  | 'immediate'
  | 'scheduled'
  | 'manual_activation'
  | 'undeterminable'

export interface AttendanceSetupReadinessEffectiveTime {
  source: string
  posture: AttendanceSetupReadinessEffectiveTimePosture
  effectiveAt?: string
}

export interface AttendanceSetupReadinessStepMeta {
  step: string
  scope: 'org' | 'deployment'
  effectiveTime: AttendanceSetupReadinessEffectiveTime
}

/** Mirrors `packages/core-backend/src/routes/attendance-admin.ts` AttendanceSetupReadinessResponse. */
export interface AttendanceSetupReadinessResponse {
  directoryLinked: boolean
  orgActiveMemberCount: number
  groupCount: number
  groupsWithMembers: number
  shiftCount: number
  rotationRuleCount: number
  hasRotationRules: boolean
  approvalFlowCount: number
  punchPolicyPosture: 'default' | 'customized' | 'unknown'
  notify: {
    workerEnabled: boolean | 'unknown'
    defaultChannelAvailable: boolean | 'unknown'
    availableChannelCount: number | 'unknown'
    orgRecipientBindingReady: boolean | 'unknown'
  }
  perStep: AttendanceSetupReadinessStepMeta[]
  deploymentScopedSignals: readonly string[]
}

/** The seven canonical step ids, in wizard order (§3). Stable across W4-0/W4-1/W4-2. */
export const ATTENDANCE_SETUP_STEP_IDS = [
  'attendance-admin-user-access',
  'attendance-admin-groups',
  'attendance-admin-shifts',
  'attendance-admin-settings',
  'attendance-admin-approval-flows',
  'attendance-admin-notification-deliveries',
  'preview',
] as const

export type AttendanceSetupStepId = (typeof ATTENDANCE_SETUP_STEP_IDS)[number]

export interface AttendanceSetupReadinessStepResult {
  stepId: AttendanceSetupStepId
  status: AttendanceSetupReadinessStatus
  /** display-only reason key — never a raw value (values-free, §4.2) */
  reason:
    | 'org_active_member_count_zero'
    | 'group_or_membership_missing'
    | 'shift_count_zero'
    | 'punch_policy_default'
    | 'punch_policy_customized'
    | 'punch_policy_unknown'
    | 'approval_flow_count_zero'
    | 'notify_not_ready'
    | 'notify_signal_unknown'
    | 'preview_blocked_by_prior_step'
    | 'preview_ready'
    | 'ready'
    | 'forbidden'
    | 'db_not_ready'
  effectiveTime?: AttendanceSetupReadinessEffectiveTime
}

/** Discriminated input the wizard shell can build directly from an HTTP response. */
export type AttendanceSetupReadinessInput =
  | { kind: 'forbidden' }
  | { kind: 'db_not_ready' }
  | { kind: 'ok'; data: AttendanceSetupReadinessResponse }

function stepMeta(
  data: AttendanceSetupReadinessResponse,
  stepId: AttendanceSetupStepId,
): AttendanceSetupReadinessEffectiveTime | undefined {
  return data.perStep.find((s) => s.step === stepId)?.effectiveTime
}

function notifyReady(notify: AttendanceSetupReadinessResponse['notify']): 'ready' | 'missing' | 'unknown' {
  const values = [notify.workerEnabled, notify.defaultChannelAvailable, notify.orgRecipientBindingReady]
  if (values.some((v) => v === 'unknown')) return 'unknown'
  return notify.workerEnabled === true && notify.defaultChannelAvailable === true && notify.orgRecipientBindingReady === true
    ? 'ready'
    : 'missing'
}

/**
 * Derive the full seven-step judgement matrix from a setup-readiness response (or a whole-endpoint
 * 403/503). Every row is one of the five locked values: ready / missing / forbidden / unknown /
 * db_not_ready (§3 判别值域) — never a sixth value, never a guess.
 */
export function deriveAttendanceSetupReadinessSteps(
  input: AttendanceSetupReadinessInput,
): AttendanceSetupReadinessStepResult[] {
  if (input.kind === 'forbidden') {
    return ATTENDANCE_SETUP_STEP_IDS.map((stepId) => ({ stepId, status: 'forbidden', reason: 'forbidden' }))
  }
  if (input.kind === 'db_not_ready') {
    return ATTENDANCE_SETUP_STEP_IDS.map((stepId) => ({ stepId, status: 'db_not_ready', reason: 'db_not_ready' }))
  }

  const { data } = input

  // ① orgActiveMemberCount>0 is sufficient (round-3 P2-1: "同步或创建" — directoryLinked is
  // auxiliary/display-only, never gating).
  const step1: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-user-access',
    status: data.orgActiveMemberCount > 0 ? 'ready' : 'missing',
    reason: data.orgActiveMemberCount > 0 ? 'ready' : 'org_active_member_count_zero',
    effectiveTime: stepMeta(data, 'attendance-admin-user-access'),
  }

  // ② groupCount>0 AND groupsWithMembers>0.
  const step2: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-groups',
    status: data.groupCount > 0 && data.groupsWithMembers > 0 ? 'ready' : 'missing',
    reason: data.groupCount > 0 && data.groupsWithMembers > 0 ? 'ready' : 'group_or_membership_missing',
    effectiveTime: stepMeta(data, 'attendance-admin-groups'),
  }

  // ③ shiftCount>0. rotationRuleCount/hasRotationRules are carried informationally only — see the
  // KNOWN SCOPE GAP note at the top of this file; NOT gating in W4-0.
  const step3: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-shifts',
    status: data.shiftCount > 0 ? 'ready' : 'missing',
    reason: data.shiftCount > 0 ? 'ready' : 'shift_count_zero',
    effectiveTime: stepMeta(data, 'attendance-admin-shifts'),
  }

  // ④ default and customized are BOTH ready (round-3 (b)); only unknown fails closed.
  const step4: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-settings',
    status: data.punchPolicyPosture === 'unknown' ? 'unknown' : 'ready',
    reason:
      data.punchPolicyPosture === 'default'
        ? 'punch_policy_default'
        : data.punchPolicyPosture === 'customized'
          ? 'punch_policy_customized'
          : 'punch_policy_unknown',
    effectiveTime: stepMeta(data, 'attendance-admin-settings'),
  }

  // ⑤ approvalFlowCount>0 (active flows).
  const step5: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-approval-flows',
    status: data.approvalFlowCount > 0 ? 'ready' : 'missing',
    reason: data.approvalFlowCount > 0 ? 'ready' : 'approval_flow_count_zero',
    effectiveTime: stepMeta(data, 'attendance-admin-approval-flows'),
  }

  // ⑥ notify port: any unknown signal ⇒ unknown (fail-closed, never displayed as complete).
  const notify = notifyReady(data.notify)
  const step6: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-notification-deliveries',
    status: notify === 'unknown' ? 'unknown' : notify === 'ready' ? 'ready' : 'missing',
    reason: notify === 'unknown' ? 'notify_signal_unknown' : notify === 'ready' ? 'ready' : 'notify_not_ready',
    effectiveTime: stepMeta(data, 'attendance-admin-notification-deliveries'),
  }

  // ⑦ previewReady = all six prior steps ready. Any prior 'unknown' propagates as 'unknown'
  // (fail-closed — §3 "unknown 绝不显示为已完成" applies transitively to the preview gate too).
  const priorSteps = [step1, step2, step3, step4, step5, step6]
  const anyUnknown = priorSteps.some((s) => s.status === 'unknown')
  const allReady = priorSteps.every((s) => s.status === 'ready')
  const step7: AttendanceSetupReadinessStepResult = {
    stepId: 'preview',
    status: anyUnknown ? 'unknown' : allReady ? 'ready' : 'missing',
    reason: anyUnknown ? 'notify_signal_unknown' : allReady ? 'preview_ready' : 'preview_blocked_by_prior_step',
    effectiveTime: stepMeta(data, 'preview'),
  }

  return [step1, step2, step3, step4, step5, step6, step7]
}
