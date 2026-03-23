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
            isOvernight: false,
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
    scheduling.shiftForm.isOvernight = false
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
        isOvernight: false,
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

  it('requires at least one working day before saving a shift', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = 'Ops Shift'
    scheduling.shiftForm.workStartTime = '08:30'
    scheduling.shiftForm.workEndTime = '17:30'
    scheduling.shiftForm.workingDays = '7,8'

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('At least one working day is required', 'error')
  })

  it('requires shift start and end times before saving', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = 'Ops Shift'
    scheduling.shiftForm.workStartTime = '   '
    scheduling.shiftForm.workEndTime = '17:30'
    scheduling.shiftForm.workingDays = '1,2,3'

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Work start time is required', 'error')
  })

  it('rejects identical shift start and end times', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = 'Ops Shift'
    scheduling.shiftForm.workStartTime = '09:00'
    scheduling.shiftForm.workEndTime = '09:00'
    scheduling.shiftForm.workingDays = '1,2,3'

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Shift start and end times cannot be the same', 'error')
  })

  it('requires non-negative integer shift grace values before saving', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = 'Ops Shift'
    scheduling.shiftForm.workStartTime = '08:30'
    scheduling.shiftForm.workEndTime = '17:30'
    scheduling.shiftForm.workingDays = '1,2,3'
    scheduling.shiftForm.lateGraceMinutes = -1

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Late grace must be a non-negative integer', 'error')
  })

  it('allows overnight shifts when the overnight flag is enabled', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { items: [] } }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      getOrgId: () => 'org-overnight',
      setStatus,
    })

    scheduling.shiftForm.name = 'Night Shift'
    scheduling.shiftForm.timezone = 'Asia/Shanghai'
    scheduling.shiftForm.workStartTime = '22:00'
    scheduling.shiftForm.workEndTime = '06:00'
    scheduling.shiftForm.isOvernight = true
    scheduling.shiftForm.workingDays = '1,2,3,4,5'

    await scheduling.saveShift()

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/shifts', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Night Shift',
        timezone: 'Asia/Shanghai',
        workStartTime: '22:00',
        workEndTime: '06:00',
        isOvernight: true,
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
        roundingMinutes: 5,
        workingDays: [1, 2, 3, 4, 5],
        orgId: 'org-overnight',
      }),
    })
    expect(setStatus).toHaveBeenCalledWith('Shift created.')
  })

  it('rejects overnight-looking shifts when the overnight flag is disabled', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.shiftForm.name = 'Night Shift'
    scheduling.shiftForm.workStartTime = '22:00'
    scheduling.shiftForm.workEndTime = '06:00'
    scheduling.shiftForm.isOvernight = false
    scheduling.shiftForm.workingDays = '1,2,3,4,5'

    await scheduling.saveShift()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(
      'Shift end must be later than start unless overnight is enabled',
      'error',
    )
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

  it('rejects assignments when the end date is earlier than the start date', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.assignmentForm.userId = 'user-1'
    scheduling.assignmentForm.shiftId = 'shift-1'
    scheduling.assignmentForm.startDate = '2026-04-10'
    scheduling.assignmentForm.endDate = '2026-04-09'

    await scheduling.saveAssignment()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('End date cannot be earlier than start date', 'error')
  })

  it('requires assignment start dates before calling the API', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.assignmentForm.userId = 'user-1'
    scheduling.assignmentForm.shiftId = 'shift-1'
    scheduling.assignmentForm.startDate = '   '

    await scheduling.saveAssignment()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Start date is required', 'error')
  })

  it('rejects rotation assignments when the end date is earlier than the start date', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.rotationAssignmentForm.userId = 'user-1'
    scheduling.rotationAssignmentForm.rotationRuleId = 'rot-1'
    scheduling.rotationAssignmentForm.startDate = '2026-04-10'
    scheduling.rotationAssignmentForm.endDate = '2026-04-09'

    await scheduling.saveRotationAssignment()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('End date cannot be earlier than start date', 'error')
  })

  it('requires rotation assignment start dates before calling the API', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const apiFetch = vi.fn()

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      setStatus,
    })

    scheduling.rotationAssignmentForm.userId = 'user-1'
    scheduling.rotationAssignmentForm.rotationRuleId = 'rot-1'
    scheduling.rotationAssignmentForm.startDate = '   '

    await scheduling.saveRotationAssignment()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Start date is required', 'error')
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

  it('keeps the selected holiday date when the form is reset after month-calendar edits', () => {
    const adminForbidden = ref(false)

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch: vi.fn(),
      defaultTimezone: 'UTC',
    })

    scheduling.holidayForm.date = '2026-04-03'
    scheduling.holidayForm.name = 'Qingming'
    scheduling.holidayForm.isWorkingDay = true
    scheduling.holidayEditingId.value = 'holiday-3'

    scheduling.resetHolidayForm()

    expect(scheduling.holidayEditingId.value).toBeNull()
    expect(scheduling.holidayForm.date).toBe('2026-04-03')
    expect(scheduling.holidayForm.name).toBe('')
    expect(scheduling.holidayForm.isWorkingDay).toBe(false)
  })

  it('keeps the saved holiday date instead of jumping back to today after save', async () => {
    const adminForbidden = ref(false)
    const setStatus = vi.fn()
    const currentYear = new Date().getFullYear()
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          items: [
            { id: 'holiday-9', date: '2026-04-03', name: 'Qingming', isWorkingDay: false },
          ],
        },
      }))

    const scheduling = useAttendanceAdminScheduling({
      adminForbidden,
      apiFetch,
      defaultTimezone: 'UTC',
      getOrgId: () => 'org-calendar',
      setStatus,
    })

    scheduling.holidayForm.date = '2026-04-03'
    scheduling.holidayForm.name = 'Qingming'

    await scheduling.saveHoliday()

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/attendance/holidays', {
      method: 'POST',
      body: JSON.stringify({
        date: '2026-04-03',
        name: 'Qingming',
        isWorkingDay: false,
        orgId: 'org-calendar',
      }),
    })
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      `/api/attendance/holidays?from=${currentYear}-01-01&to=${currentYear}-12-31&orgId=org-calendar`
    )
    expect(scheduling.holidayForm.date).toBe('2026-04-03')
    expect(scheduling.holidayForm.name).toBe('')
    expect(setStatus).toHaveBeenCalledWith('Holiday created.')
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
