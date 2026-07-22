// W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED): pure discriminator for the seven-step
// setup-readiness aggregate (`GET /api/attendance-admin/setup-readiness`). This module ONLY turns
// the aggregate response (or a whole-endpoint 403/503) into the seven-step judgement matrix — zero
// DOM, zero fetch, zero Vue reactivity. The wizard shell (`AttendanceSetupReadiness.vue`) and its
// fetch/section-registration wiring belong to W4-1, not this slice (§7 "父层 AttendanceView：
// readiness 加载/聚合调用..."; §2 W4-0 scope = "纯逻辑模块 attendanceSetupReadiness.ts（判别矩阵
// 完整，分支不埋 template）").
//
// Design lock: docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md §3/§4/§7.
// Backend mirror (types + SQL): packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts
// and packages/core-backend/src/routes/attendance-admin.ts (AttendanceSetupReadinessResponse).
//
// §3⑥ shape note (P2-2, "三个互不等价的信号...不得合并"): this module deliberately does NOT
// collapse step⑥'s three notify signals into one blended status. `recipientScopeConfig` is always
// `'unsupported'` and IS the step's `status` (it's literally the capability the step name
// "配置...接收范围" names, and it's the one signal with a remediation-relevant value); the other
// two signals (`deliveryRuntime`, `orgRecipientBinding`) are carried alongside, unreduced, for a
// future W4-1 three-line render — never folded into `status`.

/** The seven judgement values (§3/§7) — exhaustive, never an eighth. */
export const ATTENDANCE_SETUP_READINESS_STATUS_VALUES = [
  'ready',
  'missing',
  'forbidden',
  'unknown',
  'manual_review_required',
  'unsupported',
  'db_not_ready',
] as const
export type AttendanceSetupReadinessStatus = (typeof ATTENDANCE_SETUP_READINESS_STATUS_VALUES)[number]

/** The seven canonical step ids, in wizard order (§3). Doubles as the canonical admin-section id
 *  for steps ①-⑥; `preview` (⑦) has no section — it lives inside the wizard, read-only. */
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

/** §4.2-locked wire shape for each `perStep` entry — the design lock's own JSON block writes
 *  `perStep.effectiveTime: {source, posture, effectiveAt?}`, i.e. each entry nests under an
 *  `effectiveTime` key rather than being the effective-time record itself (mirrors
 *  `packages/core-backend/src/services/AttendanceSetupReadinessAggregate.ts`
 *  `AttendanceSetupReadinessPerStepEntry`). */
export interface AttendanceSetupReadinessPerStepEntry {
  effectiveTime: AttendanceSetupReadinessEffectiveTime
}

export type AttendancePunchPolicyPosture = 'default' | 'customized' | 'unknown'
export type AttendanceSetupReadinessDeliveryRuntime = 'ready' | 'not_ready' | 'unknown'

export interface AttendanceSetupReadinessOrgRecipientBinding {
  boundRecipientCount: number
  hasAnyBoundRecipient: boolean
}

export interface AttendanceSetupReadinessNotify {
  deliveryRuntime: AttendanceSetupReadinessDeliveryRuntime
  orgRecipientBinding: AttendanceSetupReadinessOrgRecipientBinding
  recipientScopeConfig: 'unsupported'
}

/** Mirrors `packages/core-backend/src/routes/attendance-admin.ts` AttendanceSetupReadinessResponse
 *  — the §4.2-locked key set PLUS `viewerIsPlatformAdmin`, a disclosed addition NOT in the §4.2
 *  locked list (§3① role-gated remediation contract, W4-1 强制) still pending explicit owner
 *  sign-off — see that file's response-interface doc comment for the full tension writeup. */
export interface AttendanceSetupReadinessResponse {
  directoryLinked: boolean
  orgActiveMemberCount: number
  groupCount: number
  groupsWithMembers: number
  shiftCount: number
  scheduledShiftGroupCount: number
  activeRotationRuleCount: number
  hasRotationRules: boolean
  approvalFlowCount: number
  punchPolicyPosture: AttendancePunchPolicyPosture
  notify: AttendanceSetupReadinessNotify
  previewReady: boolean
  perStep: Readonly<Record<AttendanceSetupStepId, AttendanceSetupReadinessPerStepEntry>>
  viewerIsPlatformAdmin: boolean
}

/** §3.2 "判别值域（纯模块判别矩阵的行）...且每信号携带 scope: 'org' | 'deployment'（全局信号显式标
 *  deployment，追加门禁 2）" — a scope tag per STEP (not per raw backend field), since that is the
 *  granularity `AttendanceSetupReadinessStepResult` rows expose. Mirrors the backend's
 *  `ATTENDANCE_SETUP_READINESS_DEPLOYMENT_SCOPED_FIELDS` registry
 *  (`packages/core-backend/src/routes/attendance-admin.ts`): step④ (`punchPolicyPosture`) and
 *  step⑥ (`recipientScopeConfig` IS the step's `status` — see the module header's ⑥ shape note) are
 *  deployment-scoped; every other step's completion signal is an org-scoped COUNT. Note the
 *  nuance for ⑥: `notifySignals.orgRecipientBinding` (carried alongside, unreduced) is itself
 *  org-scoped even though the step's overall `scope` tag is `deployment` — this constant tags the
 *  STEP, not each individual signal riding on it; a future per-signal breakdown is W4-1's call, not
 *  this slice's. */
export const ATTENDANCE_SETUP_STEP_SCOPE: Readonly<Record<AttendanceSetupStepId, 'org' | 'deployment'>> = {
  'attendance-admin-user-access': 'org',
  'attendance-admin-groups': 'org',
  'attendance-admin-shifts': 'org',
  'attendance-admin-settings': 'deployment',
  'attendance-admin-approval-flows': 'org',
  'attendance-admin-notification-deliveries': 'deployment',
  preview: 'org',
}

/** Discriminated input the wizard shell can build directly from an HTTP response. */
export type AttendanceSetupReadinessInput =
  | { kind: 'forbidden' }
  | { kind: 'db_not_ready' }
  | { kind: 'ok'; data: AttendanceSetupReadinessResponse }

export type AttendanceSetupReadinessReasonKey =
  | 'org_active_member_count_zero'
  | 'group_or_membership_missing'
  | 'shift_count_zero'
  | 'scheduled_shift_group_without_rotation_rules'
  | 'punch_policy_default'
  | 'punch_policy_customized'
  | 'punch_policy_unknown'
  | 'approval_flow_count_zero'
  | 'recipient_scope_unsupported'
  | 'preview_ready'
  | 'preview_blocked_by_prior_step'
  | 'ready'
  | 'forbidden'
  | 'db_not_ready'

export interface AttendanceSetupReadinessStepResult {
  stepId: AttendanceSetupStepId
  status: AttendanceSetupReadinessStatus
  /** display-only reason key — never a raw value (values-free, §4.2) */
  reason: AttendanceSetupReadinessReasonKey
  /** §3.2 "每信号携带 scope: 'org' | 'deployment'" — see `ATTENDANCE_SETUP_STEP_SCOPE` doc comment
   *  for what this tags at step granularity. */
  scope: 'org' | 'deployment'
  effectiveTime?: AttendanceSetupReadinessEffectiveTime
  /** step⑥ ONLY: the two non-blended advisory notify signals, carried unreduced (see module
   *  header). Absent on every other step. */
  notifySignals?: {
    deliveryRuntime: AttendanceSetupReadinessDeliveryRuntime
    orgRecipientBinding: AttendanceSetupReadinessOrgRecipientBinding
  }
}

function stepMeta(
  data: AttendanceSetupReadinessResponse,
  stepId: AttendanceSetupStepId,
): AttendanceSetupReadinessEffectiveTime | undefined {
  return data.perStep[stepId]?.effectiveTime
}

/** §3③ errata, owner-literal: org-level EXISTENCE test, not per-group rotation coverage. Exported
 *  so the wizard shell (W4-1) can reuse the exact same formula for optimistic/preview math. */
export function deriveAttendanceSetupReadinessStep3Ready(
  shiftCount: number,
  scheduledShiftGroupCount: number,
  activeRotationRuleCount: number,
): boolean {
  return shiftCount > 0 && (scheduledShiftGroupCount === 0 || activeRotationRuleCount > 0)
}

/**
 * §3.2 / §9 W4-0-G4: previewReady = ①②③⑤ ALL ready. ④ and ⑥ are advisory and MUST NOT
 * participate. This is an INDEPENDENT re-derivation from the raw counts (not a read of
 * `data.previewReady`) — defense in depth so a backend regression in the previewReady field itself
 * cannot silently agree with a broken FE render; the contract test suite separately asserts the two
 * stay consistent.
 */
export function deriveAttendanceSetupReadinessPreviewReady(data: AttendanceSetupReadinessResponse): boolean {
  const step1Ready = data.orgActiveMemberCount > 0
  const step2Ready = data.groupCount > 0 && data.groupsWithMembers > 0
  const step3Ready = deriveAttendanceSetupReadinessStep3Ready(
    data.shiftCount,
    data.scheduledShiftGroupCount,
    data.activeRotationRuleCount,
  )
  const step5Ready = data.approvalFlowCount > 0
  return step1Ready && step2Ready && step3Ready && step5Ready
}

/**
 * Derive the full seven-step judgement matrix from a setup-readiness response (or a whole-endpoint
 * 403/503 fold). Every row's `status` is one of the seven locked values (§3 判别值域) — never an
 * eighth, never a guess.
 */
export function deriveAttendanceSetupReadinessSteps(
  input: AttendanceSetupReadinessInput,
): AttendanceSetupReadinessStepResult[] {
  if (input.kind === 'forbidden') {
    return ATTENDANCE_SETUP_STEP_IDS.map((stepId) => ({
      stepId,
      status: 'forbidden',
      reason: 'forbidden',
      scope: ATTENDANCE_SETUP_STEP_SCOPE[stepId],
    }))
  }
  if (input.kind === 'db_not_ready') {
    return ATTENDANCE_SETUP_STEP_IDS.map((stepId) => ({
      stepId,
      status: 'db_not_ready',
      reason: 'db_not_ready',
      scope: ATTENDANCE_SETUP_STEP_SCOPE[stepId],
    }))
  }

  const { data } = input

  // ① orgActiveMemberCount>0 is sufficient (round-3 P2-1/P2-3: "同步或创建" OR semantics —
  // directoryLinked is auxiliary/display-only, never gating).
  const step1: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-user-access',
    status: data.orgActiveMemberCount > 0 ? 'ready' : 'missing',
    reason: data.orgActiveMemberCount > 0 ? 'ready' : 'org_active_member_count_zero',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-user-access'],
    effectiveTime: stepMeta(data, 'attendance-admin-user-access'),
  }

  // ② groupCount>0 AND groupsWithMembers>0 (OD-W4-6).
  const step2Ready = data.groupCount > 0 && data.groupsWithMembers > 0
  const step2: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-groups',
    status: step2Ready ? 'ready' : 'missing',
    reason: step2Ready ? 'ready' : 'group_or_membership_missing',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-groups'],
    effectiveTime: stepMeta(data, 'attendance-admin-groups'),
  }

  // ③ errata step3Ready formula (org-level existence test, §3③).
  const step3Ready = deriveAttendanceSetupReadinessStep3Ready(
    data.shiftCount,
    data.scheduledShiftGroupCount,
    data.activeRotationRuleCount,
  )
  const step3: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-shifts',
    status: step3Ready ? 'ready' : 'missing',
    reason: step3Ready
      ? 'ready'
      : data.shiftCount === 0
        ? 'shift_count_zero'
        : 'scheduled_shift_group_without_rotation_rules',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-shifts'],
    effectiveTime: stepMeta(data, 'attendance-admin-shifts'),
  }

  // ④ errata mapping (recomputed here, NOT trusted from a pre-mapped backend field — the backend
  // returns the raw 3-value `punchPolicyPosture` enum; this module owns the ready/manual_review/
  // unknown mapping): customized -> ready; default -> manual_review_required (NEVER ready — the
  // errata that overturned the frozen predecessor's default->ready mapping); unknown -> unknown
  // fail-closed.
  const step4Status: AttendanceSetupReadinessStatus =
    data.punchPolicyPosture === 'customized'
      ? 'ready'
      : data.punchPolicyPosture === 'default'
        ? 'manual_review_required'
        : 'unknown'
  const step4: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-settings',
    status: step4Status,
    reason:
      data.punchPolicyPosture === 'default'
        ? 'punch_policy_default'
        : data.punchPolicyPosture === 'customized'
          ? 'punch_policy_customized'
          : 'punch_policy_unknown',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-settings'],
    effectiveTime: stepMeta(data, 'attendance-admin-settings'),
  }

  // ⑤ approvalFlowCount>0 (active flows).
  const step5Ready = data.approvalFlowCount > 0
  const step5: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-approval-flows',
    status: step5Ready ? 'ready' : 'missing',
    reason: step5Ready ? 'ready' : 'approval_flow_count_zero',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-approval-flows'],
    effectiveTime: stepMeta(data, 'attendance-admin-approval-flows'),
  }

  // ⑥ §4.5(iii): recipientScopeConfig is always 'unsupported' and IS this step's status — the
  // other two signals ride unreduced on `notifySignals` (module header; §3⑥ "不得合并").
  const step6: AttendanceSetupReadinessStepResult = {
    stepId: 'attendance-admin-notification-deliveries',
    status: 'unsupported',
    reason: 'recipient_scope_unsupported',
    scope: ATTENDANCE_SETUP_STEP_SCOPE['attendance-admin-notification-deliveries'],
    effectiveTime: stepMeta(data, 'attendance-admin-notification-deliveries'),
    notifySignals: {
      deliveryRuntime: data.notify.deliveryRuntime,
      orgRecipientBinding: data.notify.orgRecipientBinding,
    },
  }

  // ⑦ previewReady = ①②③⑤ ALL ready (§3.2). ④/⑥ never participate — independently re-derived
  // (see deriveAttendanceSetupReadinessPreviewReady doc), so this cannot silently misattribute an
  // ④/⑥ unknown/manual_review_required the way the frozen predecessor's "anyUnknown across all six
  // priors" formula did (trilens P3 on that predecessor).
  const previewReady = deriveAttendanceSetupReadinessPreviewReady(data)
  const step7: AttendanceSetupReadinessStepResult = {
    stepId: 'preview',
    status: previewReady ? 'ready' : 'missing',
    reason: previewReady ? 'preview_ready' : 'preview_blocked_by_prior_step',
    scope: ATTENDANCE_SETUP_STEP_SCOPE.preview,
    effectiveTime: stepMeta(data, 'preview'),
  }

  return [step1, step2, step3, step4, step5, step6, step7]
}
