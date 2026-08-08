// #4709 FSER-4 §3/§4 gate 8/9 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md`, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): mounted render matrix for the four
// presentational components -- fixtures cover all four states, both self applicability values,
// and the unavailable postures. All fixtures are SYNTHETIC.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App } from 'vue'
import AttendanceGroupFixedScheduleEffectivenessPanel from '../src/views/attendance/AttendanceGroupFixedScheduleEffectivenessPanel.vue'
import AttendanceSelfFixedScheduleCard from '../src/views/attendance/AttendanceSelfFixedScheduleCard.vue'
import AttendanceFixedScheduleDecisionTrace from '../src/views/attendance/AttendanceFixedScheduleDecisionTrace.vue'
import AttendanceGroupFixedScheduleReportWidget from '../src/views/attendance/AttendanceGroupFixedScheduleReportWidget.vue'
import {
  ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES,
  ATTENDANCE_FIXED_SCHEDULE_STATES,
  parseAttendanceGroupFixedScheduleAdminResponse,
  parseAttendanceGroupFixedScheduleSelfResponse,
  type AttendanceFixedScheduleApplicability,
  type AttendanceFixedScheduleState,
  type AttendanceGroupFixedScheduleAdminResult,
  type AttendanceGroupFixedScheduleSelfResult,
} from '../src/views/attendance/attendanceFixedScheduleEffectiveness'
import type { AttendanceFixedScheduleEffectivenessUnavailableReason } from '../src/views/attendance/useAttendanceFixedScheduleEffectiveness'

const trZh = (_en: string, zh: string): string => zh
const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'

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

function mount(component: any, props: Record<string, unknown>): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(component, props)
  app.mount(container)
  return container
}

function adminResult(state: AttendanceFixedScheduleState, overrides: Record<string, unknown> = {}): AttendanceGroupFixedScheduleAdminResult {
  const raw = {
    groupId: GROUP_ID,
    state,
    reasonCodes: state === 'effective' ? ['EFFECTIVE'] : state === 'not_configured' ? ['NO_DESIRED_CONFIG'] : ['TARGET_MEMBER_MISSING'],
    desired: state === 'not_configured' ? null : { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 },
    coverage: { targetMembers: 5, matchingMembers: state === 'effective' ? 5 : 3, missingMembers: state === 'effective' ? 0 : 2, nonMemberTargets: 0, differentKeyRows: state === 'configuration_changed' ? 1 : 0 },
    drift: {
      unconfiguredManagedRows: 0,
      unpublishedManagedRows: 0,
      managedSets: state === 'configuration_changed'
        ? [{ shiftId: 'shift-0', startDate: '2026-07-01', endDate: '2026-07-31', producerKey: 'old-key', rowCount: 4 }]
        : [],
    },
    evaluatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
  const parsed = parseAttendanceGroupFixedScheduleAdminResponse(raw)
  expect(parsed).not.toBeNull()
  return parsed as AttendanceGroupFixedScheduleAdminResult
}

function selfResult(
  state: AttendanceFixedScheduleState,
  applicability: AttendanceFixedScheduleApplicability,
  overrides: Record<string, unknown> = {},
): AttendanceGroupFixedScheduleSelfResult {
  const raw = {
    groupId: GROUP_ID,
    state,
    reasonCodes: state === 'effective' ? ['EFFECTIVE'] : state === 'not_configured' ? ['NO_DESIRED_CONFIG'] : ['TARGET_MEMBER_MISSING'],
    desired: state === 'not_configured' ? null : { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 },
    applicability,
    evaluatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
  const parsed = parseAttendanceGroupFixedScheduleSelfResponse(raw)
  expect(parsed).not.toBeNull()
  return parsed as AttendanceGroupFixedScheduleSelfResult
}

const UNAVAILABLE_REASONS: AttendanceFixedScheduleEffectivenessUnavailableReason[] = [
  'unauthorized', 'forbidden', 'not_found', 'db_not_ready', 'malformed', 'shape_mismatch', 'error',
]

// ---------------------------------------------------------------------------------------------
// Group drawer panel — gate 8: all four admin states + every unavailable posture.
// ---------------------------------------------------------------------------------------------

describe('AttendanceGroupFixedScheduleEffectivenessPanel — gate 8/9 matrix', () => {
  it.each(ATTENDANCE_FIXED_SCHEDULE_STATES)('renders state=%s with the matching data hook and no error markup', (state) => {
    const el = mount(AttendanceGroupFixedScheduleEffectivenessPanel, {
      tr: trZh, loadState: 'loaded', result: adminResult(state),
    })
    const stateEl = el.querySelector('[data-attendance-fixed-schedule-state]')
    expect(stateEl?.getAttribute('data-attendance-fixed-schedule-state-value')).toBe(state)
    expect(el.querySelector('[data-attendance-fixed-schedule-unavailable]')).toBeNull()
  })

  it('configuration_changed renders the superseded managed-set table', () => {
    const el = mount(AttendanceGroupFixedScheduleEffectivenessPanel, {
      tr: trZh, loadState: 'loaded', result: adminResult('configuration_changed'),
    })
    const rows = el.querySelectorAll('[data-attendance-fixed-schedule-managed-set]')
    expect(rows.length).toBe(1)
  })

  it.each(UNAVAILABLE_REASONS)('unavailableReason=%s never renders one of the four states', (reason) => {
    const el = mount(AttendanceGroupFixedScheduleEffectivenessPanel, {
      tr: trZh, loadState: 'error', unavailableReason: reason, result: null,
    })
    const unavailable = el.querySelector('[data-attendance-fixed-schedule-unavailable]')
    expect(unavailable?.getAttribute('data-attendance-fixed-schedule-unavailable-reason')).toBe(reason)
    expect(el.querySelector('[data-attendance-fixed-schedule-state]')).toBeNull()
    for (const state of ATTENDANCE_FIXED_SCHEDULE_STATES) {
      expect(unavailable?.getAttribute('data-attendance-fixed-schedule-unavailable-reason')).not.toBe(state)
    }
  })

  it('idle and loading render neither a state nor an unavailable posture', () => {
    for (const loadState of ['idle', 'loading'] as const) {
      const el = mount(AttendanceGroupFixedScheduleEffectivenessPanel, { tr: trZh, loadState, result: null })
      expect(el.querySelector('[data-attendance-fixed-schedule-state]')).toBeNull()
      expect(el.querySelector('[data-attendance-fixed-schedule-unavailable]')).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Employee self card — gate 8: 4 states × {matching, non_matching}.
// ---------------------------------------------------------------------------------------------

describe('AttendanceSelfFixedScheduleCard — gate 8 matrix (4 states × 2 applicability)', () => {
  const applicabilities: AttendanceFixedScheduleApplicability[] = ['matching', 'non_matching']
  for (const state of ATTENDANCE_FIXED_SCHEDULE_STATES) {
    for (const applicability of applicabilities) {
      it(`state=${state} applicability=${applicability}: renders both, never coverage/drift markup`, () => {
        const el = mount(AttendanceSelfFixedScheduleCard, {
          tr: trZh, loadState: 'loaded', result: selfResult(state, applicability),
        })
        const stateEl = el.querySelector('[data-attendance-self-fixed-schedule-state]')
        expect(stateEl?.getAttribute('data-attendance-self-fixed-schedule-state-value')).toBe(state)
        const applicabilityEl = el.querySelector('[data-attendance-self-fixed-schedule-applicability]')
        expect(applicabilityEl?.getAttribute('data-attendance-self-fixed-schedule-applicability-value')).toBe(applicability)
        // Values-free / no-second-derivation structural check: this component's markup has no
        // coverage/drift hooks at all (the self result type has no such fields to bind).
        expect(el.innerHTML).not.toContain('data-attendance-fixed-schedule-count')
        expect(el.innerHTML).not.toContain('managed-set')
      })
    }
  }

  it('the realistic not_configured/not_configured pairing also renders correctly', () => {
    const el = mount(AttendanceSelfFixedScheduleCard, {
      tr: trZh, loadState: 'loaded', result: selfResult('not_configured', 'not_configured'),
    })
    expect(el.querySelector('[data-attendance-self-fixed-schedule-applicability]')?.getAttribute('data-attendance-self-fixed-schedule-applicability-value')).toBe('not_configured')
  })

  it.each(UNAVAILABLE_REASONS)('unavailableReason=%s never renders a state or applicability', (reason) => {
    const el = mount(AttendanceSelfFixedScheduleCard, { tr: trZh, loadState: 'error', unavailableReason: reason, result: null })
    expect(el.querySelector('[data-attendance-self-fixed-schedule-unavailable]')?.getAttribute('data-attendance-self-fixed-schedule-unavailable-reason')).toBe(reason)
    expect(el.querySelector('[data-attendance-self-fixed-schedule-state]')).toBeNull()
    expect(el.querySelector('[data-attendance-self-fixed-schedule-applicability]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Shared decision trace — both audiences, all four states; producer-comparison vs applicability
// mutual exclusivity.
// ---------------------------------------------------------------------------------------------

describe('AttendanceFixedScheduleDecisionTrace — audience matrix', () => {
  it.each(ATTENDANCE_FIXED_SCHEDULE_STATES)('audience=self state=%s renders applicability, never a producer-comparison table', (state) => {
    const el = mount(AttendanceFixedScheduleDecisionTrace, {
      tr: trZh, audience: 'self', loadState: 'loaded', selfResult: selfResult(state, 'matching'),
    })
    expect(el.querySelector('[data-attendance-fixed-schedule-trace]')?.getAttribute('data-attendance-fixed-schedule-trace-audience')).toBe('self')
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-applicability]')).not.toBeNull()
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-producer-comparison]')).toBeNull()
  })

  it.each(ATTENDANCE_FIXED_SCHEDULE_STATES)('audience=admin state=%s renders producer comparison, never applicability', (state) => {
    const el = mount(AttendanceFixedScheduleDecisionTrace, {
      tr: trZh, audience: 'admin', loadState: 'loaded', adminResult: adminResult(state),
    })
    expect(el.querySelector('[data-attendance-fixed-schedule-trace]')?.getAttribute('data-attendance-fixed-schedule-trace-audience')).toBe('admin')
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-producer-comparison]')).not.toBeNull()
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-applicability]')).toBeNull()
  })

  it('admin configuration_changed renders the superseded managed set inside the comparison table', () => {
    const el = mount(AttendanceFixedScheduleDecisionTrace, {
      tr: trZh, audience: 'admin', loadState: 'loaded', adminResult: adminResult('configuration_changed'),
    })
    expect(el.querySelectorAll('[data-attendance-fixed-schedule-trace-managed-set]').length).toBe(1)
  })

  it.each(UNAVAILABLE_REASONS)('unavailableReason=%s (self audience) never renders one of the four states', (reason) => {
    const el = mount(AttendanceFixedScheduleDecisionTrace, {
      tr: trZh, audience: 'self', loadState: 'error', unavailableReason: reason, selfResult: null,
    })
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-unavailable]')?.getAttribute('data-attendance-fixed-schedule-trace-unavailable-reason')).toBe(reason)
    expect(el.querySelector('[data-attendance-fixed-schedule-trace-state]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Report widget — state + counts ONLY, never groupId/shiftId/actions in the rendered DOM.
// ---------------------------------------------------------------------------------------------

describe('AttendanceGroupFixedScheduleReportWidget — values-free, no actions', () => {
  it.each(ATTENDANCE_FIXED_SCHEDULE_STATES)('state=%s renders state + counts only, never the raw shiftId or groupId', (state) => {
    const result = adminResult(state, { groupId: '11111111-2222-4333-8444-555555555555', desired: state === 'not_configured' ? null : { shiftId: 'super-secret-shift-id-99', startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 } })
    const el = mount(AttendanceGroupFixedScheduleReportWidget, { tr: trZh, loadState: 'loaded', result })
    expect(el.querySelector('[data-attendance-fixed-schedule-report-state]')?.getAttribute('data-attendance-fixed-schedule-report-state-value')).toBe(state)
    expect(el.querySelector('[data-attendance-fixed-schedule-report-counts]')).not.toBeNull()
    // Values-free: the raw groupId and shiftId must never appear anywhere in the rendered DOM.
    expect(el.innerHTML).not.toContain('11111111-2222-4333-8444-555555555555')
    expect(el.innerHTML).not.toContain('super-secret-shift-id-99')
    // No actions: no apply/rebuild/clear/preview button anywhere in this widget.
    expect(el.querySelectorAll('button').length).toBe(1) // exactly the "Load status" query button
    expect(el.querySelector('[data-attendance-fixed-schedule-report-load]')).not.toBeNull()
  })

  it.each(UNAVAILABLE_REASONS)('unavailableReason=%s never renders a state', (reason) => {
    const el = mount(AttendanceGroupFixedScheduleReportWidget, { tr: trZh, loadState: 'error', unavailableReason: reason, result: null })
    expect(el.querySelector('[data-attendance-fixed-schedule-report-unavailable]')?.getAttribute('data-attendance-fixed-schedule-report-unavailable-reason')).toBe(reason)
    expect(el.querySelector('[data-attendance-fixed-schedule-report-state]')).toBeNull()
  })

  it('emits load with the typed group id when the load button is clicked', () => {
    let emitted: string | null = null
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      components: { AttendanceGroupFixedScheduleReportWidget },
      setup() {
        return { onLoad: (groupId: string) => { emitted = groupId }, tr: trZh }
      },
      template: '<AttendanceGroupFixedScheduleReportWidget :tr="tr" load-state="idle" @load="onLoad" />',
    })
    app.mount(container)
    const input = container.querySelector<HTMLInputElement>('[data-attendance-fixed-schedule-report-group-id]')!
    input.value = GROUP_ID
    input.dispatchEvent(new Event('input', { bubbles: true }))
    container.querySelector<HTMLButtonElement>('[data-attendance-fixed-schedule-report-load]')!.click()
    expect(emitted).toBe(GROUP_ID)
  })
})

// Every declared applicability value has at least one exercised leg above (sanity check that the
// matrix loop actually covers the closed set, not a stale subset).
describe('coverage sanity', () => {
  it('the applicability matrix loop covers matching and non_matching (not_configured covered separately)', () => {
    expect(ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES).toContain('matching')
    expect(ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES).toContain('non_matching')
    expect(ATTENDANCE_FIXED_SCHEDULE_APPLICABILITIES).toContain('not_configured')
  })
})
