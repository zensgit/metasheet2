// W5-1 evidence harness entry (copied to apps/web/src/dev-harness/w51DecisionTraceHarness.ts at
// capture time by capture-decision-trace.mjs; removed afterwards). Mounts the REAL
// AttendanceDecisionTrace.vue with the REAL design tokens and the same SYNTHETIC fixtures the
// specs use (lock P2-a: no real user data in evidence). Fixtures run through the real strict
// parser so every screenshot shows an exactly-wire-shaped trace.
// Scenario/audience come from the query string:
//   ?scenario=approver-grounded|overtime-partial-legacy|comp-time|late-current-live|today-undeterminable
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

const FIXTURES: Record<string, AttendanceDecisionTraceParsed> = {
  'approver-grounded': mustParse({
    category: 'approver_source',
    conclusion: {
      steps: [
        { stepIndex: 0, assigneeResolved: true, sourceKind: 'direct_manager', reasonCode: 'direct_manager', actor: { displayLabel: '演示主管', identityPosture: 'resolved' } },
        { stepIndex: 1, assigneeResolved: true, sourceKind: 'manager_at_level', reasonCode: 'manager_at_level', level: 2, actor: { displayLabel: '演示总监', identityPosture: 'resolved' } },
        { stepIndex: 2, assigneeResolved: true, sourceKind: 'static', reasonCode: 'static', actor: { displayLabel: '已停用用户', identityPosture: 'inactive' } },
      ],
    },
    basis: [
      { source: { kind: 'record', ref: 'approval_assignments' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' } },
      { source: { kind: 'audit', ref: 'approval_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:30:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.metadata.approvalFlow' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' } },
    ],
    confidence: 'grounded',
  }),
  'overtime-partial-legacy': mustParse({
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
  'comp-time': mustParse({
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
  'late-current-live': mustParse({
    category: 'late_early',
    reasonCode: 'late',
    conclusion: { lateMinutes: 30, earlyLeaveMinutes: 0, severeLateCount: null, severeLateMinutes: null, absenceLateCount: null, status: 'late' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' } },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'undeterminable',
  }),
  'today-undeterminable': mustParse({
    category: 'today_status',
    conclusion: { workDate: '2026-07-01', status: null, isWorkday: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  }),
}

const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario') || 'today-undeterminable'
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
