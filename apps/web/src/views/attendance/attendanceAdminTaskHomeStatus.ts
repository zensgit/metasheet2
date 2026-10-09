// Attendance vNext leftovers (2026-09-17): charter §4.2 per-task status badges.
// Pure discriminator — zero DOM, zero fetch, zero Vue. AttendanceAdminTaskHome.vue only
// renders the code the parent supplies; AttendanceView.vue feeds already-loaded read-only
// signals (setup-readiness). Unknown / missing / unrecognized MUST stay `unknown` and
// MUST NOT become `ok` (charter §5.4 fail-closed; Wave 3 leftover, not the W4 "· 未完成" label).

import type { AttendanceSetupReadinessLoadState } from './useAttendanceSetupReadiness'
import type { AttendanceSetupReadinessInput, AttendanceSetupReadinessStepResult } from './attendanceSetupReadiness'

export const ATTENDANCE_ADMIN_TASK_HOME_STATUS_VALUES = [
  'not_configured',
  'needs_attention',
  'ok',
  'failed',
  'unknown',
] as const

export type AttendanceAdminTaskHomeStatus = (typeof ATTENDANCE_ADMIN_TASK_HOME_STATUS_VALUES)[number]

/** Fail-closed default. Mutation target: changing this to `ok` must turn the dedicated spec red. */
export const DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS: AttendanceAdminTaskHomeStatus = 'unknown'

const STATUS_SET: ReadonlySet<string> = new Set(ATTENDANCE_ADMIN_TASK_HOME_STATUS_VALUES)

/** Same gating set as the W4-1 "· 未完成" hint (①②③⑤). Advisory ④/⑥ never participate. */
export const TASK_HOME_PEOPLE_GROUPS_GATING_STEP_IDS = [
  'attendance-admin-user-access',
  'attendance-admin-groups',
  'attendance-admin-shifts',
  'attendance-admin-approval-flows',
] as const

export const TASK_HOME_STATUS_LABELS: Readonly<Record<AttendanceAdminTaskHomeStatus, { en: string; zh: string }>> = {
  not_configured: { en: 'Not configured', zh: '未配置' },
  needs_attention: { en: 'Needs attention', zh: '需处理' },
  ok: { en: 'OK', zh: '正常' },
  failed: { en: 'Failed', zh: '失败' },
  unknown: { en: 'Unknown', zh: '未知' },
}

export function isAttendanceAdminTaskHomeStatus(value: unknown): value is AttendanceAdminTaskHomeStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

/**
 * Closed-set resolver. Anything other than an explicit closed-set member — including
 * `undefined`, `null`, `''`, `'ready'`, `'success'` — is `unknown`. Never `ok`.
 */
export function resolveAttendanceAdminTaskHomeStatus(value: unknown): AttendanceAdminTaskHomeStatus {
  if (isAttendanceAdminTaskHomeStatus(value)) return value
  return DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS
}

export function attendanceAdminTaskHomeStatusLabel(
  status: AttendanceAdminTaskHomeStatus,
  tr: (en: string, zh: string) => string,
): string {
  const labels = TASK_HOME_STATUS_LABELS[resolveAttendanceAdminTaskHomeStatus(status)]
  return tr(labels.en, labels.zh)
}

export type PeopleGroupsTaskHomeStatusInput = {
  loadState: AttendanceSetupReadinessLoadState
  readiness: AttendanceSetupReadinessInput | null
  steps: readonly AttendanceSetupReadinessStepResult[]
}

/**
 * people-groups badge. Positive evidence required for `ok`: loaded `ok` payload AND every
 * gating step present and `ready`. Empty steps / idle / loading stay `unknown`.
 */
export function derivePeopleGroupsTaskHomeStatus(
  input: PeopleGroupsTaskHomeStatusInput,
): AttendanceAdminTaskHomeStatus {
  if (input.loadState === 'error') return 'failed'
  if (input.loadState === 'idle' || input.loadState === 'loading') return 'unknown'
  if (input.readiness?.kind === 'forbidden' || input.readiness?.kind === 'db_not_ready') return 'failed'
  if (input.readiness?.kind !== 'ok') return 'unknown'

  const gating = input.steps.filter((step) =>
    (TASK_HOME_PEOPLE_GROUPS_GATING_STEP_IDS as readonly string[]).includes(step.stepId),
  )
  if (gating.length === 0) return 'unknown'

  if (gating.every((step) => step.status === 'ready')) return 'ok'
  if (gating.some((step) => step.status === 'forbidden' || step.status === 'db_not_ready')) return 'failed'
  if (gating.some((step) => step.status === 'missing')) return 'not_configured'
  return 'needs_attention'
}

export type AdminTaskHomeGroupStatusKey =
  | 'daily-operations'
  | 'people-groups'
  | 'work-time-policies'
  | 'reporting-payroll'
  | string

/**
 * First-version group matrix. Groups without a reliable read-only aggregate stay `unknown`
 * (do not invent write paths or fake all-clear).
 */
export function deriveAdminTaskHomeGroupStatus(
  groupKey: AdminTaskHomeGroupStatusKey,
  peopleGroups: PeopleGroupsTaskHomeStatusInput,
): AttendanceAdminTaskHomeStatus {
  if (groupKey === 'people-groups') return derivePeopleGroupsTaskHomeStatus(peopleGroups)
  return DEFAULT_ATTENDANCE_ADMIN_TASK_HOME_STATUS
}
