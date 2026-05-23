// Unit tests for the shared effective-calendar client (PR1 of Step 4). PR2
// will reuse this client from AttendanceView/AttendanceHolidayDataSection, so
// the contract pinned here is intentionally narrow:
//   - URL shape (path + querystring keys/values).
//   - suppressUnauthorizedRedirect defaults to true so calendar widgets do
//     not bounce the whole app to /login on cross-user 401/403.
//   - Failures throw EffectiveCalendarFetchError carrying status/code so the
//     Workbench catch can clear chips without crashing the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../src/utils/api'
import {
  EffectiveCalendarFetchError,
  effectiveCalendarItemToChip,
  fetchEffectiveCalendar,
  isCalendarEffectiveItemNoteworthy,
  type CalendarEffectiveItem,
} from '../src/services/attendance/effectiveCalendar'

const apiFetchMock = vi.mocked(apiFetch)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buildOkPayload(overrides: Partial<CalendarEffectiveItem> = {}): { ok: true; data: { mode: string; from: string; to: string; timezone: string; items: CalendarEffectiveItem[] } } {
  const base: CalendarEffectiveItem = {
    date: '2026-01-01',
    base: { isWorkingDay: false, source: 'national', name: 'New Year', holidayId: 'h_1' },
    effective: { isWorkingDay: false, source: 'national', label: 'New Year' },
    layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: 'New Year' }],
    overlays: [],
    ...overrides,
  }
  return { ok: true, data: { mode: 'userId', from: '2026-01-01', to: '2026-01-01', timezone: 'UTC', items: [base] } }
}

describe('fetchEffectiveCalendar', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('builds the userId-mode URL with from/to + suppressUnauthorizedRedirect default true', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    await fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-03', userId: 'user_42' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, options] = apiFetchMock.mock.calls[0]
    expect(path).toBe('/api/attendance/effective-calendar?from=2026-01-01&to=2026-01-03&userId=user_42')
    expect((options as any)?.suppressUnauthorizedRedirect).toBe(true)
  })

  it('builds the groupId-mode URL', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    await fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02', groupId: 'grp_prod' })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/attendance/effective-calendar?from=2026-01-01&to=2026-01-02&groupId=grp_prod')
  })

  it('builds the orgOnly-mode URL with orgOnly=true', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    await fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02', orgOnly: true })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/attendance/effective-calendar?from=2026-01-01&to=2026-01-02&orgOnly=true')
  })

  it('respects an explicit suppressUnauthorizedRedirect=false override', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    await fetchEffectiveCalendar({
      from: '2026-01-01', to: '2026-01-02', userId: 'user_1',
      suppressUnauthorizedRedirect: false,
    })
    expect((apiFetchMock.mock.calls[0]?.[1] as any)?.suppressUnauthorizedRedirect).toBe(false)
  })

  it('posts draft calendar policy overrides to the admin preview endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    await fetchEffectiveCalendar({
      from: '2026-10-01',
      to: '2026-10-07',
      orgOnly: true,
      draftOverrides: [
        {
          date: '2026-10-04',
          effective: { isWorkingDay: true, source: 'org', label: 'Draft workday' },
        },
      ],
    })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, options] = apiFetchMock.mock.calls[0]
    expect(path).toBe('/api/attendance/effective-calendar/preview')
    expect((options as any)?.method).toBe('POST')
    expect((options as any)?.suppressUnauthorizedRedirect).toBe(true)
    expect(JSON.parse(String((options as any)?.body || '{}'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-07',
      orgOnly: true,
      calendarPolicy: {
        overrides: [
          {
            date: '2026-10-04',
            effective: { isWorkingDay: true, source: 'org', label: 'Draft workday' },
          },
        ],
      },
    })
  })

  it('rejects when no mode is provided (mirrors route validation)', async () => {
    await expect(fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02' } as any)).rejects.toThrow(/exactly one of/)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('rejects when multiple modes are provided', async () => {
    await expect(fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02', userId: 'u', orgOnly: true })).rejects.toThrow(/exactly one of/)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('rejects when from/to are missing', async () => {
    await expect(fetchEffectiveCalendar({ from: '', to: '2026-01-01', userId: 'u' } as any)).rejects.toThrow(/required/)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('throws EffectiveCalendarFetchError on non-2xx so callers can clear chips without page crash', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'No access to other users.' } }))
    let thrown: unknown
    try {
      await fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02', userId: 'someone_else' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(EffectiveCalendarFetchError)
    expect((thrown as EffectiveCalendarFetchError).status).toBe(403)
    expect((thrown as EffectiveCalendarFetchError).code).toBe('FORBIDDEN')
  })

  it('throws EffectiveCalendarFetchError when payload sets ok=false even on HTTP 200', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad' } }))
    await expect(
      fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-02', userId: 'u' }),
    ).rejects.toBeInstanceOf(EffectiveCalendarFetchError)
  })

  it('returns the typed data envelope on success', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, buildOkPayload()))
    const result = await fetchEffectiveCalendar({ from: '2026-01-01', to: '2026-01-01', userId: 'u' })
    expect(result.mode).toBe('userId')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].base.source).toBe('national')
  })
})

describe('effectiveCalendarItemToChip + isCalendarEffectiveItemNoteworthy', () => {
  it('maps a national holiday to a chip preserving legacy CalendarHoliday fields plus layers/overlays', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-10-01',
      base: { isWorkingDay: false, source: 'national', name: 'National Day', holidayId: 'h_x' },
      effective: { isWorkingDay: false, source: 'national', label: 'National Day' },
      layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' }],
      overlays: [],
    }
    const chip = effectiveCalendarItemToChip(item)
    expect(chip.id).toBe('h_x')
    expect(chip.date).toBe('2026-10-01')
    expect(chip.name).toBe('National Day')
    expect(chip.isWorkingDay).toBe(false)
    expect(chip.effective?.source).toBe('national')
    expect(chip.layers?.length).toBe(1)
  })

  it('preserves base.dayIndex exposed by the backend wire contract', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-10-01',
      base: { isWorkingDay: false, source: 'national', name: '国庆节-1', holidayId: 'h_1', dayIndex: 1 },
      effective: { isWorkingDay: false, source: 'national', label: '国庆节-1' },
      layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: '国庆节-1' }],
      overlays: [],
    }
    const chip = effectiveCalendarItemToChip(item)
    expect(chip.base?.dayIndex).toBe(1)
  })

  it('prefers effective.label when both base.name and effective.label exist', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-10-05',
      base: { isWorkingDay: false, source: 'national', name: 'National Day' },
      effective: { isWorkingDay: true, source: 'org', label: 'Org swap', policyId: 'pol_1' },
      layers: [
        { kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' },
        { kind: 'calendar_policy', source: 'org', isWorkingDay: true, label: 'Org swap', refId: 'pol_1' },
      ],
      overlays: [],
    }
    const chip = effectiveCalendarItemToChip(item)
    expect(chip.name).toBe('Org swap')
    expect(chip.isWorkingDay).toBe(true)
    expect(chip.effective?.policyId).toBe('pol_1')
  })

  it('isCalendarEffectiveItemNoteworthy returns true for national/manual/policy/overlay items', () => {
    const make = (overrides: Partial<CalendarEffectiveItem> = {}): CalendarEffectiveItem => ({
      date: '2026-01-01',
      base: { isWorkingDay: false, source: 'rule' },
      effective: { isWorkingDay: false, source: 'rule' },
      layers: [],
      overlays: [],
      ...overrides,
    })
    expect(isCalendarEffectiveItemNoteworthy(make({ base: { isWorkingDay: false, source: 'national' } }))).toBe(true)
    expect(isCalendarEffectiveItemNoteworthy(make({ base: { isWorkingDay: false, source: 'manual' } }))).toBe(true)
    expect(isCalendarEffectiveItemNoteworthy(make({
      layers: [{ kind: 'calendar_policy', source: 'org', isWorkingDay: true }],
    }))).toBe(true)
    expect(isCalendarEffectiveItemNoteworthy(make({
      overlays: [{ kind: 'personal_leave', source: 'attendance_requests', refId: 'r_1' }],
    }))).toBe(true)
  })

  it('derives chip name from the first overlay when there is no effective.label and no base.name (overlay-only rule day)', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-08-15',
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: true }],
      overlays: [
        { kind: 'personal_leave', source: 'attendance_requests', requestType: 'leave', minutes: 240, status: 'approved', refId: 'req_l' },
      ],
    }
    const chip = effectiveCalendarItemToChip(item)
    // Without this fallback, MetaCalendarView's fallbackHolidayName would render
    // a generic "Working day" — hiding the overlay reason on a plain rule day.
    expect(chip.name).toBe('Leave')
    expect(chip.isWorkingDay).toBe(true)
  })

  it('prefers an explicit overlay.label over the kind-based fallback', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-08-16',
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      layers: [],
      overlays: [
        { kind: 'overtime', source: 'attendance_requests', requestType: 'overtime', minutes: 180, status: 'approved', label: '加班 (Sat)' },
      ],
    }
    const chip = effectiveCalendarItemToChip(item)
    expect(chip.name).toBe('加班 (Sat)')
  })

  it('isCalendarEffectiveItemNoteworthy returns false for plain rule/shift/rotation days with no policy and no overlay', () => {
    const item: CalendarEffectiveItem = {
      date: '2026-01-02',
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      layers: [{ kind: 'base_rule', source: 'rule', isWorkingDay: true }],
      overlays: [],
    }
    expect(isCalendarEffectiveItemNoteworthy(item)).toBe(false)
  })
})
