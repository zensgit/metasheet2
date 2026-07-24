// W5-1 (Wave 5 explainability design-lock 2026-07-22, RATIFIED — see
// docs/development/attendance-vnext-wave5-explainability-data-contract-lock-20260722.md §3/§6/§9):
// pure decision-trace mapping module — the backend discriminated trace response (W5-0 #4557, both
// hosts return the SAME §3.1 shape) → a display model with the COMPLETE discriminator matrix
// (category × posture × confidence × union branches; charter L267-268 verbatim: "纯逻辑优先落到独立
// `.ts`：……decision-trace mapping。纯模块必须有完整判别矩阵，不允许再把分支埋回 Vue template").
//
// Red lines carried here (§0):
//   R2 — this module only TRANSLATES server-provided closed-set codes into whitelisted zh/en copy.
//        It never derives a reason from minutes/timestamps/amounts, never fabricates an explanation
//        for a missing chain link ("没有数据时显示「无法确定依据」，不生成貌似合理的解释" — charter
//        L368-369 verbatim), and its unknown-code/unknown-kind default branches are ALWAYS the
//        fail-closed「无法确定依据」copy — never `JSON.stringify` (the `assigneeSource.ts:29-30`
//        default branch is explicitly NOT reused, §6).
//   R3 — parse is strict whitelist projection (fail-closed to `null` on any unknown/mistyped shape,
//        `useAttendanceSetupReadiness.ts:93-100` precedent). This module never re-fetches or joins
//        other endpoints to "enrich" masked fields — actor display is EXACTLY the server-provided
//        `{displayLabel, identityPosture}` wire shape (§3.1 / owner二轮终审 P2-b), no raw-id
//        fallback ever (P2-3).
//   R4 — `current_live_no_history` renders「当前规则（无历史版本）」verbatim AND carries the
//        「可能不同于决策当时的规则」declaration (OD-W5-8=(a) owner verbatim; §3.2 last paragraph);
//        `not_in_effect` is a POLICY FACT (its copy never contains「无法确定」— §3.1 hard rule 2);
//        `undeterminable` renders「无法确定依据」verbatim (fail-closed door, W5-1 copy gate).
//
// Zero DOM, zero fetch (§6).

export type TranslateFn = (en: string, zh: string) => string

// -------------------------------------------------------------------------------------------------
// §3.1 closed sets — mirrors of the backend wire contract
// (`packages/core-backend/src/services/AttendanceDecisionTrace.ts`, W5-0 #4557). Enum-strict:
// structural discriminators (category / posture / confidence / source.kind / identityPosture /
// coverageNote / sourceResolution) outside these sets fail the WHOLE parse closed to `null`
// (§3.1 hard rule 3); per-item reason codes outside the label whitelists fail closed to the
// 「无法确定依据」display state instead (§9 W5-0-G4 "未知 code fail-closed 走「无法确定依据」态").
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
  return typeof value === 'string' && (ATTENDANCE_DECISION_TRACE_CATEGORIES as readonly string[]).includes(value)
}

export const ATTENDANCE_TRACE_VERSION_POSTURES = [
  'snapshot_frozen',
  'current_live_no_history',
  'not_in_effect',
  'undeterminable',
] as const
export type AttendanceTraceVersionPosture = (typeof ATTENDANCE_TRACE_VERSION_POSTURES)[number]

export const ATTENDANCE_TRACE_CONFIDENCES = ['grounded', 'partial', 'undeterminable'] as const
export type AttendanceTraceConfidence = (typeof ATTENDANCE_TRACE_CONFIDENCES)[number]

export const ATTENDANCE_TRACE_SOURCE_KINDS = [
  'record',
  'snapshot',
  'rule_live',
  'ledger',
  'audit',
  'policy_gate',
] as const
export type AttendanceTraceSourceKind = (typeof ATTENDANCE_TRACE_SOURCE_KINDS)[number]

/** §5.1 / owner二轮终审 P2-b — `'deleted'` deliberately absent (users has no delete tombstone). */
export const ATTENDANCE_TRACE_IDENTITY_POSTURES = ['resolved', 'inactive', 'unknown'] as const
export type AttendanceTraceIdentityPosture = (typeof ATTENDANCE_TRACE_IDENTITY_POSTURES)[number]

export const ATTENDANCE_TRACE_RECORD_STATUSES = [
  'normal',
  'late',
  'early_leave',
  'late_early',
  'partial',
  'absent',
  'adjusted',
  'off',
] as const

export const ATTENDANCE_TRACE_MISSING_SIDES = ['check_in', 'check_out', 'both'] as const
export const ATTENDANCE_TRACE_SUGGESTED_REQUEST_TYPES = [
  'leave',
  'missed_check_in',
  'missed_check_out',
  'time_correction',
] as const
export const ATTENDANCE_TRACE_OVERTIME_DAY_TYPES = ['workday', 'restday', 'holiday'] as const
export const ATTENDANCE_TRACE_COVERAGE_NOTES = ['full', 'partial_legacy'] as const
export type AttendanceTraceCoverageNote = (typeof ATTENDANCE_TRACE_COVERAGE_NOTES)[number]
/** §3.3⑤ / hard rule 5⑤ — lot item known/unknown discriminated union (owner三轮终审 P2-2). */
export const ATTENDANCE_TRACE_LOT_SOURCE_RESOLUTIONS = ['mapped', 'unknown_source'] as const
export const ATTENDANCE_TRACE_APPROVER_SOURCE_KINDS = [
  'direct_manager',
  'dept_head',
  'manager_at_level',
  'static',
  'legacy_fallback',
  'unknown',
] as const

// -------------------------------------------------------------------------------------------------
// Parsed wire shapes (post-whitelist).
// -------------------------------------------------------------------------------------------------
export interface AttendanceTraceActor {
  displayLabel: string
  identityPosture: AttendanceTraceIdentityPosture
}

export interface AttendanceTraceAuditRef {
  kind: string
  at: string
  actor?: AttendanceTraceActor
}

export interface AttendanceTraceVersion {
  posture: AttendanceTraceVersionPosture
  asOf?: string
  snapshotVersion?: string
}

export interface AttendanceTraceBasisEnv {
  source: { kind: AttendanceTraceSourceKind; ref: string }
  version: AttendanceTraceVersion
  auditRef?: AttendanceTraceAuditRef
}

export interface AttendanceTodayStatusTrace {
  category: 'today_status'
  reasonCode?: string
  conclusion: {
    workDate: string
    status: string | null
    isWorkday: boolean | null
    workMinutes: number | null
    lateMinutes: number | null
    earlyLeaveMinutes: number | null
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export interface AttendanceLateEarlyTrace {
  category: 'late_early'
  reasonCode?: string
  conclusion: {
    lateMinutes: number | null
    earlyLeaveMinutes: number | null
    severeLateCount: number | null
    severeLateMinutes: number | null
    absenceLateCount: number | null
    status: string | null
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export interface AttendanceMissingPunchTrace {
  category: 'missing_punch'
  reasonCode?: string
  conclusion: {
    missingSide: string | null
    isWorkday: boolean | null
    suggestedRequestType: string | null
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export interface AttendanceOvertimeSegmentationTrace {
  category: 'overtime_segmentation'
  coverageNote: AttendanceTraceCoverageNote
  conclusion: {
    workdayMinutes: number
    restdayMinutes: number
    holidayMinutes: number
    totalMinutes: number
    segmentationVersion: number | null
    segments: Array<{ dayType: string; minutes: number; reasonCode?: string; holidayName: string | null }>
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export type AttendanceCompTimeLot =
  | {
      sourceResolution: 'mapped'
      reasonCode: string
      grantedAt: string
      expiresAt: string | null
      overtimeSource?: string
    }
  | {
      sourceResolution: 'unknown_source'
      grantedAt: string
      expiresAt: string | null
      overtimeSource?: string
    }

export interface AttendanceCompTimeBalanceTrace {
  category: 'comp_time_balance'
  conclusion: {
    summary: { grantedMinutes: number; remainingMinutes: number; exhaustedMinutes: number; expiredMinutes: number }
    lots: AttendanceCompTimeLot[]
    events: Array<{ eventType: string; deltaMinutes: number; occurredAt: string }>
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export interface AttendanceApproverSourceTrace {
  category: 'approver_source'
  conclusion: {
    steps: Array<{
      stepIndex: number
      assigneeResolved: boolean
      sourceKind: string
      reasonCode: string
      level?: number
      actor?: AttendanceTraceActor
    }>
  }
  basis: AttendanceTraceBasisEnv[]
  confidence: AttendanceTraceConfidence
}

export type AttendanceDecisionTraceParsed =
  | AttendanceTodayStatusTrace
  | AttendanceLateEarlyTrace
  | AttendanceMissingPunchTrace
  | AttendanceOvertimeSegmentationTrace
  | AttendanceCompTimeBalanceTrace
  | AttendanceApproverSourceTrace

// -------------------------------------------------------------------------------------------------
// Strict whitelist parse (fail-closed null). Structural enum violations null the whole response
// (§3.1 hard rule 3); the ⑤ lot union enforces the EXACT key-set contract — an `'unknown_source'`
// branch carrying a `reasonCode` key is a contract violation, not "extra data" (§3.3⑤ "键整体缺席，
// 非 null"), and fails the parse.
// -------------------------------------------------------------------------------------------------
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseActor(raw: unknown): AttendanceTraceActor | null {
  if (!raw || typeof raw !== 'object') return null
  const actor = raw as Record<string, unknown>
  if (typeof actor.displayLabel !== 'string' || !actor.displayLabel) return null
  if (
    typeof actor.identityPosture !== 'string' ||
    !(ATTENDANCE_TRACE_IDENTITY_POSTURES as readonly string[]).includes(actor.identityPosture)
  ) {
    return null
  }
  return {
    displayLabel: actor.displayLabel,
    identityPosture: actor.identityPosture as AttendanceTraceIdentityPosture,
  }
}

function parseBasisEnv(raw: unknown): AttendanceTraceBasisEnv | null {
  if (!raw || typeof raw !== 'object') return null
  const env = raw as Record<string, unknown>
  const source = env.source as Record<string, unknown> | null | undefined
  if (!source || typeof source !== 'object') return null
  if (typeof source.kind !== 'string' || !(ATTENDANCE_TRACE_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
    return null
  }
  if (typeof source.ref !== 'string' || !source.ref) return null
  const version = env.version as Record<string, unknown> | null | undefined
  if (!version || typeof version !== 'object') return null
  if (
    typeof version.posture !== 'string' ||
    !(ATTENDANCE_TRACE_VERSION_POSTURES as readonly string[]).includes(version.posture)
  ) {
    return null
  }
  if (version.asOf !== undefined && typeof version.asOf !== 'string') return null
  if (version.snapshotVersion !== undefined && typeof version.snapshotVersion !== 'string') return null
  // §3.1: only `snapshot_frozen` may carry an `asOf` anchor — any other posture carrying one is a
  // fabricated timepoint ("其余 posture 禁携（不得伪造时点）") and fails the parse.
  if (version.posture !== 'snapshot_frozen' && version.asOf !== undefined) return null
  const parsed: AttendanceTraceBasisEnv = {
    source: { kind: source.kind as AttendanceTraceSourceKind, ref: source.ref },
    version: {
      posture: version.posture as AttendanceTraceVersionPosture,
      ...(version.asOf !== undefined ? { asOf: version.asOf } : {}),
      ...(version.snapshotVersion !== undefined ? { snapshotVersion: version.snapshotVersion } : {}),
    },
  }
  if (env.auditRef !== undefined) {
    const auditRef = env.auditRef as Record<string, unknown> | null
    if (!auditRef || typeof auditRef !== 'object') return null
    if (typeof auditRef.kind !== 'string' || !auditRef.kind) return null
    if (typeof auditRef.at !== 'string' || !auditRef.at) return null
    const audit: AttendanceTraceAuditRef = { kind: auditRef.kind, at: auditRef.at }
    if (auditRef.actor !== undefined) {
      const actor = parseActor(auditRef.actor)
      if (!actor) return null
      audit.actor = actor
    }
    parsed.auditRef = audit
  }
  return parsed
}

function parseBasis(raw: unknown): AttendanceTraceBasisEnv[] | null {
  if (!Array.isArray(raw)) return null
  const basis: AttendanceTraceBasisEnv[] = []
  for (const entry of raw) {
    const env = parseBasisEnv(entry)
    if (!env) return null
    basis.push(env)
  }
  return basis
}

function parseConfidence(raw: unknown): AttendanceTraceConfidence | null {
  return typeof raw === 'string' && (ATTENDANCE_TRACE_CONFIDENCES as readonly string[]).includes(raw)
    ? (raw as AttendanceTraceConfidence)
    : null
}

/** §3.1 hard rule 5 exact-key-set discipline: the response-level `reasonCode` key exists ONLY on
 *  ①②③ — its presence on a ④⑤⑥ response is a contract violation and fails the parse. */
export function parseAttendanceDecisionTraceResponse(raw: unknown): AttendanceDecisionTraceParsed | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (!isAttendanceDecisionTraceCategory(data.category)) return null
  const basis = parseBasis(data.basis)
  if (!basis) return null
  const confidence = parseConfidence(data.confidence)
  if (!confidence) return null
  const conclusion = data.conclusion as Record<string, unknown> | null | undefined
  if (!conclusion || typeof conclusion !== 'object') return null

  if (data.category === 'today_status' || data.category === 'late_early' || data.category === 'missing_punch') {
    if (data.reasonCode !== undefined && (typeof data.reasonCode !== 'string' || !data.reasonCode)) return null
    if (data.category === 'today_status') {
      if (typeof conclusion.workDate !== 'string') return null
      if (!isStringOrNull(conclusion.status)) return null
      if (!isBooleanOrNull(conclusion.isWorkday)) return null
      if (!isNumberOrNull(conclusion.workMinutes)) return null
      if (!isNumberOrNull(conclusion.lateMinutes)) return null
      if (!isNumberOrNull(conclusion.earlyLeaveMinutes)) return null
      return {
        category: 'today_status',
        ...(data.reasonCode !== undefined ? { reasonCode: data.reasonCode as string } : {}),
        conclusion: {
          workDate: conclusion.workDate,
          status: conclusion.status,
          isWorkday: conclusion.isWorkday,
          workMinutes: conclusion.workMinutes,
          lateMinutes: conclusion.lateMinutes,
          earlyLeaveMinutes: conclusion.earlyLeaveMinutes,
        },
        basis,
        confidence,
      }
    }
    if (data.category === 'late_early') {
      if (!isNumberOrNull(conclusion.lateMinutes)) return null
      if (!isNumberOrNull(conclusion.earlyLeaveMinutes)) return null
      if (!isNumberOrNull(conclusion.severeLateCount)) return null
      if (!isNumberOrNull(conclusion.severeLateMinutes)) return null
      if (!isNumberOrNull(conclusion.absenceLateCount)) return null
      if (!isStringOrNull(conclusion.status)) return null
      return {
        category: 'late_early',
        ...(data.reasonCode !== undefined ? { reasonCode: data.reasonCode as string } : {}),
        conclusion: {
          lateMinutes: conclusion.lateMinutes,
          earlyLeaveMinutes: conclusion.earlyLeaveMinutes,
          severeLateCount: conclusion.severeLateCount,
          severeLateMinutes: conclusion.severeLateMinutes,
          absenceLateCount: conclusion.absenceLateCount,
          status: conclusion.status,
        },
        basis,
        confidence,
      }
    }
    if (!isStringOrNull(conclusion.missingSide)) return null
    if (conclusion.missingSide !== null && !(ATTENDANCE_TRACE_MISSING_SIDES as readonly string[]).includes(conclusion.missingSide)) return null
    if (!isBooleanOrNull(conclusion.isWorkday)) return null
    if (!isStringOrNull(conclusion.suggestedRequestType)) return null
    if (
      conclusion.suggestedRequestType !== null &&
      !(ATTENDANCE_TRACE_SUGGESTED_REQUEST_TYPES as readonly string[]).includes(conclusion.suggestedRequestType)
    ) {
      return null
    }
    return {
      category: 'missing_punch',
      ...(data.reasonCode !== undefined ? { reasonCode: data.reasonCode as string } : {}),
      conclusion: {
        missingSide: conclusion.missingSide,
        isWorkday: conclusion.isWorkday,
        suggestedRequestType: conclusion.suggestedRequestType,
      },
      basis,
      confidence,
    }
  }

  // ④⑤⑥: response-level `reasonCode` must be ABSENT (hard rule 5④⑤⑥).
  if (Object.prototype.hasOwnProperty.call(data, 'reasonCode')) return null

  if (data.category === 'overtime_segmentation') {
    if (
      typeof data.coverageNote !== 'string' ||
      !(ATTENDANCE_TRACE_COVERAGE_NOTES as readonly string[]).includes(data.coverageNote)
    ) {
      return null
    }
    if (!isFiniteNumber(conclusion.workdayMinutes)) return null
    if (!isFiniteNumber(conclusion.restdayMinutes)) return null
    if (!isFiniteNumber(conclusion.holidayMinutes)) return null
    if (!isFiniteNumber(conclusion.totalMinutes)) return null
    if (!isNumberOrNull(conclusion.segmentationVersion)) return null
    if (!Array.isArray(conclusion.segments)) return null
    const segments: AttendanceOvertimeSegmentationTrace['conclusion']['segments'] = []
    for (const entry of conclusion.segments) {
      if (!entry || typeof entry !== 'object') return null
      const segment = entry as Record<string, unknown>
      if (
        typeof segment.dayType !== 'string' ||
        !(ATTENDANCE_TRACE_OVERTIME_DAY_TYPES as readonly string[]).includes(segment.dayType)
      ) {
        return null
      }
      if (!isFiniteNumber(segment.minutes)) return null
      if (segment.reasonCode !== undefined && (typeof segment.reasonCode !== 'string' || !segment.reasonCode)) return null
      if (!isStringOrNull(segment.holidayName)) return null
      segments.push({
        dayType: segment.dayType,
        minutes: segment.minutes,
        ...(segment.reasonCode !== undefined ? { reasonCode: segment.reasonCode as string } : {}),
        holidayName: segment.holidayName,
      })
    }
    return {
      category: 'overtime_segmentation',
      coverageNote: data.coverageNote as AttendanceTraceCoverageNote,
      conclusion: {
        workdayMinutes: conclusion.workdayMinutes,
        restdayMinutes: conclusion.restdayMinutes,
        holidayMinutes: conclusion.holidayMinutes,
        totalMinutes: conclusion.totalMinutes,
        segmentationVersion: conclusion.segmentationVersion,
        segments,
      },
      basis,
      confidence,
    }
  }

  if (data.category === 'comp_time_balance') {
    const summary = conclusion.summary as Record<string, unknown> | null | undefined
    if (!summary || typeof summary !== 'object') return null
    if (!isFiniteNumber(summary.grantedMinutes)) return null
    if (!isFiniteNumber(summary.remainingMinutes)) return null
    if (!isFiniteNumber(summary.exhaustedMinutes)) return null
    if (!isFiniteNumber(summary.expiredMinutes)) return null
    if (!Array.isArray(conclusion.lots)) return null
    const lots: AttendanceCompTimeLot[] = []
    for (const entry of conclusion.lots) {
      if (!entry || typeof entry !== 'object') return null
      const lot = entry as Record<string, unknown>
      if (
        typeof lot.sourceResolution !== 'string' ||
        !(ATTENDANCE_TRACE_LOT_SOURCE_RESOLUTIONS as readonly string[]).includes(lot.sourceResolution)
      ) {
        return null
      }
      if (typeof lot.grantedAt !== 'string' || !lot.grantedAt) return null
      if (!isStringOrNull(lot.expiresAt)) return null
      if (lot.overtimeSource !== undefined && (typeof lot.overtimeSource !== 'string' || !lot.overtimeSource)) return null
      if (lot.sourceResolution === 'mapped') {
        if (typeof lot.reasonCode !== 'string' || !lot.reasonCode) return null
        lots.push({
          sourceResolution: 'mapped',
          reasonCode: lot.reasonCode,
          grantedAt: lot.grantedAt,
          expiresAt: lot.expiresAt,
          ...(lot.overtimeSource !== undefined ? { overtimeSource: lot.overtimeSource as string } : {}),
        })
      } else {
        // §3.3⑤ exact key set (owner三轮终审 P2-2): the unknown branch's `reasonCode` key must be
        // ENTIRELY ABSENT — a present key (even null/placeholder) is a contract violation.
        if (Object.prototype.hasOwnProperty.call(lot, 'reasonCode')) return null
        lots.push({
          sourceResolution: 'unknown_source',
          grantedAt: lot.grantedAt,
          expiresAt: lot.expiresAt,
          ...(lot.overtimeSource !== undefined ? { overtimeSource: lot.overtimeSource as string } : {}),
        })
      }
    }
    if (!Array.isArray(conclusion.events)) return null
    const events: AttendanceCompTimeBalanceTrace['conclusion']['events'] = []
    for (const entry of conclusion.events) {
      if (!entry || typeof entry !== 'object') return null
      const event = entry as Record<string, unknown>
      if (typeof event.eventType !== 'string' || !event.eventType) return null
      if (!isFiniteNumber(event.deltaMinutes)) return null
      if (typeof event.occurredAt !== 'string' || !event.occurredAt) return null
      events.push({ eventType: event.eventType, deltaMinutes: event.deltaMinutes, occurredAt: event.occurredAt })
    }
    return {
      category: 'comp_time_balance',
      conclusion: {
        summary: {
          grantedMinutes: summary.grantedMinutes,
          remainingMinutes: summary.remainingMinutes,
          exhaustedMinutes: summary.exhaustedMinutes,
          expiredMinutes: summary.expiredMinutes,
        },
        lots,
        events,
      },
      basis,
      confidence,
    }
  }

  // approver_source
  if (!Array.isArray(conclusion.steps)) return null
  const steps: AttendanceApproverSourceTrace['conclusion']['steps'] = []
  for (const entry of conclusion.steps) {
    if (!entry || typeof entry !== 'object') return null
    const step = entry as Record<string, unknown>
    if (!isFiniteNumber(step.stepIndex)) return null
    if (typeof step.assigneeResolved !== 'boolean') return null
    if (typeof step.sourceKind !== 'string' || !step.sourceKind) return null
    if (typeof step.reasonCode !== 'string' || !step.reasonCode) return null
    if (step.level !== undefined && !isFiniteNumber(step.level)) return null
    let actor: AttendanceTraceActor | undefined
    if (step.actor !== undefined) {
      const parsedActor = parseActor(step.actor)
      if (!parsedActor) return null
      actor = parsedActor
    }
    steps.push({
      stepIndex: step.stepIndex,
      assigneeResolved: step.assigneeResolved,
      sourceKind: step.sourceKind,
      reasonCode: step.reasonCode,
      ...(step.level !== undefined ? { level: step.level as number } : {}),
      ...(actor ? { actor } : {}),
    })
  }
  return {
    category: 'approver_source',
    conclusion: { steps },
    basis,
    confidence,
  }
}

// -------------------------------------------------------------------------------------------------
// Copy doors (W5-1 §9 文案负向断言). The zh strings below are LOCKED VERBATIM where noted —
// specs assert them byte-for-byte, in BOTH zh and en legs.
// -------------------------------------------------------------------------------------------------

/** Fail-closed door — charter L368 verbatim zh copy. Used for: `undeterminable` posture,
 *  `undeterminable` confidence, unknown reason codes, unknown approver kinds, `unknown_source`
 *  lots. NEVER a plausible fabricated explanation. */
export function attendanceTraceUndeterminableCopy(tr: TranslateFn): string {
  return tr('Basis cannot be determined', '无法确定依据')
}

/** R4 / OD-W5-8=(a) door — the verbatim「当前规则（无历史版本）」label. */
export function attendanceTraceCurrentLiveCopy(tr: TranslateFn): string {
  return tr('Current rule (no version history)', '当前规则（无历史版本）')
}

/** W5-8 copy gate — MUST accompany every `current_live_no_history` environment (owner verbatim:
 *  「必须显示『可能不同于决策当时规则』」). */
export function attendanceTraceMayDifferCopy(tr: TranslateFn): string {
  return tr('It may differ from the rule in effect at decision time.', '可能不同于决策当时的规则。')
}

/** §3.1 hard rule 2 — a POLICY FACT, deliberately free of any「无法确定」wording. */
export function attendanceTraceNotInEffectCopy(tr: TranslateFn): string {
  return tr('Policy not in effect (engine disabled)', '策略未启用（引擎处于关闭状态）')
}

/** OD-W5-5=(b) + owner二轮终审 P3 retention-disclosure timing guardrail. Re-verified against
 *  origin/main at W5-1 implementation time (2026-07-23): the delete-immunity fix ticket has NOT
 *  landed — `attendance_leave_balance_events.balance_id` still carries `onDelete('cascade')`
 *  (`zzzz20260603120000_create_attendance_leave_balances.ts:63`, the only migration touching that
 *  FK) and no fix migration/PR exists. The W5-0 response carries NO backend retention-posture
 *  discriminator either, so per the lock's fallback this is a STATIC disclosure with this note.
 *  时序护栏: when the W5-5 fix lands, this disclosure MUST be removed (or replaced by a
 *  backend-driven closed-set posture, e.g. 'cascade_delete'|'delete_immune') — a stale warning
 *  after the fix is itself a fabricated explanation (R4 同罪, lock §9 W5-1 row). */
export function attendanceCompTimeRetentionDisclosure(tr: TranslateFn): string {
  return tr(
    'Retention boundary: balance event history is deleted together with its lot (no delete immunity yet) — once a lot is deleted, its event trail is no longer traceable.',
    '留存边界：余额流水随 lot 删除而消失（当前无删除免疫）——lot 被删除后，其流水不再可追溯。',
  )
}

// -------------------------------------------------------------------------------------------------
// Whitelisted code→copy maps (§6: "前端只译码不推导"). Every map's default branch is the
// fail-closed door — never JSON.stringify, never a guessed label.
// -------------------------------------------------------------------------------------------------
export function attendanceTraceCategoryLabel(category: AttendanceDecisionTraceCategory, tr: TranslateFn): string {
  switch (category) {
    case 'today_status': return tr('Today status', '今日状态')
    case 'late_early': return tr('Late / early leave', '迟到/早退')
    case 'missing_punch': return tr('Missing punch', '缺卡')
    case 'overtime_segmentation': return tr('Overtime segmentation', '加班分段')
    case 'comp_time_balance': return tr('Comp-time balance', '调休余额')
    case 'approver_source': return tr('Approver source', '审批人来源')
  }
}

export function attendanceTraceStatusLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'normal': return tr('Normal', '正常')
    case 'late': return tr('Late', '迟到')
    case 'early_leave': return tr('Early leave', '早退')
    case 'late_early': return tr('Late + early leave', '迟到且早退')
    case 'partial': return tr('Missing one punch', '缺卡（单侧）')
    case 'absent': return tr('Absent', '旷工')
    case 'adjusted': return tr('Adjusted', '已调整')
    case 'off': return tr('Off / rest day', '休息')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** ③ owed-punch reason closed set (`classifyOwedPunchRecord` mirror, §3.3③ — the `status_*` family
 *  is enumerable because `status` itself is the 8-value CHECK closed set). */
export function attendanceTraceOwedPunchReasonLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'non_workday': return tr('Not a workday', '非工作日')
    case 'absent_workday': return tr('Absent on a workday', '工作日旷工')
    case 'partial_missing_both': return tr('Both punches missing', '上下班卡均缺')
    case 'partial_missing_check_in': return tr('Check-in punch missing', '缺上班卡')
    case 'partial_missing_check_out': return tr('Check-out punch missing', '缺下班卡')
    case 'partial_complete': return tr('Punches complete', '打卡已补齐')
    default: {
      if (code.startsWith('status_')) {
        const status = code.slice('status_'.length)
        if ((ATTENDANCE_TRACE_RECORD_STATUSES as readonly string[]).includes(status)) {
          return tr('No punch owed for this status', '该状态无需补卡') + `：${attendanceTraceStatusLabel(status, tr)}`
        }
      }
      return attendanceTraceUndeterminableCopy(tr)
    }
  }
}

export function attendanceTraceSuggestedRequestTypeLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'leave': return tr('Leave request', '请假')
    case 'missed_check_in': return tr('Makeup check-in', '补上班卡')
    case 'missed_check_out': return tr('Makeup check-out', '补下班卡')
    case 'time_correction': return tr('Time correction', '时间更正')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

export function attendanceTraceDayTypeLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'workday': return tr('Workday', '工作日')
    case 'restday': return tr('Rest day', '休息日')
    case 'holiday': return tr('Holiday', '节假日')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** ④ segment reasonCode = day-type decision `effectiveSource` (snapshot-carried). Only VERIFIED
 *  literal values are mapped ('org'/'group'/'role'/'user' calendar-policy sources +
 *  `profileSource='rule'`); anything else fails closed — never a guessed semantic. */
export function attendanceTraceSegmentReasonLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'org': return tr('Org calendar policy', '组织日历策略')
    case 'group': return tr('Group calendar policy', '考勤组日历策略')
    case 'role': return tr('Role calendar policy', '角色日历策略')
    case 'user': return tr('User calendar policy', '个人日历策略')
    case 'rule': return tr('Attendance rule calendar', '考勤规则日历')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** ⑤ lot reasonCode — the独立冻结 enum (hard rule 5⑤, server-side mapped; never raw source_type). */
export function attendanceTraceLotReasonLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'annual_accrual': return tr('Annual-leave accrual', '年假计提')
    case 'annual_manual_adjust': return tr('Annual-leave manual adjustment', '年假手工调整')
    case 'overtime_conversion': return tr('Overtime conversion', '加班转调休')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** ⑤ event type — DB CHECK closed set (`zzzz20260603120000:72` + reverse `zzzz20260622150000:16`). */
export function attendanceTraceEventTypeLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'grant': return tr('Granted', '发放')
    case 'deduct': return tr('Deducted', '扣减')
    case 'expire': return tr('Expired', '过期')
    case 'revoke': return tr('Revoked', '撤销')
    case 'reverse': return tr('Reversed', '回冲')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** ⑥ sourceKind → label. The three dynamic kinds reuse the `assigneeSource.ts:19-31` zh wording
 *  (直属上级/部门主管/指定层级上级) — but the default branch is the fail-closed door, NEVER
 *  `JSON.stringify(source)` (§6 verbatim ban). */
export function attendanceTraceApproverSourceKindLabel(code: string, tr: TranslateFn): string {
  switch (code) {
    case 'direct_manager': return tr('Direct manager', '直属上级')
    case 'dept_head': return tr('Department head', '部门主管')
    case 'manager_at_level': return tr('Manager at level', '指定层级上级')
    case 'static': return tr('Configured approver (static step)', '固定审批人（配置指定）')
    case 'legacy_fallback': return tr('Legacy fallback approver', '兜底审批人（历史流程）')
    default: return attendanceTraceUndeterminableCopy(tr)
  }
}

/** Basis `source.ref` → friendly label. Refs are server-allowlisted storage identifiers (§3.1
 *  "ref = 白名单来源标识…绝不含用户值"); an unmapped ref falls back to the raw identifier itself —
 *  displaying a storage name verbatim is honest citation, not fabrication. */
export function attendanceTraceSourceRefLabel(ref: string, tr: TranslateFn): string {
  switch (ref) {
    case 'attendance_records': return tr('Attendance record', '考勤记录')
    case 'attendance_records.meta.tier': return tr('Late-tier result (frozen in record)', '迟到分级结果（记录内冻结）')
    case 'attendance_record_result_edits': return tr('Manual correction audit', '人工更正审计')
    case 'attendance_requests': return tr('Attendance request', '考勤申请')
    case 'attendance_requests.metadata.makeupPunchPolicySnapshot': return tr('Makeup-punch policy snapshot', '补卡策略快照')
    case 'attendance_requests.metadata.overtimeSegmentation': return tr('Overtime segmentation snapshot', '加班分段快照')
    case 'attendance_requests.metadata.overtimeRule': return tr('Overtime rule snapshot (frozen)', '加班规则快照（冻结）')
    case 'attendance_requests.metadata.approvalFlow': return tr('Approval flow snapshot', '审批流快照')
    case 'attendance_overtime_rules': return tr('Current overtime rule', '现行加班规则')
    case 'attendance_events': return tr('Attendance adjustment event', '考勤调整事件')
    case 'attendance_leave_balances': return tr('Comp-time ledger (lots)', '调休台账（批次）')
    case 'attendance_leave_balance_events': return tr('Balance event trail', '余额流水')
    case 'attendance_payroll_cycle_settlements': return tr('Payroll-cycle settlement snapshot', '周期结算快照')
    case 'approval_assignments': return tr('Approval assignments', '审批指派')
    case 'approval_records': return tr('Approval timeline (approval_records)', '审批时间线（approval_records）')
    case 'approval_instances.requester_snapshot': return tr('Requester snapshot (frozen at creation)', '发起人快照（创建时冻结）')
    case 'approval_instances.metadata.approvalFlow': return tr('Approval flow snapshot (instance)', '审批流快照（实例）')
    case 'shift_assignment': return tr('Current shift assignment', '当前班次分配')
    case 'org_default_rule': return tr('Org default rule', '组织默认规则')
    case 'global_default_rule': return tr('Global default rule', '全局默认规则')
    case 'none': return tr('No resolvable rule', '无可解析规则')
    case 'auto_absence_generation': return tr('Auto-absence generation', '自动旷工生成')
    case 'overtimeSegmentation': return tr('Overtime segmentation engine', '加班分段引擎')
    case 'compTimeFromOvertime': return tr('Comp-time-from-overtime policy', '加班转调休策略')
    case 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED': return tr('Dynamic approver resolution gate', '动态审批人解析开关')
    default: return ref
  }
}

export function attendanceTraceSourceKindLabel(kind: AttendanceTraceSourceKind, tr: TranslateFn): string {
  switch (kind) {
    case 'record': return tr('Record', '记录')
    case 'snapshot': return tr('Frozen snapshot', '冻结快照')
    case 'rule_live': return tr('Live rule', '活体规则')
    case 'ledger': return tr('Ledger', '台账')
    case 'audit': return tr('Audit', '审计')
    case 'policy_gate': return tr('Policy gate', '策略开关')
  }
}

/** auditRef.kind → label. §4.4/charter L196: organized as "发生了什么" — a known kind gets a
 *  human phrase; an unknown kind gets the GENERIC "操作记录" phrase (never the raw internal event
 *  code dumped at the business user, and never a fabricated specific claim). */
export function attendanceTraceAuditKindLabel(kind: string, tr: TranslateFn): string {
  switch (kind) {
    case 'record_write': return tr('Record written', '记录写入')
    case 'result_edit': return tr('Result manually corrected', '结果被人工更正')
    default: return tr('Operation recorded', '操作记录')
  }
}

export function attendanceTraceConfidenceLabel(confidence: AttendanceTraceConfidence, tr: TranslateFn): string {
  switch (confidence) {
    case 'grounded': return tr('Fully grounded (frozen evidence)', '依据完整（冻结证据）')
    case 'partial': return tr('Partially grounded (includes current-rule reference)', '部分依据（含当前规则参考）')
    case 'undeterminable': return attendanceTraceUndeterminableCopy(tr)
  }
}

// -------------------------------------------------------------------------------------------------
// Display model — the complete discriminator matrix output the component renders verbatim.
// -------------------------------------------------------------------------------------------------
export interface AttendanceTraceBasisEnvDisplay {
  key: string
  sourceKind: AttendanceTraceSourceKind
  sourceKindLabel: string
  refCode: string
  refLabel: string
  posture: AttendanceTraceVersionPosture
  postureLabel: string
  /** W5-8 gate: non-null iff posture === 'current_live_no_history'. */
  mayDifferNote: string | null
  /** Fail-closed door: non-null iff posture === 'undeterminable' (contains「无法确定依据」verbatim). */
  undeterminableNote: string | null
  asOfLabel: string | null
  snapshotVersionLabel: string | null
  audit: { kindLabel: string; atLabel: string; actorLabel: string | null } | null
}

export interface AttendanceTraceConclusionRow {
  key: string
  label: string
  value: string
}

export interface AttendanceDecisionTraceDisplay {
  category: AttendanceDecisionTraceCategory
  categoryLabel: string
  confidence: AttendanceTraceConfidence
  confidenceLabel: string
  /** True iff confidence === 'undeterminable' — the whole-trace fail-closed banner. */
  confidenceFailClosed: boolean
  /** ①②③ response-level reason (translated); null when the key is absent (no record). */
  reasonLabel: string | null
  conclusionRows: AttendanceTraceConclusionRow[]
  /** ④ only. */
  segments: Array<{ key: string; dayTypeLabel: string; minutesLabel: string; reasonLabel: string; holidayName: string | null }> | null
  /** ④ only — non-null iff coverageNote === 'partial_legacy' (§5.2④ 口径差 explicit declaration). */
  coverageNote: string | null
  /** ⑤ only. */
  lots: Array<{
    key: string
    resolved: boolean
    reasonLabel: string
    grantedAtLabel: string
    expiresAtLabel: string
    overtimeSourceLabel: string | null
  }> | null
  events: Array<{ key: string; typeLabel: string; deltaLabel: string; atLabel: string }> | null
  /** ⑤ only — static retention boundary disclosure (OD-W5-5=(b), fix NOT landed → must show). */
  retentionDisclosure: string | null
  /** ⑥ only. */
  steps: Array<{
    key: string
    indexLabel: string
    sourceKindLabel: string
    levelLabel: string | null
    actorLabel: string | null
    failClosed: boolean
  }> | null
  /** ⑥ only — the audit-timeline citation MUST come from the `approval_records` env (§3.3⑥E2:
   *  "审批时间线以 approval_records 为准" — mutation target: reading it from `approval_assignments`
   *  must turn the wiring spec red). Null when the env is absent from the basis chain. */
  timelineSourceRef: string | null
  basis: AttendanceTraceBasisEnvDisplay[]
}

function formatTraceTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function minutesLabel(value: number | null, tr: TranslateFn): string {
  if (value === null) return attendanceTraceUndeterminableCopy(tr)
  return tr(`${value} min`, `${value} 分钟`)
}

function postureDisplay(
  posture: AttendanceTraceVersionPosture,
  tr: TranslateFn,
): { label: string; mayDifferNote: string | null; undeterminableNote: string | null } {
  switch (posture) {
    case 'snapshot_frozen':
      return { label: tr('Frozen at decision time', '决策时冻结'), mayDifferNote: null, undeterminableNote: null }
    case 'current_live_no_history':
      // R4/W5-8: the verbatim label AND the may-differ declaration travel together — the
      // declaration is not optional decoration ("必须显示", OD-W5-8 owner verbatim).
      return {
        label: attendanceTraceCurrentLiveCopy(tr),
        mayDifferNote: attendanceTraceMayDifferCopy(tr),
        undeterminableNote: null,
      }
    case 'not_in_effect':
      return { label: attendanceTraceNotInEffectCopy(tr), mayDifferNote: null, undeterminableNote: null }
    case 'undeterminable':
      return {
        label: attendanceTraceUndeterminableCopy(tr),
        mayDifferNote: null,
        undeterminableNote: attendanceTraceUndeterminableCopy(tr),
      }
  }
}

function deriveBasisDisplay(basis: AttendanceTraceBasisEnv[], tr: TranslateFn): AttendanceTraceBasisEnvDisplay[] {
  return basis.map((env, index) => {
    const posture = postureDisplay(env.version.posture, tr)
    return {
      key: `${index}-${env.source.ref}`,
      sourceKind: env.source.kind,
      sourceKindLabel: attendanceTraceSourceKindLabel(env.source.kind, tr),
      refCode: env.source.ref,
      refLabel: attendanceTraceSourceRefLabel(env.source.ref, tr),
      posture: env.version.posture,
      postureLabel: posture.label,
      mayDifferNote: posture.mayDifferNote,
      undeterminableNote: posture.undeterminableNote,
      asOfLabel: env.version.asOf ? formatTraceTimestamp(env.version.asOf) : null,
      snapshotVersionLabel: env.version.snapshotVersion ? tr(`v${env.version.snapshotVersion}`, `版本 ${env.version.snapshotVersion}`) : null,
      audit: env.auditRef
        ? {
            kindLabel: attendanceTraceAuditKindLabel(env.auditRef.kind, tr),
            atLabel: formatTraceTimestamp(env.auditRef.at),
            actorLabel: env.auditRef.actor ? env.auditRef.actor.displayLabel : null,
          }
        : null,
    }
  })
}

function booleanLabel(value: boolean | null, tr: TranslateFn, yes: [string, string], no: [string, string]): string {
  if (value === null) return attendanceTraceUndeterminableCopy(tr)
  return value ? tr(yes[0], yes[1]) : tr(no[0], no[1])
}

export function deriveAttendanceDecisionTraceDisplay(
  parsed: AttendanceDecisionTraceParsed,
  tr: TranslateFn,
): AttendanceDecisionTraceDisplay {
  const base = {
    category: parsed.category,
    categoryLabel: attendanceTraceCategoryLabel(parsed.category, tr),
    confidence: parsed.confidence,
    confidenceLabel: attendanceTraceConfidenceLabel(parsed.confidence, tr),
    confidenceFailClosed: parsed.confidence === 'undeterminable',
    basis: deriveBasisDisplay(parsed.basis, tr),
  }

  if (parsed.category === 'today_status') {
    const c = parsed.conclusion
    return {
      ...base,
      reasonLabel: parsed.reasonCode !== undefined ? attendanceTraceStatusLabel(parsed.reasonCode, tr) : null,
      conclusionRows: [
        { key: 'workDate', label: tr('Work date', '工作日期'), value: c.workDate },
        {
          key: 'status',
          label: tr('Status', '状态'),
          value: c.status === null ? attendanceTraceUndeterminableCopy(tr) : attendanceTraceStatusLabel(c.status, tr),
        },
        {
          key: 'isWorkday',
          label: tr('Scheduled workday', '应出勤'),
          value: booleanLabel(c.isWorkday, tr, ['Yes', '是'], ['No', '否']),
        },
        { key: 'workMinutes', label: tr('Work minutes', '工作时长'), value: minutesLabel(c.workMinutes, tr) },
        { key: 'lateMinutes', label: tr('Late minutes', '迟到时长'), value: minutesLabel(c.lateMinutes, tr) },
        { key: 'earlyLeaveMinutes', label: tr('Early-leave minutes', '早退时长'), value: minutesLabel(c.earlyLeaveMinutes, tr) },
      ],
      segments: null,
      coverageNote: null,
      lots: null,
      events: null,
      retentionDisclosure: null,
      steps: null,
      timelineSourceRef: null,
    }
  }

  if (parsed.category === 'late_early') {
    const c = parsed.conclusion
    return {
      ...base,
      reasonLabel: parsed.reasonCode !== undefined ? attendanceTraceStatusLabel(parsed.reasonCode, tr) : null,
      conclusionRows: [
        { key: 'lateMinutes', label: tr('Late minutes', '迟到时长'), value: minutesLabel(c.lateMinutes, tr) },
        { key: 'earlyLeaveMinutes', label: tr('Early-leave minutes', '早退时长'), value: minutesLabel(c.earlyLeaveMinutes, tr) },
        // §3.3② tier legs: a legacy row without tier keys arrives as null — rendered as the
        // fail-closed door, NEVER as a fabricated "0 次" ("禁把 fallback-0 读作「无严重迟到」证据").
        { key: 'severeLateCount', label: tr('Severe-late count', '严重迟到次数'), value: c.severeLateCount === null ? attendanceTraceUndeterminableCopy(tr) : String(c.severeLateCount) },
        { key: 'severeLateMinutes', label: tr('Severe-late minutes', '严重迟到时长'), value: c.severeLateMinutes === null ? attendanceTraceUndeterminableCopy(tr) : minutesLabel(c.severeLateMinutes, tr) },
        { key: 'absenceLateCount', label: tr('Absence-tier late count', '旷工级迟到次数'), value: c.absenceLateCount === null ? attendanceTraceUndeterminableCopy(tr) : String(c.absenceLateCount) },
        {
          key: 'status',
          label: tr('Status', '状态'),
          value: c.status === null ? attendanceTraceUndeterminableCopy(tr) : attendanceTraceStatusLabel(c.status, tr),
        },
      ],
      segments: null,
      coverageNote: null,
      lots: null,
      events: null,
      retentionDisclosure: null,
      steps: null,
      timelineSourceRef: null,
    }
  }

  if (parsed.category === 'missing_punch') {
    const c = parsed.conclusion
    const missingSideLabel =
      c.missingSide === null
        ? tr('None', '无')
        : c.missingSide === 'check_in'
          ? tr('Check-in', '上班卡')
          : c.missingSide === 'check_out'
            ? tr('Check-out', '下班卡')
            : tr('Both', '上下班卡')
    return {
      ...base,
      reasonLabel: parsed.reasonCode !== undefined ? attendanceTraceOwedPunchReasonLabel(parsed.reasonCode, tr) : null,
      conclusionRows: [
        { key: 'missingSide', label: tr('Missing side', '缺卡侧'), value: missingSideLabel },
        {
          key: 'isWorkday',
          label: tr('Scheduled workday', '应出勤'),
          value: booleanLabel(c.isWorkday, tr, ['Yes', '是'], ['No', '否']),
        },
        {
          key: 'suggestedRequestType',
          label: tr('Suggested remediation', '建议补救方式'),
          value: c.suggestedRequestType === null ? tr('None', '无') : attendanceTraceSuggestedRequestTypeLabel(c.suggestedRequestType, tr),
        },
      ],
      segments: null,
      coverageNote: null,
      lots: null,
      events: null,
      retentionDisclosure: null,
      steps: null,
      timelineSourceRef: null,
    }
  }

  if (parsed.category === 'overtime_segmentation') {
    const c = parsed.conclusion
    return {
      ...base,
      reasonLabel: null,
      conclusionRows: [
        { key: 'workdayMinutes', label: tr('Workday overtime', '工作日加班'), value: minutesLabel(c.workdayMinutes, tr) },
        { key: 'restdayMinutes', label: tr('Rest-day overtime', '休息日加班'), value: minutesLabel(c.restdayMinutes, tr) },
        { key: 'holidayMinutes', label: tr('Holiday overtime', '节假日加班'), value: minutesLabel(c.holidayMinutes, tr) },
        { key: 'totalMinutes', label: tr('Total overtime', '加班合计'), value: minutesLabel(c.totalMinutes, tr) },
        {
          key: 'segmentationVersion',
          label: tr('Segmentation version', '分段引擎版本'),
          value: c.segmentationVersion === null ? attendanceTraceUndeterminableCopy(tr) : tr(`v${c.segmentationVersion}`, `版本 ${c.segmentationVersion}`),
        },
      ],
      segments: c.segments.map((segment, index) => ({
        key: `${index}-${segment.dayType}`,
        dayTypeLabel: attendanceTraceDayTypeLabel(segment.dayType, tr),
        minutesLabel: minutesLabel(segment.minutes, tr),
        reasonLabel:
          segment.reasonCode !== undefined
            ? attendanceTraceSegmentReasonLabel(segment.reasonCode, tr)
            : attendanceTraceUndeterminableCopy(tr),
        holidayName: segment.holidayName,
      })),
      // §5.2④ 口径差 explicit declaration — only the partial_legacy branch carries copy; the
      // 'full' branch carries none (nothing to disclaim). NEVER silently aligned.
      coverageNote:
        parsed.coverageNote === 'partial_legacy'
          ? tr(
              'Caliber note: total overtime is summed from raw request minutes, while segments only cover requests with a frozen segmentation snapshot — legacy/pre-engine requests are not segmented, so totals may exceed the segment sum.',
              '口径差说明：加班合计按原始申请分钟求和，而分段仅覆盖带冻结分段快照的申请——legacy/引擎前的申请未分段，合计可能大于分段之和。',
            )
          : null,
      lots: null,
      events: null,
      retentionDisclosure: null,
      steps: null,
      timelineSourceRef: null,
    }
  }

  if (parsed.category === 'comp_time_balance') {
    const c = parsed.conclusion
    return {
      ...base,
      reasonLabel: null,
      conclusionRows: [
        { key: 'grantedMinutes', label: tr('Granted', '已发放'), value: minutesLabel(c.summary.grantedMinutes, tr) },
        { key: 'remainingMinutes', label: tr('Remaining', '剩余'), value: minutesLabel(c.summary.remainingMinutes, tr) },
        { key: 'exhaustedMinutes', label: tr('Used', '已使用'), value: minutesLabel(c.summary.exhaustedMinutes, tr) },
        { key: 'expiredMinutes', label: tr('Expired', '已过期'), value: minutesLabel(c.summary.expiredMinutes, tr) },
      ],
      segments: null,
      coverageNote: null,
      lots: c.lots.map((lot, index) => ({
        key: `${index}-${lot.grantedAt}`,
        resolved: lot.sourceResolution === 'mapped',
        // §3.3⑤: the `unknown_source` branch IS the item-level fail-closed state — the door copy,
        // never the raw source_type (which the server already refuses to echo, 原值零回显).
        reasonLabel:
          lot.sourceResolution === 'mapped'
            ? attendanceTraceLotReasonLabel(lot.reasonCode, tr)
            : attendanceTraceUndeterminableCopy(tr),
        grantedAtLabel: formatTraceTimestamp(lot.grantedAt),
        // §3.3⑤E1: expiry is a materialized fact ("授予时定为 X 到期") — never re-derived.
        expiresAtLabel: lot.expiresAt === null ? tr('No expiry recorded', '未记录到期日') : formatTraceTimestamp(lot.expiresAt),
        overtimeSourceLabel: lot.overtimeSource !== undefined ? lot.overtimeSource : null,
      })),
      events: c.events.map((event, index) => ({
        key: `${index}-${event.occurredAt}`,
        typeLabel: attendanceTraceEventTypeLabel(event.eventType, tr),
        deltaLabel: tr(`${event.deltaMinutes} min`, `${event.deltaMinutes} 分钟`),
        atLabel: formatTraceTimestamp(event.occurredAt),
      })),
      retentionDisclosure: attendanceCompTimeRetentionDisclosure(tr),
      steps: null,
      timelineSourceRef: null,
    }
  }

  // approver_source
  const steps = parsed.conclusion.steps.map((step) => {
    const known = (ATTENDANCE_TRACE_APPROVER_SOURCE_KINDS as readonly string[]).includes(step.sourceKind)
    const failClosed = !known || step.sourceKind === 'unknown'
    return {
      key: `step-${step.stepIndex}`,
      indexLabel: tr(`Step ${step.stepIndex + 1}`, `第 ${step.stepIndex + 1} 步`),
      sourceKindLabel: attendanceTraceApproverSourceKindLabel(step.sourceKind, tr),
      levelLabel: step.level !== undefined ? tr(`Level ${step.level}`, `第 ${step.level} 级`) : null,
      actorLabel: step.actor ? step.actor.displayLabel : null,
      failClosed,
    }
  })
  // §3.3⑥E2: the audit TIMELINE citation is pinned to the `approval_records` env — the
  // append-only truth source. `approval_assignments` (ON CONFLICT overwrite, non-append-only) is
  // NEVER the timeline source.
  const timelineEnv = parsed.basis.find((env) => env.source.kind === 'audit' && env.source.ref === 'approval_records')
  return {
    ...base,
    reasonLabel: null,
    conclusionRows: [
      { key: 'stepCount', label: tr('Approval steps', '审批步数'), value: String(parsed.conclusion.steps.length) },
    ],
    segments: null,
    coverageNote: null,
    lots: null,
    events: null,
    retentionDisclosure: null,
    steps,
    timelineSourceRef: timelineEnv ? timelineEnv.source.ref : null,
  }
}

// -------------------------------------------------------------------------------------------------
// Canonical deep links (W5-1 R2: canonical QUERY form — hash-form navigation is banned, zero `#`
// anywhere; W4-R2 same-style precedent `/attendance?section=attendance-overview-anomalies`,
// AttendanceView `:14777-14783`).
// -------------------------------------------------------------------------------------------------
export const ATTENDANCE_ADMIN_DECISION_TRACE_SECTION_ID = 'attendance-admin-decision-trace'
export const ATTENDANCE_OVERVIEW_DECISION_TRACE_SECTION_ID = 'attendance-overview-decision-trace'

export function buildAttendanceAdminDecisionTraceDeepLink(): string {
  return `/attendance?tab=admin&section=${ATTENDANCE_ADMIN_DECISION_TRACE_SECTION_ID}`
}

export function buildAttendanceSelfDecisionTraceDeepLink(): string {
  return `/attendance?section=${ATTENDANCE_OVERVIEW_DECISION_TRACE_SECTION_ID}`
}

// -------------------------------------------------------------------------------------------------
// OD-W5-7 / #4562 comp_time channel — UI-side input self-validation (the W5-7 gate note: the
// parameterized balance read functions accept free-form strings by existing contract; the W5-1 UI
// must validate its OWN input against this closed set before calling — an out-of-set value never
// reaches the wire).
// -------------------------------------------------------------------------------------------------
export const ATTENDANCE_BALANCE_LEAVE_TYPE_CODES = ['annual', 'comp_time'] as const
export type AttendanceBalanceLeaveTypeCode = (typeof ATTENDANCE_BALANCE_LEAVE_TYPE_CODES)[number]

export function isAttendanceBalanceLeaveTypeCode(value: unknown): value is AttendanceBalanceLeaveTypeCode {
  return typeof value === 'string' && (ATTENDANCE_BALANCE_LEAVE_TYPE_CODES as readonly string[]).includes(value)
}

export function attendanceBalanceLeaveTypeLabel(code: AttendanceBalanceLeaveTypeCode, tr: TranslateFn): string {
  return code === 'annual' ? tr('Annual leave', '年假') : tr('Comp time', '调休')
}
