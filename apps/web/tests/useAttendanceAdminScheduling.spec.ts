import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useAttendanceAdminScheduling } from '../src/views/attendance/useAttendanceAdminScheduling'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

describe('useAttendanceAdminScheduling', () => {
  it('loads rotation rules and seeds the rotation assignment form', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          {
            id: 'rot-1',
            name: 'Two Shift',
            timezone: 'UTC',
            shiftSequence: ['shift-a', 'shift-b'],
            isActive: true,
          },
        ],
      },
    }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
    })

    await scheduling.loadRotationRules()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/rotation-rules?')
    expect(scheduling.rotationRules.value).toHaveLength(1)
    expect(scheduling.rotationAssignmentForm.rotationRuleId).toBe('rot-1')
    expect(adminForbidden.value).toBe(false)
  })

  it('saves a shift, parses working days, reloads, resets, and reports success', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          items: [
            {
              id: 'shift-1',
              name: 'Ops Shift',
              timezone: 'Asia/Shanghai',
              workStartTime: '08:30',
              workEndTime: '17:30',
              lateGraceMinutes: 8,
              earlyGraceMinutes: 7,
              roundingMinutes: 10,
              workingDays: [1, 3, 5],
            },
          ],
        },
      }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      getOrgId: () => 'org-1',
      setStatus,
    })

    scheduling.shiftForm.name = 'Ops Shift'
    scheduling.shiftForm.timezone = 'Asia/Shanghai'
    scheduling.shiftForm.workStartTime = '08:30'
    scheduling.shiftForm.workEndTime = '17:30'
    scheduling.shiftForm.lateGraceMinutes = 8
    scheduling.shiftForm.earlyGraceMinutes = 7
    scheduling.shiftForm.roundingMinutes = 10
    scheduling.shiftForm.workingDays = '1, 3, 5'

    await scheduling.saveShift()

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/shifts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ops Shift',
        timezone: 'Asia/Shanghai',
        workStartTime: '08:30',
        workEndTime: '17:30',
        lateGraceMinutes: 8,
        earlyGraceMinutes: 7,
        roundingMinutes: 10,
        workingDays: [1, 3, 5],
        orgId: 'org-1',
      }),
    })
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/shifts?orgId=org-1')
    expect(scheduling.shifts.value[0]?.id).toBe('shift-1')
    expect(scheduling.assignmentForm.shiftId).toBe('shift-1')
    expect(scheduling.shiftForm.name).toBe('Standard Shift')
    expect(setStatus).toHaveBeenCalledWith('Shift created.')
  })

  it('requires a shift name before saving', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = '   '
    scheduling.shiftForm.timezone = 'Asia/Shanghai'
    scheduling.shiftForm.workStartTime = '08:30'
    scheduling.shiftForm.workEndTime = '17:30'

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Shift name is required', 'error')
  })

  it('deletes a rotation rule and reloads both rules and assignments', async () => {
    const adminForbidden = ref(false)
    const confirm = vi.fn().mockReturnValue(true)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { items: [] } }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      confirm,
      defaultTimezone: 'UTC',
      setStatus,
    })

    await scheduling.deleteRotationRule('rot-1')

    expect(confirm).toHaveBeenCalledWith('Delete this rotation rule?')
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/rotation-rules/rot-1', { method: 'DELETE' })
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/rotation-rules?')
    expect(apiFetch).toHaveBeenNthCalledWith(3, '/api/attendance/rotation-assignments?')
    expect(setStatus).toHaveBeenCalledWith('Rotation rule deleted.')
  })

  it('validates assignment input before calling the API', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.assignmentForm.shiftId = 'shift-1'
    await scheduling.saveAssignment()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('User ID is required', 'error')
  })

  it('loads holidays with the injected date range and org id', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          { id: 'holiday-1', date: '2026-03-01', name: 'Spring Break', isWorkingDay: false },
        ],
      },
    }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      getOrgId: () => 'org-2',
      getDateRange: () => ({ from: '2026-03-01', to: '2026-03-31' }),
    })

    await scheduling.loadHolidays()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/holidays?from=2026-03-01&to=2026-03-31&orgId=org-2')
    expect(scheduling.holidays.value[0]?.id).toBe('holiday-1')
  })

  it('uses the holiday module range instead of the overview range once the admin changes it', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        items: [
          { id: 'holiday-2', date: '2026-01-01', name: 'New Year', isWorkingDay: false },
        ],
        total: 12,
      },
    }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      getOrgId: () => 'org-3',
      getDateRange: () => ({ from: '2026-03-01', to: '2026-03-31' }),
    })

    scheduling.holidayRange.from = '2026-01-01'
    scheduling.holidayRange.to = '2026-12-31'

    await scheduling.loadHolidays()

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance/holidays?from=2026-01-01&to=2026-12-31&orgId=org-3')
    expect(scheduling.holidayTotal.value).toBe(12)
    expect(scheduling.holidays.value[0]?.id).toBe('holiday-2')
  })

  it('requires a holiday name before saving', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.holidayForm.date = '2026-03-15'
    scheduling.holidayForm.name = '   '

    await scheduling.saveHoliday()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Holiday name is required', 'error')
  })

  it('marks admin forbidden and shows the direct 403 message for holiday saves', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn().mockResolvedValue(jsonResponse(403, { ok: false }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.holidayForm.date = '2026-03-15'
    scheduling.holidayForm.name = 'Spring Festival'

    await scheduling.saveHoliday()

    expect(adminForbidden.value).toBe(true)
    expect(setStatus).toHaveBeenCalledWith('Admin permissions required', 'error')
  })
})
