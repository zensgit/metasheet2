// Wave 5 收官验证 (docs/development/attendance-vnext-wave5-explainability-data-contract-lock-20260722.md
// §10 完成定义 + 章程 §9「解释完整性」L427): the 12-cell explainability metric matrix — six
// categories × {positive cell, undeterminable fail-closed cell} — mounted against the REAL
// `AttendanceDecisionTrace.vue` + the REAL `attendanceDecisionTrace.ts` pure module. Every fixture
// here is the exact wire shape the corresponding `packages/core-backend/src/services/
// AttendanceDecisionTrace.ts` builder produces (verified against that file at verification time,
// not inferred from the category alone — §1/§9 caution against class-level generalization).
//
// POSTURE CEILING (the load-bearing finding of this spec, verified against the six
// `buildXxxTrace`/`deriveAttendanceDecisionTraceConfidence` functions): `confidence==='grounded'`
// requires EVERY basis environment to be `snapshot_frozen`. Five of six builders unconditionally
// push a non-frozen ring (①②③: `currentRuleBasisEnv` always non-frozen; ④: `rule_live` always
// pushed; ⑤: `compTimeFromOvertime` policy_gate always pushed) — so ①-⑤ can NEVER legitimately
// reach `confidence==='grounded'`, only `'partial'` at best. Only ⑥ can (when every step is
// `static`/`legacy_fallback` — no dynamic kind — the dynamic-assignee `policy_gate` env is omitted
// entirely and the remaining four envs are all frozen). This spec's "positive cell" for ①-⑤ is
// therefore `confidence:'partial'` (the honest ceiling — §3.2 "posture 只能 current_live_no_history"
// / R2 "禁猜真实记录"), NOT a relabeled `'grounded'`. Fabricating a `'grounded'` badge for a class
// whose builder can never emit one would be exactly the R2 violation the design-lock warns against
// ("为截图好看而超上限"). The cross-cutting describe block at the bottom asserts this ceiling
// directly (negative: no grounded badge on ①-⑤; positive: ⑥ alone carries it).
//
// P2-a values-free evidence discipline: every assertion below is on parsed structural fields / DOM
// attribute values / whitelisted copy — never a body dump, never written to a log/snapshot file.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App } from 'vue'
import AttendanceDecisionTrace from '../src/views/attendance/AttendanceDecisionTrace.vue'
import {
  parseAttendanceDecisionTraceResponse,
  type AttendanceDecisionTraceParsed,
  type TranslateFn,
} from '../src/views/attendance/attendanceDecisionTrace'

const trZh: TranslateFn = (_en, zh) => zh

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (app) {
    app.unmount()
    app = null
  }
  container?.remove()
  container = null
})

function mount(trace: AttendanceDecisionTraceParsed, audience: 'admin' | 'self' = 'self'): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(AttendanceDecisionTrace, {
    tr: trZh,
    audience,
    loadState: 'loaded',
    errorKind: null,
    trace,
  })
  app.mount(container)
  return container
}

function mustParse(raw: Record<string, unknown>): AttendanceDecisionTraceParsed {
  const parsed = parseAttendanceDecisionTraceResponse(raw)
  expect(parsed, 'fixture must be wire-valid — a drifted fixture proves nothing about the real contract').not.toBeNull()
  return parsed as AttendanceDecisionTraceParsed
}

function conclusionRowText(root: HTMLElement, key: string): string {
  const row = root.querySelector(`[data-trace-conclusion-row="${key}"] dd`)
  expect(row, `conclusion row "${key}" must be present`).not.toBeNull()
  return row!.textContent ?? ''
}

function confidenceValue(root: HTMLElement): string | null {
  return root.querySelector('[data-trace-confidence]')?.getAttribute('data-trace-confidence-value') ?? null
}

// -----------------------------------------------------------------------------------------------
// §9 12-cell fixtures — one function per cell, named `<class><A|B>` (A = positive, B =
// undeterminable). Each basis array is a literal transcription of the corresponding
// `buildXxxTrace` function's env-push logic (see file header comment) — NOT an invented shape.
// -----------------------------------------------------------------------------------------------

// ① today_status — mirrors `buildTodayStatusTrace`.
function todayA(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'today_status',
    reasonCode: 'normal',
    conclusion: { workDate: '2026-07-01', status: 'normal', isWorkday: true, workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0 },
    basis: [
      {
        source: { kind: 'record', ref: 'attendance_records' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:02:00.000Z' },
        auditRef: { kind: 'record_write', at: '2026-07-01T10:02:00.000Z' },
      },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  })
}
function todayB(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'today_status',
    conclusion: { workDate: '2026-07-02', status: null, isWorkday: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null },
    basis: [{ source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } }],
    confidence: 'undeterminable',
  })
}

// ② late_early — mirrors `buildLateEarlyTrace`. Positive = post-migration row (hasTierKeys=true,
// real frozen counts); undeterminable = legacy row missing tier keys (record itself stays real —
// only the tier ring is a door, never a fabricated 0, §3.2 last row / mutation target below).
function lateA(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'late_early',
    reasonCode: 'late',
    conclusion: { lateMinutes: 25, earlyLeaveMinutes: 0, severeLateCount: 1, severeLateMinutes: 25, absenceLateCount: 0, status: 'late' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T09:25:00.000Z' } },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T09:25:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'shift_assignment' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  })
}
function lateB(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'late_early',
    reasonCode: 'late',
    conclusion: { lateMinutes: 25, earlyLeaveMinutes: 0, severeLateCount: null, severeLateMinutes: null, absenceLateCount: null, status: 'late' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-01T09:25:00.000Z' } },
      { source: { kind: 'record', ref: 'attendance_records.meta.tier' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'undeterminable',
  })
}

// ③ missing_punch — mirrors `buildMissingPunchTrace`. Undeterminable = `status==='absent'` leg,
// where the generation-source ring (`auto_absence_generation`) is unconditionally undeterminable
// (§1-3: materialized absence rows carry zero generation-source marker) — `missingSide` itself
// stays a real, known fact (the record row exists); only "who/when generated this" is unknown.
function missingA(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'missing_punch',
    reasonCode: 'partial_missing_check_in',
    conclusion: { missingSide: 'check_in', isWorkday: true, suggestedRequestType: 'missed_check_in' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-04T18:00:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  })
}
function missingB(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'missing_punch',
    reasonCode: 'absent_workday',
    conclusion: { missingSide: 'both', isWorkday: true, suggestedRequestType: 'leave' },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-05T23:59:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'policy_gate', ref: 'auto_absence_generation' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  })
}

// ④ overtime_segmentation — mirrors `buildOvertimeSegmentationTrace`. Positive = valid snapshot
// (`coverageNote:'full'`) with the frozen-vs-live rule pair shown side by side (§3.1 hard rule 6,
// "并列呈现、显式区分" — never a replacement). Undeterminable = invalid/legacy snapshot
// (`coverageNote:'partial_legacy'`) where the segmentation env is the ring that poisons overall
// confidence, while the `not_in_effect` policy-gate env stays its own distinct posture — the two
// must never collapse into one (§3.1 hard rule 2 / W5-0-G5).
function overtimeA(): AttendanceDecisionTraceParsed {
  return mustParse({
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
  })
}
function overtimeB(): AttendanceDecisionTraceParsed {
  return mustParse({
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
  })
}

// ⑤ comp_time_balance — mirrors `buildCompTimeBalanceTrace`. Undeterminable = engine-ON empty
// ledger (`dormantLedgerPosture` resolves to `'undeterminable'` only when
// `compTimeFromOvertime.enabled===true`, the OD-W5-4 "rejected/never-pooled leaves no row to cite"
// gap) — distinct from the dormant-org `not_in_effect` policy fact (engine OFF + empty ledger),
// which this spec deliberately does NOT relabel as undeterminable (hard rule 2).
function compTimeA(): AttendanceDecisionTraceParsed {
  return mustParse({
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
  })
}
function compTimeB(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'comp_time_balance',
    conclusion: { summary: { grantedMinutes: 0, remainingMinutes: 0, exhaustedMinutes: 0, expiredMinutes: 0 }, lots: [], events: [] },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'ledger', ref: 'attendance_leave_balance_events' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'current_live_no_history' } },
      { source: { kind: 'snapshot', ref: 'attendance_payroll_cycle_settlements' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'undeterminable',
  })
}

// ⑥ approver_source — mirrors `buildApproverSourceTrace`. THE ONLY class whose positive cell can
// legitimately show `confidence:'grounded'` — it requires zero dynamic-kind steps (the
// `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` policy_gate env is pushed
// `if (hasDynamicStep)` only) AND every remaining env frozen. Undeterminable = zero ACTIVE
// assignment rows (`steps.length>0 ? snapshot_frozen : undeterminable`) + no `approval_records`
// rows yet — `requester_snapshot` stays frozen regardless (unconditional per `instance.created_at`,
// never faked as unknown just to look "more broken").
function approverA(): AttendanceDecisionTraceParsed {
  return mustParse({
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
  })
}
function approverB(): AttendanceDecisionTraceParsed {
  return mustParse({
    category: 'approver_source',
    conclusion: { steps: [] },
    basis: [
      { source: { kind: 'record', ref: 'approval_assignments' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'audit', ref: 'approval_records' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.requester_snapshot' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-08T00:00:00.000Z' } },
      { source: { kind: 'snapshot', ref: 'approval_instances.metadata.approvalFlow' }, version: { posture: 'undeterminable' } },
    ],
    confidence: 'undeterminable',
  })
}

// -----------------------------------------------------------------------------------------------
// The 12 cells.
// -----------------------------------------------------------------------------------------------
describe('§9 explainability metric matrix — ① today_status', () => {
  it('positive cell: partial confidence, frozen record + current-live rule + may-differ declaration, reasonCode present', () => {
    const root = mount(todayA(), 'self')
    expect(confidenceValue(root)).toBe('partial')
    expect(root.querySelector('[data-trace-reason]')?.textContent).toContain('正常')
    expect(conclusionRowText(root, 'status')).toBe('正常')
    const ruleEnv = root.querySelector('[data-trace-basis-env][data-trace-posture="current_live_no_history"]')
    expect(ruleEnv, 'rule ring must render as current_live_no_history — never snapshot_frozen (posture ceiling)').not.toBeNull()
    expect(ruleEnv!.querySelector('[data-trace-may-differ]')?.textContent).toContain('可能不同于决策当时的规则')
    // ceiling: no env in this cell may be snapshot_frozen for the RULE ring specifically —
    // only the record env may be frozen (it's a materialized write-time fact, not a rule snapshot).
    expect(root.querySelectorAll('[data-trace-basis-ref="org_default_rule"][data-trace-posture="snapshot_frozen"]').length).toBe(0)
  })

  it('undeterminable cell: no record ⇒ whole-trace fail-closed banner, reasonCode key absent, zero fabricated conclusion values', () => {
    const root = mount(todayB(), 'self')
    expect(confidenceValue(root)).toBe('undeterminable')
    expect(root.querySelector('[data-trace-fail-closed]')?.textContent).toContain('无法确定依据')
    expect(root.querySelector('[data-trace-reason]')).toBeNull()
    expect(conclusionRowText(root, 'status')).toBe('无法确定依据')
    expect(conclusionRowText(root, 'workMinutes')).toBe('无法确定依据')
    expect(root.querySelector('[data-trace-basis-env][data-trace-posture="undeterminable"] [data-trace-undeterminable]')).not.toBeNull()
  })
})

describe('§9 explainability metric matrix — ② late_early', () => {
  it('positive cell: post-migration row — tier ring snapshot_frozen with real severe-late counts', () => {
    const root = mount(lateA(), 'admin')
    expect(confidenceValue(root)).toBe('partial')
    const tierEnv = root.querySelector('[data-trace-basis-ref="attendance_records.meta.tier"]')
    expect(tierEnv?.getAttribute('data-trace-posture')).toBe('snapshot_frozen')
    expect(conclusionRowText(root, 'severeLateCount')).toBe('1')
    expect(conclusionRowText(root, 'severeLateMinutes')).toContain('25')
  })

  it('undeterminable cell: legacy row without tier keys — tier ring is the door, never a fabricated 0, even though lateMinutes stays real', () => {
    const root = mount(lateB(), 'admin')
    expect(confidenceValue(root)).toBe('undeterminable')
    const tierEnv = root.querySelector('[data-trace-basis-ref="attendance_records.meta.tier"]')
    expect(tierEnv?.getAttribute('data-trace-posture')).toBe('undeterminable')
    expect(conclusionRowText(root, 'severeLateCount')).toBe('无法确定依据')
    expect(conclusionRowText(root, 'severeLateCount')).not.toBe('0')
    // the record ring itself is real (frozen) — lateMinutes is a genuine known fact, not a door.
    expect(conclusionRowText(root, 'lateMinutes')).toContain('25')
    expect(root.querySelector('[data-trace-basis-ref="attendance_records"][data-trace-posture="snapshot_frozen"]')).not.toBeNull()
  })
})

describe('§9 explainability metric matrix — ③ missing_punch', () => {
  it('positive cell: single-side missing punch, no absence generation-source ring in play', () => {
    const root = mount(missingA(), 'self')
    expect(confidenceValue(root)).toBe('partial')
    expect(conclusionRowText(root, 'missingSide')).toBe('上班卡')
    expect(root.querySelector('[data-trace-basis-ref="auto_absence_generation"]')).toBeNull()
  })

  it('undeterminable cell: absent-day generation-source ring undeterminable ("谁在何时判我旷工"), missingSide stays a real known fact', () => {
    const root = mount(missingB(), 'self')
    expect(confidenceValue(root)).toBe('undeterminable')
    const genEnv = root.querySelector('[data-trace-basis-ref="auto_absence_generation"]')
    expect(genEnv?.getAttribute('data-trace-posture')).toBe('undeterminable')
    expect(genEnv?.querySelector('[data-trace-undeterminable]')).not.toBeNull()
    expect(conclusionRowText(root, 'missingSide')).toBe('上下班卡')
  })
})

describe('§9 explainability metric matrix — ④ overtime_segmentation', () => {
  it('positive cell: full coverage — frozen segmentation snapshot + frozen rule snapshot shown ALONGSIDE the current-live rule (never a replacement)', () => {
    const root = mount(overtimeA(), 'admin')
    expect(confidenceValue(root)).toBe('partial')
    expect(root.querySelector('[data-trace-coverage-note]')).toBeNull()
    const snapEnv = root.querySelector('[data-trace-basis-ref="attendance_requests.metadata.overtimeSegmentation"]')
    expect(snapEnv?.getAttribute('data-trace-posture')).toBe('snapshot_frozen')
    const liveEnv = root.querySelector('[data-trace-basis-ref="attendance_overtime_rules"]')
    expect(liveEnv?.getAttribute('data-trace-posture')).toBe('current_live_no_history')
    expect(root.querySelector('[data-trace-segment]')?.textContent).toContain('考勤组日历策略')
  })

  it('undeterminable cell: partial_legacy coverage note — not_in_effect stays its OWN posture, never collapsed into undeterminable', () => {
    const root = mount(overtimeB(), 'admin')
    expect(confidenceValue(root)).toBe('undeterminable')
    expect(root.querySelector('[data-trace-coverage-note]')?.textContent).toContain('口径差说明')
    const gateEnv = root.querySelector('[data-trace-basis-ref="overtimeSegmentation"]')
    expect(gateEnv?.getAttribute('data-trace-posture')).toBe('not_in_effect')
    expect(gateEnv?.querySelector('[data-trace-undeterminable]'), 'not_in_effect must NEVER carry the undeterminable door copy').toBeNull()
    const snapEnv = root.querySelector('[data-trace-basis-ref="attendance_requests.metadata.overtimeSegmentation"]')
    expect(snapEnv?.getAttribute('data-trace-posture')).toBe('undeterminable')
  })
})

describe('§9 explainability metric matrix — ⑤ comp_time_balance', () => {
  it('positive cell: mapped + unknown_source lots side by side, retention disclosure present', () => {
    const root = mount(compTimeA(), 'self')
    expect(confidenceValue(root)).toBe('partial')
    expect(root.querySelector('[data-trace-lot][data-trace-lot-resolved="mapped"]')).not.toBeNull()
    expect(root.querySelector('[data-trace-lot][data-trace-lot-resolved="unknown_source"]')).not.toBeNull()
    expect(root.querySelector('[data-trace-retention-disclosure]')?.textContent).toContain('留存边界')
  })

  it('undeterminable cell: engine-on empty ledger — ledger rings undeterminable (OD-W5-4 gap), distinct from the dormant-org not_in_effect policy fact', () => {
    const root = mount(compTimeB(), 'self')
    expect(confidenceValue(root)).toBe('undeterminable')
    expect(root.querySelectorAll('[data-trace-lot]').length).toBe(0)
    expect(root.querySelector('[data-trace-lots]')?.textContent).toContain('无有效批次')
    const ledgerEnv = root.querySelector('[data-trace-basis-ref="attendance_leave_balances"]')
    expect(ledgerEnv?.getAttribute('data-trace-posture')).toBe('undeterminable')
    const gateEnv = root.querySelector('[data-trace-basis-ref="compTimeFromOvertime"]')
    expect(gateEnv?.getAttribute('data-trace-posture')).toBe('current_live_no_history')
  })
})

describe('§9 explainability metric matrix — ⑥ approver_source', () => {
  it('GROUNDED cell (the only one of the twelve): no dynamic-kind step ⇒ policy_gate env omitted ⇒ every remaining env frozen', () => {
    const root = mount(approverA(), 'admin')
    expect(confidenceValue(root)).toBe('grounded')
    expect(root.querySelector('[data-trace-basis-ref="ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED"]'), 'no dynamic step ⇒ the gate env must be entirely absent').toBeNull()
    expect(root.querySelectorAll('[data-trace-basis-env]').length).toBe(4)
    expect(root.querySelectorAll('[data-trace-basis-env][data-trace-posture="snapshot_frozen"]').length).toBe(4)
    expect(root.querySelector('[data-trace-timeline-source][data-trace-timeline-source-ref="approval_records"]')).not.toBeNull()
  })

  it('undeterminable cell: zero active assignments — steps render honestly empty, requester_snapshot stays frozen (never faked as unknown)', () => {
    const root = mount(approverB(), 'admin')
    expect(confidenceValue(root)).toBe('undeterminable')
    expect(root.querySelector('[data-trace-steps]')?.textContent).toContain('无指派步骤记录')
    const snapshotEnv = root.querySelector('[data-trace-basis-ref="approval_instances.requester_snapshot"]')
    expect(snapshotEnv?.getAttribute('data-trace-posture'), 'requester_snapshot is unconditional on instance.created_at — never fabricated as unknown').toBe('snapshot_frozen')
    const assignmentsEnv = root.querySelector('[data-trace-basis-ref="approval_assignments"]')
    expect(assignmentsEnv?.getAttribute('data-trace-posture')).toBe('undeterminable')
  })
})

// -----------------------------------------------------------------------------------------------
// Cross-cutting posture-ceiling guard (R2 / mirrors §9 W5-0-G5's not_in_effect≠undeterminable
// discipline, applied here to the grounded ceiling instead). This is the mutation-load-bearing
// negative that catches an implementer relabeling a class's positive cell to look uniformly
// "grounded" across the matrix.
// -----------------------------------------------------------------------------------------------
describe('§9 explainability metric matrix — cross-cutting posture ceiling', () => {
  it('①-⑤ positive cells never render the grounded badge — the backend builders structurally cannot emit it (unconditional non-frozen ring)', () => {
    for (const [label, trace] of [
      ['today_status', todayA()],
      ['late_early', lateA()],
      ['missing_punch', missingA()],
      ['overtime_segmentation', overtimeA()],
      ['comp_time_balance', compTimeA()],
    ] as const) {
      const root = mount(trace, 'self')
      expect(confidenceValue(root), `${label} positive cell must be 'partial', never 'grounded'`).toBe('partial')
      container?.remove()
      container = null
      app?.unmount()
      app = null
    }
  })

  it('⑥ is the only class among the twelve cells whose positive cell legitimately reaches confidence=grounded', () => {
    const root = mount(approverA(), 'admin')
    expect(confidenceValue(root)).toBe('grounded')
  })
})
