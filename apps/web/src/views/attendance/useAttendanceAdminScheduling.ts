import { reactive, ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'

type Translate = (en: string, zh: string) => string
type ConfirmFn = (message: string) => boolean
type StatusKind = 'info' | 'error'
type SetStatusFn = (message: string, kind?: StatusKind) => void
type SetStatusFromErrorFn = (error: unknown, fallbackMessage: string, context: string) => void
type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export interface AttendanceShift {
  id: string
  orgId?: string
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: number[]
}

export interface AttendanceAssignment {
  id: string
  orgId?: string
  userId: string
  shiftId: string
  startDate: string
  endDate: string | null
  isActive: boolean
}

export interface AttendanceAssignmentItem {
  assignment: AttendanceAssignment
  shift: AttendanceShift
}

export interface AttendanceHoliday {
  id: string
  orgId?: string
  date: string
  name: string | null
  isWorkingDay: boolean
}

export interface AttendanceRotationRule {
  id: string
  orgId?: string
  name: string
  timezone: string
  shiftSequence: string[]
  isActive: boolean
}

export interface AttendanceRotationAssignment {
  id: string
  orgId?: string
  userId: string
  rotationRuleId: string
  startDate: string
  endDate: string | null
  isActive: boolean
}

export interface AttendanceRotationAssignmentItem {
  assignment: AttendanceRotationAssignment
  rotation: AttendanceRotationRule
}

interface DateRange {
  from?: string
  to?: string
}

interface UseAttendanceAdminSchedulingOptions {
  adminForbidden: Ref<boolean>
  apiFetch?: ApiFetchFn
  confirm?: ConfirmFn
  defaultTimezone: string
  getDateRange?: () => DateRange
  getOrgId?: () => string | undefined
  setStatus?: SetStatusFn
  setStatusFromError?: SetStatusFromErrorFn
  tr?: Translate
}

function defaultTranslate(en: string): string {
  return en
}

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function buildQuery(params: Record<string, string | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (normalized) {
      query.set(key, normalized)
    }
  }
  return query
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function parseShiftSequenceInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function parseWorkingDaysInput(value: string): number[] {
  return value
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item >= 0 && item <= 6)
}

function extractErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message ? error.message : fallbackMessage
}

export function useAttendanceAdminScheduling({
  adminForbidden,
  apiFetch = defaultApiFetch,
  confirm = (message: string) => window.confirm(message),
  defaultTimezone,
  getDateRange = () => ({}),
  getOrgId = () => undefined,
  setStatus = () => undefined,
  setStatusFromError: _setStatusFromError,
  tr = defaultTranslate,
}: UseAttendanceAdminSchedulingOptions) {
  const today = new Date()

  const rotationRules = ref<AttendanceRotationRule[]>([])
  const rotationRuleLoading = ref(false)
  const rotationRuleSaving = ref(false)
  const rotationRuleEditingId = ref<string | null>(null)
  const rotationRuleForm = reactive({
    name: '',
    timezone: defaultTimezone,
    shiftSequence: '',
    isActive: true,
  })

  const rotationAssignments = ref<AttendanceRotationAssignmentItem[]>([])
  const rotationAssignmentLoading = ref(false)
  const rotationAssignmentSaving = ref(false)
  const rotationAssignmentEditingId = ref<string | null>(null)
  const rotationAssignmentForm = reactive({
    userId: '',
    rotationRuleId: '',
    startDate: toDateInput(today),
    endDate: '',
    isActive: true,
  })

  const shifts = ref<AttendanceShift[]>([])
  const shiftLoading = ref(false)
  const shiftSaving = ref(false)
  const shiftEditingId = ref<string | null>(null)
  const shiftForm = reactive({
    name: 'Standard Shift',
    timezone: defaultTimezone,
    workStartTime: '09:00',
    workEndTime: '18:00',
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    roundingMinutes: 5,
    workingDays: '1,2,3,4,5',
  })

  const assignments = ref<AttendanceAssignmentItem[]>([])
  const assignmentLoading = ref(false)
  const assignmentSaving = ref(false)
  const assignmentEditingId = ref<string | null>(null)
  const assignmentForm = reactive({
    userId: '',
    shiftId: '',
    startDate: toDateInput(today),
    endDate: '',
    isActive: true,
  })

  const holidays = ref<AttendanceHoliday[]>([])
  const holidayLoading = ref(false)
  const holidaySaving = ref(false)
  const holidayEditingId = ref<string | null>(null)
  const holidayForm = reactive({
    date: toDateInput(today),
    name: '',
    isWorkingDay: false,
  })

  function resetRotationRuleForm() {
    rotationRuleEditingId.value = null
    rotationRuleForm.name = ''
    rotationRuleForm.timezone = defaultTimezone
    rotationRuleForm.shiftSequence = ''
    rotationRuleForm.isActive = true
  }

  function editRotationRule(rule: AttendanceRotationRule) {
    rotationRuleEditingId.value = rule.id
    rotationRuleForm.name = rule.name
    rotationRuleForm.timezone = rule.timezone
    rotationRuleForm.shiftSequence = rule.shiftSequence.join(', ')
    rotationRuleForm.isActive = rule.isActive
  }

  async function loadRotationRules() {
    rotationRuleLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/rotation-rules?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson(response) as { ok?: boolean; data?: { items?: AttendanceRotationRule[] }; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load rotation rules', '加载轮班规则失败'))
      }
      adminForbidden.value = false
      rotationRules.value = data.data?.items || []
      if (!rotationAssignmentForm.rotationRuleId && rotationRules.value.length > 0) {
        rotationAssignmentForm.rotationRuleId = rotationRules.value[0].id
      }
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to load rotation rules', '加载轮班规则失败')), 'error')
    } finally {
      rotationRuleLoading.value = false
    }
  }

  async function saveRotationRule() {
    rotationRuleSaving.value = true
    const isEditing = Boolean(rotationRuleEditingId.value)
    try {
      if (!rotationRuleForm.name.trim()) {
        throw new Error(tr('Name is required', '名称为必填项'))
      }
      const shiftSequence = parseShiftSequenceInput(rotationRuleForm.shiftSequence)
      if (shiftSequence.length === 0) {
        throw new Error(tr('Shift sequence required', '班次序列为必填项'))
      }
      const payload = {
        name: rotationRuleForm.name.trim(),
        timezone: rotationRuleForm.timezone.trim() || defaultTimezone,
        shiftSequence,
        isActive: rotationRuleForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/rotation-rules/${rotationRuleEditingId.value}`
        : '/api/attendance/rotation-rules'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save rotation rule', '保存轮班规则失败'))
      }
      adminForbidden.value = false
      await loadRotationRules()
      resetRotationRuleForm()
      setStatus(
        isEditing
          ? tr('Rotation rule updated.', '轮班规则已更新。')
          : tr('Rotation rule created.', '轮班规则已创建。')
      )
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to save rotation rule', '保存轮班规则失败')), 'error')
    } finally {
      rotationRuleSaving.value = false
    }
  }

  async function deleteRotationRule(id: string) {
    if (!confirm(tr('Delete this rotation rule?', '确认删除该轮班规则吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/rotation-rules/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete rotation rule', '删除轮班规则失败'))
      }
      adminForbidden.value = false
      await loadRotationRules()
      await loadRotationAssignments()
      setStatus(tr('Rotation rule deleted.', '轮班规则已删除。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to delete rotation rule', '删除轮班规则失败')), 'error')
    }
  }

  function resetRotationAssignmentForm() {
    rotationAssignmentEditingId.value = null
    rotationAssignmentForm.userId = ''
    rotationAssignmentForm.rotationRuleId = rotationRules.value[0]?.id ?? ''
    rotationAssignmentForm.startDate = toDateInput(today)
    rotationAssignmentForm.endDate = ''
    rotationAssignmentForm.isActive = true
  }

  function editRotationAssignment(item: AttendanceRotationAssignmentItem) {
    rotationAssignmentEditingId.value = item.assignment.id
    rotationAssignmentForm.userId = item.assignment.userId
    rotationAssignmentForm.rotationRuleId = item.assignment.rotationRuleId
    rotationAssignmentForm.startDate = item.assignment.startDate
    rotationAssignmentForm.endDate = item.assignment.endDate ?? ''
    rotationAssignmentForm.isActive = item.assignment.isActive
  }

  async function loadRotationAssignments() {
    rotationAssignmentLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/rotation-assignments?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson(response) as { ok?: boolean; data?: { items?: AttendanceRotationAssignmentItem[] }; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load rotation assignments', '加载轮班分配失败'))
      }
      adminForbidden.value = false
      rotationAssignments.value = data.data?.items || []
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to load rotation assignments', '加载轮班分配失败')), 'error')
    } finally {
      rotationAssignmentLoading.value = false
    }
  }

  async function saveRotationAssignment() {
    rotationAssignmentSaving.value = true
    const isEditing = Boolean(rotationAssignmentEditingId.value)
    try {
      if (!rotationAssignmentForm.userId.trim()) {
        throw new Error(tr('User ID is required', '用户 ID 为必填项'))
      }
      if (!rotationAssignmentForm.rotationRuleId) {
        throw new Error(tr('Rotation rule is required', '轮班规则为必填项'))
      }
      const endDate = rotationAssignmentForm.endDate.trim()
      const payload = {
        userId: rotationAssignmentForm.userId.trim(),
        rotationRuleId: rotationAssignmentForm.rotationRuleId,
        startDate: rotationAssignmentForm.startDate,
        endDate: endDate.length > 0 ? endDate : null,
        isActive: rotationAssignmentForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/rotation-assignments/${rotationAssignmentEditingId.value}`
        : '/api/attendance/rotation-assignments'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save rotation assignment', '保存轮班分配失败'))
      }
      adminForbidden.value = false
      await loadRotationAssignments()
      resetRotationAssignmentForm()
      setStatus(
        isEditing
          ? tr('Rotation assignment updated.', '轮班分配已更新。')
          : tr('Rotation assignment created.', '轮班分配已创建。')
      )
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to save rotation assignment', '保存轮班分配失败')), 'error')
    } finally {
      rotationAssignmentSaving.value = false
    }
  }

  async function deleteRotationAssignment(id: string) {
    if (!confirm(tr('Delete this rotation assignment?', '确认删除该轮班分配吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/rotation-assignments/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete rotation assignment', '删除轮班分配失败'))
      }
      adminForbidden.value = false
      await loadRotationAssignments()
      setStatus(tr('Rotation assignment deleted.', '轮班分配已删除。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to delete rotation assignment', '删除轮班分配失败')), 'error')
    }
  }

  function resetShiftForm() {
    shiftEditingId.value = null
    shiftForm.name = 'Standard Shift'
    shiftForm.timezone = defaultTimezone
    shiftForm.workStartTime = '09:00'
    shiftForm.workEndTime = '18:00'
    shiftForm.lateGraceMinutes = 10
    shiftForm.earlyGraceMinutes = 10
    shiftForm.roundingMinutes = 5
    shiftForm.workingDays = '1,2,3,4,5'
  }

  function editShift(shift: AttendanceShift) {
    shiftEditingId.value = shift.id
    shiftForm.name = shift.name
    shiftForm.timezone = shift.timezone
    shiftForm.workStartTime = shift.workStartTime
    shiftForm.workEndTime = shift.workEndTime
    shiftForm.lateGraceMinutes = shift.lateGraceMinutes
    shiftForm.earlyGraceMinutes = shift.earlyGraceMinutes
    shiftForm.roundingMinutes = shift.roundingMinutes
    shiftForm.workingDays = shift.workingDays.join(',')
  }

  async function loadShifts() {
    shiftLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/shifts?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson(response) as { ok?: boolean; data?: { items?: AttendanceShift[] }; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load shifts', '加载班次失败'))
      }
      adminForbidden.value = false
      shifts.value = data.data?.items || []
      if (!assignmentForm.shiftId && shifts.value.length > 0) {
        assignmentForm.shiftId = shifts.value[0].id
      }
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to load shifts', '加载班次失败')), 'error')
    } finally {
      shiftLoading.value = false
    }
  }

  async function saveShift() {
    shiftSaving.value = true
    const isEditing = Boolean(shiftEditingId.value)
    try {
      const payload = {
        name: shiftForm.name,
        timezone: shiftForm.timezone,
        workStartTime: shiftForm.workStartTime,
        workEndTime: shiftForm.workEndTime,
        lateGraceMinutes: Number(shiftForm.lateGraceMinutes) || 0,
        earlyGraceMinutes: Number(shiftForm.earlyGraceMinutes) || 0,
        roundingMinutes: Number(shiftForm.roundingMinutes) || 0,
        workingDays: parseWorkingDaysInput(shiftForm.workingDays),
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/shifts/${shiftEditingId.value}`
        : '/api/attendance/shifts'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save shift', '保存班次失败'))
      }
      adminForbidden.value = false
      await loadShifts()
      resetShiftForm()
      setStatus(isEditing ? tr('Shift updated.', '班次已更新。') : tr('Shift created.', '班次已创建。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to save shift', '保存班次失败')), 'error')
    } finally {
      shiftSaving.value = false
    }
  }

  async function deleteShift(id: string) {
    if (!confirm(tr('Delete this shift? Assignments will be removed.', '确认删除该班次吗？关联分配也会被移除。'))) return
    try {
      const response = await apiFetch(`/api/attendance/shifts/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete shift', '删除班次失败'))
      }
      adminForbidden.value = false
      await loadShifts()
      await loadAssignments()
      setStatus(tr('Shift deleted.', '班次已删除。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to delete shift', '删除班次失败')), 'error')
    }
  }

  function resetAssignmentForm() {
    assignmentEditingId.value = null
    assignmentForm.userId = ''
    assignmentForm.shiftId = shifts.value[0]?.id ?? ''
    assignmentForm.startDate = toDateInput(today)
    assignmentForm.endDate = ''
    assignmentForm.isActive = true
  }

  function editAssignment(item: AttendanceAssignmentItem) {
    assignmentEditingId.value = item.assignment.id
    assignmentForm.userId = item.assignment.userId
    assignmentForm.shiftId = item.assignment.shiftId
    assignmentForm.startDate = item.assignment.startDate
    assignmentForm.endDate = item.assignment.endDate ?? ''
    assignmentForm.isActive = item.assignment.isActive
  }

  async function loadAssignments() {
    assignmentLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/assignments?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson(response) as { ok?: boolean; data?: { items?: AttendanceAssignmentItem[] }; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load assignments', '加载分配失败'))
      }
      adminForbidden.value = false
      assignments.value = data.data?.items || []
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to load assignments', '加载分配失败')), 'error')
    } finally {
      assignmentLoading.value = false
    }
  }

  async function saveAssignment() {
    assignmentSaving.value = true
    const isEditing = Boolean(assignmentEditingId.value)
    try {
      if (!assignmentForm.userId.trim()) {
        throw new Error(tr('User ID is required', '用户 ID 为必填项'))
      }
      if (!assignmentForm.shiftId) {
        throw new Error(tr('Shift selection is required', '班次为必选项'))
      }
      const endDate = assignmentForm.endDate.trim()
      const payload = {
        userId: assignmentForm.userId.trim(),
        shiftId: assignmentForm.shiftId,
        startDate: assignmentForm.startDate,
        endDate: endDate.length > 0 ? endDate : null,
        isActive: assignmentForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/assignments/${assignmentEditingId.value}`
        : '/api/attendance/assignments'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save assignment', '保存分配失败'))
      }
      adminForbidden.value = false
      await loadAssignments()
      resetAssignmentForm()
      setStatus(isEditing ? tr('Assignment updated.', '分配已更新。') : tr('Assignment created.', '分配已创建。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to save assignment', '保存分配失败')), 'error')
    } finally {
      assignmentSaving.value = false
    }
  }

  async function deleteAssignment(id: string) {
    if (!confirm(tr('Delete this assignment?', '确认删除该分配吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/assignments/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete assignment', '删除分配失败'))
      }
      adminForbidden.value = false
      await loadAssignments()
      setStatus(tr('Assignment deleted.', '分配已删除。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to delete assignment', '删除分配失败')), 'error')
    }
  }

  function resetHolidayForm() {
    holidayEditingId.value = null
    holidayForm.date = toDateInput(today)
    holidayForm.name = ''
    holidayForm.isWorkingDay = false
  }

  function editHoliday(holiday: AttendanceHoliday) {
    holidayEditingId.value = holiday.id
    holidayForm.date = holiday.date
    holidayForm.name = holiday.name ?? ''
    holidayForm.isWorkingDay = holiday.isWorkingDay
  }

  async function loadHolidays() {
    holidayLoading.value = true
    try {
      const range = getDateRange()
      const query = buildQuery({
        from: range.from,
        to: range.to,
        orgId: getOrgId(),
      })
      const response = await apiFetch(`/api/attendance/holidays?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson(response) as { ok?: boolean; data?: { items?: AttendanceHoliday[] }; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load holidays', '加载节假日失败'))
      }
      adminForbidden.value = false
      holidays.value = data.data?.items || []
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to load holidays', '加载节假日失败')), 'error')
    } finally {
      holidayLoading.value = false
    }
  }

  async function saveHoliday() {
    holidaySaving.value = true
    const isEditing = Boolean(holidayEditingId.value)
    try {
      if (!holidayForm.date) {
        throw new Error(tr('Holiday date is required', '节假日日期为必填项'))
      }
      const payload = {
        date: holidayForm.date,
        name: holidayForm.name.trim().length > 0 ? holidayForm.name.trim() : null,
        isWorkingDay: holidayForm.isWorkingDay,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/holidays/${holidayEditingId.value}`
        : '/api/attendance/holidays'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save holiday', '保存节假日失败'))
      }
      adminForbidden.value = false
      await loadHolidays()
      resetHolidayForm()
      setStatus(isEditing ? tr('Holiday updated.', '节假日已更新。') : tr('Holiday created.', '节假日已创建。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to save holiday', '保存节假日失败')), 'error')
    } finally {
      holidaySaving.value = false
    }
  }

  async function deleteHoliday(id: string) {
    if (!confirm(tr('Delete this holiday?', '确认删除该节假日吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/holidays/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson(response) as { ok?: boolean; error?: { message?: string } } | null
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete holiday', '删除节假日失败'))
      }
      adminForbidden.value = false
      await loadHolidays()
      setStatus(tr('Holiday deleted.', '节假日已删除。'))
    } catch (error) {
      setStatus(extractErrorMessage(error, tr('Failed to delete holiday', '删除节假日失败')), 'error')
    }
  }

  return {
    rotationRules,
    rotationRuleLoading,
    rotationRuleSaving,
    rotationRuleEditingId,
    rotationRuleForm,
    resetRotationRuleForm,
    editRotationRule,
    loadRotationRules,
    saveRotationRule,
    deleteRotationRule,
    rotationAssignments,
    rotationAssignmentLoading,
    rotationAssignmentSaving,
    rotationAssignmentEditingId,
    rotationAssignmentForm,
    resetRotationAssignmentForm,
    editRotationAssignment,
    loadRotationAssignments,
    saveRotationAssignment,
    deleteRotationAssignment,
    shifts,
    shiftLoading,
    shiftSaving,
    shiftEditingId,
    shiftForm,
    resetShiftForm,
    editShift,
    loadShifts,
    saveShift,
    deleteShift,
    assignments,
    assignmentLoading,
    assignmentSaving,
    assignmentEditingId,
    assignmentForm,
    resetAssignmentForm,
    editAssignment,
    loadAssignments,
    saveAssignment,
    deleteAssignment,
    holidays,
    holidayLoading,
    holidaySaving,
    holidayEditingId,
    holidayForm,
    resetHolidayForm,
    editHoliday,
    loadHolidays,
    saveHoliday,
    deleteHoliday,
  }
}
