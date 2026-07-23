/**
 * W5-0 (Wave 5 explainability design-lock 2026-07-22, RATIFIED §3/§4/§9): mock-level contract
 * coverage for the six evidence-chain builders in `services/AttendanceDecisionTrace.ts`.
 *
 * Real-Postgres behavioural proof (§9 W5-0-G1..G7 — the READ ONLY seam actually rejecting writes,
 * the two-user/same-org subject-constrained negative matrix, the ⑤ raw-`source_type` fixture, the
 * G6 snapshot-exclusivity mutation) lives in
 * `tests/integration/attendance-decision-trace-w5-0.db.test.ts`. This file's job is everything a
 * mock CAN prove: exact response key-set per category, the `reasonCode` discriminated-union
 * carrier rule (hard rule 5 — ①②③ scalar / ④⑤⑥ absent at response level), the ⑤ lot
 * `sourceResolution` known/unknown branches with EXACT per-branch key sets, enum-strict category
 * validation, the confidence-derivation pure formula, and the identity-posture resolver's three
 * branches.
 *
 * Mutation evidence (load-bearing; PR body cross-references these by name):
 *  - move `reasonCode` from ① response-level to a `[reasonCode]` array ⇒ scalar-vs-array test red.
 *  - add a `reasonCode` key to the ④/⑤/⑥ response level ⇒ "no top-level reasonCode" tests red.
 *  - make the ⑤ unknown-source branch carry the raw `source_type` string ⇒ no-raw-value test red.
 *  - make the ⑤ unknown-source branch carry a placeholder `reasonCode` ⇒ key-set test red.
 *  - collapse `identityPosture` 'unknown'/'inactive' into one branch ⇒ identity tests red.
 */
import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  ATTENDANCE_APPROVER_SOURCE_KINDS,
  ATTENDANCE_DECISION_TRACE_CATEGORIES,
  ATTENDANCE_DECISION_TRACE_NOT_FOUND,
  ATTENDANCE_RECORD_STATUS_VALUES,
  attendancePayrollCycleSettlementBasisEnv,
  buildApproverSourceTrace,
  buildCompTimeBalanceTrace,
  buildLateEarlyTrace,
  buildMissingPunchTrace,
  buildOvertimeSegmentationTrace,
  buildTodayStatusTrace,
  classifyAttendanceOwedPunch,
  deriveAttendanceDecisionTraceConfidence,
  isAttendanceDecisionTraceCategory,
  resolveAttendanceDecisionTraceActor,
  suggestAttendanceRequestType,
  type AttendanceDecisionTraceBasisEnv,
  type AttendanceDecisionTraceQueryFn,
} from '../../src/services/AttendanceDecisionTrace'

// ---------------------------------------------------------------------------------------------
// Mock query function: dispatches on a SQL-text substring so builders that issue several queries
// stay testable without depending on call ORDER (resilient to future query re-sequencing).
// ---------------------------------------------------------------------------------------------
type Handler = { match: RegExp; rows: QueryResultRow[] }

function makeMockQuery(handlers: Handler[], fallback: QueryResultRow[] = []): AttendanceDecisionTraceQueryFn {
  return (async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
    for (const h of handlers) {
      if (h.match.test(sql)) {
        return { rows: h.rows, rowCount: h.rows.length } as unknown as QueryResult<T>
      }
    }
    return { rows: fallback, rowCount: fallback.length } as unknown as QueryResult<T>
  }) as AttendanceDecisionTraceQueryFn
}

const NO_RULE_HANDLERS: Handler[] = [
  { match: /attendance_shift_assignments/, rows: [] },
  { match: /FROM attendance_rules WHERE org_id = \$1/, rows: [] },
  { match: /FROM attendance_rules WHERE org_id = 'default'/, rows: [] },
  { match: /attendance_record_result_edits/, rows: [] },
  { match: /FROM users WHERE id/, rows: [] },
]

describe('W5-0 category closed set', () => {
  it('has exactly the six charter-ordered categories', () => {
    expect(ATTENDANCE_DECISION_TRACE_CATEGORIES).toEqual([
      'today_status',
      'late_early',
      'missing_punch',
      'overtime_segmentation',
      'comp_time_balance',
      'approver_source',
    ])
  })

  it('isAttendanceDecisionTraceCategory rejects unknown strings and non-strings (enum-strict)', () => {
    expect(isAttendanceDecisionTraceCategory('today_status')).toBe(true)
    expect(isAttendanceDecisionTraceCategory('bogus_category')).toBe(false)
    expect(isAttendanceDecisionTraceCategory('')).toBe(false)
    expect(isAttendanceDecisionTraceCategory(undefined)).toBe(false)
    expect(isAttendanceDecisionTraceCategory(123)).toBe(false)
  })
})

describe('W5-0 confidence derivation (pure formula, §3.1)', () => {
  const frozen: AttendanceDecisionTraceBasisEnv = { source: { kind: 'record', ref: 'x' }, version: { posture: 'snapshot_frozen', asOf: '2026-01-01T00:00:00Z' } }
  const live: AttendanceDecisionTraceBasisEnv = { source: { kind: 'rule_live', ref: 'x' }, version: { posture: 'current_live_no_history' } }
  const notInEffect: AttendanceDecisionTraceBasisEnv = { source: { kind: 'policy_gate', ref: 'x' }, version: { posture: 'not_in_effect' } }
  const undeterminable: AttendanceDecisionTraceBasisEnv = { source: { kind: 'record', ref: 'x' }, version: { posture: 'undeterminable' } }

  it('all snapshot_frozen ⇒ grounded', () => {
    expect(deriveAttendanceDecisionTraceConfidence([frozen, frozen])).toBe('grounded')
  })
  it('any current_live_no_history/not_in_effect (no undeterminable) ⇒ partial', () => {
    expect(deriveAttendanceDecisionTraceConfidence([frozen, live])).toBe('partial')
    expect(deriveAttendanceDecisionTraceConfidence([frozen, notInEffect])).toBe('partial')
  })
  it('any undeterminable ⇒ undeterminable, even alongside grounded environments', () => {
    expect(deriveAttendanceDecisionTraceConfidence([frozen, undeterminable])).toBe('undeterminable')
  })
  it('empty basis ⇒ undeterminable (fail-closed, never grounded-by-vacuous-truth)', () => {
    expect(deriveAttendanceDecisionTraceConfidence([])).toBe('undeterminable')
  })
})

describe('W5-0 identity resolution (§5.1 auditRef.actor, owner P2-b)', () => {
  it('resolved: active user with a name ⇒ {displayLabel:name, identityPosture:"resolved"}', async () => {
    const q = makeMockQuery([{ match: /FROM users WHERE id/, rows: [{ id: 'u1', name: 'Alice', email: 'a@x.com', is_active: true }] }])
    const actor = await resolveAttendanceDecisionTraceActor('u1', q)
    expect(actor).toEqual({ displayLabel: 'Alice', identityPosture: 'resolved' })
  })
  it('inactive: users.is_active=false ⇒ neutral label, NEVER the raw id', async () => {
    const q = makeMockQuery([{ match: /FROM users WHERE id/, rows: [{ id: 'u2', name: 'Bob', email: 'b@x.com', is_active: false }] }])
    const actor = await resolveAttendanceDecisionTraceActor('u2', q)
    expect(actor).toEqual({ displayLabel: '已停用用户', identityPosture: 'inactive' })
    expect(JSON.stringify(actor)).not.toContain('u2')
  })
  it('unknown: no users row ⇒ neutral label, NEVER the raw id', async () => {
    const q = makeMockQuery([{ match: /FROM users WHERE id/, rows: [] }])
    const actor = await resolveAttendanceDecisionTraceActor('ghost-id', q)
    expect(actor).toEqual({ displayLabel: '未知用户', identityPosture: 'unknown' })
    expect(JSON.stringify(actor)).not.toContain('ghost-id')
  })
  it('null/blank userId ⇒ null (no actor key at all upstream)', async () => {
    const q = makeMockQuery([])
    expect(await resolveAttendanceDecisionTraceActor(null, q)).toBeNull()
    expect(await resolveAttendanceDecisionTraceActor('', q)).toBeNull()
  })
  it('resolved user with NO name ⇒ neutral label, NEVER falls back to email (§5.1 allowlist has no email row)', async () => {
    const q = makeMockQuery([{ match: /FROM users WHERE id/, rows: [{ id: 'u3', name: null, email: 'carol@example.com', is_active: true }] }])
    const actor = await resolveAttendanceDecisionTraceActor('u3', q)
    expect(actor).toEqual({ displayLabel: '已注册用户', identityPosture: 'resolved' })
    expect(JSON.stringify(actor)).not.toContain('carol@example.com')
    expect(JSON.stringify(actor)).not.toContain('@')
  })

  it('identityPosture closed set is exactly resolved|inactive|unknown (deleted deliberately excluded, owner P2-b)', async () => {
    const q1 = makeMockQuery([{ match: /FROM users WHERE id/, rows: [{ id: 'u', name: null, email: null, is_active: true }] }])
    const resolved = await resolveAttendanceDecisionTraceActor('u', q1)
    const closedSet = ['resolved', 'inactive', 'unknown']
    expect(closedSet).toContain(resolved?.identityPosture)
  })
})

describe('① today_status', () => {
  it('record absent ⇒ 200-shaped undeterminable trace, reasonCode KEY ABSENT (not null/placeholder)', async () => {
    const q = makeMockQuery([{ match: /FROM attendance_records/, rows: [] }, ...NO_RULE_HANDLERS])
    const trace = await buildTodayStatusTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.confidence).toBe('undeterminable')
    expect(trace.conclusion.status).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
    expect(trace.basis.every((b) => b.version.posture === 'undeterminable')).toBe(true)
  })

  it('record present ⇒ EXACT response key set + reasonCode is the status column value (scalar, hard rule 5①)', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_records/,
        rows: [
          {
            id: 'r1', status: 'late', is_workday: true, work_minutes: 400, late_minutes: 15, early_leave_minutes: 0,
            meta: {}, source_batch_id: null, created_at: '2026-07-01T09:00:00Z', updated_at: '2026-07-01T09:20:00Z',
          },
        ],
      },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildTodayStatusTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.category).toBe('today_status')
    expect(trace.reasonCode).toBe('late')
    expect(typeof trace.reasonCode).toBe('string') // scalar, never an array
    expect(Object.keys(trace).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence', 'reasonCode'])
    expect(Object.keys(trace.conclusion).sort()).toEqual(
      ['earlyLeaveMinutes', 'isWorkday', 'lateMinutes', 'status', 'workDate', 'workMinutes'],
    )
    expect(ATTENDANCE_RECORD_STATUS_VALUES).toContain(trace.reasonCode)
  })

  it('current-rule environment is ALWAYS current_live_no_history, never snapshot_frozen (R4/§3.1 hard rule 6)', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_records/,
        rows: [{ id: 'r1', status: 'normal', is_workday: true, work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: '2026-07-01T09:00:00Z' }],
      },
      { match: /attendance_shift_assignments/, rows: [] },
      { match: /FROM attendance_rules WHERE org_id = \$1/, rows: [{ late_grace_minutes: 10, early_grace_minutes: 10, severe_late_threshold_minutes: 30, absence_late_threshold_minutes: 60 }] },
      { match: /attendance_record_result_edits/, rows: [] },
    ])
    const trace = await buildTodayStatusTrace('org1', 'user1', '2026-07-01', q)
    const ruleEnv = trace.basis.find((b) => b.source.kind === 'rule_live')
    expect(ruleEnv?.version.posture).toBe('current_live_no_history')
    expect(ruleEnv?.version.asOf).toBeUndefined() // current_live_no_history never carries asOf
  })
})

describe('② late_early — tier legacy fail-closed (not a fabricated zero)', () => {
  it('legacy record without tier meta keys ⇒ tier environment undeterminable, conclusion tier fields null', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_records/,
        rows: [{ id: 'r1', status: 'late', is_workday: true, work_minutes: 400, late_minutes: 20, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: '2026-07-01T09:00:00Z' }],
      },
      { match: /attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildLateEarlyTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.conclusion.severeLateCount).toBeNull()
    const tierEnv = trace.basis.find((b) => b.source.ref === 'attendance_records.meta.tier')
    expect(tierEnv?.version.posture).toBe('undeterminable')
  })

  it('record with tier meta keys present ⇒ tier fields surfaced from meta, tier env snapshot_frozen', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_records/,
        rows: [{
          id: 'r1', status: 'late', is_workday: true, work_minutes: 400, late_minutes: 45, early_leave_minutes: 0,
          meta: { severe_late_count: 1, severe_late_minutes: 45, absence_late_count: 0 },
          source_batch_id: null, created_at: 'x', updated_at: '2026-07-01T09:00:00Z',
        }],
      },
      { match: /attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildLateEarlyTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.conclusion.severeLateCount).toBe(1)
    expect(trace.conclusion.severeLateMinutes).toBe(45)
    const tierEnv = trace.basis.find((b) => b.source.ref === 'attendance_records.meta.tier')
    expect(tierEnv?.version.posture).toBe('snapshot_frozen')
  })

  it('reasonCode is present at response level (scalar, hard rule 5②) and NEVER an array', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'normal', is_workday: true, work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y' }] },
      { match: /attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildLateEarlyTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.reasonCode).toBe('normal')
    expect(Array.isArray(trace.reasonCode)).toBe(false)
  })

  it('EXACT response key set (G4 — a `requester`/extra-key leak would fail this, not just toMatchObject)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'normal', is_workday: true, work_minutes: 480, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y' }] },
      { match: /attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildLateEarlyTrace('org1', 'user1', '2026-07-01', q)
    expect(Object.keys(trace).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence', 'reasonCode'])
    expect(Object.keys(trace.conclusion).sort()).toEqual(
      ['absenceLateCount', 'earlyLeaveMinutes', 'lateMinutes', 'severeLateCount', 'severeLateMinutes', 'status'],
    )
  })
})

describe('③ missing_punch — reuses classifyAttendanceOwedPunch / suggestAttendanceRequestType closed sets', () => {
  it('classifyAttendanceOwedPunch mirrors index.cjs:25932-25956 decision table exactly', () => {
    expect(classifyAttendanceOwedPunch({ status: 'absent', is_workday: true, first_in_at: null, last_out_at: null })).toEqual({
      owedPunch: true, missingSide: 'both', owedPunchReason: 'absent_workday',
    })
    expect(classifyAttendanceOwedPunch({ status: 'partial', is_workday: true, first_in_at: null, last_out_at: '2026-01-01T18:00:00Z' })).toEqual({
      owedPunch: true, missingSide: 'check_in', owedPunchReason: 'partial_missing_check_in',
    })
    expect(classifyAttendanceOwedPunch({ status: 'partial', is_workday: true, first_in_at: '2026-01-01T09:00:00Z', last_out_at: null })).toEqual({
      owedPunch: true, missingSide: 'check_out', owedPunchReason: 'partial_missing_check_out',
    })
    expect(classifyAttendanceOwedPunch({ status: 'normal', is_workday: true, first_in_at: 'x', last_out_at: 'y' })).toEqual({
      owedPunch: false, missingSide: null, owedPunchReason: 'status_normal',
    })
    expect(classifyAttendanceOwedPunch({ status: 'late', is_workday: false, first_in_at: 'x', last_out_at: 'y' })).toEqual({
      owedPunch: false, missingSide: null, owedPunchReason: 'non_workday',
    })
  })

  it('suggestAttendanceRequestType mirrors index.cjs:26427-26436 exactly', () => {
    expect(suggestAttendanceRequestType({ status: 'absent', first_in_at: null, last_out_at: null })).toBe('leave')
    expect(suggestAttendanceRequestType({ status: 'partial', first_in_at: null, last_out_at: 'y' })).toBe('missed_check_in')
    expect(suggestAttendanceRequestType({ status: 'partial', first_in_at: 'x', last_out_at: null })).toBe('missed_check_out')
    expect(suggestAttendanceRequestType({ status: 'late', first_in_at: 'x', last_out_at: 'y' })).toBe('time_correction')
    expect(suggestAttendanceRequestType({ status: 'normal', first_in_at: 'x', last_out_at: 'y' })).toBeNull()
  })

  it('no record row ⇒ undeterminable, reasonCode key absent', async () => {
    const q = makeMockQuery([{ match: /FROM attendance_records/, rows: [] }, ...NO_RULE_HANDLERS])
    const trace = await buildMissingPunchTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.confidence).toBe('undeterminable')
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
  })

  it('absent row ⇒ generation-source environment always undeterminable (no run marker exists, §1-3)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'absent', is_workday: true, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y', first_in_at: null, last_out_at: null }] },
      { match: /FROM attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildMissingPunchTrace('org1', 'user1', '2026-07-01', q)
    const genEnv = trace.basis.find((b) => b.source.ref === 'auto_absence_generation')
    expect(genEnv?.version.posture).toBe('undeterminable')
    expect(trace.reasonCode).toBe('absent_workday')
  })

  it('EXACT response key set (G4 — a `requester`/extra-key leak would fail this, not just toMatchObject)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'partial', is_workday: true, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y', first_in_at: null, last_out_at: '2026-07-01T18:00:00Z' }] },
      { match: /FROM attendance_requests/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildMissingPunchTrace('org1', 'user1', '2026-07-01', q)
    expect(Object.keys(trace).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence', 'reasonCode'])
    expect(Object.keys(trace.conclusion).sort()).toEqual(['isWorkday', 'missingSide', 'suggestedRequestType'])
  })

  it('③E4 adjustment audit event (index.cjs:30077-30097, event_type=adjustment/source=request) is cited when present', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'partial', is_workday: true, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y', first_in_at: null, last_out_at: '2026-07-01T18:00:00Z' }] },
      { match: /FROM attendance_requests/, rows: [] },
      { match: /FROM attendance_events/, rows: [{ occurred_at: '2026-07-02T00:00:00Z' }] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildMissingPunchTrace('org1', 'user1', '2026-07-01', q)
    const adjustmentEnv = trace.basis.find((b) => b.source.ref === 'attendance_events')
    expect(adjustmentEnv?.version).toEqual({ posture: 'snapshot_frozen', asOf: '2026-07-02T00:00:00Z' })
  })

  it('③E4 adjustment audit event ABSENT ⇒ no attendance_events env pushed (no fabricated env)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_records/, rows: [{ id: 'r1', status: 'partial', is_workday: true, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0, meta: {}, source_batch_id: null, created_at: 'x', updated_at: 'y', first_in_at: null, last_out_at: '2026-07-01T18:00:00Z' }] },
      { match: /FROM attendance_requests/, rows: [] },
      { match: /FROM attendance_events/, rows: [] },
      ...NO_RULE_HANDLERS,
    ])
    const trace = await buildMissingPunchTrace('org1', 'user1', '2026-07-01', q)
    expect(trace.basis.find((b) => b.source.ref === 'attendance_events')).toBeUndefined()
  })
})

describe('④ overtime_segmentation', () => {
  it('unknown requestId (or belongs to another org/user) ⇒ NOT_FOUND sentinel', async () => {
    const q = makeMockQuery([{ match: /FROM attendance_requests/, rows: [] }])
    const result = await buildOvertimeSegmentationTrace('org1', 'user1', 'req-ghost', q, false)
    expect(result).toBe(ATTENDANCE_DECISION_TRACE_NOT_FOUND)
  })

  it('valid snapshot ⇒ response-level has NO reasonCode key; segment carries its own reasonCode; coverageNote="full"', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_requests/,
        rows: [{
          id: 'req1',
          metadata: {
            minutes: 120,
            overtimeSegmentation: {
              version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-07-01', dayType: 'workday',
              calendar: { effectiveSource: 'calendar_default', holidayName: null },
              segments: { workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 }, totalMinutes: 120,
            },
            overtimeRule: { minMinutes: 30 },
            approvalFlow: { steps: [] },
          },
          resolved_at: '2026-07-02T10:00:00Z', updated_at: '2026-07-01T20:00:00Z',
        }],
      },
      { match: /FROM attendance_overtime_rules/, rows: [{ id: 'rule1' }] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
    expect(trace.coverageNote).toBe('full')
    expect(trace.conclusion.segments).toHaveLength(1)
    expect(trace.conclusion.segments[0].reasonCode).toBe('calendar_default')
    expect(trace.conclusion.segmentationVersion).toBe(1)
    // asOf anchors resolvedAt (terminal review time), NEVER created_at (§5.2①).
    const snapEnv = trace.basis.find((b) => b.source.ref === 'attendance_requests.metadata.overtimeSegmentation')
    expect(snapEnv?.version.asOf).toBe('2026-07-02T10:00:00Z')
  })

  it('legacy request (no valid snapshot) ⇒ coverageNote="partial_legacy", snapshot env undeterminable, engine-gate env present', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests/, rows: [{ id: 'req1', metadata: { minutes: 90 }, resolved_at: null, updated_at: '2026-06-01T10:00:00Z' }] },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.coverageNote).toBe('partial_legacy')
    expect(trace.conclusion.segmentationVersion).toBeNull()
    const snapEnv = trace.basis.find((b) => b.source.ref === 'attendance_requests.metadata.overtimeSegmentation')
    expect(snapEnv?.version.posture).toBe('undeterminable')
    const gateEnv = trace.basis.find((b) => b.source.ref === 'overtimeSegmentation')
    expect(gateEnv?.version.posture).toBe('not_in_effect') // engine disabled param
  })

  it('response-level key set has no reasonCode, has coverageNote (hard rule 5④)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests/, rows: [{ id: 'req1', metadata: { minutes: 90 }, resolved_at: null, updated_at: 'y' }] },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(Object.keys(trace).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence', 'coverageNote'])
  })

  it('otherwise-valid snapshot but resolved_at IS NULL (still pending) ⇒ treated as NOT valid — never fabricates asOf from updated_at (§3.2 "不得伪造时点")', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_requests/,
        rows: [{
          id: 'req1',
          metadata: {
            minutes: 120,
            overtimeSegmentation: {
              version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-07-01', dayType: 'workday',
              calendar: { effectiveSource: 'calendar_default', holidayName: null },
              segments: { workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 }, totalMinutes: 120,
            },
          },
          resolved_at: null, updated_at: '2026-07-01T20:00:00Z',
        }],
      },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.coverageNote).toBe('partial_legacy')
    const snapEnv = trace.basis.find((b) => b.source.ref === 'attendance_requests.metadata.overtimeSegmentation')
    expect(snapEnv?.version.posture).toBe('undeterminable')
    expect(snapEnv?.version.asOf).toBeUndefined() // never falls back to updated_at
  })

  it('snapshot with a malformed dayType outside the closed set ⇒ treated as NOT valid, never silently defaults to "restday" (§3.1 hard rule 3)', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_requests/,
        rows: [{
          id: 'req1',
          metadata: {
            overtimeSegmentation: {
              version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-07-01', dayType: 'bogus_day_type',
              calendar: { effectiveSource: 'calendar_default', holidayName: null },
              segments: { workdayMinutes: 0, restdayMinutes: 120, holidayMinutes: 0 }, totalMinutes: 120,
            },
          },
          resolved_at: '2026-07-02T10:00:00Z', updated_at: 'y',
        }],
      },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.coverageNote).toBe('partial_legacy')
    expect(trace.conclusion.segments).toHaveLength(0)
  })

  it('segment reasonCode is OMITTED (not a fabricated "unknown" literal) when effectiveSource is not a recognized string (§3.1 hard rule 5⑤ precedent applied to ④)', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_requests/,
        rows: [{
          id: 'req1',
          metadata: {
            overtimeSegmentation: {
              version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-07-01', dayType: 'workday',
              calendar: { effectiveSource: null, holidayName: null },
              segments: { workdayMinutes: 60, restdayMinutes: 0, holidayMinutes: 0 }, totalMinutes: 60,
            },
          },
          resolved_at: '2026-07-02T10:00:00Z', updated_at: 'y',
        }],
      },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.conclusion.segments).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(trace.conclusion.segments[0], 'reasonCode')).toBe(false)
    expect(JSON.stringify(trace)).not.toContain('unknown')
  })

  it('crossesMidnight snapshot ⇒ segments[] walks EVERY perDate entry (Σsegments.minutes === totalMinutes, no discarded date)', async () => {
    const q = makeMockQuery([
      {
        match: /FROM attendance_requests/,
        rows: [{
          id: 'req1',
          metadata: {
            overtimeSegmentation: {
              version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: '2026-07-01',
              crossesMidnight: true,
              dayType: 'workday', // primary/back-compat fields — must NOT be the only segment
              calendar: { effectiveSource: 'calendar_default', holidayName: null },
              perDate: [
                { date: '2026-07-01', dayType: 'workday', minutes: 40, calendar: { effectiveSource: 'calendar_default', holidayName: null } },
                { date: '2026-07-02', dayType: 'restday', minutes: 20, calendar: { effectiveSource: 'weekend_default', holidayName: null } },
              ],
              segments: { workdayMinutes: 40, restdayMinutes: 20, holidayMinutes: 0 }, totalMinutes: 60,
            },
          },
          resolved_at: '2026-07-03T10:00:00Z', updated_at: 'y',
        }],
      },
      { match: /FROM attendance_overtime_rules/, rows: [] },
    ])
    const trace = await buildOvertimeSegmentationTrace('org1', 'user1', 'req1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.conclusion.segments).toHaveLength(2)
    expect(trace.conclusion.segments[0]).toEqual({ dayType: 'workday', minutes: 40, reasonCode: 'calendar_default', holidayName: null })
    expect(trace.conclusion.segments[1]).toEqual({ dayType: 'restday', minutes: 20, reasonCode: 'weekend_default', holidayName: null })
    const sum = trace.conclusion.segments.reduce((acc, s) => acc + s.minutes, 0)
    expect(sum).toBe(trace.conclusion.totalMinutes)
  })
})

describe('⑤ comp_time_balance — sourceResolution known/unknown discriminated union (hard rule 5⑤)', () => {
  it('mapped source_type ⇒ {sourceResolution:"mapped", reasonCode, grantedAt, expiresAt} EXACT key set', async () => {
    const q = makeMockQuery([
      { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '480', exhausted: '0', expired: '0' }] },
      { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '480' }] },
      { match: /FROM attendance_leave_balances/, rows: [{ id: 'lot1', source_type: 'overtime_conversion', granted_at: '2026-07-01T00:00:00Z', expires_at: null, overtime_source: 'workday' }] },
      { match: /FROM attendance_leave_balance_events/, rows: [] },
    ])
    const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: true, overtimeBankPolicy: true })
    const lot = trace.conclusion.lots[0]
    expect(lot).toEqual({ sourceResolution: 'mapped', reasonCode: 'overtime_conversion', grantedAt: '2026-07-01T00:00:00Z', expiresAt: null, overtimeSource: 'workday' })
  })

  it('unmapped/unknown source_type ⇒ {sourceResolution:"unknown_source", grantedAt, expiresAt} — reasonCode key ABSENT, raw value NEVER echoed', async () => {
    const q = makeMockQuery([
      { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '480', exhausted: '0', expired: '0' }] },
      { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '480' }] },
      { match: /FROM attendance_leave_balances/, rows: [{ id: 'lot1', source_type: 'some_future_migration_source', granted_at: '2026-07-01T00:00:00Z', expires_at: null, overtime_source: null }] },
      { match: /FROM attendance_leave_balance_events/, rows: [] },
    ])
    const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: true, overtimeBankPolicy: true })
    const lot = trace.conclusion.lots[0]
    expect(lot).toEqual({ sourceResolution: 'unknown_source', grantedAt: '2026-07-01T00:00:00Z', expiresAt: null })
    expect(Object.prototype.hasOwnProperty.call(lot, 'reasonCode')).toBe(false)
    expect(JSON.stringify(lot)).not.toContain('some_future_migration_source')
  })

  it('response level has NO reasonCode key (hard rule 5⑤)', async () => {
    const q = makeMockQuery([
      { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
      { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
      { match: /FROM attendance_leave_balances/, rows: [] },
      { match: /FROM attendance_leave_balance_events/, rows: [] },
    ])
    const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: false })
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
  })

  it('engine disabled ⇒ policy-gate environment is not_in_effect (not undeterminable, §5.2②)', async () => {
    const q = makeMockQuery([
      { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
      { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
      { match: /FROM attendance_leave_balances/, rows: [] },
      { match: /FROM attendance_leave_balance_events/, rows: [] },
    ])
    const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: false })
    const gateEnv = trace.basis.find((b) => b.source.ref === 'compTimeFromOvertime')
    expect(gateEnv?.version.posture).toBe('not_in_effect')
  })

  describe('§3.1 hard rule 2 — dormant org (engine OFF, empty ledger) is `not_in_effect`, NEVER `undeterminable` (owner worked example)', () => {
    it('compTimeFromOvertime OFF + empty lots/events ⇒ E1/E2 ledger envs are not_in_effect, top-level confidence is "partial" (never "undeterminable" for a policy fact)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
        { match: /FROM attendance_leave_balances/, rows: [] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: false })
      const ledgerEnv = trace.basis.find((b) => b.source.ref === 'attendance_leave_balances')
      const eventsEnv = trace.basis.find((b) => b.source.ref === 'attendance_leave_balance_events')
      expect(ledgerEnv?.version.posture).toBe('not_in_effect')
      expect(eventsEnv?.version.posture).toBe('not_in_effect')
      expect(trace.confidence).toBe('partial')
    })

    it('compTimeFromOvertime ON + empty lots/events (pool empty / never accrued) ⇒ E1/E2 stay undeterminable (OD-W5-4: a real gap, not a policy fact)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
        { match: /FROM attendance_leave_balances/, rows: [] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: true, overtimeBankPolicy: false })
      const ledgerEnv = trace.basis.find((b) => b.source.ref === 'attendance_leave_balances')
      const eventsEnv = trace.basis.find((b) => b.source.ref === 'attendance_leave_balance_events')
      expect(ledgerEnv?.version.posture).toBe('undeterminable')
      expect(eventsEnv?.version.posture).toBe('undeterminable')
      expect(trace.confidence).toBe('undeterminable')
    })

    it('a non-empty ledger stays snapshot_frozen regardless of the CURRENT gate value (§3.1 hard rule 6 — a real lot does not un-happen when the policy is later turned off)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '480', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '480' }] },
        { match: /FROM attendance_leave_balances/, rows: [{ id: 'lot1', source_type: 'annual_manual_adjust', granted_at: '2026-07-01T00:00:00Z', expires_at: null, overtime_source: null }] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: false })
      const ledgerEnv = trace.basis.find((b) => b.source.ref === 'attendance_leave_balances')
      expect(ledgerEnv?.version.posture).toBe('snapshot_frozen')
    })
  })

  describe('§3.3⑤E4 — payroll-cycle-settlement snapshot folded into THIS builder (OD-W5-6=(a), no longer dead code)', () => {
    it('settlement rows present ⇒ E4 basis env is snapshot_frozen (the settlements query is actually issued from buildCompTimeBalanceTrace)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
        { match: /FROM attendance_leave_balances/, rows: [] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
        {
          match: /FROM attendance_payroll_cycle_settlements/,
          rows: [{ cycle_id: 'c1', period_start_date: '2026-06-01', period_end_date: '2026-06-30', closed_at: '2026-07-01T00:00:00Z', source: 'workday', convertible_minutes: 60, must_pay_minutes: 0 }],
        },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: true })
      const settlementEnv = trace.basis.find((b) => b.source.ref === 'attendance_payroll_cycle_settlements')
      expect(settlementEnv).toEqual({
        source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-01T00:00:00Z' },
      })
    })

    it('no settlement rows + overtimeBankPolicy OFF ⇒ E4 is not_in_effect (policy fact)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
        { match: /FROM attendance_leave_balances/, rows: [] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
        { match: /FROM attendance_payroll_cycle_settlements/, rows: [] },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: false })
      const settlementEnv = trace.basis.find((b) => b.source.ref === 'attendance_payroll_cycle_settlements')
      expect(settlementEnv?.version.posture).toBe('not_in_effect')
    })

    it('no settlement rows + overtimeBankPolicy ON ⇒ E4 is undeterminable (should have settled but did not)', async () => {
      const q = makeMockQuery([
        { match: /SUM\(CASE WHEN e\.event_type = 'grant'/, rows: [{ granted: '0', exhausted: '0', expired: '0' }] },
        { match: /SUM\(remaining_minutes\)/, rows: [{ remaining: '0' }] },
        { match: /FROM attendance_leave_balances/, rows: [] },
        { match: /FROM attendance_leave_balance_events/, rows: [] },
        { match: /FROM attendance_payroll_cycle_settlements/, rows: [] },
      ])
      const trace = await buildCompTimeBalanceTrace('org1', 'user1', q, { compTimeFromOvertime: false, overtimeBankPolicy: true })
      const settlementEnv = trace.basis.find((b) => b.source.ref === 'attendance_payroll_cycle_settlements')
      expect(settlementEnv?.version.posture).toBe('undeterminable')
    })
  })
})

describe('settlement seventh read face (OD-W5-6) — pure helper unit coverage', () => {
  it('rows present ⇒ snapshot_frozen anchored at closed_at (most recent)', () => {
    const env = attendancePayrollCycleSettlementBasisEnv(
      [{ cycleId: 'c1', periodStartDate: '2026-06-01', periodEndDate: '2026-06-30', closedAt: '2026-07-01T00:00:00Z', source: 'workday', convertibleMinutes: 60, mustPayMinutes: 0 }],
      true,
    )
    expect(env).toEqual({ source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-01T00:00:00Z' } })
  })
  it('no rows + bank policy disabled ⇒ not_in_effect (policy fact, not a data gap)', () => {
    const env = attendancePayrollCycleSettlementBasisEnv([], false)
    expect(env.version.posture).toBe('not_in_effect')
  })
  it('no rows + bank policy enabled ⇒ undeterminable (should have settled but did not)', () => {
    const env = attendancePayrollCycleSettlementBasisEnv([], true)
    expect(env.version.posture).toBe('undeterminable')
  })
})

describe('⑥ approver_source', () => {
  it('instanceId not linked to this (org,user) via attendance_requests reverse-link ⇒ NOT_FOUND', async () => {
    const q = makeMockQuery([{ match: /FROM attendance_requests WHERE org_id/, rows: [] }])
    const result = await buildApproverSourceTrace('org1', 'user1', 'inst-ghost', q, false)
    expect(result).toBe(ATTENDANCE_DECISION_TRACE_NOT_FOUND)
  })

  it('sourceKind closed set covers three dynamic kinds + static + legacy_fallback + unknown', () => {
    expect(ATTENDANCE_APPROVER_SOURCE_KINDS).toEqual([
      'direct_manager', 'dept_head', 'manager_at_level', 'static', 'legacy_fallback', 'unknown',
    ])
  })

  it('resolvedFrom.kind=direct_manager assignment ⇒ step.sourceKind/reasonCode = "direct_manager"; response has NO top-level reasonCode', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: '2026-07-01T00:00:00Z', requester_snapshot: {}, metadata: { approvalFlow: { steps: [] } } }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'user', assignee_id: 'mgr1', source_step: 0, metadata: { resolvedFrom: { kind: 'direct_manager' } }, updated_at: '2026-07-01T00:05:00Z' }] },
      { match: /FROM approval_records/, rows: [{ occurred_at: '2026-07-01T00:10:00Z' }] },
      { match: /FROM users WHERE id/, rows: [{ id: 'mgr1', name: 'Manager One', email: null, is_active: true }] },
    ])
    const trace = await buildApproverSourceTrace('org1', 'user1', 'inst1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(Object.prototype.hasOwnProperty.call(trace, 'reasonCode')).toBe(false)
    // EXACT key set (G4 — toMatchObject alone would pass even if a `requester`/raw `assigneeId` key
    // were added; deepEqual on the sorted key list is what actually turns red on that mutation).
    expect(Object.keys(trace.conclusion.steps[0]).sort()).toEqual(['actor', 'assigneeResolved', 'reasonCode', 'sourceKind', 'stepIndex'])
    expect(trace.conclusion.steps[0]).toMatchObject({ stepIndex: 0, assigneeResolved: true, sourceKind: 'direct_manager', reasonCode: 'direct_manager' })
    expect(trace.conclusion.steps[0].actor).toEqual({ displayLabel: 'Manager One', identityPosture: 'resolved' })
    expect(Object.keys(trace).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence'])
  })

  it('a step with NO level and NO resolved actor (role-type assignment) has the MINIMAL key set — no `level`/`actor` key at all (not null-valued)', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'role', assignee_id: 'admin', source_step: 0, metadata: { source: 'attendance', queue: 'attendance-approval' }, updated_at: 'y' }] },
      { match: /FROM approval_records/, rows: [] },
    ])
    const trace = await buildApproverSourceTrace('org1', 'user1', 'inst1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(Object.keys(trace.conclusion.steps[0]).sort()).toEqual(['assigneeResolved', 'reasonCode', 'sourceKind', 'stepIndex'])
  })

  it('is_active = true predicate on approval_assignments (§3.3⑥E1 "当前有效指派" — a deactivated/superseded assignment must never surface as a step)', async () => {
    const calls: string[] = []
    const q = (async (sql: string) => {
      calls.push(sql)
      if (/FROM attendance_requests WHERE org_id/.test(sql)) return { rows: [{ id: 'req1' }], rowCount: 1 } as never
      if (/FROM approval_instances/.test(sql)) return { rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }], rowCount: 1 } as never
      return { rows: [], rowCount: 0 } as never
    }) as AttendanceDecisionTraceQueryFn
    await buildApproverSourceTrace('org1', 'user1', 'inst1', q, false)
    const assignmentsSql = calls.find((sql) => /FROM approval_assignments/.test(sql))
    expect(assignmentsSql).toBeDefined()
    expect(assignmentsSql).toMatch(/is_active\s*=\s*true/)
  })

  it('manager_at_level assignment ⇒ step carries level', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'user', assignee_id: 'mgr2', source_step: 0, metadata: { resolvedFrom: { kind: 'manager_at_level', level: 2 } }, updated_at: 'y' }] },
      { match: /FROM approval_records/, rows: [] },
      { match: /FROM users WHERE id/, rows: [{ id: 'mgr2', name: null, email: null, is_active: true }] },
    ])
    const trace = await buildApproverSourceTrace('org1', 'user1', 'inst1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.conclusion.steps[0].level).toBe(2)
    expect(trace.conclusion.steps[0].sourceKind).toBe('manager_at_level')
  })

  it('legacy admin-queue fallback metadata ⇒ sourceKind="legacy_fallback"; static step metadata ⇒ "static"', async () => {
    const legacyQ = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'role', assignee_id: 'admin', source_step: 0, metadata: { source: 'attendance', queue: 'attendance-approval' }, updated_at: 'y' }] },
      { match: /FROM approval_records/, rows: [] },
    ])
    const legacyTrace = await buildApproverSourceTrace('org1', 'user1', 'inst1', legacyQ, false)
    if (legacyTrace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(legacyTrace.conclusion.steps[0].sourceKind).toBe('legacy_fallback')

    const staticQ = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'user', assignee_id: 'u9', source_step: 0, metadata: { source: 'attendance', stepName: '经理审批' }, updated_at: 'y' }] },
      { match: /FROM approval_records/, rows: [] },
      { match: /FROM users WHERE id/, rows: [{ id: 'u9', name: 'Static Approver', email: null, is_active: true }] },
    ])
    const staticTrace = await buildApproverSourceTrace('org1', 'user1', 'inst1', staticQ, false)
    if (staticTrace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(staticTrace.conclusion.steps[0].sourceKind).toBe('static')
  })

  it('default/JSON.stringify-style dumps NEVER appear — unrecognized metadata shape ⇒ "unknown"', async () => {
    const q = makeMockQuery([
      { match: /FROM attendance_requests WHERE org_id/, rows: [{ id: 'req1' }] },
      { match: /FROM approval_instances/, rows: [{ id: 'inst1', created_at: 'x', requester_snapshot: {}, metadata: {} }] },
      { match: /FROM approval_assignments/, rows: [{ assignment_type: 'role', assignee_id: 'weird', source_step: 0, metadata: { somethingElse: true }, updated_at: 'y' }] },
      { match: /FROM approval_records/, rows: [] },
    ])
    const trace = await buildApproverSourceTrace('org1', 'user1', 'inst1', q, false)
    if (trace === ATTENDANCE_DECISION_TRACE_NOT_FOUND) throw new Error('unexpected not-found')
    expect(trace.conclusion.steps[0].sourceKind).toBe('unknown')
    expect(JSON.stringify(trace)).not.toContain('somethingElse')
  })
})
