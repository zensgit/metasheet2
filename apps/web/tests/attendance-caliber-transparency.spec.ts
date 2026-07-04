// Attendance caliber-transparency (display-only) — design-lock
// docs/development/attendance-caliber-transparency-display-design-lock-20260705.md (PR #3575).
//
// Three display-only attachment points, zero wire/settings/schema change, zero computation change:
//   G1 — records table header `<th>` carries a `title` tooltip sourced from the backend field-catalog
//        `description` (already present on the `/api/attendance/records` `reportFields` payload via
//        `resolveAttendanceRecordReportFields` in plugins/plugin-attendance/index.cjs). A column with
//        no description (empty string, or the built-in fallback columns) must NOT get a `title` attr.
//   G2 — AttendanceTeamAvailabilitySection's legend states the availableFormal caliber equation
//        (scheduled + pending, tentative/not-deducted; excluded = approved leave/rest/unscheduled).
//   G3 — a new "Caliber guide" reports-insight card (cloned from the Status-guide list idiom) gives a
//        one-sentence definition for each headline number; no threshold VALUES ever appear in it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import AttendanceTeamAvailabilitySection from '../src/views/attendance/AttendanceTeamAvailabilitySection.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'

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

const BASE_RECORD = {
  id: 'record-1',
  work_date: '2026-04-01',
  first_in_at: '2026-04-01T09:00:00+08:00',
  last_out_at: '2026-04-01T18:00:00+08:00',
  work_minutes: 480,
  late_minutes: 0,
  early_leave_minutes: 0,
  status: 'normal',
  meta: {},
}

const BASE_SUMMARY = {
  total_days: 1,
  total_minutes: 480,
  total_late_minutes: 0,
  total_early_leave_minutes: 0,
  normal_days: 1,
  late_days: 0,
  early_leave_days: 0,
  late_early_days: 0,
  partial_days: 0,
  absent_days: 0,
  adjusted_days: 0,
  off_days: 0,
  leave_minutes: 0,
  overtime_minutes: 0,
}

/** Installs an `/api/attendance/*` mock for reports-mode. `reportFields`, when provided, is
 * threaded onto the records response verbatim (mirrors the real backend's `reportFields` array). */
function installRecordsReportMock(reportFields?: unknown[]): void {
  vi.mocked(apiFetch).mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.includes('/api/attendance/summary?')) {
      return jsonResponse(200, { ok: true, data: BASE_SUMMARY })
    }
    if (url.includes('/api/attendance/records?')) {
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [BASE_RECORD],
          total: 1,
          ...(reportFields ? { reportFields } : {}),
        },
      })
    }
    if (url.includes('/api/attendance/requests?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/anomalies?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/reports/requests?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/holidays?')) return jsonResponse(200, { ok: true, data: { items: [] } })
    if (url.includes('/api/attendance/settings')) return jsonResponse(200, { ok: true, data: {} })
    if (url.includes('/api/attendance/rules/default')) return jsonResponse(200, { ok: true, data: {} })
    if (url.includes('/api/attendance/rule-templates')) {
      return jsonResponse(200, { ok: true, data: { system: [], library: [], versions: [] } })
    }

    return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
  })
}

function recordHeaders(container: HTMLElement): HTMLElement[] {
  const ths = Array.from(
    container.querySelectorAll<HTMLElement>('[data-report-card="records"] table.attendance__table--records thead th'),
  )
  // drop the trailing empty actions <th></th> (no v-for, no label)
  return ths.filter(th => (th.textContent ?? '').trim().length > 0)
}

function findColumnHeader(container: HTMLElement, labelText: string): HTMLElement {
  const match = recordHeaders(container).find(th => th.textContent?.trim() === labelText)
  expect(match, `expected a records header labelled "${labelText}"`).toBeTruthy()
  return match as HTMLElement
}

describe('Attendance caliber transparency — reports mode (G1 records header + G3 guide card)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T08:00:00Z'))
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    // useLocale()'s `localeState` is a module-level singleton resolved once at first import —
    // a plain localStorage write after that point does nothing on its own (only its `storage`
    // event listener or an explicit setLocale() call updates it). Drive it explicitly so each
    // test starts from a known 'en' baseline regardless of what an earlier test left behind.
    useLocale().setLocale('en')
    window.history.replaceState({}, '', '/attendance?tab=reports')
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

  describe('G1 — records header title mirrors the field-catalog description', () => {
    it('a column whose backend field carries a description gets a matching title tooltip', async () => {
      installRecordsReportMock([
        { code: 'work_date', name: '日期', sortOrder: 1000, description: '考勤记录所属工作日期。' },
        {
          code: 'expected_attendance_days',
          name: '应出勤天数',
          sortOrder: 2000,
          description: '按排班、工作日和节假日规则计算的应出勤天数。',
        },
        { code: 'attendance_result', name: '考勤结果', sortOrder: 3000, description: '' },
      ])
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const dateHeader = findColumnHeader(container!, 'Date')
      expect(dateHeader.getAttribute('title')).toBe('考勤记录所属工作日期。')

      const expectedHeader = findColumnHeader(container!, 'Expected days')
      expect(expectedHeader.getAttribute('title')).toBe('按排班、工作日和节假日规则计算的应出勤天数。')
    })

    it('a column whose backend field has an empty description gets NO title attribute (same response as the previous case)', async () => {
      installRecordsReportMock([
        { code: 'work_date', name: '日期', sortOrder: 1000, description: '考勤记录所属工作日期。' },
        { code: 'attendance_result', name: '考勤结果', sortOrder: 3000, description: '' },
      ])
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const statusHeader = findColumnHeader(container!, 'Status')
      expect(statusHeader.hasAttribute('title')).toBe(false)
    })

    it('the built-in fallback columns (no reportFields from the backend) never carry a title', async () => {
      installRecordsReportMock(undefined)
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const headers = recordHeaders(container!)
      expect(headers.length).toBeGreaterThan(0)
      for (const th of headers) {
        expect(th.hasAttribute('title')).toBe(false)
      }
    })
  })

  describe('G3 — reports-insight "Caliber guide" card', () => {
    it('renders the 7 locked one-sentence definitions with stable per-item testids and no digits anywhere (no threshold-value leakage)', async () => {
      installRecordsReportMock()
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const card = container!.querySelector('[data-attendance-caliber-guide]')
      expect(card, 'expected the caliber-guide card').toBeTruthy()
      expect(card!.textContent).toContain('Caliber guide')

      const items = Array.from(card!.querySelectorAll<HTMLElement>('[data-attendance-caliber-guide-item]'))
      const keys = items.map(item => item.getAttribute('data-attendance-caliber-guide-item'))
      expect(keys).toEqual([
        'expected_attendance_days',
        'attendance_days',
        'severe_late_count',
        'absence_late_count',
        'workday_overtime_duration',
        'restday_overtime_duration',
        'holiday_overtime_duration',
      ])

      const expectedItem = items.find(i => i.getAttribute('data-attendance-caliber-guide-item') === 'expected_attendance_days')!
      expect(expectedItem.textContent).toContain('Expected days')
      expect(expectedItem.textContent).toContain('Expected attendance days, computed from the schedule')

      const severeItem = items.find(i => i.getAttribute('data-attendance-caliber-guide-item') === 'severe_late_count')!
      expect(severeItem.textContent).toContain('Severe late count')
      expect(severeItem.textContent).toContain('severe-late threshold')

      // §4 hard boundary: this slice explains WHAT a number means, never the configured threshold
      // VALUE — so no digit should ever appear anywhere in the card's rendered text.
      expect(card!.textContent).not.toMatch(/[0-9]/)
    })

    it('zh locale renders the card header and reuses the field-catalog description verbatim', async () => {
      window.localStorage.setItem('metasheet_locale', 'zh-CN')
      useLocale().setLocale('zh-CN')
      installRecordsReportMock()
      app = createApp(AttendanceView, { mode: 'reports' })
      app.mount(container!)
      await flushUi()

      const card = container!.querySelector('[data-attendance-caliber-guide]')
      expect(card!.textContent).toContain('口径说明')

      const expectedItem = container!.querySelector('[data-attendance-caliber-guide-item="expected_attendance_days"]')
      expect(expectedItem!.textContent).toContain('按排班、工作日和节假日规则计算的应出勤天数。')
      expect(card!.textContent).not.toMatch(/[0-9]/)
    })
  })
})

describe('Attendance caliber transparency — team availability legend (G2)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  function mountSection(tr: (en: string, zh: string) => string) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceTeamAvailabilitySection, { tr })
    app.mount(container)
    return { container, app }
  }

  async function loadOnce(container: HTMLElement): Promise<void> {
    const fields: Array<[string, string]> = [
      ['#attendance-ta-group', 'grp_1'],
      ['#attendance-ta-from', '2026-09-21'],
      ['#attendance-ta-to', '2026-09-21'],
    ]
    for (const [selector, value] of fields) {
      const el = container.querySelector<HTMLInputElement>(selector)!
      el.value = value
      el.dispatchEvent(new Event('input'))
    }
    await flushUi()
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, {
      ok: true,
      data: {
        groupId: 'grp_1',
        range: { from: '2026-09-21', to: '2026-09-21' },
        members: 1,
        items: [{ date: '2026-09-21', userId: 'u1', state: 'scheduled' }],
        summary: [
          { date: '2026-09-21', scheduled: 1, rest: 0, approvedLeave: 0, pendingLeaveTentative: 0, unscheduled: 0, availableFormal: 1 },
        ],
      },
    }))
    ;(container.querySelector('.attendance__btn--primary') as HTMLButtonElement).click()
    await flushUi()
  }

  it('zh legend states the availableFormal caliber equation (scheduled + pending, excluded set named)', async () => {
    const { container, app } = mountSection((_en, zh) => zh)
    await flushUi()
    await loadOnce(container)

    const equation = container.querySelector('[data-attendance-team-availability-caliber-equation]')
    expect(equation, 'expected the caliber-equation legend line').toBeTruthy()
    expect(equation!.textContent).toContain('已排班')
    expect(equation!.textContent).toContain('待审批')
    expect(equation!.textContent).toContain('不扣减')
    expect(equation!.textContent).toContain('已批请假')
    expect(equation!.textContent).toContain('未排班')

    app.unmount()
    container.remove()
  })

  it('en legend states the availableFormal caliber equation (scheduled + pending, excluded set named)', async () => {
    const { container, app } = mountSection((en: string) => en)
    await flushUi()
    await loadOnce(container)

    const equation = container.querySelector('[data-attendance-team-availability-caliber-equation]')
    expect(equation, 'expected the caliber-equation legend line').toBeTruthy()
    expect(equation!.textContent).toContain('Scheduled')
    expect(equation!.textContent).toContain('Pending')
    expect(equation!.textContent).toContain('not deducted')
    expect(equation!.textContent).toContain('Excluded')
    expect(equation!.textContent).toContain('Approved leave')
    expect(equation!.textContent).toContain('Unscheduled')

    app.unmount()
    container.remove()
  })
})
