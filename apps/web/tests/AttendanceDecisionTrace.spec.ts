// W5-1 (Wave 5 explainability design-lock, RATIFIED §6/§9 W5-1): mounted render matrix for
// AttendanceDecisionTrace.vue — the copy doors (undeterminable / current_live_no_history + W5-8
// may-differ / not_in_effect / retention disclosure / coverage note / timeline source) asserted in
// the REAL DOM, zh + en legs, plus the R1 zero-write-CTA shape (the only buttons in the whole tree
// are the read-only reload/retry). Synthetic fixtures only (lock P2-a).
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App } from 'vue'
import AttendanceDecisionTrace from '../src/views/attendance/AttendanceDecisionTrace.vue'
import {
  parseAttendanceDecisionTraceResponse,
  type AttendanceDecisionTraceParsed,
  type TranslateFn,
} from '../src/views/attendance/attendanceDecisionTrace'
import type {
  AttendanceDecisionTraceErrorKind,
  AttendanceDecisionTraceLoadState,
} from '../src/views/attendance/useAttendanceDecisionTrace'

const trZh: TranslateFn = (_en, zh) => zh
const trEn: TranslateFn = (en, _zh) => en

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

function mountTrace(options: {
  tr?: TranslateFn
  audience?: 'admin' | 'self'
  loadState?: AttendanceDecisionTraceLoadState
  errorKind?: AttendanceDecisionTraceErrorKind | null
  trace?: AttendanceDecisionTraceParsed | null
}): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(AttendanceDecisionTrace, {
    tr: options.tr ?? trZh,
    audience: options.audience ?? 'self',
    loadState: options.loadState ?? 'loaded',
    errorKind: options.errorKind ?? null,
    trace: options.trace ?? null,
  })
  app.mount(container)
  return container
}

function parsed(raw: Record<string, unknown>): AttendanceDecisionTraceParsed {
  const result = parseAttendanceDecisionTraceResponse(raw)
  expect(result).not.toBeNull()
  return result as AttendanceDecisionTraceParsed
}

function currentLiveTodayFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'today_status',
    reasonCode: 'late',
    conclusion: { workDate: '2026-07-01', status: 'late', isWorkday: true, workMinutes: 480, lateMinutes: 12, earlyLeaveMinutes: 0 },
    basis: [
      { source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-01T10:00:00.000Z' } },
      { source: { kind: 'rule_live', ref: 'org_default_rule' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  })
}

function undeterminableTodayFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'today_status',
    conclusion: { workDate: '2026-07-01', status: null, isWorkday: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null },
    basis: [{ source: { kind: 'record', ref: 'attendance_records' }, version: { posture: 'undeterminable' } }],
    confidence: 'undeterminable',
  })
}

function notInEffectCompTimeFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'comp_time_balance',
    conclusion: {
      summary: { grantedMinutes: 0, remainingMinutes: 0, exhaustedMinutes: 0, expiredMinutes: 0 },
      lots: [],
      events: [],
    },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'not_in_effect' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'partial',
  })
}

function compTimeLotsFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'comp_time_balance',
    conclusion: {
      summary: { grantedMinutes: 300, remainingMinutes: 180, exhaustedMinutes: 120, expiredMinutes: 0 },
      lots: [
        { sourceResolution: 'mapped', reasonCode: 'overtime_conversion', grantedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', overtimeSource: 'restday' },
        { sourceResolution: 'unknown_source', grantedAt: '2026-05-01T00:00:00.000Z', expiresAt: null },
      ],
      events: [{ eventType: 'grant', deltaMinutes: 300, occurredAt: '2026-06-01T00:00:00.000Z' }],
    },
    basis: [
      { source: { kind: 'ledger', ref: 'attendance_leave_balances' }, version: { posture: 'snapshot_frozen', asOf: '2026-06-01T00:00:00.000Z' } },
      { source: { kind: 'policy_gate', ref: 'compTimeFromOvertime' }, version: { posture: 'current_live_no_history' } },
    ],
    confidence: 'partial',
  })
}

function partialLegacyOvertimeFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'overtime_segmentation',
    coverageNote: 'partial_legacy',
    conclusion: { workdayMinutes: 0, restdayMinutes: 0, holidayMinutes: 0, totalMinutes: 90, segmentationVersion: null, segments: [] },
    basis: [
      { source: { kind: 'snapshot', ref: 'attendance_requests.metadata.overtimeSegmentation' }, version: { posture: 'undeterminable' } },
      { source: { kind: 'policy_gate', ref: 'overtimeSegmentation' }, version: { posture: 'not_in_effect' } },
    ],
    confidence: 'undeterminable',
  })
}

function approverFixture(): AttendanceDecisionTraceParsed {
  return parsed({
    category: 'approver_source',
    conclusion: {
      steps: [
        { stepIndex: 0, assigneeResolved: true, sourceKind: 'direct_manager', reasonCode: 'direct_manager', actor: { displayLabel: '测试主管', identityPosture: 'resolved' } },
        { stepIndex: 1, assigneeResolved: true, sourceKind: 'unknown', reasonCode: 'unknown' },
      ],
    },
    basis: [
      { source: { kind: 'record', ref: 'approval_assignments' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:00:00.000Z' } },
      { source: { kind: 'audit', ref: 'approval_records' }, version: { posture: 'snapshot_frozen', asOf: '2026-07-03T02:30:00.000Z' } },
      {
        source: { kind: 'audit', ref: 'attendance_record_result_edits' },
        version: { posture: 'snapshot_frozen', asOf: '2026-07-03T03:00:00.000Z' },
        auditRef: { kind: 'result_edit', at: '2026-07-03T03:00:00.000Z', actor: { displayLabel: '已停用用户', identityPosture: 'inactive' } },
      },
    ],
    confidence: 'grounded',
  })
}

describe('AttendanceDecisionTrace.vue — mounted copy doors', () => {
  it('renders the whole-trace fail-closed banner + per-env door for undeterminable (zh)', () => {
    const el = mountTrace({ trace: undeterminableTodayFixture() })
    const banner = el.querySelector('[data-trace-fail-closed]')
    expect(banner?.textContent).toContain('无法确定依据')
    // 绝不生成貌似合理解释 — the banner says so verbatim.
    expect(banner?.textContent).toContain('不会生成貌似合理的解释')
    const envDoor = el.querySelector('[data-trace-undeterminable]')
    expect(envDoor?.textContent?.trim()).toBe('无法确定依据')
    // No reason line is fabricated when the record is absent.
    expect(el.querySelector('[data-trace-reason]')).toBeNull()
  })

  it('renders the fail-closed banner in the en leg too', () => {
    const el = mountTrace({ trace: undeterminableTodayFixture(), tr: trEn })
    expect(el.querySelector('[data-trace-fail-closed]')?.textContent).toContain('Basis cannot be determined')
    expect(el.querySelector('[data-trace-undeterminable]')?.textContent?.trim()).toBe('Basis cannot be determined')
  })

  it('W5-8 gate: current_live_no_history env renders the verbatim label AND the may-differ note (zh + en)', () => {
    const zhEl = mountTrace({ trace: currentLiveTodayFixture() })
    const zhEnv = zhEl.querySelector('[data-trace-basis-env][data-trace-posture="current_live_no_history"]')
    expect(zhEnv).not.toBeNull()
    expect(zhEnv?.querySelector('[data-trace-posture-label]')?.textContent?.trim()).toBe('当前规则（无历史版本）')
    expect(zhEnv?.querySelector('[data-trace-may-differ]')?.textContent?.trim()).toBe('可能不同于决策当时的规则。')
    // The frozen env must NOT carry the warning (it is a per-env door, not decoration).
    const frozenEnv = zhEl.querySelector('[data-trace-basis-env][data-trace-posture="snapshot_frozen"]')
    expect(frozenEnv?.querySelector('[data-trace-may-differ]')).toBeNull()

    if (app) app.unmount()
    app = null
    container?.remove()
    const enEl = mountTrace({ trace: currentLiveTodayFixture(), tr: trEn })
    const enEnv = enEl.querySelector('[data-trace-basis-env][data-trace-posture="current_live_no_history"]')
    expect(enEnv?.querySelector('[data-trace-posture-label]')?.textContent?.trim()).toBe('Current rule (no version history)')
    expect(enEnv?.querySelector('[data-trace-may-differ]')?.textContent?.trim()).toBe('It may differ from the rule in effect at decision time.')
  })

  it('not_in_effect env renders the policy fact without any fail-closed wording', () => {
    const el = mountTrace({ trace: notInEffectCompTimeFixture() })
    const gateEnv = el.querySelector('[data-trace-basis-env][data-trace-basis-ref="compTimeFromOvertime"]')
    expect(gateEnv).not.toBeNull()
    expect(gateEnv?.textContent).toContain('策略未启用')
    expect(gateEnv?.textContent?.includes('无法确定')).toBe(false)
    expect(gateEnv?.querySelector('[data-trace-undeterminable]')).toBeNull()
  })

  it('⑤ renders lots (unknown_source as item-level fail-closed) + the verbatim retention disclosure', () => {
    const el = mountTrace({ trace: compTimeLotsFixture() })
    const lots = el.querySelectorAll('[data-trace-lot]')
    expect(lots).toHaveLength(2)
    expect(lots[0].getAttribute('data-trace-lot-resolved')).toBe('mapped')
    expect(lots[0].textContent).toContain('加班转调休')
    expect(lots[1].getAttribute('data-trace-lot-resolved')).toBe('unknown_source')
    expect(lots[1].textContent).toContain('无法确定依据')
    const retention = el.querySelector('[data-trace-retention-disclosure]')
    expect(retention?.textContent).toContain('流水随 lot 删除而消失')
    const event = el.querySelector('[data-trace-event]')
    expect(event?.textContent).toContain('发放')
  })

  it('⑤ en leg carries the retention disclosure too', () => {
    const el = mountTrace({ trace: compTimeLotsFixture(), tr: trEn })
    expect(el.querySelector('[data-trace-retention-disclosure]')?.textContent).toContain('deleted together with its lot')
  })

  it('④ partial_legacy renders the explicit caliber note; the engine gate renders as policy fact', () => {
    const el = mountTrace({ trace: partialLegacyOvertimeFixture() })
    const note = el.querySelector('[data-trace-coverage-note]')
    expect(note?.textContent).toContain('口径差')
    expect(el.querySelector('[data-trace-basis-env][data-trace-basis-ref="overtimeSegmentation"]')?.textContent).toContain('策略未启用')
  })

  it('⑥ renders steps (unknown kind fail-closed, zero JSON) + the approval_records timeline citation + actor labels', () => {
    const el = mountTrace({ trace: approverFixture() })
    const steps = el.querySelectorAll('[data-trace-step]')
    expect(steps).toHaveLength(2)
    expect(steps[0].textContent).toContain('直属上级')
    expect(steps[0].textContent).toContain('测试主管')
    expect(steps[1].textContent).toContain('无法确定依据')
    expect(el.textContent?.includes('{"')).toBe(false)
    expect(el.textContent?.includes('JSON')).toBe(false)
    const timeline = el.querySelector('[data-trace-timeline-source]')
    expect(timeline?.getAttribute('data-trace-timeline-source-ref')).toBe('approval_records')
    // §5.1 identity postures render ONLY the server-provided neutral labels — never a raw id.
    const actorLine = el.querySelector('[data-trace-audit-actor]')
    expect(actorLine?.textContent).toContain('已停用用户')
  })

  it('R1: the ONLY buttons in the entire tree are the read-only reload/retry (zero write CTA)', () => {
    for (const trace of [currentLiveTodayFixture(), compTimeLotsFixture(), partialLegacyOvertimeFixture(), approverFixture()]) {
      const el = mountTrace({ trace })
      const buttons = Array.from(el.querySelectorAll('button'))
      expect(buttons.length).toBeGreaterThan(0)
      for (const button of buttons) {
        expect(button.hasAttribute('data-trace-reload')).toBe(true)
      }
      // No form/anchor that could carry a write action exists inside the component either.
      expect(el.querySelectorAll('form')).toHaveLength(0)
      if (app) app.unmount()
      app = null
      container?.remove()
      container = null
    }
  })

  it('error kinds render the values-free closed-set copy (not_found / forbidden / org_required)', () => {
    const cases: Array<[AttendanceDecisionTraceErrorKind, string]> = [
      ['not_found', '目标不存在'],
      ['forbidden', '无权限查看'],
      ['org_required', '需要选择组织'],
      ['db_not_ready', '服务未就绪'],
      ['invalid_target', '查询条件不完整'],
      ['error', '加载失败'],
    ]
    for (const [kind, copy] of cases) {
      const el = mountTrace({ loadState: 'error', errorKind: kind })
      const error = el.querySelector('[data-trace-error]')
      expect(error?.getAttribute('data-trace-error-kind')).toBe(kind)
      expect(error?.textContent).toContain(copy)
      if (app) app.unmount()
      app = null
      container?.remove()
      container = null
    }
  })

  it('idle / loading states render their own hints (never a stale trace)', () => {
    const idle = mountTrace({ loadState: 'idle' })
    expect(idle.querySelector('[data-trace-idle]')).not.toBeNull()
    if (app) app.unmount()
    app = null
    container?.remove()
    const loading = mountTrace({ loadState: 'loading' })
    expect(loading.querySelector('[data-trace-loading]')).not.toBeNull()
    expect(loading.querySelector('[data-trace-conclusion]')).toBeNull()
  })

  it('exposes the audience marker for both faces (admin styling/testing hook)', () => {
    const self = mountTrace({ trace: currentLiveTodayFixture(), audience: 'self' })
    expect(self.querySelector('[data-attendance-decision-trace]')?.getAttribute('data-trace-audience')).toBe('self')
    if (app) app.unmount()
    app = null
    container?.remove()
    const admin = mountTrace({ trace: currentLiveTodayFixture(), audience: 'admin' })
    expect(admin.querySelector('[data-attendance-decision-trace]')?.getAttribute('data-trace-audience')).toBe('admin')
  })
})
