// Half-day leave helper (display-only) — design-lock
// docs/development/attendance-halfday-leave-helper-design-lock-20260705.md (PR #3605).
//
// Two display-only affordances on the employee inline leave request form, zero wire/backend
// change:
//   G1 — "Full day / Morning half-day / Afternoon half-day" quick-fill buttons above the duration
//        triplet. They prefill `requestedInAt` / `requestedOutAt` / `minutes` from the employee's
//        effective shift window (`GET /api/attendance/rules/me` -> `runtimeRule`) and the selected
//        leave type's `defaultMinutesPerDay` (`GET /api/attendance/leave-types`). Half-day splits
//        at the shift window's time midpoint. One-time seed only (a click handler, not a
//        watcher) -- a manual edit after clicking is never clobbered. Hidden (not defaulted) when
//        the effective shift window is missing.
//   G2 — a live "≈ N day(s)" hint under the minutes input, converting the typed minutes against
//        the selected leave type's own `defaultMinutesPerDay` (never an org-level standard).
//
// This file has two parts: pure-function unit tests against
// ../src/views/attendance/halfDayLeaveHelper.ts (fast, exact arithmetic assertions, including the
// odd-minute midpoint/rounding cases), and component tests mounting the real inline
// AttendanceView.vue form (the only active surface per the design-lock's parity note --
// AttendanceRequestCenterSection.vue is an unmounted twin, out of scope for this slice).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import {
  buildLeaveQuickFill,
  computeLeaveMinutesDaysEquivalent,
  hasValidLeaveQuickFillShiftWindow,
} from '../src/views/attendance/halfDayLeaveHelper'

// ---------------------------------------------------------------------------------------------
// Part A -- pure-function unit tests (no Vue mounting)
// ---------------------------------------------------------------------------------------------

describe('halfDayLeaveHelper (pure)', () => {
  const evenShiftWindow = { workStartTime: '09:00', workEndTime: '18:00' }
  const leaveType = { defaultMinutesPerDay: 480 }

  describe('buildLeaveQuickFill', () => {
    it('full_day fills the whole shift window and the leave type default minutes verbatim', () => {
      expect(buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, leaveType)).toEqual({
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '2026-04-15T18:00',
        minutes: 480,
        exactMinutes: 480,
      })
    })

    it('morning_half fills start -> window midpoint and half the default minutes', () => {
      expect(buildLeaveQuickFill('morning_half', '2026-04-15', evenShiftWindow, leaveType)).toEqual({
        requestedInAt: '2026-04-15T09:00',
        requestedOutAt: '2026-04-15T13:30',
        minutes: 240,
        exactMinutes: 240,
      })
    })

    it('afternoon_half fills window midpoint -> end and half the default minutes', () => {
      expect(buildLeaveQuickFill('afternoon_half', '2026-04-15', evenShiftWindow, leaveType)).toEqual({
        requestedInAt: '2026-04-15T13:30',
        requestedOutAt: '2026-04-15T18:00',
        minutes: 240,
        exactMinutes: 240,
      })
    })

    it('rounds an odd-total-minute shift window midpoint to the nearest minute (both halves agree on the split point)', () => {
      // 09:00-18:01 spans 541 minutes; the exact midpoint is 270.5 min past 09:00 (13:30:30),
      // which is not a whole minute -- it must round to 13:31 (Math.round rounds .5 up).
      const oddWindow = { workStartTime: '09:00', workEndTime: '18:01' }
      const morning = buildLeaveQuickFill('morning_half', '2026-04-15', oddWindow, leaveType)
      const afternoon = buildLeaveQuickFill('afternoon_half', '2026-04-15', oddWindow, leaveType)
      expect(morning?.requestedInAt).toBe('2026-04-15T09:00')
      expect(morning?.requestedOutAt).toBe('2026-04-15T13:31')
      expect(afternoon?.requestedInAt).toBe('2026-04-15T13:31')
      expect(afternoon?.requestedOutAt).toBe('2026-04-15T18:01')
    })

    it('rounds an odd defaultMinutesPerDay half to the nearest minute and reports the exact pre-rounding value', () => {
      const oddLeaveType = { defaultMinutesPerDay: 481 }
      const morning = buildLeaveQuickFill('morning_half', '2026-04-15', evenShiftWindow, oddLeaveType)
      const afternoon = buildLeaveQuickFill('afternoon_half', '2026-04-15', evenShiftWindow, oddLeaveType)
      expect(morning?.minutes).toBe(241) // 481 / 2 = 240.5 -> rounds up to 241
      expect(morning?.exactMinutes).toBe(240.5)
      expect(afternoon?.minutes).toBe(241)
      expect(afternoon?.exactMinutes).toBe(240.5)
    })

    it('full_day never disagrees between minutes and exactMinutes for a whole-number default', () => {
      const result = buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, leaveType)
      expect(result?.minutes).toBe(result?.exactMinutes)
    })

    it('returns null (hidden) when the shift window is missing or partial', () => {
      expect(buildLeaveQuickFill('full_day', '2026-04-15', null, leaveType)).toBeNull()
      expect(buildLeaveQuickFill('full_day', '2026-04-15', undefined, leaveType)).toBeNull()
      expect(buildLeaveQuickFill('full_day', '2026-04-15', {}, leaveType)).toBeNull()
      expect(
        buildLeaveQuickFill('full_day', '2026-04-15', { workStartTime: '09:00', workEndTime: '' }, leaveType),
      ).toBeNull()
      expect(
        buildLeaveQuickFill('full_day', '2026-04-15', { workStartTime: '09:00', workEndTime: null }, leaveType),
      ).toBeNull()
    })

    it('returns null for a degenerate/overnight window (end <= start) rather than guessing a policy', () => {
      expect(
        buildLeaveQuickFill('full_day', '2026-04-15', { workStartTime: '22:00', workEndTime: '06:00' }, leaveType),
      ).toBeNull()
      expect(
        buildLeaveQuickFill('full_day', '2026-04-15', { workStartTime: '09:00', workEndTime: '09:00' }, leaveType),
      ).toBeNull()
    })

    it('returns null for a malformed workDate', () => {
      expect(buildLeaveQuickFill('full_day', '2026/04/15', evenShiftWindow, leaveType)).toBeNull()
      expect(buildLeaveQuickFill('full_day', '', evenShiftWindow, leaveType)).toBeNull()
    })

    it('returns null when the leave type has no usable defaultMinutesPerDay', () => {
      expect(buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, null)).toBeNull()
      expect(buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, undefined)).toBeNull()
      expect(buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, { defaultMinutesPerDay: -1 })).toBeNull()
      expect(
        buildLeaveQuickFill('full_day', '2026-04-15', evenShiftWindow, { defaultMinutesPerDay: Number.NaN }),
      ).toBeNull()
    })
  })

  describe('hasValidLeaveQuickFillShiftWindow', () => {
    it('is true for a valid forward window', () => {
      expect(hasValidLeaveQuickFillShiftWindow(evenShiftWindow)).toBe(true)
    })

    it('is false when missing, partial, or degenerate (same rule buildLeaveQuickFill uses)', () => {
      expect(hasValidLeaveQuickFillShiftWindow(null)).toBe(false)
      expect(hasValidLeaveQuickFillShiftWindow(undefined)).toBe(false)
      expect(hasValidLeaveQuickFillShiftWindow({})).toBe(false)
      expect(hasValidLeaveQuickFillShiftWindow({ workStartTime: '09:00' })).toBe(false)
      expect(hasValidLeaveQuickFillShiftWindow({ workStartTime: '18:00', workEndTime: '09:00' })).toBe(false)
    })
  })

  describe('computeLeaveMinutesDaysEquivalent (G2)', () => {
    it('rounds minutes / defaultMinutesPerDay to one decimal place', () => {
      expect(computeLeaveMinutesDaysEquivalent('600', 480)).toBe(1.3)
      expect(computeLeaveMinutesDaysEquivalent(480, 480)).toBe(1)
      expect(computeLeaveMinutesDaysEquivalent('240', 480)).toBe(0.5)
    })

    it('returns null (hint hidden) for empty or non-numeric minutes', () => {
      expect(computeLeaveMinutesDaysEquivalent('', 480)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent('   ', 480)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent('not-a-number', 480)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent(undefined, 480)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent(null, 480)).toBeNull()
    })

    it('returns null for a negative minutes value', () => {
      expect(computeLeaveMinutesDaysEquivalent('-30', 480)).toBeNull()
    })

    it('returns null when defaultMinutesPerDay is missing or non-positive', () => {
      expect(computeLeaveMinutesDaysEquivalent('240', undefined)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent('240', null)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent('240', 0)).toBeNull()
      expect(computeLeaveMinutesDaysEquivalent('240', -480)).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Part B -- component tests against the real inline form (AttendanceView.vue)
// ---------------------------------------------------------------------------------------------

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const LEAVE_TYPE_ITEMS = [
  {
    id: 'leave-annual',
    code: 'annual',
    name: 'Annual Leave',
    requiresApproval: true,
    requiresAttachment: false,
    defaultMinutesPerDay: 480,
    isActive: true,
  },
  {
    id: 'leave-odd',
    code: 'odd',
    name: 'Odd-default Leave',
    requiresApproval: false,
    requiresAttachment: false,
    defaultMinutesPerDay: 481,
    isActive: true,
  },
]

/** Installs an `/api/attendance/*` mock for employee overview mode with a valid effective shift
 * window (09:00-18:00) and the two leave types above. `runtimeRuleOverride`, when provided,
 * replaces `runtimeRule` wholesale (used by the "missing shift window" test). */
function installOverviewMock(options?: { runtimeRuleOverride?: Record<string, unknown>; leaveTypeItems?: unknown[] }): void {
  const runtimeRule = options?.runtimeRuleOverride ?? {
    name: 'Standard',
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '18:00',
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 5,
    earlyGraceMinutes: 5,
  }
  const leaveTypeItems = options?.leaveTypeItems ?? LEAVE_TYPE_ITEMS

  vi.mocked(apiFetch).mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url

    if (url.includes('/api/attendance/summary?')) return jsonResponse(200, { ok: true, data: null })
    if (url.includes('/api/attendance/records?')) return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    if (url.includes('/api/attendance/requests?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/anomalies?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/reports/requests?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/holidays?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/settings')) return jsonResponse(200, { ok: true, data: {} })
    if (url.includes('/api/attendance/rules/me')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          userId: 'user-1',
          orgId: 'default',
          resolvedForDate: '2026-04-15',
          assignment: { attendanceGroups: [], scheduleGroups: [] },
          runtimeRule,
          punchPolicy: { unscheduledMode: 'allow', outdoorApprovalRequired: false, merge: {} },
          warnings: [],
        },
      })
    }
    if (url.includes('/api/attendance/rules/default')) return jsonResponse(200, { ok: true, data: {} })
    if (url.includes('/api/attendance/rule-templates')) {
      return jsonResponse(200, { ok: true, data: { system: [], library: [], versions: [] } })
    }
    if (url.includes('/api/attendance/leave-types')) {
      return jsonResponse(200, { ok: true, data: { items: leaveTypeItems } })
    }
    if (url.includes('/api/attendance/overtime-rules')) {
      return jsonResponse(200, { ok: true, data: { items: [{ id: 'ot-default', name: 'Standard Overtime' }] } })
    }

    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
}

function setSelectValue(select: HTMLSelectElement | null, value: string): void {
  expect(select, 'expected a <select> element').toBeTruthy()
  select!.value = value
  select!.dispatchEvent(new Event('change', { bubbles: true }))
}

function setInputValue(input: HTMLInputElement | null, value: string): void {
  expect(input, 'expected an <input> element').toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Attendance half-day leave helper — inline request form (component)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T08:00:00Z'))
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    useLocale().setLocale('en')
    vi.useRealTimers()
    app = null
    container = null
  })

  async function mountAndSelectLeave(): Promise<{
    requestType: HTMLSelectElement
    leaveTypeSelect: HTMLSelectElement
    requestedIn: HTMLInputElement
    requestedOut: HTMLInputElement
    minutes: HTMLInputElement
  }> {
    app = createApp(AttendanceView, { mode: 'overview' })
    app.mount(container!)
    await flushUi()

    const requestType = container!.querySelector<HTMLSelectElement>('#attendance-request-type')!
    setSelectValue(requestType, 'leave')
    await flushUi()

    return {
      requestType,
      leaveTypeSelect: container!.querySelector<HTMLSelectElement>('#attendance-request-leave-type')!,
      requestedIn: container!.querySelector<HTMLInputElement>('#attendance-request-in')!,
      requestedOut: container!.querySelector<HTMLInputElement>('#attendance-request-out')!,
      minutes: container!.querySelector<HTMLInputElement>('#attendance-request-minutes')!,
    }
  }

  describe('G1 — quick-fill buttons', () => {
    it('renders the three buttons once a leave type is selected, pre-selecting the first active leave type', async () => {
      installOverviewMock()
      const { leaveTypeSelect } = await mountAndSelectLeave()

      // loadLeaveTypes() auto-selects the first active item when nothing is chosen yet.
      expect(leaveTypeSelect.value).toBe('leave-annual')

      const group = container!.querySelector('[data-leave-quickfill-group]')
      expect(group, 'expected the quick-fill group to render').toBeTruthy()
      expect(container!.querySelector('[data-leave-quickfill-kind="full_day"]')).toBeTruthy()
      expect(container!.querySelector('[data-leave-quickfill-kind="morning_half"]')).toBeTruthy()
      expect(container!.querySelector('[data-leave-quickfill-kind="afternoon_half"]')).toBeTruthy()
    })

    it('full_day fills the whole effective shift window and the leave type default minutes', async () => {
      installOverviewMock()
      const { requestedIn, requestedOut, minutes } = await mountAndSelectLeave()

      container!.querySelector<HTMLButtonElement>('[data-leave-quickfill-kind="full_day"]')!.click()
      await flushUi()

      expect(requestedIn.value).toBe('2026-04-15T09:00')
      expect(requestedOut.value).toBe('2026-04-15T18:00')
      expect(minutes.value).toBe('480')
    })

    it('morning_half and afternoon_half both split at the shift window midpoint with half the default minutes', async () => {
      installOverviewMock()
      const { requestedIn, requestedOut, minutes } = await mountAndSelectLeave()

      container!.querySelector<HTMLButtonElement>('[data-leave-quickfill-kind="morning_half"]')!.click()
      await flushUi()
      expect(requestedIn.value).toBe('2026-04-15T09:00')
      expect(requestedOut.value).toBe('2026-04-15T13:30')
      expect(minutes.value).toBe('240')

      container!.querySelector<HTMLButtonElement>('[data-leave-quickfill-kind="afternoon_half"]')!.click()
      await flushUi()
      expect(requestedIn.value).toBe('2026-04-15T13:30')
      expect(requestedOut.value).toBe('2026-04-15T18:00')
      expect(minutes.value).toBe('240')
    })

    it('one-time seed only: editing an input after a quick-fill click is never reverted', async () => {
      installOverviewMock()
      const { requestedIn, requestedOut, minutes } = await mountAndSelectLeave()

      container!.querySelector<HTMLButtonElement>('[data-leave-quickfill-kind="full_day"]')!.click()
      await flushUi()
      expect(requestedIn.value).toBe('2026-04-15T09:00')

      // Manual edit after the click -- must stick, not snap back.
      setInputValue(requestedIn, '2026-04-15T10:15')
      setInputValue(minutes, '500')
      await flushUi()

      expect(requestedIn.value).toBe('2026-04-15T10:15')
      expect(minutes.value).toBe('500')
      // The untouched sibling field from the same fill is also left alone.
      expect(requestedOut.value).toBe('2026-04-15T18:00')

      // A second, unrelated re-render (locale toggle) still must not snap the edited field back.
      useLocale().setLocale('zh-CN')
      await flushUi()
      expect(requestedIn.value).toBe('2026-04-15T10:15')
    })

    it('discloses the half-day rounding truthfully when defaultMinutesPerDay is odd', async () => {
      installOverviewMock()
      const { leaveTypeSelect } = await mountAndSelectLeave()

      setSelectValue(leaveTypeSelect, 'leave-odd')
      await flushUi()

      const note = container!.querySelector('[data-leave-quickfill-half-note]')
      expect(note, 'expected the half-day rounding note').toBeTruthy()
      expect(note!.textContent).toContain('241')
      expect(note!.textContent).toContain('240.5')
    })

    it('states the half-day minutes plainly (no rounding disclosure) when defaultMinutesPerDay is even', async () => {
      installOverviewMock()
      const { leaveTypeSelect } = await mountAndSelectLeave()
      expect(leaveTypeSelect.value).toBe('leave-annual')

      const note = container!.querySelector('[data-leave-quickfill-half-note]')
      expect(note!.textContent).toContain('240')
      expect(note!.textContent).not.toContain('rounded')
    })

    it('hides the buttons (does not guess a default) when the effective shift window is missing', async () => {
      installOverviewMock({ runtimeRuleOverride: { timezone: 'Asia/Shanghai' } })
      await mountAndSelectLeave()

      expect(container!.querySelector('[data-leave-quickfill-group]')).toBeNull()
    })

    it('hides the buttons when no active leave type is selected even though the shift window is valid', async () => {
      installOverviewMock({ leaveTypeItems: [] })
      await mountAndSelectLeave()

      expect(container!.querySelector('[data-leave-quickfill-group]')).toBeNull()
    })

    it('review P3: clearing the (clearable) work date hides the buttons + rounding note, not dead no-op buttons', async () => {
      installOverviewMock()
      await mountAndSelectLeave()
      // buttons present with a valid work date + leave type + shift window
      expect(container!.querySelector('[data-leave-quickfill-group]')).not.toBeNull()

      const workDate = container!.querySelector<HTMLInputElement>('#attendance-request-work-date')!
      workDate.value = ''
      workDate.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()

      // cleared date -> buttons AND the half-day note both hidden (consistent), never visible-but-no-op
      expect(container!.querySelector('[data-leave-quickfill-group]')).toBeNull()
      expect(container!.querySelector('[data-leave-quickfill-half-note]')).toBeNull()
    })
  })

  describe('G2 — minutes-to-days conversion hint', () => {
    it('shows "≈ N day(s)" against the selected leave type standard day, rounded to one decimal', async () => {
      installOverviewMock()
      const { minutes } = await mountAndSelectLeave()

      setInputValue(minutes, '600')
      await flushUi()

      const hint = container!.querySelector('[data-leave-minutes-days-hint]')
      expect(hint, 'expected the days-equivalent hint').toBeTruthy()
      expect(hint!.textContent).toContain('1.3')
      expect(hint!.textContent).toContain('480')
    })

    it('hides when minutes is empty', async () => {
      installOverviewMock()
      const { minutes } = await mountAndSelectLeave()

      setInputValue(minutes, '600')
      await flushUi()
      expect(container!.querySelector('[data-leave-minutes-days-hint]')).toBeTruthy()

      setInputValue(minutes, '')
      await flushUi()
      expect(container!.querySelector('[data-leave-minutes-days-hint]')).toBeNull()
    })

    it('is scoped to leave requests only -- overtime requests never show the leave-standard hint', async () => {
      installOverviewMock()
      const { requestType, minutes } = await mountAndSelectLeave()

      setSelectValue(requestType, 'overtime')
      await flushUi()
      setInputValue(container!.querySelector<HTMLInputElement>('#attendance-request-minutes'), '600')
      await flushUi()

      expect(container!.querySelector('[data-leave-minutes-days-hint]')).toBeNull()
      expect(container!.querySelector('[data-leave-quickfill-group]')).toBeNull()
      // sanity: the shared minutes input itself is still there for overtime
      expect(minutes).toBeTruthy()
    })
  })
})
