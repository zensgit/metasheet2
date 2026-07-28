// Wave 5 收官验证 evidence harness entry (copied to apps/web/src/dev-harness/
// w5MetricDecisionTraceHarness.ts at capture time by capture-decision-trace-metric.mjs; removed
// afterwards — same mechanism as the W5-1 harness, docs/development/assets/w5-1-vnext-20260723/
// capture-harness/w51DecisionTraceHarness.ts). Mounts the REAL AttendanceDecisionTrace.vue with
// the REAL design tokens and the SAME SYNTHETIC fixtures as
// apps/web/tests/attendance-decision-trace-metric.spec.ts (lock P2-a: no real user data in
// evidence; fixtures kept byte-identical to the spec's by construction — both transcribe the same
// backend `buildXxxTrace` basis compositions, see that spec file's header comment for the
// posture-ceiling finding these 12 cells encode). Fixtures run through the real strict parser so
// every screenshot shows an exactly-wire-shaped trace.
//   ?scenario=today-a|today-b|late-a|late-b|missing-a|missing-b|overtime-a|overtime-b|
//             comptime-a|comptime-b|approver-a|approver-b
//   &audience=admin|self
import { createApp } from 'vue'
import '../styles/tokens.css'
import AttendanceDecisionTrace from '../views/attendance/AttendanceDecisionTrace.vue'
import {
  parseAttendanceDecisionTraceResponse,
  type AttendanceDecisionTraceParsed,
} from '../views/attendance/attendanceDecisionTrace'

const zhTr = (_en: string, zh: string) => zh

function mustParse(raw: Record<string, unknown>): AttendanceDecisionTraceParsed {
  const parsed = parseAttendanceDecisionTraceResponse(raw)
  if (!parsed) throw new Error('harness fixture failed the strict parser — fixture drifted from the wire contract')
  return parsed
}

// Transcribed verbatim from apps/web/tests/attendance-decision-trace-metric.spec.ts — see that
// file for the per-cell backend-fidelity rationale (§9 12-cell matrix, one fixture per cell).
const FIXTURES: Record<string, AttendanceDecisionTraceParsed> = {
  'today-a': mustParse({
    category: 'today_status',
    reasonCode: 'normal',
    conclusion: { workDate: '2026-07-01', status: 'normal', isWorkday: true, workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0 },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:02:00.000Z' }, auditRef: { kind: 'record_write', at: '2026-07-01T10:02:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }),
  'today-b': mustParse({
    category: 'today_status',
    conclusion: { workDate: '2026-07-02', status: null, isWorkday: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null },
    basis: [{ source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } }],
    confidence: 'undeterminable',
  }),
  'late-a': mustParse({
    category: 'late_early',
    reasonCode: 'late',
    conclusion: { lateMinutes: 25, earlyLeaveMinutes: 0, severeLateCount: 1, severeLateMinutes: 25, absenceLateCount: 0, status: 'late' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T09:25:00.000Z' } },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T09:25:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'shift_assignment' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }),
  'late-b': mustParse({
    category: 'late_early',
    reasonCode: 'late',
    conclusion: { lateMinutes: 25, earlyLeaveMinutes: 0, severeLateCount: null, severeLateMinutes: null, absenceLateCount: null, status: 'late' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-01T09:25:00.000Z' } },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'undeterminable',
  }),
  'missing-a': mustParse({
    category: 'missing_punch',
    reasonCode: 'partial_missing_check_in',
    conclusion: { missingSide: 'check_in', isWorkday: true, suggestedRequestType: 'missed_check_in' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-04T18:00:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  }),
  'missing-b': mustParse({
    category: 'missing_punch',
    reasonCode: 'absent_workday',
    conclusion: { missingSide: 'both', isWorkday: true, suggestedRequestType: 'leave' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-05T23:59:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'policy_gate', ref: 'auto_absence_generation' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  }),
  'overtime-a': mustParse({
    category: 'overtime_segmentation',
    coverageNote: 'full',
    conclusion: {
      workdayMinutes: 0,
      restdayMinutes: 150,
      holidayMinutes: 0,
      totalMinutes: 150,
      segmentationVersion: 1,
      segments: [{ dayType: 'restday', minutes: 150, reasonCode: 'group', holidayName: null }],
    },
    basis: [
      { source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-06T12:00:00.000Z', snapshotVersion: '1' } },
      { source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeRule' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-06T12:00:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'attendance_overtime_rules' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'audit', ref: 'attendance_requests.metadata.approvalFlow' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-06T12:00:00.000Z' } },
    ],
    confidence: 'partial',
  }),
  'overtime-b': mustParse({
    category: 'overtime_segmentation',
    coverageNote: 'partial_legacy',
    conclusion: { workdayMinutes: 0, restdayMinutes: 0, holidayMinutes: 0, totalMinutes: 90, segmentationVersion: null, segments: [] },
    basis: [
      { source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'rule_live', ref: 'attendance_overtime_rules' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'audit', ref: 'attendance_requests.metadata.approvalFlow' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'policy_gate', ref: 'overtimeSegmentation' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'undeterminable',
  }),
  'comptime-a': mustParse({
    category: 'comp_time_balance',
    conclusion: {
      summary: { grantedMinutes: 300, remainingMinutes: 180, exhaustedMinutes: 120, expiredMinutes: 0 },
      lots: [
        { sourceResolution: 'mapped', reasonCode: 'overtime_conversion', grantedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', overtimeSource: 'restday' },
        { sourceResolution: 'unknown_source', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: null },
      ],
      events: [
        { eventType: 'deduct', deltaMinutes: -120, occurredAt: '2026-06-20T01:00:00.000Z' },
        { eventType: 'grant', deltaMinutes: 300, occurredAt: '2026-06-01T00:00:00.000Z' },
      ],
    },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-01T00:00:00.000Z' } },
      { source: { kind: 'ledger', ref: 'attendance_leave_balance_events' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-20T01:00:00.000Z' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'partial',
  }),
  'comptime-b': mustParse({
    category: 'comp_time_balance',
    conclusion: { summary: { grantedMinutes: 0, remainingMinutes: 0, exhaustedMinutes: 0, expiredMinutes: 0 }, lots: [], events: [] },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'ledger', ref: 'attendance_leave_balance_events' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'undeterminable',
  }),
  'approver-a': mustParse({
    category: 'approver_source',
    conclusion: {
      steps: [
        { stepIndex: 0, assigneeResolved: true, sourceKind: 'static', reasonCode: 'static', actor: { displayLabel: '演示审批人', identityPosture: 'resolved' } },
        { stepIndex: 1, assigneeResolved: true, sourceKind: 'legacy_fallback', reasonCode: 'legacy_fallback', actor: { displayLabel: '已停用用户', identityPosture: 'inactive' } },
      ],
    },
    basis: [
      { source: { kind: 'record', ref: 'approval_assignments' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-07T02:00:00.000Z' } },
      { source: { kind: 'audit', ref: 'approval_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-07T02:30:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-07T02:00:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.metadata.approvalFlow' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-07T02:00:00.000Z' } },
    ],
    confidence: 'grounded',
  }),
  'approver-b': mustParse({
    category: 'approver_source',
    conclusion: { steps: [] },
    basis: [
      { source: { kind: 'record', ref: 'approval_assignments' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'audit', ref: 'approval_records' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-08T00:00:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.metadata.approvalFlow' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  }),
}

const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario') || 'today-a'
const audience = params.get('audience') === 'admin' ? 'admin' : 'self'
const trace = FIXTURES[scenario]
if (!trace) throw new Error(`unknown harness scenario: ${scenario}`)

createApp(AttendanceDecisionTrace, {
  tr: zhTr,
  audience,
  loadState: 'loaded',
  errorKind: null,
  trace,
}).mount('#app')
