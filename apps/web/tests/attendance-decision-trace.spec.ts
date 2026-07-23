// W5-1 (Wave 5 explainability design-lock 2026-07-22, RATIFIED §3/§6/§9 W5-1): pure-module
// discriminator matrix + fetch-composable contract for the decision-trace display slice.
// All fixtures are SYNTHETIC (charter §8.1 / lock P2-a: no real user data in any test surface);
// assertions stay on exact shapes / verbatim copy — trace bodies are asserted structurally, never
// dumped to logs.
import { describe, expect, it, vi } from 'vitest'
import {
  ATTENDANCE_ADMIN_DECISION_TRACE_SECTION_ID,
  ATTENDANCE_BALANCE_LEAVE_TYPE_CODES,
  ATTENDANCE_DECISION_TRACE_CATEGORIES,
  ATTENDANCE_OVERVIEW_DECISION_TRACE_SECTION_ID,
  ATTENDANCE_TRACE_CONFIDENCES,
  ATTENDANCE_TRACE_VERSION_POSTURES,
  attendanceCompTimeRetentionDisclosure,
  attendanceTraceApproverSourceKindLabel,
  attendanceTraceCategoryLabel,
  attendanceTraceCurrentLiveCopy,
  attendanceTraceEventTypeLabel,
  attendanceTraceLotReasonLabel,
  attendanceTraceMayDifferCopy,
  attendanceTraceNotInEffectCopy,
  attendanceTraceOwedPunchReasonLabel,
  attendanceTraceSegmentReasonLabel,
  attendanceTraceStatusLabel,
  attendanceTraceSuggestedRequestTypeLabel,
  attendanceTraceUndeterminableCopy,
  buildAttendanceAdminDecisionTraceDeepLink,
  buildAttendanceSelfDecisionTraceDeepLink,
  deriveAttendanceDecisionTraceDisplay,
  isAttendanceBalanceLeaveTypeCode,
  parseAttendanceDecisionTraceResponse,
  type AttendanceDecisionTraceParsed,
  type AttendanceTraceVersionPosture,
} from '../src/views/attendance/attendanceDecisionTrace'
import {
  buildAttendanceDecisionTraceRequestPath,
  useAttendanceDecisionTrace,
} from '../src/views/attendance/useAttendanceDecisionTrace'

const trZh = (_en: string, zh: string): string => zh
const trEn = (en: string, _zh: string): string => en

// -------------------------------------------------------------------------------------------------
// Synthetic wire fixtures (§3.1 shapes as emitted by the W5-0 endpoints).
// -------------------------------------------------------------------------------------------------
function todayStatusFixture(): Record<string, unknown> {
  return {
    category: 'today_status',
    reasonCode: 'late',
    conclusion: {
      workDate: '2026-07-01',
      status: 'late',
      isWorkday: true,
      workMinutes: 480,
      lateMinutes: 12,
      earlyLeaveMinutes: 0,
    },
    basis: [
      {
        source: { kind: 'record', ref: 'attendance_records' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' },
        auditRef: { kind: 'record_write', at: '2026-07-01T10:00:00.000Z' },
      },
      {
        source: { kind: 'rule_live', ref: 'org_default_rule' },
        version: { posture: 'current_live_no_history' },
      },
      {
        source: { kind: 'audit', ref: 'attendance_record_result_edits' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-02T03:00:00.000Z' },
        auditRef: {
          kind: 'result_edit',
          at: '2026-07-02T03:00:00.000Z',
          actor: { displayLabel: '测试管理员', identityPosture: 'resolved' },
        },
      },
    ],
    confidence: 'partial',
  }
}

function todayStatusUndeterminableFixture(): Record<string, unknown> {
  return {
    category: 'today_status',
    conclusion: {
      workDate: '2026-07-01',
      status: null,
      isWorkday: null,
      workMinutes: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
    },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  }
}

function lateEarlyLegacyFixture(): Record<string, unknown> {
  return {
    category: 'late_early',
    reasonCode: 'late',
    conclusion: {
      lateMinutes: 30,
      earlyLeaveMinutes: null,
      severeLateCount: null,
      severeLateMinutes: null,
      absenceLateCount: null,
      status: 'late',
    },
    basis: [
      {
        source: { kind: 'record', ref: 'attendance_records' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' },
      },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'rule_live', ref: 'shift_assignment' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'undeterminable',
  }
}

function missingPunchFixture(): Record<string, unknown> {
  return {
    category: 'missing_punch',
    reasonCode: 'partial_missing_check_out',
    conclusion: { missingSide: 'check_out', isWorkday: true, suggestedRequestType: 'missed_check_out' },
    basis: [
      {
        source: { kind: 'record', ref: 'attendance_records' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' },
      },
      { source: { kind: 'rule_live', ref: 'global_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }
}

function overtimeFullFixture(): Record<string, unknown> {
  return {
    category: 'overtime_segmentation',
    coverageNote: 'full',
    conclusion: {
      workdayMinutes: 0,
      restdayMinutes: 120,
      holidayMinutes: 0,
      totalMinutes: 120,
      segmentationVersion: 1,
      segments: [{ dayType: 'restday', minutes: 120, reasonCode: 'org', holidayName: null }],
    },
    basis: [
      {
        source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-05T08:00:00.000Z', snapshotVersion: '1' },
      },
      { source: { kind: 'rule_live', ref: 'attendance_overtime_rules' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }
}

function overtimePartialLegacyFixture(): Record<string, unknown> {
  return {
    category: 'overtime_segmentation',
    coverageNote: 'partial_legacy',
    conclusion: {
      workdayMinutes: 0,
      restdayMinutes: 0,
      holidayMinutes: 0,
      totalMinutes: 90,
      segmentationVersion: null,
      segments: [],
    },
    basis: [
      {
        source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' },
        version: { posture: 'undeterminable' },
      },
      { source: { kind: 'policy_gate', ref: 'overtimeSegmentation' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'undeterminable',
  }
}

function compTimeFixture(): Record<string, unknown> {
  return {
    category: 'comp_time_balance',
    conclusion: {
      summary: { grantedMinutes: 300, remainingMinutes: 180, exhaustedMinutes: 120, expiredMinutes: 0 },
      lots: [
        {
          sourceResolution: 'mapped',
          reasonCode: 'overtime_conversion',
          grantedAt: '2026-06-01T00:00:00.000Z',
          expiresAt: '2026-12-01T00:00:00.000Z',
          overtimeSource: 'restday',
        },
        {
          sourceResolution: 'unknown_source',
          grantedAt: '2026-05-01T00:00:00.000Z',
          expiresAt: null,
        },
      ],
      events: [{ eventType: 'grant', deltaMinutes: 300, occurredAt: '2026-06-01T00:00:00.000Z' }],
    },
    basis: [
      {
        source: { kind: 'ledger', ref: 'attendance_leave_balances' },
        version: { posture: 'snapshot_frozen', asOf: '2026-06-01T00:00:00.000Z' },
      },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'not_in_effect' } },
      { source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'partial',
  }
}

function approverSourceFixture(): Record<string, unknown> {
  return {
    category: 'approver_source',
    conclusion: {
      steps: [
        {
          stepIndex: 0,
          assigneeResolved: true,
          sourceKind: 'direct_manager',
          reasonCode: 'direct_manager',
          actor: { displayLabel: '测试主管', identityPosture: 'resolved' },
        },
        { stepIndex: 1, assigneeResolved: true, sourceKind: 'static', reasonCode: 'static' },
        { stepIndex: 2, assigneeResolved: true, sourceKind: 'unknown', reasonCode: 'unknown' },
      ],
    },
    basis: [
      {
        source: { kind: 'record', ref: 'approval_assignments' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' },
      },
      {
        source: { kind: 'audit', ref: 'approval_records' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:30:00.000Z' },
      },
      {
        source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' },
      },
      {
        source: { kind: 'policy_gate', ref: 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED' },
        version: { posture: 'not_in_effect' },
      },
    ],
    confidence: 'partial',
  }
}

// -------------------------------------------------------------------------------------------------
// Parse matrix (strict whitelist, fail-closed null).
// -------------------------------------------------------------------------------------------------
describe('parseAttendanceDecisionTraceResponse — strict whitelist matrix', () => {
  it('parses every category fixture to the exact projected shape (deepEqual, no extra keys)', () => {
    expect(parseAttendanceDecisionTraceResponse(todayStatusFixture())).toEqual(todayStatusFixture())
    expect(parseAttendanceDecisionTraceResponse(todayStatusUndeterminableFixture())).toEqual(todayStatusUndeterminableFixture())
    expect(parseAttendanceDecisionTraceResponse(lateEarlyLegacyFixture())).toEqual(lateEarlyLegacyFixture())
    expect(parseAttendanceDecisionTraceResponse(missingPunchFixture())).toEqual(missingPunchFixture())
    expect(parseAttendanceDecisionTraceResponse(overtimeFullFixture())).toEqual(overtimeFullFixture())
    expect(parseAttendanceDecisionTraceResponse(overtimePartialLegacyFixture())).toEqual(overtimePartialLegacyFixture())
    expect(parseAttendanceDecisionTraceResponse(compTimeFixture())).toEqual(compTimeFixture())
    expect(parseAttendanceDecisionTraceResponse(approverSourceFixture())).toEqual(approverSourceFixture())
  })

  it('drops unknown extra keys via whitelist projection (unknown top-level key never round-trips)', () => {
    const withExtra = { ...todayStatusFixture(), internalDebug: { secret: true } }
    const parsed = parseAttendanceDecisionTraceResponse(withExtra)
    expect(parsed).toEqual(todayStatusFixture())
    expect(parsed && Object.prototype.hasOwnProperty.call(parsed, 'internalDebug')).toBe(false)
  })

  it('fails closed to null on non-object / unknown category (enum-strict, never a default)', () => {
    expect(parseAttendanceDecisionTraceResponse(null)).toBeNull()
    expect(parseAttendanceDecisionTraceResponse('today_status')).toBeNull()
    expect(parseAttendanceDecisionTraceResponse({ ...todayStatusFixture(), category: 'weird_category' })).toBeNull()
    expect(parseAttendanceDecisionTraceResponse({ ...todayStatusFixture(), category: '' })).toBeNull()
  })

  it('fails closed on out-of-domain posture / confidence / source.kind / identityPosture', () => {
    const badPosture = todayStatusFixture()
    ;(badPosture.basis as Array<Record<string, any>>)[0].version.posture = 'guessed_live'
    expect(parseAttendanceDecisionTraceResponse(badPosture)).toBeNull()

    expect(parseAttendanceDecisionTraceResponse({ ...todayStatusFixture(), confidence: 'high' })).toBeNull()

    const badKind = todayStatusFixture()
    ;(badKind.basis as Array<Record<string, any>>)[0].source.kind = 'table'
    expect(parseAttendanceDecisionTraceResponse(badKind)).toBeNull()

    // 'deleted' is deliberately NOT a legal identity posture (owner二轮终审 P2-b — users has no
    // delete tombstone, the value is unimplementable and must not round-trip).
    const badIdentity = todayStatusFixture()
    ;(badIdentity.basis as Array<Record<string, any>>)[2].auditRef.actor.identityPosture = 'deleted'
    expect(parseAttendanceDecisionTraceResponse(badIdentity)).toBeNull()
  })

  it('fails closed when a non-frozen posture carries an asOf anchor (伪造时点 ban)', () => {
    const fabricated = todayStatusFixture()
    ;(fabricated.basis as Array<Record<string, any>>)[1].version.asOf = '2026-07-01T00:00:00.000Z'
    expect(parseAttendanceDecisionTraceResponse(fabricated)).toBeNull()
  })

  it('enforces the reasonCode carrier discipline: response-level key on ④⑤⑥ = contract violation', () => {
    expect(parseAttendanceDecisionTraceResponse({ ...overtimeFullFixture(), reasonCode: 'restday' })).toBeNull()
    expect(parseAttendanceDecisionTraceResponse({ ...compTimeFixture(), reasonCode: 'overtime_conversion' })).toBeNull()
    expect(parseAttendanceDecisionTraceResponse({ ...approverSourceFixture(), reasonCode: 'static' })).toBeNull()
    // scalar-or-array 双读 ban: an array reasonCode on ① is malformed, never "first element wins".
    expect(parseAttendanceDecisionTraceResponse({ ...todayStatusFixture(), reasonCode: ['late'] })).toBeNull()
  })

  it('⑤ lot union: unknown_source carrying a reasonCode key fails closed (键整体缺席 contract)', () => {
    const smuggled = compTimeFixture()
    ;((smuggled.conclusion as Record<string, any>).lots as Array<Record<string, unknown>>)[1].reasonCode = 'overtime_conversion'
    expect(parseAttendanceDecisionTraceResponse(smuggled)).toBeNull()

    const smuggledNull = compTimeFixture()
    ;((smuggledNull.conclusion as Record<string, any>).lots as Array<Record<string, unknown>>)[1].reasonCode = null
    expect(parseAttendanceDecisionTraceResponse(smuggledNull)).toBeNull()
  })

  it('⑤ lot union: mapped without reasonCode / unknown sourceResolution fails closed', () => {
    const missingCode = compTimeFixture()
    delete ((missingCode.conclusion as Record<string, any>).lots as Array<Record<string, unknown>>)[0].reasonCode
    expect(parseAttendanceDecisionTraceResponse(missingCode)).toBeNull()

    const badResolution = compTimeFixture()
    ;((badResolution.conclusion as Record<string, any>).lots as Array<Record<string, unknown>>)[0].sourceResolution = 'raw_passthrough'
    expect(parseAttendanceDecisionTraceResponse(badResolution)).toBeNull()
  })

  it('③ enum-strict conclusion fields: out-of-domain missingSide / suggestedRequestType fail closed', () => {
    const badSide = missingPunchFixture()
    ;(badSide.conclusion as Record<string, unknown>).missingSide = 'lunch'
    expect(parseAttendanceDecisionTraceResponse(badSide)).toBeNull()

    const badSuggestion = missingPunchFixture()
    ;(badSuggestion.conclusion as Record<string, unknown>).suggestedRequestType = 'apologize'
    expect(parseAttendanceDecisionTraceResponse(badSuggestion)).toBeNull()
  })

  it('④ enum-strict: out-of-domain coverageNote / segment dayType fail closed', () => {
    expect(parseAttendanceDecisionTraceResponse({ ...overtimeFullFixture(), coverageNote: 'complete' })).toBeNull()
    const badDayType = overtimeFullFixture()
    ;((badDayType.conclusion as Record<string, any>).segments as Array<Record<string, unknown>>)[0].dayType = 'midnight'
    expect(parseAttendanceDecisionTraceResponse(badDayType)).toBeNull()
  })
})

// -------------------------------------------------------------------------------------------------
// Display derivation — copy doors, both zh and en legs.
// -------------------------------------------------------------------------------------------------
describe('deriveAttendanceDecisionTraceDisplay — posture copy doors (zh + en legs)', () => {
  function fixtureWithPosture(posture: AttendanceTraceVersionPosture): AttendanceDecisionTraceParsed {
    const raw = todayStatusFixture()
    const env = (raw.basis as Array<Record<string, any>>)[1]
    env.version = posture === 'snapshot_frozen' ? { posture, asOf: '2026-07-01T00:00:00.000Z' } : { posture }
    const parsed = parseAttendanceDecisionTraceResponse(raw)
    expect(parsed).not.toBeNull()
    return parsed as AttendanceDecisionTraceParsed
  }

  it('current_live_no_history renders the verbatim label AND the may-differ declaration (W5-8 gate, zh)', () => {
    const display = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('current_live_no_history'), trZh)
    const env = display.basis[1]
    expect(env.postureLabel).toBe('当前规则（无历史版本）')
    expect(env.mayDifferNote).toBe('可能不同于决策当时的规则。')
    expect(env.undeterminableNote).toBeNull()
  })

  it('current_live_no_history — en leg carries both doors too', () => {
    const display = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('current_live_no_history'), trEn)
    const env = display.basis[1]
    expect(env.postureLabel).toBe('Current rule (no version history)')
    expect(env.mayDifferNote).toBe('It may differ from the rule in effect at decision time.')
  })

  it('undeterminable renders the verbatim fail-closed copy — never a plausible explanation (zh + en)', () => {
    const zh = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('undeterminable'), trZh).basis[1]
    expect(zh.postureLabel).toBe('无法确定依据')
    expect(zh.undeterminableNote).toBe('无法确定依据')
    expect(zh.mayDifferNote).toBeNull()
    const en = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('undeterminable'), trEn).basis[1]
    expect(en.postureLabel).toBe('Basis cannot be determined')
    expect(en.undeterminableNote).toBe('Basis cannot be determined')
  })

  it('not_in_effect is a policy fact: its copy NEVER contains the fail-closed wording (zh + en)', () => {
    const zh = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('not_in_effect'), trZh).basis[1]
    expect(zh.postureLabel).toBe('策略未启用（引擎处于关闭状态）')
    expect(zh.postureLabel.includes('无法确定')).toBe(false)
    expect(zh.undeterminableNote).toBeNull()
    const en = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('not_in_effect'), trEn).basis[1]
    expect(en.postureLabel).toBe('Policy not in effect (engine disabled)')
    expect(en.postureLabel.toLowerCase().includes('cannot be determined')).toBe(false)
  })

  it('snapshot_frozen carries the asOf anchor and neither warning door', () => {
    const env = deriveAttendanceDecisionTraceDisplay(fixtureWithPosture('snapshot_frozen'), trZh).basis[1]
    expect(env.postureLabel).toBe('决策时冻结')
    expect(env.asOfLabel).not.toBeNull()
    expect(env.mayDifferNote).toBeNull()
    expect(env.undeterminableNote).toBeNull()
  })

  it('covers the full posture domain (no fifth value exists to render)', () => {
    expect(ATTENDANCE_TRACE_VERSION_POSTURES).toEqual([
      'snapshot_frozen',
      'current_live_no_history',
      'not_in_effect',
      'undeterminable',
    ])
    expect(ATTENDANCE_TRACE_CONFIDENCES).toEqual(['grounded', 'partial', 'undeterminable'])
  })
})

describe('deriveAttendanceDecisionTraceDisplay — category matrix', () => {
  it('confidence=undeterminable sets the whole-trace fail-closed flag with the verbatim label', () => {
    const parsed = parseAttendanceDecisionTraceResponse(todayStatusUndeterminableFixture()) as AttendanceDecisionTraceParsed
    const display = deriveAttendanceDecisionTraceDisplay(parsed, trZh)
    expect(display.confidenceFailClosed).toBe(true)
    expect(display.confidenceLabel).toBe('无法确定依据')
    // No record → response-level reasonCode absent → no reason line (never fabricated).
    expect(display.reasonLabel).toBeNull()
    // All conclusion values render the fail-closed door, not fabricated zeros.
    const statusRow = display.conclusionRows.find((row) => row.key === 'status')
    expect(statusRow?.value).toBe('无法确定依据')
  })

  it('② legacy tier rows render the fail-closed door — never a fabricated 0 count', () => {
    const parsed = parseAttendanceDecisionTraceResponse(lateEarlyLegacyFixture()) as AttendanceDecisionTraceParsed
    const display = deriveAttendanceDecisionTraceDisplay(parsed, trZh)
    const severeRow = display.conclusionRows.find((row) => row.key === 'severeLateCount')
    expect(severeRow?.value).toBe('无法确定依据')
    expect(severeRow?.value).not.toBe('0')
  })

  it('④ partial_legacy carries the explicit caliber declaration; full carries none', () => {
    const partial = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(overtimePartialLegacyFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(partial.coverageNote).not.toBeNull()
    expect(partial.coverageNote).toContain('口径差')
    const full = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(overtimeFullFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(full.coverageNote).toBeNull()
    expect(full.segments?.[0]?.reasonLabel).toBe('组织日历策略')
  })

  it('⑤ unknown_source lot renders as the item-level fail-closed state; mapped lot translates its frozen code', () => {
    const display = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(compTimeFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(display.lots).toHaveLength(2)
    expect(display.lots?.[0]).toMatchObject({ resolved: true, reasonLabel: '加班转调休', overtimeSourceLabel: 'restday' })
    expect(display.lots?.[1]).toMatchObject({ resolved: false, reasonLabel: '无法确定依据', overtimeSourceLabel: null })
  })

  it('⑤ always carries the retention disclosure with the lock-verbatim boundary phrase (zh + en)', () => {
    const zh = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(compTimeFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(zh.retentionDisclosure).toContain('流水随 lot 删除而消失')
    const en = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(compTimeFixture()) as AttendanceDecisionTraceParsed,
      trEn,
    )
    expect(en.retentionDisclosure).toContain('deleted together with its lot')
    // Non-⑤ categories carry no retention note (the disclosure is a ⑤ ledger boundary, not decor).
    const other = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(todayStatusFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(other.retentionDisclosure).toBeNull()
  })

  it('⑥ pins the audit-timeline citation to the approval_records env (append-only truth source)', () => {
    const display = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(approverSourceFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(display.timelineSourceRef).toBe('approval_records')

    // Without the approval_records env the citation is honestly absent — it must NEVER fall back
    // to the overwritable approval_assignments env (mutation target: reading the timeline from
    // assignments turns this leg red).
    const raw = approverSourceFixture()
    raw.basis = (raw.basis as Array<Record<string, any>>).filter((env) => env.source.ref !== 'approval_records')
    const without = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(raw) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(without.timelineSourceRef).toBeNull()
  })

  it('⑥ steps: unknown kind is fail-closed copy — zero JSON.stringify output', () => {
    const display = deriveAttendanceDecisionTraceDisplay(
      parseAttendanceDecisionTraceResponse(approverSourceFixture()) as AttendanceDecisionTraceParsed,
      trZh,
    )
    expect(display.steps).toHaveLength(3)
    expect(display.steps?.[0]).toMatchObject({ sourceKindLabel: '直属上级', actorLabel: '测试主管', failClosed: false })
    expect(display.steps?.[1]).toMatchObject({ sourceKindLabel: '固定审批人（配置指定）', failClosed: false })
    expect(display.steps?.[2]).toMatchObject({ sourceKindLabel: '无法确定依据', failClosed: true })
    for (const step of display.steps ?? []) {
      expect(step.sourceKindLabel.includes('{')).toBe(false)
      expect(step.sourceKindLabel.includes('"kind"')).toBe(false)
    }
  })
})

describe('code→copy whitelist maps — unknown codes fail closed, never JSON/never guessed', () => {
  it('status labels cover the 8-value closed set; out-of-set fails closed (zh + en)', () => {
    expect(attendanceTraceStatusLabel('late', trZh)).toBe('迟到')
    expect(attendanceTraceStatusLabel('off', trZh)).toBe('休息')
    expect(attendanceTraceStatusLabel('totally_new_status', trZh)).toBe('无法确定依据')
    expect(attendanceTraceStatusLabel('totally_new_status', trEn)).toBe('Basis cannot be determined')
  })

  it('owed-punch reasons: closed set + status_* family; unknown fails closed', () => {
    expect(attendanceTraceOwedPunchReasonLabel('partial_missing_check_in', trZh)).toBe('缺上班卡')
    expect(attendanceTraceOwedPunchReasonLabel('status_normal', trZh)).toContain('正常')
    expect(attendanceTraceOwedPunchReasonLabel('status_unknown', trZh)).toBe('无法确定依据')
    expect(attendanceTraceOwedPunchReasonLabel('status_made_up_value', trZh)).toBe('无法确定依据')
    expect(attendanceTraceOwedPunchReasonLabel('some_new_reason', trZh)).toBe('无法确定依据')
  })

  it('lot / event / segment / suggested-request labels fail closed on unknown codes', () => {
    expect(attendanceTraceLotReasonLabel('annual_accrual', trZh)).toBe('年假计提')
    expect(attendanceTraceLotReasonLabel('mystery_source', trZh)).toBe('无法确定依据')
    expect(attendanceTraceEventTypeLabel('reverse', trZh)).toBe('回冲')
    expect(attendanceTraceEventTypeLabel('transfer', trZh)).toBe('无法确定依据')
    expect(attendanceTraceSegmentReasonLabel('user', trZh)).toBe('个人日历策略')
    expect(attendanceTraceSegmentReasonLabel('mystic_calendar', trZh)).toBe('无法确定依据')
    expect(attendanceTraceSuggestedRequestTypeLabel('leave', trZh)).toBe('请假')
    expect(attendanceTraceSuggestedRequestTypeLabel('bribe', trZh)).toBe('无法确定依据')
  })

  it('approver kind labels: three dynamic kinds reuse the canonical zh wording; default is the door, not JSON.stringify', () => {
    expect(attendanceTraceApproverSourceKindLabel('direct_manager', trZh)).toBe('直属上级')
    expect(attendanceTraceApproverSourceKindLabel('dept_head', trZh)).toBe('部门主管')
    expect(attendanceTraceApproverSourceKindLabel('manager_at_level', trZh)).toBe('指定层级上级')
    const unknownLabel = attendanceTraceApproverSourceKindLabel('brand_new_kind', trZh)
    expect(unknownLabel).toBe('无法确定依据')
    expect(unknownLabel.includes('{')).toBe(false)
  })

  it('door copies are stable in both legs', () => {
    expect(attendanceTraceUndeterminableCopy(trZh)).toBe('无法确定依据')
    expect(attendanceTraceCurrentLiveCopy(trZh)).toBe('当前规则（无历史版本）')
    expect(attendanceTraceMayDifferCopy(trZh)).toBe('可能不同于决策当时的规则。')
    expect(attendanceTraceNotInEffectCopy(trZh).includes('无法确定')).toBe(false)
    expect(attendanceTraceUndeterminableCopy(trEn)).toBe('Basis cannot be determined')
    expect(attendanceCompTimeRetentionDisclosure(trZh)).toContain('流水随 lot 删除而消失')
  })

  it('category labels cover the six-class closed set', () => {
    expect(ATTENDANCE_DECISION_TRACE_CATEGORIES).toHaveLength(6)
    for (const category of ATTENDANCE_DECISION_TRACE_CATEGORIES) {
      expect(attendanceTraceCategoryLabel(category, trZh).length).toBeGreaterThan(0)
      expect(attendanceTraceCategoryLabel(category, trEn).length).toBeGreaterThan(0)
    }
  })
})

// -------------------------------------------------------------------------------------------------
// R2: canonical deep links — query form, hash form banned.
// -------------------------------------------------------------------------------------------------
describe('canonical deep links (R2 — query form, zero hash)', () => {
  it('admin deep link is the exact canonical query form', () => {
    expect(buildAttendanceAdminDecisionTraceDeepLink()).toBe('/attendance?tab=admin&section=attendance-admin-decision-trace')
  })

  it('self deep link is the exact canonical query form', () => {
    expect(buildAttendanceSelfDecisionTraceDeepLink()).toBe('/attendance?section=attendance-overview-decision-trace')
  })

  it('no built link ever contains a hash (mutation: switching to #-form turns this red)', () => {
    expect(buildAttendanceAdminDecisionTraceDeepLink().includes('#')).toBe(false)
    expect(buildAttendanceSelfDecisionTraceDeepLink().includes('#')).toBe(false)
  })

  it('section id constants match the registered literals', () => {
    expect(ATTENDANCE_ADMIN_DECISION_TRACE_SECTION_ID).toBe('attendance-admin-decision-trace')
    expect(ATTENDANCE_OVERVIEW_DECISION_TRACE_SECTION_ID).toBe('attendance-overview-decision-trace')
  })
})

// -------------------------------------------------------------------------------------------------
// OD-W5-7 / #4562 channel: leave-type closed set (UI 输入自验).
// -------------------------------------------------------------------------------------------------
describe('balance leave-type closed set (OD-W5-7 UI input self-validation)', () => {
  it('accepts exactly annual and comp_time', () => {
    expect(ATTENDANCE_BALANCE_LEAVE_TYPE_CODES).toEqual(['annual', 'comp_time'])
    expect(isAttendanceBalanceLeaveTypeCode('annual')).toBe(true)
    expect(isAttendanceBalanceLeaveTypeCode('comp_time')).toBe(true)
  })

  it('rejects everything else (out-of-set input must never reach the wire)', () => {
    expect(isAttendanceBalanceLeaveTypeCode('sick')).toBe(false)
    expect(isAttendanceBalanceLeaveTypeCode('ANNUAL')).toBe(false)
    expect(isAttendanceBalanceLeaveTypeCode('')).toBe(false)
    expect(isAttendanceBalanceLeaveTypeCode(null)).toBe(false)
    expect(isAttendanceBalanceLeaveTypeCode(undefined)).toBe(false)
    expect(isAttendanceBalanceLeaveTypeCode(['annual'])).toBe(false)
  })
})

// -------------------------------------------------------------------------------------------------
// Composable: request-path construction + HTTP folding + R1/R3 contracts.
// -------------------------------------------------------------------------------------------------
describe('buildAttendanceDecisionTraceRequestPath', () => {
  const UUID = '11111111-2222-3333-4444-555555555555'

  it('builds the exact admin path (orgId + userId + category + companion)', () => {
    expect(
      buildAttendanceDecisionTraceRequestPath('admin', { category: 'today_status', workDate: '2026-07-01' }, { orgId: 'org-1', userId: 'emp-1' }),
    ).toBe('/api/attendance-admin/decision-trace?orgId=org-1&userId=emp-1&category=today_status&workDate=2026-07-01')
    expect(
      buildAttendanceDecisionTraceRequestPath('admin', { category: 'overtime_segmentation', requestId: UUID }, { orgId: 'org-1', userId: 'emp-1' }),
    ).toBe(`/api/attendance-admin/decision-trace?orgId=org-1&userId=emp-1&category=overtime_segmentation&requestId=${UUID}`)
    expect(
      buildAttendanceDecisionTraceRequestPath('admin', { category: 'comp_time_balance' }, { orgId: 'org-1', userId: 'emp-1' }),
    ).toBe('/api/attendance-admin/decision-trace?orgId=org-1&userId=emp-1&category=comp_time_balance')
  })

  it('builds the exact self path — no orgId until one is chosen, appended when chosen', () => {
    expect(buildAttendanceDecisionTraceRequestPath('self', { category: 'comp_time_balance' })).toBe(
      '/api/attendance/decision-trace?category=comp_time_balance',
    )
    expect(
      buildAttendanceDecisionTraceRequestPath('self', { category: 'late_early', workDate: '2026-07-01' }, { orgId: 'org-2' }),
    ).toBe('/api/attendance/decision-trace?category=late_early&workDate=2026-07-01&orgId=org-2')
  })

  it('self path NEVER carries a userId — for any category, even when a caller passes one (§4.1)', () => {
    for (const category of ATTENDANCE_DECISION_TRACE_CATEGORIES) {
      const path = buildAttendanceDecisionTraceRequestPath(
        'self',
        { category, workDate: '2026-07-01', requestId: UUID, instanceId: 'inst-1' },
        { orgId: 'org-1', userId: 'spoofed-user' },
      )
      expect(path).not.toBeNull()
      expect(path!.includes('userId')).toBe(false)
      expect(path!.includes('spoofed-user')).toBe(false)
    }
  })

  it('never emits a hash-form path (R2)', () => {
    for (const category of ATTENDANCE_DECISION_TRACE_CATEGORIES) {
      const path = buildAttendanceDecisionTraceRequestPath(
        'admin',
        { category, workDate: '2026-07-01', requestId: UUID, instanceId: 'inst-1' },
        { orgId: 'org-1', userId: 'emp-1' },
      )
      expect(path).not.toBeNull()
      expect(path!.includes('#')).toBe(false)
    }
  })

  it('fails closed to null on invalid targets — nothing malformed ever reaches the wire', () => {
    // admin without scope
    expect(buildAttendanceDecisionTraceRequestPath('admin', { category: 'today_status', workDate: '2026-07-01' })).toBeNull()
    expect(buildAttendanceDecisionTraceRequestPath('admin', { category: 'today_status', workDate: '2026-07-01' }, { orgId: 'org-1' })).toBeNull()
    // malformed workDate
    expect(buildAttendanceDecisionTraceRequestPath('self', { category: 'today_status', workDate: '07/01/2026' })).toBeNull()
    expect(buildAttendanceDecisionTraceRequestPath('self', { category: 'today_status' })).toBeNull()
    // ④ non-uuid requestId
    expect(buildAttendanceDecisionTraceRequestPath('self', { category: 'overtime_segmentation', requestId: 'not-a-uuid' })).toBeNull()
    // ⑥ empty instanceId
    expect(buildAttendanceDecisionTraceRequestPath('self', { category: 'approver_source', instanceId: '  ' })).toBeNull()
    // unknown category (enum-strict at the builder too)
    expect(
      buildAttendanceDecisionTraceRequestPath('self', { category: 'weird' as never, workDate: '2026-07-01' }),
    ).toBeNull()
  })
})

describe('useAttendanceDecisionTrace — HTTP folding + R1/R3 contracts', () => {
  function jsonResponse(status: number, payload: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }

  it('folds a valid 200 into loaded + the exact parsed trace (single GET, no enrichment fetch — R1/R3)', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: compTimeFixture() }))
    const composable = useAttendanceDecisionTrace({ apiFetch })
    await composable.loadTrace('self', { category: 'comp_time_balance' })
    expect(composable.state.value).toBe('loaded')
    expect(composable.errorKind.value).toBeNull()
    expect(composable.trace.value).toEqual(compTimeFixture())
    // R1 (read-only) + R3 (no reassembly): EXACTLY one call, plain GET (no RequestInit at all),
    // to the trace endpoint only. A second "enrichment" fetch here = mutation leg red.
    expect(apiFetch.mock.calls).toHaveLength(1)
    expect(apiFetch.mock.calls[0]).toHaveLength(1)
    expect(String(apiFetch.mock.calls[0][0])).toBe('/api/attendance/decision-trace?category=comp_time_balance')
  })

  it('folds 403/404/503/400 into the closed error-kind set (values-free)', async () => {
    const cases: Array<[Response, string]> = [
      [jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN' } }), 'forbidden'],
      [jsonResponse(404, { ok: false, error: { code: 'DECISION_TRACE_TARGET_NOT_FOUND' } }), 'not_found'],
      [jsonResponse(503, { ok: false, error: { code: 'DB_NOT_READY' } }), 'db_not_ready'],
      [jsonResponse(400, { ok: false, error: { code: 'ORG_ID_REQUIRED' } }), 'org_required'],
      [jsonResponse(500, { ok: false, error: { code: 'DECISION_TRACE_FAILED' } }), 'error'],
    ]
    for (const [response, expected] of cases) {
      const apiFetch = vi.fn(async () => response)
      const composable = useAttendanceDecisionTrace({ apiFetch })
      await composable.loadTrace('self', { category: 'comp_time_balance' })
      expect(composable.state.value).toBe('error')
      expect(composable.errorKind.value).toBe(expected)
      expect(composable.trace.value).toBeNull()
    }
  })

  it('malformed 200 body fails closed to error — never a partial render', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: { category: 'comp_time_balance', nonsense: true } }))
    const composable = useAttendanceDecisionTrace({ apiFetch })
    await composable.loadTrace('self', { category: 'comp_time_balance' })
    expect(composable.state.value).toBe('error')
    expect(composable.errorKind.value).toBe('error')
    expect(composable.trace.value).toBeNull()
  })

  it('category mismatch between request and response fails closed (contract violation)', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: todayStatusFixture() }))
    const composable = useAttendanceDecisionTrace({ apiFetch })
    await composable.loadTrace('self', { category: 'comp_time_balance' })
    expect(composable.state.value).toBe('error')
    expect(composable.trace.value).toBeNull()
  })

  it('invalid target: fails locally with ZERO wire traffic', async () => {
    const apiFetch = vi.fn(async () => jsonResponse(200, { ok: true, data: todayStatusFixture() }))
    const composable = useAttendanceDecisionTrace({ apiFetch })
    await composable.loadTrace('self', { category: 'today_status', workDate: 'nope' })
    expect(composable.state.value).toBe('error')
    expect(composable.errorKind.value).toBe('invalid_target')
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('network failure folds to error (fail-closed), never a fabricated result', async () => {
    const apiFetch = vi.fn(async () => {
      throw new Error('offline')
    })
    const composable = useAttendanceDecisionTrace({ apiFetch })
    await composable.loadTrace('self', { category: 'comp_time_balance' })
    expect(composable.state.value).toBe('error')
    expect(composable.errorKind.value).toBe('error')
  })
})
