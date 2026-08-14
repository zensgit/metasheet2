// W6-3 (#4556) §5.5 — pure label/navigation module for the group effective-policy panel
// (AttendanceGroupEffectivePolicyPanel.vue). NO fetch, NO DOM, NO Vue reactivity: this module only
// turns the closed W6-1 aggregate unions into display text and editor-navigation targets, and is
// unit-tested in isolation.
//
// Design lock: docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
// §4.2 (closed enums), §5 (UI contract — item 5: pure logic lives in a standalone .ts module, not
// in the SFC or in AttendanceView.vue).
//
// Backend mirror (types + closed enums — canonical source; NOT cross-imported. apps/web mirrors
// backend contracts with a citing comment rather than importing packages/core-backend, matching the
// existing convention in attendanceSetupReadiness.ts / attendanceDecisionTrace.ts — there is no
// cross-package build wiring between apps/web and packages/core-backend/packages/openapi):
//   packages/core-backend/src/attendance/w6-group-effective-policy-contract.ts
//   packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts
//   packages/openapi/dist-sdk/index.d.ts (published SDK types, W6-2 / PR #4893)
//
// Every display-text map below is a `Record<ClosedUnion, …>`, never a hand-maintained array +
// switch: TypeScript requires every union member as a key, so a member added upstream without a
// matching entry here fails to compile rather than silently rendering nothing (matches the
// established idiom in attendanceContextHelp.ts's BLOCKED_SPREADSHEET_HELP_LINES — see that file's
// P2-1 finding comment for why an array + switch let a union member go missing undetected).

import {
  ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO,
  ATTENDANCE_GROUP_ROUTE_STEPS,
  ATTENDANCE_GROUP_STEP_SURFACES,
  buildAttendanceGroupRouteHref,
  type AttendanceGroupRouteStep,
  type AttendanceGroupRouteSurface,
} from '../../router/attendanceGroupContextRoute'

export type TranslateFn = (en: string, zh: string) => string

// ---------------------------------------------------------------------------
// Closed enums (contract §4.2)
// ---------------------------------------------------------------------------

/** Parent §5.1 five display states — machine spelling per OD-W6-3(a). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1 = Object.freeze([
  'effective',
  'org_inherited',
  'preview_only',
  'needs_configuration',
  'conflict_action_required',
] as const)
export type AttendanceGroupEffectivePolicySourceLabelV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1)[number]

/** Closed policy-domain union per OD-W6-4(a). `basics` never has a `domains.basics` summary
 *  object (§4.3) — it appears only as a `conflicts[].domain` value. */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1 = Object.freeze([
  'basics',
  'membership',
  'schedule',
  'segments',
  'flex',
  'rules',
  'punch_method',
  'request_posture',
] as const)
export type AttendanceGroupEffectivePolicyDomainV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1)[number]

/** Closed v1 conflict inventory per OD-W6-4(a). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1 = Object.freeze([
  'CALCULATION_GROUP_MEMBERSHIP_OVERLAP',
  'FIXED_SCHEDULE_CONFIGURATION_CHANGED',
  'FIXED_SCHEDULE_PENDING_APPLY',
  'FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW',
  'SCHEDULE_STRATEGY_INCOMPLETE',
  'RULE_SOURCE_MISSING',
  'TIMEZONE_MISSING',
] as const)
export type AttendanceGroupEffectivePolicyConflictCodeV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1)[number]

/** Existing CHECK-constrained group-type union (read-only mirror). */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1 = Object.freeze([
  'fixed_shift',
  'scheduled_shift',
  'free_time',
] as const)
export type AttendanceGroupEffectivePolicyGroupTypeV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1)[number]

/** Read-only mirror of the W4 org rollout-state union. */
export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1 = Object.freeze([
  'legacy',
  'shadow',
  'eligible',
  'authoritative',
  'suspended',
] as const)
export type AttendanceGroupEffectivePolicyCalculationPostureV1 =
  (typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1)[number]

/** FSER's own closed state list (read-only mirror; W6 adds no FSER state). */
export const ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1 = Object.freeze([
  'not_configured',
  'pending_apply',
  'effective',
  'configuration_changed',
] as const)
export type AttendanceGroupFixedScheduleStateV1 = (typeof ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1)[number]

// ---------------------------------------------------------------------------
// Display-text maps — Record<ClosedUnion, …>, no free text composed elsewhere.
// ---------------------------------------------------------------------------

const SOURCE_LABEL_TEXT: Record<AttendanceGroupEffectivePolicySourceLabelV1, (tr: TranslateFn) => string> = {
  effective: (tr) => tr('Effective', '生效中'),
  org_inherited: (tr) => tr('Org default', '继承组织默认'),
  preview_only: (tr) => tr('Preview only', '仅预览'),
  needs_configuration: (tr) => tr('Needs configuration', '待配置'),
  conflict_action_required: (tr) => tr('Conflict — action required', '存在冲突，需处理'),
}

export function attendanceGroupEffectivePolicySourceLabelText(
  label: AttendanceGroupEffectivePolicySourceLabelV1,
  tr: TranslateFn,
): string {
  return SOURCE_LABEL_TEXT[label](tr)
}

const DOMAIN_TEXT: Record<AttendanceGroupEffectivePolicyDomainV1, (tr: TranslateFn) => string> = {
  basics: (tr) => tr('Basics', '基本信息'),
  membership: (tr) => tr('Membership', '成员'),
  schedule: (tr) => tr('Schedule', '排班'),
  segments: (tr) => tr('Segments', '时段'),
  flex: (tr) => tr('Flexible hours', '弹性工时'),
  rules: (tr) => tr('Rules', '规则'),
  punch_method: (tr) => tr('Punch method', '打卡方式'),
  request_posture: (tr) => tr('Request posture', '申请策略'),
}

export function attendanceGroupEffectivePolicyDomainText(
  domain: AttendanceGroupEffectivePolicyDomainV1,
  tr: TranslateFn,
): string {
  return DOMAIN_TEXT[domain](tr)
}

const CONFLICT_CODE_TEXT: Record<AttendanceGroupEffectivePolicyConflictCodeV1, (tr: TranslateFn) => string> = {
  CALCULATION_GROUP_MEMBERSHIP_OVERLAP: (tr) =>
    tr('Overlapping calculation-group membership', '存在重叠的核算组成员关系'),
  FIXED_SCHEDULE_CONFIGURATION_CHANGED: (tr) => tr('Fixed-schedule configuration changed', '固定排班配置已变更'),
  FIXED_SCHEDULE_PENDING_APPLY: (tr) => tr('Fixed-schedule change pending apply', '固定排班变更待应用'),
  FIXED_SCHEDULE_UNPUBLISHED_MANAGED_ROW: (tr) =>
    tr('Fixed-schedule has unpublished managed rows', '固定排班存在未发布的托管行'),
  SCHEDULE_STRATEGY_INCOMPLETE: (tr) => tr('Schedule strategy incomplete', '排班策略未配置完整'),
  RULE_SOURCE_MISSING: (tr) => tr('Rule source missing', '缺少规则来源'),
  TIMEZONE_MISSING: (tr) => tr('Timezone missing', '缺少时区'),
}

export function attendanceGroupEffectivePolicyConflictCodeText(
  code: AttendanceGroupEffectivePolicyConflictCodeV1,
  tr: TranslateFn,
): string {
  return CONFLICT_CODE_TEXT[code](tr)
}

const GROUP_TYPE_TEXT: Record<AttendanceGroupEffectivePolicyGroupTypeV1, (tr: TranslateFn) => string> = {
  fixed_shift: (tr) => tr('Fixed shift', '固定班'),
  scheduled_shift: (tr) => tr('Scheduled shift', '排班制'),
  free_time: (tr) => tr('Free time', '自由工时'),
}

export function attendanceGroupEffectivePolicyGroupTypeText(
  groupType: AttendanceGroupEffectivePolicyGroupTypeV1,
  tr: TranslateFn,
): string {
  return GROUP_TYPE_TEXT[groupType](tr)
}

const CALCULATION_POSTURE_TEXT: Record<
  AttendanceGroupEffectivePolicyCalculationPostureV1,
  (tr: TranslateFn) => string
> = {
  legacy: (tr) => tr('Legacy', '存量口径'),
  shadow: (tr) => tr('Shadow', '影子运行'),
  eligible: (tr) => tr('Eligible', '具备切换资格'),
  authoritative: (tr) => tr('Authoritative', '权威口径'),
  suspended: (tr) => tr('Suspended', '已暂停'),
}

export function attendanceGroupEffectivePolicyCalculationPostureText(
  posture: AttendanceGroupEffectivePolicyCalculationPostureV1,
  tr: TranslateFn,
): string {
  return CALCULATION_POSTURE_TEXT[posture](tr)
}

const FIXED_SCHEDULE_STATE_TEXT: Record<AttendanceGroupFixedScheduleStateV1, (tr: TranslateFn) => string> = {
  not_configured: (tr) => tr('Not configured', '未配置'),
  pending_apply: (tr) => tr('Pending apply', '待应用'),
  effective: (tr) => tr('Effective', '生效中'),
  configuration_changed: (tr) => tr('Configuration changed', '配置已变更'),
}

export function attendanceGroupFixedScheduleStateText(
  state: AttendanceGroupFixedScheduleStateV1,
  tr: TranslateFn,
): string {
  return FIXED_SCHEDULE_STATE_TEXT[state](tr)
}

// ---------------------------------------------------------------------------
// Runtime guards — fetched JSON is `unknown`; these fail closed (return null / false) rather than
// coercing an unrecognized value to a valid-looking label (W6-R6: "unknown internal states fail
// closed rather than mapping to a default label").
// ---------------------------------------------------------------------------

function makeGuard<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const set = new Set<string>(values)
  return (value: unknown): value is T => typeof value === 'string' && set.has(value)
}

export const isAttendanceGroupEffectivePolicySourceLabelV1 = makeGuard(
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_SOURCE_LABELS_V1,
)
export const isAttendanceGroupEffectivePolicyDomainV1 = makeGuard(ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAINS_V1)
export const isAttendanceGroupEffectivePolicyConflictCodeV1 = makeGuard(
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CONFLICT_CODES_V1,
)
export const isAttendanceGroupEffectivePolicyGroupTypeV1 = makeGuard(ATTENDANCE_GROUP_EFFECTIVE_POLICY_GROUP_TYPES_V1)
export const isAttendanceGroupEffectivePolicyCalculationPostureV1 = makeGuard(
  ATTENDANCE_GROUP_EFFECTIVE_POLICY_CALCULATION_POSTURES_V1,
)
export const isAttendanceGroupFixedScheduleStateV1 = makeGuard(ATTENDANCE_GROUP_FIXED_SCHEDULE_STATES_V1)

// ---------------------------------------------------------------------------
// Response `domains` object keys (camelCase) -> closed domain enum values (snake_case). Lets every
// caller share ONE domain-label function instead of two vocabularies for the same concept.
// `basics` has no summary key (see above).
// ---------------------------------------------------------------------------

export const ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1 = Object.freeze({
  membership: 'membership',
  schedule: 'schedule',
  segments: 'segments',
  flex: 'flex',
  rules: 'rules',
  punchMethod: 'punch_method',
  requestPosture: 'request_posture',
} satisfies Record<string, AttendanceGroupEffectivePolicyDomainV1>)
export type AttendanceGroupEffectivePolicyDomainSummaryKeyV1 =
  keyof typeof ATTENDANCE_GROUP_EFFECTIVE_POLICY_DOMAIN_SUMMARY_KEYS_V1

// ---------------------------------------------------------------------------
// editorRef union (contract §4.2, OD-W6-9(a)) + navigation resolver.
// ---------------------------------------------------------------------------

/** `basics|people` stay ordinary group-editor stages outside the #4711 route family (that lock's
 *  own §3.1); `schedule|policies` line up with #4711 steps but are reached via `group_stage` when
 *  the aggregate names the editor stage directly rather than a route step. */
const GROUP_STAGES = Object.freeze(['basics', 'people', 'schedule', 'policies'] as const)
export type AttendanceGroupEffectivePolicyStageV1 = (typeof GROUP_STAGES)[number]

export type AttendanceGroupEffectivePolicyEditorRefV1 =
  | { readonly kind: 'group_stage'; readonly stage: AttendanceGroupEffectivePolicyStageV1 }
  | {
      readonly kind: 'group_context_route'
      readonly step: AttendanceGroupRouteStep
      readonly surface?: AttendanceGroupRouteSurface
    }

function isAttendanceGroupEffectivePolicyStageV1(value: unknown): value is AttendanceGroupEffectivePolicyStageV1 {
  return typeof value === 'string' && (GROUP_STAGES as readonly string[]).includes(value)
}

/** Fail-closed parser for the raw fetched `editorRef` value: an unrecognized kind/step/stage/
 *  surface returns `null` rather than a best-effort guess (W6-R8: closed-table parse only). */
export function parseAttendanceGroupEffectivePolicyEditorRefV1(
  value: unknown,
): AttendanceGroupEffectivePolicyEditorRefV1 | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'group_stage') {
    return isAttendanceGroupEffectivePolicyStageV1(candidate.stage)
      ? { kind: 'group_stage', stage: candidate.stage }
      : null
  }
  if (candidate.kind === 'group_context_route') {
    if (
      typeof candidate.step !== 'string' ||
      !(ATTENDANCE_GROUP_ROUTE_STEPS as readonly string[]).includes(candidate.step)
    ) {
      return null
    }
    const step = candidate.step as AttendanceGroupRouteStep
    if (candidate.surface === undefined) return { kind: 'group_context_route', step }
    if (
      typeof candidate.surface !== 'string' ||
      !(ATTENDANCE_GROUP_STEP_SURFACES[step] as readonly string[]).includes(candidate.surface)
    ) {
      return null
    }
    return { kind: 'group_context_route', step, surface: candidate.surface as AttendanceGroupRouteSurface }
  }
  return null
}

export type AttendanceGroupEffectivePolicyEditorNavigationV1 =
  | { readonly kind: 'route'; readonly href: string }
  | { readonly kind: 'group-list'; readonly href: string }

/**
 * Resolve one editorRef into a navigable target.
 *
 * `group_context_route` reuses the EXISTING #4711 route builder
 * (`buildAttendanceGroupRouteHref`) verbatim — the same function
 * `AttendanceExperienceView.vue`'s `openGroupRoute` already uses.
 *
 * `group_stage` (`basics|people|schedule|policies`) has no query-addressable deep link into a
 * specific stage tab today: the only existing entry point is clicking a group row inside the
 * classic groups list, which then exposes the stage tabs internally
 * (`selectAttendanceGroupStage` in `AttendanceView.vue` — a private ref with no external route
 * contract). Rather than inventing a NEW query-param/deep-link contract for that (design-lock
 * W6-R8: "mints no second navigation spelling and no caller-supplied section IDs"), every
 * `group_stage` ref resolves to the existing groups-list section
 * (`ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO`) — the honest, zero-invention target. Reaching the
 * specific stage tab from there still requires the existing manual click onto the group.
 */
export function resolveAttendanceGroupEffectivePolicyEditorNavigationV1(
  editorRef: AttendanceGroupEffectivePolicyEditorRefV1,
  context: { readonly groupId: string; readonly returnTo: string },
): AttendanceGroupEffectivePolicyEditorNavigationV1 | null {
  switch (editorRef.kind) {
    case 'group_stage':
      return { kind: 'group-list', href: ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO }
    case 'group_context_route': {
      const href = buildAttendanceGroupRouteHref({
        groupId: context.groupId,
        step: editorRef.step,
        surface: editorRef.surface ?? null,
        returnTo: context.returnTo,
      })
      return href ? { kind: 'route', href } : null
    }
    default: {
      const exhaustiveCheck: never = editorRef
      return exhaustiveCheck
    }
  }
}

// ---------------------------------------------------------------------------
// R7 — native neutral labels for unknown/deleted members.
//
// NOTE on call sites: the W6-1 aggregate is values-free by design-lock red line W6-R2 (counts and
// closed enums only — no member list, no user ID; see `managerPosture` and
// `conflicts[].affectedUserCount`, both counts). This panel therefore has NO current call site for
// this helper: it never renders a member identity. Shipped here per the W6-3 build brief item 3
// ("native R7 neutral labels for unknown/deleted users from the start"), pre-positioned for a
// future member-bearing surface, and deliberately DISTINCT from the raw-UUID fallback at
// AttendanceView.vue's member render path (~L5160, tracked separately as FE-06, a live runtime
// defect elsewhere this module does not touch or paper over).
// ---------------------------------------------------------------------------

export type AttendanceGroupEffectivePolicyMemberLabelKind = 'unknown' | 'deleted'

const MEMBER_LABEL_TEXT: Record<AttendanceGroupEffectivePolicyMemberLabelKind, (tr: TranslateFn) => string> = {
  unknown: (tr) => tr('Unknown member', '未知成员'),
  deleted: (tr) => tr('Deleted member', '已删除成员'),
}

export function attendanceGroupEffectivePolicyNeutralMemberLabel(
  kind: AttendanceGroupEffectivePolicyMemberLabelKind,
  tr: TranslateFn,
): string {
  return MEMBER_LABEL_TEXT[kind](tr)
}

// ---------------------------------------------------------------------------
// Minimal envelope narrowing for the panel's fetch response (contract §4.3).
//
// This is deliberately NOT a re-implementation of the backend's full exact-key,
// enum-strict validator (`validateAttendanceGroupEffectivePolicyResponseV1` in
// `packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts`) — that
// property is already owned and tested server-side (W6-1/W6-2). This only narrows "is this at
// least a `{ ok: true, data: {...groupId} }` shape" so the panel can safely route individual field
// reads through the closed-enum guards above (each of which already fails closed on its own) —
// values-free by construction (W6-R2): nothing here reformats or echoes an unrecognized value,
// callers render only the closed-enum-derived label text or a fixed "unrecognized" indicator.
// ---------------------------------------------------------------------------

/** Untyped mirror of the aggregate `data` shape — every field is `unknown` until a guard narrows
 *  it. Mirrors `AttendanceGroupEffectivePolicyAggregateV1` in the backend contract module (§4.3). */
export interface AttendanceGroupEffectivePolicyAggregateRawV1 {
  readonly groupId: string
  readonly groupType: unknown
  readonly timezone: unknown
  readonly activeMemberCount: unknown
  readonly managerPosture: unknown
  readonly calculationPosture: unknown
  readonly domains: unknown
  readonly conflicts: unknown
  readonly evaluatedAt: unknown
}

/** `{ ok: true, data: {...} }` envelope narrowing. Returns `null` for any other shape (including
 *  a well-formed `{ ok: false, error }` rejection body, which the caller already branches on via
 *  HTTP status before this is ever invoked). */
export function parseAttendanceGroupEffectivePolicyEnvelopeV1(
  raw: unknown,
): AttendanceGroupEffectivePolicyAggregateRawV1 | null {
  if (!raw || typeof raw !== 'object') return null
  const envelope = raw as Record<string, unknown>
  if (envelope.ok !== true) return null
  const data = envelope.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.groupId !== 'string' || !d.groupId.trim()) return null
  return d as unknown as AttendanceGroupEffectivePolicyAggregateRawV1
}
