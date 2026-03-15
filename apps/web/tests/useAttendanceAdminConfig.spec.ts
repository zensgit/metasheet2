import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAttendanceAdminConfig } from '../src/views/attendance/useAttendanceAdminConfig'

const tr = (en: string, _zh: string) => en

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function createOptions(overrides: Partial<Parameters<typeof useAttendanceAdminConfig>[0]> = {}) {
  const adminForbidden = ref(false)
  const setStatus = vi.fn()
  const setStatusFromError = vi.fn()
  const buildQuery = (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value) query.set(key, value)
    })
    return query
  }

  return {
    adminForbidden,
    apiFetchWithTimeout: vi.fn(),
    buildQuery,
    createApiError: (_response: { status: number }, payload: any, fallbackMessage: string) => new Error(payload?.error?.message || fallbackMessage),
    createForbiddenError: (message = 'Admin permissions required') => new Error(message),
    defaultTimezone: 'Asia/Shanghai',
    getOrgId: () => 'org-1',
    setStatus,
    setStatusFromError,
    tr,
    ...overrides,
  }
}

describe('useAttendanceAdminConfig', () => {
  it('loads settings into the reactive form', async () => {
    const options = createOptions({
      apiFetchWithTimeout: vi.fn(async () => jsonResponse(200, {
        ok: true,
        data: {
          autoAbsence: { enabled: true, runAt: '01:30', lookbackDays: 2 },
          holidayPolicy: {
            firstDayEnabled: false,
            firstDayBaseHours: 6,
            overtimeAdds: false,
            overtimeSource: 'clock',
            overrides: [
              {
                name: 'Ops',
                match: 'equals',
                attendanceGroups: ['ops'],
                roles: ['leader'],
              },
            ],
          },
          holidaySync: {
            baseUrl: 'https://example.com',
            years: [2026],
            addDayIndex: false,
            auto: { enabled: true, runAt: '03:15', timezone: 'UTC' },
            lastRun: { ranAt: '2026-03-12T00:00:00Z', success: true, totalApplied: 3 },
          },
          ipAllowlist: ['10.0.0.1'],
          geoFence: { lat: 31.2, lng: 121.5, radiusMeters: 150 },
          minPunchIntervalMinutes: 5,
        },
      })),
    })
    const config = useAttendanceAdminConfig(options)

    await config.loadSettings()

    expect(config.settingsForm.autoAbsenceEnabled).toBe(true)
    expect(config.settingsForm.autoAbsenceRunAt).toBe('01:30')
    expect(config.settingsForm.holidayOverrides).toHaveLength(1)
    expect(config.settingsForm.holidayOverrides[0]?.attendanceGroups).toBe('ops')
    expect(config.settingsForm.holidaySyncBaseUrl).toBe('https://example.com')
    expect(config.settingsForm.ipAllowlist).toBe('10.0.0.1')
    expect(config.holidaySyncLastRun.value?.totalApplied).toBe(3)
    expect(options.adminForbidden.value).toBe(false)
  })

  it('saves settings with normalized payload fields', async () => {
    const apiFetchWithTimeout = vi.fn(async () => jsonResponse(200, { ok: true, data: {} }))
    const options = createOptions({ apiFetchWithTimeout })
    const config = useAttendanceAdminConfig(options)

    config.settingsForm.autoAbsenceEnabled = true
    config.settingsForm.autoAbsenceRunAt = '02:15'
    config.settingsForm.autoAbsenceLookbackDays = 3
    config.settingsForm.holidayOvertimeSource = 'both'
    config.settingsForm.holidaySyncYears = '2026,2027'
    config.settingsForm.holidaySyncDayIndexHolidays = '春节, 国庆'
    config.settingsForm.ipAllowlist = '10.0.0.1\n10.0.0.2'
    config.settingsForm.geoFenceLat = '31.2'
    config.settingsForm.geoFenceLng = '121.5'
    config.settingsForm.geoFenceRadius = '200'
    config.settingsForm.holidayOverrides.push({
      name: 'Ops',
      match: 'contains',
      attendanceGroups: 'ops',
      roles: 'manager',
      roleTags: '',
      userIds: '',
      userNames: '',
      excludeUserIds: '',
      excludeUserNames: '',
      dayIndexStart: 1,
      dayIndexEnd: 2,
      dayIndexList: '1 2',
      firstDayEnabled: true,
      firstDayBaseHours: 8,
      overtimeAdds: true,
      overtimeSource: 'approval',
    })

    await config.saveSettings()

    expect(apiFetchWithTimeout).toHaveBeenCalledTimes(1)
    const [, request] = apiFetchWithTimeout.mock.calls[0]!
    const payload = JSON.parse(String(request?.body || '{}'))
    expect(payload.autoAbsence).toEqual({ enabled: true, runAt: '02:15', lookbackDays: 3 })
    expect(payload.holidayPolicy.overtimeSource).toBe('both')
    expect(payload.holidayPolicy.overrides[0]).toMatchObject({
      name: 'Ops',
      attendanceGroups: ['ops'],
      roles: ['manager'],
      dayIndexList: [1, 2],
    })
    expect(payload.holidaySync.years).toEqual([2026, 2027])
    expect(payload.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(payload.geoFence).toEqual({ lat: 31.2, lng: 121.5, radiusMeters: 200 })
    expect(options.setStatus).toHaveBeenCalledWith('Settings updated.')
  })

  it('syncs holidays for the requested years and updates last run', async () => {
    const apiFetchWithTimeout = vi.fn(async () => jsonResponse(200, {
      ok: true,
      data: {
        totalApplied: 4,
        lastRun: {
          ranAt: '2026-03-12T01:00:00Z',
          success: true,
          years: [2026],
          totalApplied: 4,
        },
      },
    }))
    const options = createOptions({ apiFetchWithTimeout })
    const config = useAttendanceAdminConfig(options)

    await config.syncHolidaysForYears([2026])

    expect(config.settingsForm.holidaySyncYears).toBe('2026')
    const [, request] = apiFetchWithTimeout.mock.calls[0]!
    const payload = JSON.parse(String(request?.body || '{}'))
    expect(payload.years).toEqual([2026])
    expect(config.holidaySyncLastRun.value?.totalApplied).toBe(4)
    expect(options.setStatus).toHaveBeenCalledWith('Holiday sync complete (4 applied).')
  })

  it('loads and saves the default rule', async () => {
    const apiFetchWithTimeout = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/attendance/rules/default?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            name: 'Night shift',
            timezone: 'Asia/Tokyo',
            workStartTime: '10:00',
            workEndTime: '19:00',
            lateGraceMinutes: 12,
            earlyGraceMinutes: 8,
            roundingMinutes: 15,
            workingDays: [1, 2, 3, 4],
          },
        })
      }
      if (path === '/api/attendance/rules/default' && init?.method === 'PUT') {
        return jsonResponse(200, {
          ok: true,
          data: JSON.parse(String(init.body)),
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    const options = createOptions({ apiFetchWithTimeout })
    const config = useAttendanceAdminConfig(options)

    await config.loadRule()
    expect(config.ruleForm.name).toBe('Night shift')
    expect(config.ruleForm.workingDays).toBe('1,2,3,4')

    config.ruleForm.workingDays = '1,2,5'
    await config.saveRule()

    const [, request] = apiFetchWithTimeout.mock.calls[1]!
    const payload = JSON.parse(String(request?.body || '{}'))
    expect(payload.orgId).toBe('org-1')
    expect(payload.workingDays).toEqual([1, 2, 5])
    expect(options.setStatus).toHaveBeenLastCalledWith('Rule updated.')
  })
})
