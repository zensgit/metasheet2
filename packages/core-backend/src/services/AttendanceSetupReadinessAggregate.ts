/**
 * W4-0 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§4/§9 — see
 * docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md): the seven-step
 * setup-readiness aggregate's computational core — every org-scoped COUNT, the ④ punch-policy
 * closed-set posture check, the ⑥ notify readiness port, the §3② step③/⑦ pure formulas, and the
 * ONLY authorized read-only proof (§4.2 / §9 W4-0-G2). This module has zero Express/route
 * dependencies (no `Request`/`Response`) so every function is directly unit-testable with a mock
 * query function — the route wiring (authorization-before-aggregation, `directoryLinked` reuse of
 * S7-5's `readOrgDirectoryReadiness`, HTTP status mapping) lives in
 * `packages/core-backend/src/routes/attendance-admin.ts`, which imports from here.
 *
 * §0 red line R1 (readiness is READ-ONLY): `runAttendanceSetupReadinessReadOnly` is the ONLY
 * sanctioned way any of this module's queries may reach Postgres in production. It is a REAL
 * `SET TRANSACTION READ ONLY` transaction — never a prefix/regex check on SQL text. A prior,
 * frozen attempt at this line used `sql.trim().toUpperCase().startsWith('SELECT'||'WITH')`; it was
 * killed in review (three independent findings, all confirmed) because Postgres freely permits:
 *   (a) a data-modifying CTE — `WITH d AS (DELETE FROM t RETURNING 1) SELECT * FROM d` starts with
 *       `WITH` and passes a prefix check, but is a write;
 *   (b) `SELECT ... INTO new_table` — starts with `SELECT`, creates a table;
 *   (c) a multi-statement batch sent as a single un-parameterized string (`SELECT 1; DELETE ...`) —
 *       the simple-query protocol executes every statement in the batch.
 * All three slip straight past any first-token/regex test. `SET TRANSACTION READ ONLY` is a real
 * Postgres transaction property enforced by the server at EXECUTION time against the actual
 * command type of every statement that follows — bare, CTE-nested, or later in a batch — so it
 * closes all three holes at once, structurally, with no text inspection at all. See §9 W4-0-G2 for
 * the three required-reject test cases and the "no first-word/regex readiness check anywhere in
 * this module" negative meta-assertion (grep guard, not just a test).
 */
import type { QueryResult, QueryResultRow } from 'pg'
import { query, transaction } from '../db/pg'
import { getSharedAttendanceScheduler } from './AttendanceScheduler'

// ---------------------------------------------------------------------------------------------
// Value domain (§3 / §7): the SEVEN judgement values a step (or the whole per-step matrix, on a
// whole-endpoint fold) may take. Exhaustive — a discriminator branch must never invent an eighth.
// ---------------------------------------------------------------------------------------------

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

/** The seven canonical step ids (§3), stable wizard order. Doubles as the canonical admin-section
 *  deep-link id for steps ①-⑥ (§6.2); `preview` has no section — ⑦ lives inside the wizard. */
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

// ---------------------------------------------------------------------------------------------
// §3.2 "计划生效时间" — four-state posture, registered once per step, never guessed (追加门禁4).
// Fully static (no step in this slice has an app-observable *scheduled* trigger), so this is a
// plain constant, computed with zero DB access, safe to reuse verbatim in every response.
// ---------------------------------------------------------------------------------------------

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

export const ATTENDANCE_SETUP_READINESS_STEP_EFFECTIVE_TIME: Readonly<
  Record<AttendanceSetupStepId, AttendanceSetupReadinessEffectiveTime>
> = {
  'attendance-admin-user-access': { source: 'user_orgs.is_active', posture: 'immediate' },
  'attendance-admin-groups': { source: 'attendance_group_members', posture: 'immediate' },
  'attendance-admin-shifts': { source: 'attendance_shifts+attendance_rotation_rules', posture: 'immediate' },
  'attendance-admin-settings': { source: 'system_configs.attendance_settings', posture: 'immediate' },
  'attendance-admin-approval-flows': { source: 'attendance_approval_flows.is_active', posture: 'immediate' },
  // Channel/worker enablement is operator env/redeploy-controlled — no app-observable schedule.
  'attendance-admin-notification-deliveries': { source: 'none', posture: 'undeterminable' },
  // §3⑦: preview-ready never means "already enabled" — activation is always a human action against
  // the canonical checklist, never an app-triggered event.
  preview: { source: 'none', posture: 'manual_activation' },
}

/** §4.2-locked wire shape for the response's `perStep` key: the design lock's own JSON block
 *  writes `perStep.effectiveTime: { source, posture, effectiveAt? }` — i.e. each per-step ENTRY
 *  is an object carrying an `effectiveTime` key, not the effective-time record itself. (Trilens
 *  review on the frozen predecessor: a flat `perStep[stepId] = {source,posture,effectiveAt?}`
 *  shape reads as a claims-vs-lock-text deviation.) This wraps
 *  `ATTENDANCE_SETUP_READINESS_STEP_EFFECTIVE_TIME` — the single source of truth for VALUES — into
 *  the locked wire shape once, at module load, so every request reuses the same frozen object. */
export interface AttendanceSetupReadinessPerStepEntry {
  effectiveTime: AttendanceSetupReadinessEffectiveTime
}

export const ATTENDANCE_SETUP_READINESS_PER_STEP: Readonly<
  Record<AttendanceSetupStepId, AttendanceSetupReadinessPerStepEntry>
> = Object.fromEntries(
  ATTENDANCE_SETUP_STEP_IDS.map((stepId) => [
    stepId,
    { effectiveTime: ATTENDANCE_SETUP_READINESS_STEP_EFFECTIVE_TIME[stepId] },
  ]),
) as Readonly<Record<AttendanceSetupStepId, AttendanceSetupReadinessPerStepEntry>>

// ---------------------------------------------------------------------------------------------
// §4.1 / R1: the read-only seam. Exported so a real-DB test can drive it DIRECTLY with synthetic
// SQL (the behavioural proof §9 W4-0-G2 requires) without going through any business query.
// ---------------------------------------------------------------------------------------------

/** Matches `typeof query`'s call shape so it is a drop-in replacement everywhere `query` is used
 *  as a parameter default (e.g. S7-5's `readOrgDirectoryReadiness`). */
export type AttendanceSetupReadinessQueryFn = typeof query

export async function runAttendanceSetupReadinessReadOnly<T>(
  handler: (readOnlyQuery: AttendanceSetupReadinessQueryFn) => Promise<T>,
  runTransaction: typeof transaction = transaction,
): Promise<T> {
  return runTransaction(async (client) => {
    // MUST be the first statement in the transaction (Postgres applies READ ONLY to every
    // statement issued afterward in THIS transaction, regardless of shape or batching — see the
    // module header for exactly which write-shapes this closes that a text check could not).
    await client.query('SET TRANSACTION READ ONLY')
    const readOnlyQuery = (<T2 extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T2>> => client.query(sql, params) as Promise<QueryResult<T2>>) as AttendanceSetupReadinessQueryFn
    return handler(readOnlyQuery)
  })
}

// ---------------------------------------------------------------------------------------------
// §3①②③⑤ / §4.2 / OD-W4-1 追加门禁2: every org-scoped count in a single CTE, `org_id = $1` on
// every leg, one positional parameter for the whole query (S7-5 precedent; §9 audits this SQL
// text literally — 7 occurrences of `org_id = $1`, exactly one `$` parameter).
// ---------------------------------------------------------------------------------------------

export interface AttendanceSetupReadinessOrgCounts {
  orgActiveMemberCount: number
  groupCount: number
  groupsWithMembers: number
  shiftCount: number
  scheduledShiftGroupCount: number
  activeRotationRuleCount: number
  approvalFlowCount: number
}

export async function readAttendanceSetupReadinessOrgCounts(
  orgId: string,
  runQuery: AttendanceSetupReadinessQueryFn,
): Promise<AttendanceSetupReadinessOrgCounts> {
  const result = await runQuery<{
    org_active_member_count: number
    group_count: number
    groups_with_members: number
    shift_count: number
    scheduled_shift_group_count: number
    active_rotation_rule_count: number
    approval_flow_count: number
  }>(
    `WITH member_scope AS (
       -- §3① P2-1: RD-3 "active org members only" — BOTH user_orgs.is_active AND users.is_active
       -- (mirrors canReadAttendanceDirectoryReadiness's own org-membership door verbatim).
       SELECT COUNT(*)::int AS org_active_member_count
         FROM user_orgs uo
         JOIN users u ON u.id = uo.user_id AND u.is_active = true
        WHERE uo.org_id = $1 AND uo.is_active = true
     ),
     group_member_counts AS (
       SELECT group_id, COUNT(*)::int AS member_count
         FROM attendance_group_members
        WHERE org_id = $1
        GROUP BY group_id
     ),
     group_scope AS (
       -- §3② / OD-W4-6: groupCount vs groupsWithMembers, deliberately split.
       SELECT COUNT(*)::int AS group_count,
              COUNT(*) FILTER (WHERE COALESCE(gmc.member_count, 0) > 0)::int AS groups_with_members
         FROM attendance_groups g
         LEFT JOIN group_member_counts gmc ON gmc.group_id = g.id
        WHERE g.org_id = $1
     ),
     shift_scope AS (
       SELECT COUNT(*)::int AS shift_count
         FROM attendance_shifts
        WHERE org_id = $1
     ),
     scheduled_shift_group_scope AS (
       -- §3③ errata: the missing "排班制组是否存在" signal, owner's literal definition.
       SELECT COUNT(*)::int AS scheduled_shift_group_count
         FROM attendance_groups
        WHERE org_id = $1 AND attendance_type = 'scheduled_shift'
     ),
     rotation_scope AS (
       SELECT COUNT(*)::int AS active_rotation_rule_count
         FROM attendance_rotation_rules
        WHERE org_id = $1 AND is_active = true
     ),
     approval_scope AS (
       SELECT COUNT(*)::int AS approval_flow_count
         FROM attendance_approval_flows
        WHERE org_id = $1 AND is_active = true
     )
     SELECT member_scope.org_active_member_count,
            group_scope.group_count,
            group_scope.groups_with_members,
            shift_scope.shift_count,
            scheduled_shift_group_scope.scheduled_shift_group_count,
            rotation_scope.active_rotation_rule_count,
            approval_scope.approval_flow_count
       FROM member_scope, group_scope, shift_scope, scheduled_shift_group_scope, rotation_scope, approval_scope`,
    [orgId],
  )
  const row = result.rows[0]
  return {
    orgActiveMemberCount: Number(row?.org_active_member_count ?? 0),
    groupCount: Number(row?.group_count ?? 0),
    groupsWithMembers: Number(row?.groups_with_members ?? 0),
    shiftCount: Number(row?.shift_count ?? 0),
    scheduledShiftGroupCount: Number(row?.scheduled_shift_group_count ?? 0),
    activeRotationRuleCount: Number(row?.active_rotation_rule_count ?? 0),
    approvalFlowCount: Number(row?.approval_flow_count ?? 0),
  }
}

// ---------------------------------------------------------------------------------------------
// §3③ step3Ready / §3⑦ previewReady — pure formulas, zero I/O, owner-literal (errata + re-ratify).
// ---------------------------------------------------------------------------------------------

/** §3③ errata, owner-literal: org-level EXISTENCE test, not per-group rotation coverage (today's
 *  schema has no group<->rotation-rule association — see the design lock's §3③ cell). */
export function computeAttendanceSetupReadinessStep3Ready(
  shiftCount: number,
  scheduledShiftGroupCount: number,
  activeRotationRuleCount: number,
): boolean {
  return shiftCount > 0 && (scheduledShiftGroupCount === 0 || activeRotationRuleCount > 0)
}

/** §3.2 / §9 W4-0-G4: previewReady = ①②③⑤ ALL ready. ④ and ⑥ are advisory and MUST NOT
 *  participate — this is asserted directly by a contract test that flips every ④/⑥ combination
 *  and shows previewReady unaffected. */
export function computeAttendanceSetupReadinessPreviewReady(counts: AttendanceSetupReadinessOrgCounts): boolean {
  const step1Ready = counts.orgActiveMemberCount > 0
  const step2Ready = counts.groupCount > 0 && counts.groupsWithMembers > 0
  const step3Ready = computeAttendanceSetupReadinessStep3Ready(
    counts.shiftCount,
    counts.scheduledShiftGroupCount,
    counts.activeRotationRuleCount,
  )
  const step5Ready = counts.approvalFlowCount > 0
  return step1Ready && step2Ready && step3Ready && step5Ready
}

// ---------------------------------------------------------------------------------------------
// §3④ / §3.1 / OD-W4-4=(c) — punch-policy posture: back-end internal semantic check against the
// §3.1 CLOSED SET (punchPolicy, ipAllowlist, geoFence, minPunchIntervalMinutes — 4 of 24 top-level
// DEFAULT_SETTINGS keys), never the whole settings blob. The front end only ever sees this 3-value
// enum — raw settings values never leave this function.
// ---------------------------------------------------------------------------------------------

const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'

export type AttendancePunchPolicyPosture = 'default' | 'customized' | 'unknown'

/** Literal mirror of `DEFAULT_SETTINGS`'s §3.1 closed-set subset
 *  (plugins/plugin-attendance/index.cjs, `DEFAULT_SETTINGS` ~L295-512). core-backend has no
 *  sanctioned import of plugin internals (plugin -> core-backend is the only wired dependency
 *  direction), so this is an independently pinned literal copy of ONLY the closed set — never the
 *  other 20 settings keys, so an unrelated write (e.g. a holiday-sync machine write to
 *  `holidaySync.lastRun`) can never mislabel this posture (§3.1 "整包比对必然误判").
 *  KNOWN DRIFT RISK (flagged, not silently accepted — trilens P3 on the frozen predecessor): if the
 *  plugin's DEFAULT_SETTINGS closed-set defaults ever change, this mirror will not auto-follow; the
 *  §9 W4-0-G5 reconciliation test only checks that the KEY NAMES in the closed set are exhaustively
 *  classified against the live key set, not that this mirror's VALUES still match the plugin's. */
const ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT = {
  punchPolicy: {
    unscheduled: { mode: 'allow' },
    merge: { internalWinsOnIn: false, externalWinsOnOut: false },
    outdoor: { requireApproval: false, requireNote: false, requirePhoto: false, approvalFlowId: '' },
  },
  ipAllowlist: [] as unknown[],
  geoFence: null as Record<string, unknown> | null,
  minPunchIntervalMinutes: 1,
}

/** §3.1 closed-set membership registry, IN + OUT = all 24 DEFAULT_SETTINGS top-level keys. §9
 *  W4-0-G5's contract test parses the LIVE plugin source text (not a second hardcoded mirror of
 *  this list) and asserts IN ∪ OUT equals the live key set — a new settings key nobody classified
 *  reds that test instead of silently being swept into (or excluded from) the ④ comparison. */
export const ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_IN = [
  'punchPolicy',
  'ipAllowlist',
  'geoFence',
  'minPunchIntervalMinutes',
] as const

export const ATTENDANCE_PUNCH_POLICY_CLOSED_SET_KEYS_OUT = [
  'autoAbsence',
  'holidayPolicy',
  'calendarPolicy',
  'holidaySync',
  'shiftEditPolicy',
  'shiftCompliance',
  'multiShiftDay',
  'formula',
  'comprehensiveHours',
  'compTimeFromOvertime',
  'annualLeavePolicy',
  'overtimeSegmentation',
  'overtimeBankPolicy',
  'leaveBalanceDeductionPolicy',
  'attendanceBonusPolicy',
  'attendanceReportDigestPolicy',
  'makeupPunchPolicy',
  'attendanceResultEditPolicy',
  'autoShiftMatching',
  'reportSync',
] as const

function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqualJsonValue(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqualJsonValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  }
  return a === b
}

/**
 * §3④ / OD-W4-4=(c). Reads the ONE deployment-wide `system_configs` row and classifies the §3.1
 * closed-set subset against normalized defaults. Any write to `attendance.settings` is ALWAYS
 * `normalizeSettings(...)`'s output (plugin `saveSettings`, the sole write path) — so a stored row
 * is already normalized and this function compares it directly, with no re-normalization pass.
 * Legacy-schema note (found via a real Postgres probe against a pre-`z20251231` "038" JSONB
 * `system_configs.value` column): the pg driver auto-parses a `jsonb` column into a JS object, so
 * `JSON.parse(String(raw))` on that shape throws `"[object Object]" is not valid JSON`; today's
 * canonical migration creates `value text`, but a legacy-migrated deployment could still carry the
 * older jsonb column, so both shapes are handled here.
 */
export async function readAttendancePunchPolicyPosture(
  runQuery: AttendanceSetupReadinessQueryFn,
): Promise<AttendancePunchPolicyPosture> {
  try {
    const result = await runQuery<{ value: unknown }>('SELECT value FROM system_configs WHERE key = $1', [
      ATTENDANCE_SETTINGS_KEY,
    ])
    const raw = result.rows[0]?.value
    if (raw === undefined || raw === null) {
      // No row at all: the platform default is in force (never explicitly saved).
      return 'default'
    }
    const parsed: unknown = typeof raw === 'object' ? raw : JSON.parse(String(raw))
    if (!parsed || typeof parsed !== 'object' || !('punchPolicy' in (parsed as Record<string, unknown>))) {
      // A row exists but carries no punchPolicy subtree (pre-S0 shape / corrupted write) — cannot
      // honestly claim default or customized.
      return 'unknown'
    }
    const p = parsed as Record<string, unknown>
    const closedSet = {
      punchPolicy: p.punchPolicy,
      ipAllowlist: 'ipAllowlist' in p ? p.ipAllowlist : ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT.ipAllowlist,
      geoFence: 'geoFence' in p ? p.geoFence : ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT.geoFence,
      minPunchIntervalMinutes:
        'minPunchIntervalMinutes' in p
          ? p.minPunchIntervalMinutes
          : ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT.minPunchIntervalMinutes,
    }
    return deepEqualJsonValue(closedSet, ATTENDANCE_PUNCH_POLICY_CLOSED_SET_DEFAULT) ? 'default' : 'customized'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------------------------
// §4.5 — ⑥ the three independent notify signals (P2-2, MUST NOT be merged into one value).
// ---------------------------------------------------------------------------------------------

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

/**
 * §4.5(i): "调度器真的起来了" — the ONLY today-observable half of "scheduler up AND delivery job
 * registered" (the job-registration half has no public accessor; §4.5(i) explicitly forbids
 * inventing one for this slice). Deliberately reads `getSharedAttendanceScheduler()` ONLY — NEVER
 * `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` (§9 W4-0-G4's exact point: that env var being
 * `true` while the scheduler itself is down must still read `not_ready`, not `ready`).
 * scheduler null => 'not_ready' (actionable: an operator can start it); scheduler non-null =>
 * 'unknown', fail-closed — never 'ready' today (§4.5(i) "绝不报 ready").
 */
export function computeAttendanceSetupReadinessDeliveryRuntime(): AttendanceSetupReadinessDeliveryRuntime {
  return getSharedAttendanceScheduler() === null ? 'not_ready' : 'unknown'
}

/**
 * §4.5(ii): org-scoped bound-recipient coverage. Mirrors the EXACT join
 * `AttendanceNotificationDeliveryWorker.resolveRecipient` uses to find a usable recipient
 * (directory_account_links ⋈ directory_accounts ⋈ directory_integrations), minus the per-recipient
 * `local_user_id = $1` filter (this is an org-wide aggregate, not a single lookup).
 * **Provider coverage (§4.5(ii) real-source note "企微同型")**: the WeCom channel's own
 * `resolveRecipient` (`AttendanceNotificationDeliveryWorker.ts` WeCom section) uses the EXACT same
 * three-table join shape as DingTalk's, just with `provider='wecom'` on both legs — a
 * dingtalk-only filter here would under-report coverage (false `hasAnyBoundRecipient=false`) for a
 * purely-WeCom-deployed org. `a.provider = i.provider` (rather than pinning both sides to one
 * literal) plus the `IN (...)` list below covers both wired channels without a cross-provider
 * account/integration mismatch. `l.local_user_id IS NOT NULL` and `COUNT(DISTINCT ...)` mirror the
 * worker's own resolution precondition (`resolveRecipient` selects `WHERE l.local_user_id = $1`, so
 * a NULL-local_user_id link can never be resolved for anyone and must not inflate this count; two+
 * active links for the same local user is one recipient, not two — the worker itself flags that
 * shape as a data-integrity anomaly, not extra coverage). Returns ONLY a count/boolean — never a
 * userId, external_user_id, or integration id (values-free, §4.2). No `unknown` state exists for
 * this signal (its type is count/boolean only, unlike deliveryRuntime); a query failure here is not
 * swallowed — it propagates to the route's DB_NOT_READY/500 handling so the response is never a
 * fabricated zero.
 */
export async function readAttendanceSetupReadinessOrgRecipientBinding(
  orgId: string,
  runQuery: AttendanceSetupReadinessQueryFn,
): Promise<AttendanceSetupReadinessOrgRecipientBinding> {
  const result = await runQuery<{ bound_recipient_count: number }>(
    `SELECT COUNT(DISTINCT l.local_user_id)::int AS bound_recipient_count
       FROM directory_account_links l
       JOIN directory_accounts a
         ON a.id = l.directory_account_id
        AND a.provider IN ('dingtalk', 'wecom')
        AND a.is_active = true
       JOIN directory_integrations i
         ON i.id = a.integration_id
        AND i.provider = a.provider
        AND i.status = 'active'
        AND i.org_id = $1
      WHERE l.link_status = 'linked'
        AND l.local_user_id IS NOT NULL`,
    [orgId],
  )
  const count = Number(result.rows[0]?.bound_recipient_count ?? 0)
  return { boundRecipientCount: count, hasAnyBoundRecipient: count > 0 }
}

/** §4.5(iii): today there is no per-org/per-recipient scope-configuration capability at all
 *  (deployment-wide single default channel — see `AttendanceNotificationDeliveryWorker.ts`'s own
 *  "Per-org / per-recipient routing is the design-lock §3 follow-up" comment). Always
 *  `'unsupported'` — never rendered as "not configured yet" (that would name a remediation action
 *  that does not exist). */
export const ATTENDANCE_SETUP_READINESS_RECIPIENT_SCOPE_CONFIG = 'unsupported' as const
