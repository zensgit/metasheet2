/**
 * W5-0 (Wave 5 explainability design-lock 2026-07-22, RATIFIED — see
 * docs/development/attendance-vnext-wave5-explainability-data-contract-lock-20260722.md, §3/§4/§9):
 * the six read-only decision-trace evidence-chain builders + the payroll-cycle-settlement "seventh
 * read face" (OD-W5-6=(a)). Zero Express/Request/Response dependency (mirrors
 * `AttendanceSetupReadinessAggregate.ts`) so every builder is directly unit-testable with a mock
 * query function; route wiring (authorization-before-query, host/subject resolution, HTTP status
 * mapping) lives in `routes/attendance-admin.ts`.
 *
 * §0 red line R1 (explainability is READ-ONLY): every builder here runs its queries through
 * `runAttendanceDecisionTraceReadOnly`, a verbatim re-export of the ALREADY-proven
 * `runAttendanceSetupReadinessReadOnly` seam (`AttendanceSetupReadinessAggregate.ts:124-139`) — a
 * REAL `SET TRANSACTION READ ONLY` transaction, never a first-word/regex text check (§9 W4-0-G2's
 * three-case Postgres proof already covers this exact function; W5-0-G3 reuses it, not
 * re-derives it).
 *
 * §0 red line R2 (basis must point at real storage): every environment below reads STORED rows —
 * this module NEVER calls `computeMetrics`/rebuilds overtime segmentation/re-resolves the current
 * rule and presents the result as "what was decided". A `current_live_no_history` environment is
 * always the CURRENT policy, read fresh and labeled as such (never substituted for a missing
 * `snapshot_frozen` environment — §3.1 hard rule 6, "快照排他").
 *
 * Scope note (disclosed, W5-0 PR body "deviations"): the ①/③ "current effective rule" environment
 * resolves shift-assignment → org default rule → global default rule (mirrors two of the three
 * `resolveWorkContext` priority tiers, `index.cjs:14347-14394`) but does NOT walk
 * `attendance_rotation_rules` (the first, highest-priority tier) — `source.ref` only ever claims
 * `'shift_assignment' | 'org_default_rule' | 'global_default_rule'`, never `'rotation'`, so the
 * label is always honest about what was actually read even though rotation-assigned orgs get a
 * less specific (but never wrong) `current_live_no_history` citation.
 */
import type { QueryResultRow } from 'pg'
import {
  runAttendanceSetupReadinessReadOnly,
  type AttendanceSetupReadinessQueryFn,
} from './AttendanceSetupReadinessAggregate'

// -------------------------------------------------------------------------------------------------
// §4.2 read-only seam — verbatim reuse, not reimplementation (W5-0-G3).
// -------------------------------------------------------------------------------------------------
export const runAttendanceDecisionTraceReadOnly = runAttendanceSetupReadinessReadOnly
export type AttendanceDecisionTraceQueryFn = AttendanceSetupReadinessQueryFn

// -------------------------------------------------------------------------------------------------
// §3.1 category closed set (six classes, charter §7-Wave5 L366 verbatim order).
// -------------------------------------------------------------------------------------------------
export const ATTENDANCE_DECISION_TRACE_CATEGORIES = [
  'today_status',
  'late_early',
  'missing_punch',
  'overtime_segmentation',
  'comp_time_balance',
  'approver_source',
] as const
export type AttendanceDecisionTraceCategory = (typeof ATTENDANCE_DECISION_TRACE_CATEGORIES)[number]

export function isAttendanceDecisionTraceCategory(value: unknown): value is AttendanceDecisionTraceCategory {
  return (
    typeof value === 'string' &&
    (ATTENDANCE_DECISION_TRACE_CATEGORIES as readonly string[]).includes(value)
  )
}

// -------------------------------------------------------------------------------------------------
// §3.1 shared closed sets.
// -------------------------------------------------------------------------------------------------
export type AttendanceDecisionTraceVersionPosture =
  | 'snapshot_frozen'
  | 'current_live_no_history'
  | 'not_in_effect'
  | 'undeterminable'

export type AttendanceDecisionTraceConfidence = 'grounded' | 'partial' | 'undeterminable'

/** §5.1 / owner two-round-terminal-review P2-b — `'deleted'` deliberately excluded: `users` carries
 *  no delete tombstone (`zzzz20260119100000_create_users_table.ts:18`, only `is_active`), so
 *  "deleted" has no authoritative ground truth to distinguish from "never existed". */
export type AttendanceIdentityPosture = 'resolved' | 'inactive' | 'unknown'

export interface AttendanceDecisionTraceActor {
  displayLabel: string
  identityPosture: AttendanceIdentityPosture
}

export interface AttendanceDecisionTraceAuditRef {
  kind: string
  at: string
  actor?: AttendanceDecisionTraceActor
}

export interface AttendanceDecisionTraceVersion {
  posture: AttendanceDecisionTraceVersionPosture
  asOf?: string
  snapshotVersion?: string
}

export type AttendanceDecisionTraceSourceKind =
  | 'record'
  | 'snapshot'
  | 'rule_live'
  | 'ledger'
  | 'audit'
  | 'policy_gate'

export interface AttendanceDecisionTraceSource {
  kind: AttendanceDecisionTraceSourceKind
  ref: string
}

export interface AttendanceDecisionTraceBasisEnv {
  source: AttendanceDecisionTraceSource
  version: AttendanceDecisionTraceVersion
  auditRef?: AttendanceDecisionTraceAuditRef
}

/** `attendance_records_status_check` closed set (`zzzz20260114120000...ts:211`, 8 values —
 *  `'off'` added by the scheduling migration over the original 7). Single source of truth for the
 *  ①/② `reasonCode` code source (§3.1 hard rule 5①②). */
export const ATTENDANCE_RECORD_STATUS_VALUES = [
  'normal',
  'late',
  'early_leave',
  'late_early',
  'partial',
  'absent',
  'adjusted',
  'off',
] as const
export type AttendanceRecordStatus = (typeof ATTENDANCE_RECORD_STATUS_VALUES)[number]

// -------------------------------------------------------------------------------------------------
// Row shapes read directly off storage (documented per-table so a future maintainer does not have
// to re-derive them from migrations/index.cjs — same discipline as the W4-0 module).
// -------------------------------------------------------------------------------------------------
interface AttendanceRecordRow extends QueryResultRow {
  id: string
  status: string
  is_workday: boolean
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  meta: Record<string, unknown> | null
  source_batch_id: string | null
  created_at: string
  updated_at: string
}

interface UserIdentityRow extends QueryResultRow {
  id: string
  name: string | null
  email: string | null
  is_active: boolean
}

/** Resolve a stored actor user id into the §5.1 wire-safe `{displayLabel, identityPosture}` shape.
 *  NEVER falls back to the raw id (owner terminal-review P2-3) — absent/inactive rows get a neutral
 *  Chinese label, matching the existing never-fabricate precedent
 *  (`apps/web/src/approvals/routePreviewSummary.ts:11`). */
export async function resolveAttendanceDecisionTraceActor(
  userId: string | null | undefined,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceDecisionTraceActor | null> {
  const id = typeof userId === 'string' ? userId.trim() : ''
  if (!id) return null
  const result = await runQuery<UserIdentityRow>(
    `SELECT id, name, email, is_active FROM users WHERE id = $1`,
    [id],
  )
  const row = result.rows[0]
  if (!row) {
    return { displayLabel: '未知用户', identityPosture: 'unknown' }
  }
  if (row.is_active === false) {
    return { displayLabel: '已停用用户', identityPosture: 'inactive' }
  }
  const label = (row.name && row.name.trim()) || (row.email && row.email.trim()) || '已注册用户'
  return { displayLabel: label, identityPosture: 'resolved' }
}

/** §3.1 hard rule — confidence is PURELY derived from the basis chain, never an independent
 *  assertion. `grounded` requires every environment to be `snapshot_frozen` (or absent); any
 *  `current_live_no_history`/`not_in_effect` degrades to `partial`; any `undeterminable` degrades
 *  the whole trace to `undeterminable` (§3.1 hard rule 1). */
export function deriveAttendanceDecisionTraceConfidence(
  basis: AttendanceDecisionTraceBasisEnv[],
): AttendanceDecisionTraceConfidence {
  if (basis.length === 0) return 'undeterminable'
  let sawNonFrozen = false
  for (const env of basis) {
    if (env.version.posture === 'undeterminable') return 'undeterminable'
    if (env.version.posture !== 'snapshot_frozen') sawNonFrozen = true
  }
  return sawNonFrozen ? 'partial' : 'grounded'
}

// -------------------------------------------------------------------------------------------------
// §4.1 current-rule resolution (shift assignment → org default rule → global default rule). Only
// ever produces `current_live_no_history` environments — NEVER presented as a historical decision
// basis (§3.1 hard rule 6).
// -------------------------------------------------------------------------------------------------
interface CurrentRuleGraceParams {
  refKind: 'shift_assignment' | 'org_default_rule' | 'global_default_rule'
  lateGraceMinutes: number
  earlyGraceMinutes: number
  severeLateThresholdMinutes: number | null
  absenceLateThresholdMinutes: number | null
}

async function resolveCurrentRuleGraceParams(
  orgId: string,
  userId: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<CurrentRuleGraceParams | null> {
  const shiftAssignment = await runQuery<{
    late_grace_minutes: number
    early_grace_minutes: number
  }>(
    `SELECT s.late_grace_minutes, s.early_grace_minutes
       FROM attendance_shift_assignments a
       JOIN attendance_shifts s ON s.id = a.shift_id
      WHERE a.org_id = $1 AND a.user_id = $2 AND a.is_active = true
        AND a.start_date <= CURRENT_DATE
        AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)
      ORDER BY a.start_date DESC
      LIMIT 1`,
    [orgId, userId],
  )
  if (shiftAssignment.rows[0]) {
    const row = shiftAssignment.rows[0]
    return {
      refKind: 'shift_assignment',
      lateGraceMinutes: Number(row.late_grace_minutes) || 0,
      earlyGraceMinutes: Number(row.early_grace_minutes) || 0,
      severeLateThresholdMinutes: null,
      absenceLateThresholdMinutes: null,
    }
  }
  const orgDefault = await runQuery<{
    late_grace_minutes: number
    early_grace_minutes: number
    severe_late_threshold_minutes: number | null
    absence_late_threshold_minutes: number | null
  }>(
    `SELECT late_grace_minutes, early_grace_minutes, severe_late_threshold_minutes, absence_late_threshold_minutes
       FROM attendance_rules WHERE org_id = $1 AND is_default = true LIMIT 1`,
    [orgId],
  )
  if (orgDefault.rows[0]) {
    const row = orgDefault.rows[0]
    return {
      refKind: 'org_default_rule',
      lateGraceMinutes: Number(row.late_grace_minutes) || 0,
      earlyGraceMinutes: Number(row.early_grace_minutes) || 0,
      severeLateThresholdMinutes:
        row.severe_late_threshold_minutes == null ? null : Number(row.severe_late_threshold_minutes),
      absenceLateThresholdMinutes:
        row.absence_late_threshold_minutes == null ? null : Number(row.absence_late_threshold_minutes),
    }
  }
  const globalDefault = await runQuery<{
    late_grace_minutes: number
    early_grace_minutes: number
    severe_late_threshold_minutes: number | null
    absence_late_threshold_minutes: number | null
  }>(
    `SELECT late_grace_minutes, early_grace_minutes, severe_late_threshold_minutes, absence_late_threshold_minutes
       FROM attendance_rules WHERE org_id = 'default' AND is_default = true LIMIT 1`,
    [],
  )
  if (globalDefault.rows[0]) {
    const row = globalDefault.rows[0]
    return {
      refKind: 'global_default_rule',
      lateGraceMinutes: Number(row.late_grace_minutes) || 0,
      earlyGraceMinutes: Number(row.early_grace_minutes) || 0,
      severeLateThresholdMinutes:
        row.severe_late_threshold_minutes == null ? null : Number(row.severe_late_threshold_minutes),
      absenceLateThresholdMinutes:
        row.absence_late_threshold_minutes == null ? null : Number(row.absence_late_threshold_minutes),
    }
  }
  return null
}

function currentRuleBasisEnv(rule: CurrentRuleGraceParams | null): AttendanceDecisionTraceBasisEnv {
  if (!rule) {
    return { source: { kind: 'rule_live', ref: 'none' }, version: { posture: 'undeterminable' } }
  }
  return { source: { kind: 'rule_live', ref: rule.refKind }, version: { posture: 'current_live_no_history' } }
}

async function readAttendanceRecordRow(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceRecordRow | null> {
  const result = await runQuery<AttendanceRecordRow>(
    `SELECT id, status, is_workday, work_minutes, late_minutes, early_leave_minutes, meta, source_batch_id,
            created_at, updated_at
       FROM attendance_records
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
      LIMIT 1`,
    [orgId, userId, workDate],
  )
  return result.rows[0] ?? null
}

/** §3.3①E3 correction environment — `attendance_record_result_edits` (AE-1, no FK on `record_id`,
 *  keyed to the record's SUBJECT column `user_id` here — §4.1 distinguishes it from `actor_user_id`,
 *  the operator column). Returns the MOST RECENT correction row, if any. */
async function readMostRecentResultEdit(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<{ created_at: string; actor_user_id: string } | null> {
  const result = await runQuery<{ created_at: string; actor_user_id: string }>(
    `SELECT created_at, actor_user_id
       FROM attendance_record_result_edits
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, userId, workDate],
  )
  return result.rows[0] ?? null
}

// -------------------------------------------------------------------------------------------------
// ① today_status
// -------------------------------------------------------------------------------------------------
export interface AttendanceTodayStatusTraceResponse {
  category: 'today_status'
  reasonCode?: AttendanceRecordStatus
  conclusion: {
    workDate: string
    status: AttendanceRecordStatus | null
    isWorkday: boolean | null
    workMinutes: number | null
    lateMinutes: number | null
    earlyLeaveMinutes: number | null
  }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

export async function buildTodayStatusTrace(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceTodayStatusTraceResponse> {
  const record = await readAttendanceRecordRow(orgId, userId, workDate, runQuery)
  // §3.3① fail-closed: "record 行不存在 ⇒ 整类 undeterminable" — every environment undeterminable,
  // and `reasonCode` (whose only closed set is the `status` column) has no value to report — the
  // key is OMITTED (not fabricated as null/placeholder), mirroring the ⑤ unknown-branch discipline
  // (§3.3⑤ "键整体缺席，非 null").
  if (!record) {
    const basis: AttendanceDecisionTraceBasisEnv[] = [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } },
    ]
    return {
      category: 'today_status',
      conclusion: {
        workDate,
        status: null,
        isWorkday: null,
        workMinutes: null,
        lateMinutes: null,
        earlyLeaveMinutes: null,
      },
      basis,
      confidence: 'undeterminable',
    }
  }

  const status = record.status as AttendanceRecordStatus
  const rule = await resolveCurrentRuleGraceParams(orgId, userId, runQuery)
  const correction = await readMostRecentResultEdit(orgId, userId, workDate, runQuery)

  const basis: AttendanceDecisionTraceBasisEnv[] = [
    {
      source: { kind: 'record', ref: 'attendance_records' },
      version: { posture: 'snapshot_frozen', asOf: record.updated_at },
      auditRef: {
        kind: 'record_write',
        at: record.updated_at,
      },
    },
    // §3.3① E2: this environment ALSO carries the "为什么应出勤" decision chain (owner freeze ③) —
    // its RESULT is the E1 record's `is_workday` column (already surfaced above); the environment
    // here is only the current rule-resolution identity, always `current_live_no_history`.
    currentRuleBasisEnv(rule),
  ]
  if (correction) {
    basis.push({
      source: { kind: 'audit', ref: 'attendance_record_result_edits' },
      version: { posture: 'snapshot_frozen', asOf: correction.created_at },
      auditRef: {
        kind: 'result_edit',
        at: correction.created_at,
        actor: (await resolveAttendanceDecisionTraceActor(correction.actor_user_id, runQuery)) ?? undefined,
      },
    })
  }
  if (status === 'absent') {
    // §1-3 / §3.3① E4: materialized absence rows carry zero generation-source marker — always
    // undeterminable, never a fabricated "who ran the job" claim.
    basis.push({ source: { kind: 'policy_gate', ref: 'auto_absence_generation' }, version: { posture: 'undeterminable' } })
  }

  return {
    category: 'today_status',
    reasonCode: status,
    conclusion: {
      workDate,
      status,
      isWorkday: record.is_workday,
      workMinutes: record.work_minutes,
      lateMinutes: record.late_minutes,
      earlyLeaveMinutes: record.early_leave_minutes,
    },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// ② late_early
// -------------------------------------------------------------------------------------------------
export interface AttendanceLateEarlyTraceResponse {
  category: 'late_early'
  reasonCode?: AttendanceRecordStatus
  conclusion: {
    lateMinutes: number | null
    earlyLeaveMinutes: number | null
    severeLateCount: number | null
    severeLateMinutes: number | null
    absenceLateCount: number | null
    status: AttendanceRecordStatus | null
  }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

export async function buildLateEarlyTrace(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceLateEarlyTraceResponse> {
  const record = await readAttendanceRecordRow(orgId, userId, workDate, runQuery)
  if (!record) {
    const basis: AttendanceDecisionTraceBasisEnv[] = [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } },
    ]
    return {
      category: 'late_early',
      conclusion: {
        lateMinutes: null,
        earlyLeaveMinutes: null,
        severeLateCount: null,
        severeLateMinutes: null,
        absenceLateCount: null,
        status: null,
      },
      basis,
      confidence: 'undeterminable',
    }
  }

  const status = record.status as AttendanceRecordStatus
  const meta = (record.meta ?? {}) as Record<string, unknown>
  // §1-2 / §3.2 last row: tier counts are a HALF-snapshot — the RESULT is frozen in `meta` at
  // upsert time, but the threshold VALUE itself is not. Legacy rows predating #3055 never carry
  // these keys (`index.cjs:18824-18825` comment, verbatim) — that leg is `undeterminable`, never a
  // fabricated "no severe lateness" 0.
  const hasTierKeys =
    Object.prototype.hasOwnProperty.call(meta, 'severe_late_count') &&
    Object.prototype.hasOwnProperty.call(meta, 'severe_late_minutes') &&
    Object.prototype.hasOwnProperty.call(meta, 'absence_late_count')
  const rule = await resolveCurrentRuleGraceParams(orgId, userId, runQuery)
  const correction = await readMostRecentResultEdit(orgId, userId, workDate, runQuery)
  const remediation = await runQuery<{ id: string; metadata: Record<string, unknown> | null; created_at: string }>(
    `SELECT id, metadata, created_at
       FROM attendance_requests
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
        AND request_type IN ('missed_check_in', 'missed_check_out', 'time_correction')
        AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, userId, workDate],
  )

  const basis: AttendanceDecisionTraceBasisEnv[] = [
    {
      source: { kind: 'record', ref: 'attendance_records' },
      version: { posture: 'snapshot_frozen', asOf: record.updated_at },
    },
    {
      source: { kind: 'record', ref: 'attendance_records.meta.tier' },
      version: hasTierKeys ? { posture: 'snapshot_frozen', asOf: record.updated_at } : { posture: 'undeterminable' },
    },
    currentRuleBasisEnv(rule),
  ]
  if (correction) {
    basis.push({
      source: { kind: 'audit', ref: 'attendance_record_result_edits' },
      version: { posture: 'snapshot_frozen', asOf: correction.created_at },
      auditRef: {
        kind: 'result_edit',
        at: correction.created_at,
        actor: (await resolveAttendanceDecisionTraceActor(correction.actor_user_id, runQuery)) ?? undefined,
      },
    })
  }
  const remediationRow = remediation.rows[0]
  const makeupSnapshot = remediationRow?.metadata
    ? (remediationRow.metadata as Record<string, unknown>).makeupPunchPolicySnapshot
    : null
  if (remediationRow && makeupSnapshot && typeof makeupSnapshot === 'object') {
    const snap = makeupSnapshot as Record<string, unknown>
    const requestEvaluatedAt = typeof snap.requestEvaluatedAt === 'string' ? snap.requestEvaluatedAt : remediationRow.created_at
    basis.push({
      source: { kind: 'snapshot', ref: 'attendance_requests.metadata.makeupPunchPolicySnapshot' },
      version: {
        posture: 'snapshot_frozen',
        asOf: requestEvaluatedAt,
        snapshotVersion: typeof snap.version === 'number' ? String(snap.version) : undefined,
      },
    })
  }

  return {
    category: 'late_early',
    reasonCode: status,
    conclusion: {
      lateMinutes: record.late_minutes,
      earlyLeaveMinutes: record.early_leave_minutes,
      severeLateCount: hasTierKeys ? Number(meta.severe_late_count) || 0 : null,
      severeLateMinutes: hasTierKeys ? Number(meta.severe_late_minutes) || 0 : null,
      absenceLateCount: hasTierKeys ? Number(meta.absence_late_count) || 0 : null,
      status,
    },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// ③ missing_punch
// -------------------------------------------------------------------------------------------------
export type AttendanceMissingSide = 'check_in' | 'check_out' | 'both'
export type AttendanceSuggestedRequestType = 'leave' | 'missed_check_in' | 'missed_check_out' | 'time_correction'

/** Mirrors `classifyOwedPunchRecord` (`index.cjs:25932-25956`) EXACTLY — same decision table, same
 *  closed set of reason strings. Not imported (core-backend has no sanctioned static import of the
 *  plugin CJS runtime), reproduced here as the authoritative TS copy for the trace read path; drift
 *  risk is closed by the contract test parsing the plugin source text (mirrors the W4-0 punch-policy
 *  closed-set reconciliation precedent). NEVER invents a new reason string beyond this table (§3.1
 *  hard rule 4). */
export function classifyAttendanceOwedPunch(row: {
  status: string | null
  is_workday: boolean | null
  first_in_at: unknown
  last_out_at: unknown
}): { owedPunch: boolean; missingSide: AttendanceMissingSide | null; owedPunchReason: string } {
  const status = String(row?.status ?? '')
  if (row?.is_workday === false) {
    return { owedPunch: false, missingSide: null, owedPunchReason: 'non_workday' }
  }
  if (status === 'absent') {
    return { owedPunch: true, missingSide: 'both', owedPunchReason: 'absent_workday' }
  }
  if (status !== 'partial') {
    return { owedPunch: false, missingSide: null, owedPunchReason: status ? `status_${status}` : 'status_unknown' }
  }
  const missingIn = !row.first_in_at
  const missingOut = !row.last_out_at
  if (missingIn && missingOut) {
    return { owedPunch: true, missingSide: 'both', owedPunchReason: 'partial_missing_both' }
  }
  if (missingIn) {
    return { owedPunch: true, missingSide: 'check_in', owedPunchReason: 'partial_missing_check_in' }
  }
  if (missingOut) {
    return { owedPunch: true, missingSide: 'check_out', owedPunchReason: 'partial_missing_check_out' }
  }
  return { owedPunch: false, missingSide: null, owedPunchReason: 'partial_complete' }
}

/** Mirrors `suggestRequestType` (`index.cjs:26427-26436`) exactly. */
export function suggestAttendanceRequestType(row: {
  status: string | null
  first_in_at: unknown
  last_out_at: unknown
}): AttendanceSuggestedRequestType | null {
  const status = row?.status ? String(row.status) : ''
  if (status === 'absent') return 'leave'
  if (status === 'partial') {
    if (!row.first_in_at) return 'missed_check_in'
    if (!row.last_out_at) return 'missed_check_out'
    return 'time_correction'
  }
  if (status === 'late' || status === 'early_leave' || status === 'late_early') return 'time_correction'
  return null
}

export interface AttendanceMissingPunchTraceResponse {
  category: 'missing_punch'
  reasonCode?: string
  conclusion: {
    missingSide: AttendanceMissingSide | null
    isWorkday: boolean | null
    suggestedRequestType: AttendanceSuggestedRequestType | null
  }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

export async function buildMissingPunchTrace(
  orgId: string,
  userId: string,
  workDate: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceMissingPunchTraceResponse> {
  const recordResult = await runQuery<
    AttendanceRecordRow & { first_in_at: string | null; last_out_at: string | null }
  >(
    `SELECT id, status, is_workday, work_minutes, late_minutes, early_leave_minutes, meta, source_batch_id,
            created_at, updated_at, first_in_at, last_out_at
       FROM attendance_records
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
      LIMIT 1`,
    [orgId, userId, workDate],
  )
  const record = recordResult.rows[0] ?? null
  const rule = await resolveCurrentRuleGraceParams(orgId, userId, runQuery)
  // §3.3③ fail-closed: no record AND the current rule cannot resolve ⇒整类 undeterminable.
  if (!record) {
    const basis: AttendanceDecisionTraceBasisEnv[] = [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } },
    ]
    if (rule) basis.push(currentRuleBasisEnv(rule))
    return {
      category: 'missing_punch',
      conclusion: { missingSide: null, isWorkday: null, suggestedRequestType: null },
      basis,
      confidence: 'undeterminable',
    }
  }

  const classification = classifyAttendanceOwedPunch(record)
  const suggested = suggestAttendanceRequestType(record)
  const remediation = await runQuery<{ id: string; created_at: string; metadata: Record<string, unknown> | null }>(
    `SELECT id, created_at, metadata
       FROM attendance_requests
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
        AND request_type IN ('missed_check_in', 'missed_check_out', 'time_correction')
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, userId, workDate],
  )

  const basis: AttendanceDecisionTraceBasisEnv[] = [
    { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: record.updated_at } },
    currentRuleBasisEnv(rule),
  ]
  if (record.status === 'absent') {
    basis.push({ source: { kind: 'policy_gate', ref: 'auto_absence_generation' }, version: { posture: 'undeterminable' } })
  }
  const remediationRow = remediation.rows[0]
  if (remediationRow) {
    const snap = (remediationRow.metadata ?? {}) as Record<string, unknown>
    const makeupSnapshot = snap.makeupPunchPolicySnapshot
    if (makeupSnapshot && typeof makeupSnapshot === 'object') {
      const s = makeupSnapshot as Record<string, unknown>
      basis.push({
        source: { kind: 'snapshot', ref: 'attendance_requests.metadata.makeupPunchPolicySnapshot' },
        version: {
          posture: 'snapshot_frozen',
          asOf: typeof s.requestEvaluatedAt === 'string' ? s.requestEvaluatedAt : remediationRow.created_at,
          snapshotVersion: typeof s.version === 'number' ? String(s.version) : undefined,
        },
      })
    } else {
      basis.push({
        source: { kind: 'audit', ref: 'attendance_requests' },
        version: { posture: 'snapshot_frozen', asOf: remediationRow.created_at },
      })
    }
  }

  return {
    category: 'missing_punch',
    reasonCode: classification.owedPunchReason,
    conclusion: {
      missingSide: classification.missingSide,
      isWorkday: record.is_workday,
      suggestedRequestType: suggested,
    },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// ④ overtime_segmentation (keyed by a single overtime `attendance_requests` row — the segmentation
// snapshot and rule/flow/approval environments are all per-instance facts, §3.2's `resolvedAt`
// anchor is a single request's terminal-review timestamp, not an aggregate).
// -------------------------------------------------------------------------------------------------
const OVERTIME_SEGMENTATION_ENGINE = 'attendance_overtime_segmentation_v1'
const OVERTIME_SEGMENTATION_VERSION = 1

export type AttendanceOvertimeDayType = 'workday' | 'restday' | 'holiday'
export type AttendanceOvertimeCoverageNote = 'full' | 'partial_legacy'

export interface AttendanceOvertimeSegmentationTraceResponse {
  category: 'overtime_segmentation'
  coverageNote: AttendanceOvertimeCoverageNote
  conclusion: {
    workdayMinutes: number
    restdayMinutes: number
    holidayMinutes: number
    totalMinutes: number
    segmentationVersion: number | null
    segments: Array<{ dayType: AttendanceOvertimeDayType; minutes: number; reasonCode: string; holidayName: string | null }>
  }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

/** 404-shape sentinel — reference-style targets (④ requestId, ⑥ instanceId) return this exact
 *  literal so a real-not-found and an other-user's-row-under-subject-constraint 404 are
 *  byte-identical (§4.1 存在性 oracle defense). */
export const ATTENDANCE_DECISION_TRACE_NOT_FOUND = Symbol('attendance-decision-trace-not-found')

export async function buildOvertimeSegmentationTrace(
  orgId: string,
  userId: string,
  requestId: string,
  runQuery: AttendanceDecisionTraceQueryFn,
  overtimeSegmentationEnabled: boolean,
): Promise<AttendanceOvertimeSegmentationTraceResponse | typeof ATTENDANCE_DECISION_TRACE_NOT_FOUND> {
  const result = await runQuery<{
    id: string
    metadata: Record<string, unknown> | null
    resolved_at: string | null
    updated_at: string
  }>(
    `SELECT id, metadata, resolved_at, updated_at
       FROM attendance_requests
      WHERE org_id = $1 AND user_id = $2 AND id = $3
        AND request_type = 'overtime'
      LIMIT 1`,
    [orgId, userId, requestId],
  )
  const row = result.rows[0]
  if (!row) return ATTENDANCE_DECISION_TRACE_NOT_FOUND

  const metadata = (row.metadata ?? {}) as Record<string, unknown>
  const snapshot = metadata.overtimeSegmentation as Record<string, unknown> | undefined
  const snapshotValid =
    snapshot &&
    typeof snapshot === 'object' &&
    snapshot.version === OVERTIME_SEGMENTATION_VERSION &&
    snapshot.engine === OVERTIME_SEGMENTATION_ENGINE
  const resolvedAt = row.resolved_at ?? row.updated_at

  const basis: AttendanceDecisionTraceBasisEnv[] = []
  const segments: AttendanceOvertimeSegmentationTraceResponse['conclusion']['segments'] = []
  let workdayMinutes = 0
  let restdayMinutes = 0
  let holidayMinutes = 0
  let totalMinutes = 0

  if (snapshotValid) {
    const segs = (snapshot!.segments ?? {}) as Record<string, unknown>
    workdayMinutes = Number(segs.workdayMinutes) || 0
    restdayMinutes = Number(segs.restdayMinutes) || 0
    holidayMinutes = Number(segs.holidayMinutes) || 0
    totalMinutes = Number(snapshot!.totalMinutes) || 0
    const calendar = (snapshot!.calendar ?? {}) as Record<string, unknown>
    const dayType = (snapshot!.dayType as AttendanceOvertimeDayType) ?? 'restday'
    const minutesForType = dayType === 'workday' ? workdayMinutes : dayType === 'holiday' ? holidayMinutes : restdayMinutes
    segments.push({
      dayType,
      minutes: minutesForType,
      reasonCode: typeof calendar.effectiveSource === 'string' ? calendar.effectiveSource : 'unknown',
      holidayName: typeof calendar.holidayName === 'string' ? calendar.holidayName : null,
    })
    basis.push({
      source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' },
      version: { posture: 'snapshot_frozen', asOf: resolvedAt, snapshotVersion: String(OVERTIME_SEGMENTATION_VERSION) },
    })
  } else {
    basis.push({ source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' }, version: { posture: 'undeterminable' } })
    totalMinutes = Number(metadata.minutes) || 0
  }

  const overtimeRule = metadata.overtimeRule
  if (overtimeRule && typeof overtimeRule === 'object') {
    basis.push({
      source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeRule' },
      version: { posture: 'snapshot_frozen', asOf: resolvedAt },
    })
  }
  const liveRule = await runQuery<{ id: string }>(
    `SELECT id FROM attendance_overtime_rules WHERE org_id = $1 AND is_active = true LIMIT 1`,
    [orgId],
  )
  basis.push({
    source: { kind: 'rule_live', ref: 'attendance_overtime_rules' },
    version: { posture: liveRule.rows[0] ? 'current_live_no_history' : 'undeterminable' },
  })

  const approvalFlow = metadata.approvalFlow
  basis.push({
    source: { kind: 'audit', ref: 'attendance_requests.metadata.approvalFlow' },
    version: approvalFlow ? { posture: 'snapshot_frozen', asOf: resolvedAt } : { posture: 'undeterminable' },
  })
  // §3.3④E4 engine-gate: a snapshot present on THIS request always wins (§3.1 hard rule 6, "快照排
  // 他") — the engine gate is only informative for requests that never got a snapshot (legacy /
  // engine-off-at-submit-time), where it explains WHY `coverageNote='partial_legacy'`.
  if (!snapshotValid) {
    basis.push({
      source: { kind: 'policy_gate', ref: 'overtimeSegmentation' },
      version: { posture: overtimeSegmentationEnabled ? 'undeterminable' : 'not_in_effect' },
    })
  }

  return {
    category: 'overtime_segmentation',
    coverageNote: snapshotValid ? 'full' : 'partial_legacy',
    conclusion: {
      workdayMinutes,
      restdayMinutes,
      holidayMinutes,
      totalMinutes,
      segmentationVersion: snapshotValid ? OVERTIME_SEGMENTATION_VERSION : null,
      segments,
    },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// ⑤ comp_time_balance — `sourceResolution` known/unknown discriminated union (§3.1 hard rule 5⑤).
// -------------------------------------------------------------------------------------------------

/** Frozen enum by literal write-site value (§3.1 hard rule 5⑤ / §11.1) —
 *  `'annual_accrual'` (`index.cjs:17922`), `'annual_manual_adjust'` (`:18162`),
 *  `'overtime_conversion'` (`:29788`/`:29863`). `attendance_leave_balances.source_type` is free TEXT
 *  (no CHECK, `zzzz20260603120000:34`) — NEVER pass a raw value through; anything outside this map
 *  is the `'unknown_source'` branch with the `reasonCode` key entirely absent. */
const ATTENDANCE_COMP_TIME_LOT_SOURCE_TYPE_TO_REASON_CODE: Record<string, string> = {
  annual_accrual: 'annual_accrual',
  annual_manual_adjust: 'annual_manual_adjust',
  overtime_conversion: 'overtime_conversion',
}

export type AttendanceCompTimeLot =
  | { sourceResolution: 'mapped'; reasonCode: string; grantedAt: string; expiresAt: string | null; overtimeSource?: string }
  | { sourceResolution: 'unknown_source'; grantedAt: string; expiresAt: string | null; overtimeSource?: string }

export interface AttendanceCompTimeBalanceTraceResponse {
  category: 'comp_time_balance'
  conclusion: {
    summary: { grantedMinutes: number; remainingMinutes: number; exhaustedMinutes: number; expiredMinutes: number }
    lots: AttendanceCompTimeLot[]
    events: Array<{ eventType: string; deltaMinutes: number; occurredAt: string }>
  }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

const COMP_TIME_LEAVE_TYPE_CODE = 'comp_time'

export async function buildCompTimeBalanceTrace(
  orgId: string,
  userId: string,
  runQuery: AttendanceDecisionTraceQueryFn,
  settingsEnabled: { compTimeFromOvertime: boolean; overtimeBankPolicy: boolean },
): Promise<AttendanceCompTimeBalanceTraceResponse> {
  const summaryResult = await runQuery<{ granted: string; exhausted: string; expired: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN e.event_type = 'grant' THEN e.delta_minutes ELSE 0 END), 0) AS granted,
       COALESCE(SUM(CASE WHEN e.event_type = 'deduct' THEN -e.delta_minutes ELSE 0 END), 0) AS exhausted,
       COALESCE(SUM(CASE WHEN e.event_type = 'expire' THEN -e.delta_minutes ELSE 0 END), 0) AS expired
     FROM attendance_leave_balance_events e
     JOIN attendance_leave_balances b ON b.id = e.balance_id AND b.org_id = e.org_id AND b.user_id = e.user_id
     WHERE e.org_id = $1 AND e.user_id = $2 AND b.leave_type_code = $3`,
    [orgId, userId, COMP_TIME_LEAVE_TYPE_CODE],
  )
  const remainingResult = await runQuery<{ remaining: string }>(
    `SELECT COALESCE(SUM(remaining_minutes), 0) AS remaining
       FROM attendance_leave_balances
      WHERE org_id = $1 AND user_id = $2 AND leave_type_code = $3 AND status = 'active'`,
    [orgId, userId, COMP_TIME_LEAVE_TYPE_CODE],
  )
  const lotsResult = await runQuery<{
    id: string
    source_type: string
    granted_at: string
    expires_at: string | null
    overtime_source: string | null
  }>(
    `SELECT id, source_type, granted_at, expires_at, overtime_source
       FROM attendance_leave_balances
      WHERE org_id = $1 AND user_id = $2 AND leave_type_code = $3 AND status = 'active'
      ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC`,
    [orgId, userId, COMP_TIME_LEAVE_TYPE_CODE],
  )
  const eventsResult = await runQuery<{ event_type: string; delta_minutes: number; occurred_at: string }>(
    `SELECT e.event_type, e.delta_minutes, e.occurred_at
       FROM attendance_leave_balance_events e
       JOIN attendance_leave_balances b ON b.id = e.balance_id AND b.org_id = e.org_id AND b.user_id = e.user_id
      WHERE e.org_id = $1 AND e.user_id = $2 AND b.leave_type_code = $3
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 50`,
    [orgId, userId, COMP_TIME_LEAVE_TYPE_CODE],
  )

  const lots: AttendanceCompTimeLot[] = lotsResult.rows.map((row) => {
    const overtimeSource = row.overtime_source ?? undefined
    const mapped = ATTENDANCE_COMP_TIME_LOT_SOURCE_TYPE_TO_REASON_CODE[row.source_type]
    if (mapped) {
      return {
        sourceResolution: 'mapped',
        reasonCode: mapped,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
        ...(overtimeSource ? { overtimeSource } : {}),
      }
    }
    return {
      sourceResolution: 'unknown_source',
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      ...(overtimeSource ? { overtimeSource } : {}),
    }
  })

  const basis: AttendanceDecisionTraceBasisEnv[] = [
    {
      source: { kind: 'ledger', ref: 'attendance_leave_balances' },
      version: lots.length > 0 ? { posture: 'snapshot_frozen', asOf: lots[0].grantedAt } : { posture: 'undeterminable' },
    },
    {
      source: { kind: 'ledger', ref: 'attendance_leave_balance_events' },
      version:
        eventsResult.rows.length > 0
          ? { posture: 'snapshot_frozen', asOf: eventsResult.rows[0].occurred_at }
          : { posture: 'undeterminable' },
    },
    {
      source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' },
      version: { posture: settingsEnabled.compTimeFromOvertime ? 'current_live_no_history' : 'not_in_effect' },
    },
  ]

  return {
    category: 'comp_time_balance',
    conclusion: {
      summary: {
        grantedMinutes: Number(summaryResult.rows[0]?.granted ?? 0),
        remainingMinutes: Number(remainingResult.rows[0]?.remaining ?? 0),
        exhaustedMinutes: Number(summaryResult.rows[0]?.exhausted ?? 0),
        expiredMinutes: Number(summaryResult.rows[0]?.expired ?? 0),
      },
      lots,
      events: eventsResult.rows.map((row) => ({
        eventType: row.event_type,
        deltaMinutes: row.delta_minutes,
        occurredAt: row.occurred_at,
      })),
    },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// "Seventh read face" (OD-W5-6=(a)) — `attendance_payroll_cycle_settlements` has NO existing read
// API (only INSERT + LIMIT-1 existence probes, per the design lock's §1-4 grounding). This is a
// standalone read used both directly (admin/self list) and as ⑤'s E4 settlement environment.
// -------------------------------------------------------------------------------------------------
export interface AttendancePayrollCycleSettlementRow {
  cycleId: string
  periodStartDate: string
  periodEndDate: string
  closedAt: string
  source: string
  convertibleMinutes: number
  mustPayMinutes: number
}

export async function readAttendancePayrollCycleSettlements(
  orgId: string,
  userId: string,
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendancePayrollCycleSettlementRow[]> {
  const result = await runQuery<{
    cycle_id: string
    period_start_date: string
    period_end_date: string
    closed_at: string
    source: string
    convertible_minutes: number
    must_pay_minutes: number
  }>(
    `SELECT cycle_id, period_start_date, period_end_date, closed_at, source, convertible_minutes, must_pay_minutes
       FROM attendance_payroll_cycle_settlements
      WHERE org_id = $1 AND user_id = $2
      ORDER BY closed_at DESC, cycle_id ASC`,
    [orgId, userId],
  )
  return result.rows.map((row) => ({
    cycleId: row.cycle_id,
    periodStartDate: row.period_start_date,
    periodEndDate: row.period_end_date,
    closedAt: row.closed_at,
    source: row.source,
    convertibleMinutes: row.convertible_minutes,
    mustPayMinutes: row.must_pay_minutes,
  }))
}

/** Fold the settlement read face into ⑤'s E4 basis environment (§3.3⑤E4) — has its OWN
 *  `not_in_effect` vs `undeterminable` split, gated by `overtimeBankPolicy.enabled`. */
export function attendancePayrollCycleSettlementBasisEnv(
  settlements: AttendancePayrollCycleSettlementRow[],
  overtimeBankPolicyEnabled: boolean,
): AttendanceDecisionTraceBasisEnv {
  if (settlements.length > 0) {
    return {
      source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' },
      version: { posture: 'snapshot_frozen', asOf: settlements[0].closedAt },
    }
  }
  return {
    source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' },
    version: { posture: overtimeBankPolicyEnabled ? 'undeterminable' : 'not_in_effect' },
  }
}

// -------------------------------------------------------------------------------------------------
// ⑥ approver_source
// -------------------------------------------------------------------------------------------------
export const ATTENDANCE_APPROVER_SOURCE_KINDS = [
  'direct_manager',
  'dept_head',
  'manager_at_level',
  'static',
  'legacy_fallback',
  'unknown',
] as const
export type AttendanceApproverSourceKind = (typeof ATTENDANCE_APPROVER_SOURCE_KINDS)[number]

export interface AttendanceApproverSourceStep {
  stepIndex: number
  assigneeResolved: boolean
  sourceKind: AttendanceApproverSourceKind
  reasonCode: AttendanceApproverSourceKind
  level?: number
  actor?: AttendanceDecisionTraceActor
}

export interface AttendanceApproverSourceTraceResponse {
  category: 'approver_source'
  conclusion: { steps: AttendanceApproverSourceStep[] }
  basis: AttendanceDecisionTraceBasisEnv[]
  confidence: AttendanceDecisionTraceConfidence
}

function classifyApproverAssignmentMetadata(metadata: Record<string, unknown>): {
  sourceKind: AttendanceApproverSourceKind
  level?: number
} {
  const resolvedFrom = metadata.resolvedFrom
  if (resolvedFrom && typeof resolvedFrom === 'object') {
    const kind = (resolvedFrom as Record<string, unknown>).kind
    if (kind === 'direct_manager' || kind === 'dept_head' || kind === 'manager_at_level') {
      const level = (resolvedFrom as Record<string, unknown>).level
      return { sourceKind: kind, ...(typeof level === 'number' ? { level } : {}) }
    }
  }
  if (typeof metadata.queue === 'string') return { sourceKind: 'legacy_fallback' }
  if (typeof metadata.stepName !== 'undefined') return { sourceKind: 'static' }
  return { sourceKind: 'unknown' }
}

export async function buildApproverSourceTrace(
  orgId: string,
  userId: string,
  instanceId: string,
  runQuery: AttendanceDecisionTraceQueryFn,
  dynamicAssigneeSourcesEnabled: boolean,
): Promise<AttendanceApproverSourceTraceResponse | typeof ATTENDANCE_DECISION_TRACE_NOT_FOUND> {
  // §4.1 reverse-link ownership: attendance_requests.user_id = subject AND approval_instance_id =
  // target — NEVER a requester_snapshot JSONB comparison (the snapshot is a display artifact, not
  // an authorization source of truth).
  const requestLink = await runQuery<{ id: string }>(
    `SELECT id FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND approval_instance_id = $3 LIMIT 1`,
    [orgId, userId, instanceId],
  )
  if (!requestLink.rows[0]) return ATTENDANCE_DECISION_TRACE_NOT_FOUND

  const instanceResult = await runQuery<{
    id: string
    created_at: string
    requester_snapshot: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
  }>(
    `SELECT id, created_at, requester_snapshot, metadata FROM approval_instances WHERE id = $1 LIMIT 1`,
    [instanceId],
  )
  const instance = instanceResult.rows[0]
  if (!instance) return ATTENDANCE_DECISION_TRACE_NOT_FOUND

  const assignmentsResult = await runQuery<{
    assignment_type: string
    assignee_id: string
    source_step: number
    metadata: Record<string, unknown> | null
    updated_at: string
  }>(
    `SELECT assignment_type, assignee_id, source_step, metadata, updated_at
       FROM approval_assignments
      WHERE instance_id = $1
      ORDER BY source_step ASC, created_at ASC`,
    [instanceId],
  )

  const bySourceStep = new Map<number, (typeof assignmentsResult.rows)[number][]>()
  for (const row of assignmentsResult.rows) {
    const list = bySourceStep.get(row.source_step) ?? []
    list.push(row)
    bySourceStep.set(row.source_step, list)
  }

  const steps: AttendanceApproverSourceStep[] = []
  for (const [stepIndex, rows] of Array.from(bySourceStep.entries()).sort((a, b) => a[0] - b[0])) {
    const first = rows[0]
    const meta = (first.metadata ?? {}) as Record<string, unknown>
    const { sourceKind, level } = classifyApproverAssignmentMetadata(meta)
    let actor: AttendanceDecisionTraceActor | undefined
    if (first.assignment_type === 'user') {
      actor = (await resolveAttendanceDecisionTraceActor(first.assignee_id, runQuery)) ?? undefined
    }
    steps.push({
      stepIndex,
      assigneeResolved: true,
      sourceKind,
      reasonCode: sourceKind,
      ...(typeof level === 'number' ? { level } : {}),
      ...(actor ? { actor } : {}),
    })
  }

  const basis: AttendanceDecisionTraceBasisEnv[] = [
    {
      source: { kind: 'record', ref: 'approval_assignments' },
      version: steps.length > 0 ? { posture: 'snapshot_frozen', asOf: assignmentsResult.rows[0].updated_at } : { posture: 'undeterminable' },
    },
  ]
  const recordsResult = await runQuery<{ occurred_at: string }>(
    `SELECT occurred_at FROM approval_records WHERE instance_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [instanceId],
  )
  basis.push({
    source: { kind: 'audit', ref: 'approval_records' },
    version: recordsResult.rows[0]
      ? { posture: 'snapshot_frozen', asOf: recordsResult.rows[0].occurred_at }
      : { posture: 'undeterminable' },
  })
  basis.push({
    source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' },
    version: { posture: 'snapshot_frozen', asOf: instance.created_at },
  })
  const approvalFlow = (instance.metadata ?? {}) as Record<string, unknown>
  basis.push({
    source: { kind: 'snapshot', ref: 'approval_instances.metadata.approvalFlow' },
    version: approvalFlow.approvalFlow ? { posture: 'snapshot_frozen', asOf: instance.created_at } : { posture: 'undeterminable' },
  })
  // §3.3⑥E5 door: whether the DYNAMIC-kind resolver is enabled TODAY — informational only (the
  // steps above already reflect the frozen historical resolution, §0.1⑥/OD-W5-2=(a): this module
  // never re-explains WHY a resolution failed or would fail now, only discloses today's gate state
  // honestly alongside the frozen facts).
  const hasDynamicStep = steps.some((s) => s.sourceKind === 'direct_manager' || s.sourceKind === 'dept_head' || s.sourceKind === 'manager_at_level')
  if (hasDynamicStep) {
    basis.push({
      source: { kind: 'policy_gate', ref: 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED' },
      version: { posture: dynamicAssigneeSourcesEnabled ? 'current_live_no_history' : 'not_in_effect' },
    })
  }

  return {
    category: 'approver_source',
    conclusion: { steps },
    basis,
    confidence: deriveAttendanceDecisionTraceConfidence(basis),
  }
}

// -------------------------------------------------------------------------------------------------
// §5.2②/§9 W5-0-G5: engine-enablement gates read off the ONE deployment-wide `system_configs` row
// (`attendance.settings`, single key — `index.cjs` `SETTINGS_KEY` `:291`, no org_id column). Only
// the two booleans this module needs — never the whole settings blob (same discipline as W4-0's
// punch-policy closed-set reader). Absent row / absent sub-key ⇒ the documented DEFAULT_SETTINGS
// default (`false` for both — `index.cjs:377-380` compTimeFromOvertime, `:412-417`
// overtimeBankPolicy), never a fabricated `true`.
// -------------------------------------------------------------------------------------------------
const ATTENDANCE_SETTINGS_KEY = 'attendance.settings'

export interface AttendanceDecisionTraceSettingsGates {
  compTimeFromOvertime: boolean
  overtimeBankPolicy: boolean
  overtimeSegmentation: boolean
  autoAbsence: boolean
  dynamicAssigneeSourcesEnabled: boolean
}

export async function readAttendanceDecisionTraceSettingsGates(
  runQuery: AttendanceDecisionTraceQueryFn,
): Promise<AttendanceDecisionTraceSettingsGates> {
  const result = await runQuery<{ value: unknown }>('SELECT value FROM system_configs WHERE key = $1', [
    ATTENDANCE_SETTINGS_KEY,
  ])
  const raw = result.rows[0]?.value
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const boolAt = (key: string, subkey: string): boolean => {
    const section = value[key]
    if (!section || typeof section !== 'object') return false
    return (section as Record<string, unknown>)[subkey] === true
  }
  return {
    compTimeFromOvertime: boolAt('compTimeFromOvertime', 'enabled'),
    overtimeBankPolicy: boolAt('overtimeBankPolicy', 'enabled'),
    overtimeSegmentation: boolAt('overtimeSegmentation', 'enabled'),
    autoAbsence: boolAt('autoAbsence', 'enabled'),
    dynamicAssigneeSourcesEnabled: process.env.ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED === 'true',
  }
}

// -------------------------------------------------------------------------------------------------
// Discriminated response union (contract-test-friendly).
// -------------------------------------------------------------------------------------------------
export type AttendanceDecisionTraceResponse =
  | AttendanceTodayStatusTraceResponse
  | AttendanceLateEarlyTraceResponse
  | AttendanceMissingPunchTraceResponse
  | AttendanceOvertimeSegmentationTraceResponse
  | AttendanceCompTimeBalanceTraceResponse
  | AttendanceApproverSourceTraceResponse
