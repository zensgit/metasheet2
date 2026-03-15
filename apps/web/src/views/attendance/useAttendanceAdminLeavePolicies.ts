import { reactive, ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'

type Translate = (en: string, zh: string) => string
type ConfirmFn = (message: string) => boolean
type StatusKind = 'info' | 'error'
type StatusContext = 'admin'
type SetStatusFn = (message: string, kind?: StatusKind) => void
type SetStatusFromErrorFn = (error: unknown, fallbackMessage: string, context: StatusContext) => void
type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export interface AttendanceLeaveType {
  id: string
  orgId?: string
  code: string
  name: string
  paid: boolean
  requiresApproval: boolean
  requiresAttachment: boolean
  defaultMinutesPerDay: number
  isActive: boolean
}

export interface AttendanceOvertimeRule {
  id: string
  orgId?: string
  name: string
  minMinutes: number
  roundingMinutes: number
  maxMinutesPerDay: number
  requiresApproval: boolean
  isActive: boolean
}

export interface AttendanceApprovalStep {
  name?: string
  approverUserIds?: string[]
  approverRoleIds?: string[]
}

export interface AttendanceApprovalFlow {
  id: string
  orgId?: string
  name: string
  requestType: string
  steps: AttendanceApprovalStep[]
  isActive: boolean
}

export interface AttendanceAdminRequestFormLike {
  leaveTypeId: string
  overtimeRuleId: string
}

interface AttendanceApiError extends Error {
  status?: number
  code?: string
}

interface ApiEnvelope<T> {
  ok?: boolean
  data?: T
  error?: {
    message?: string
    code?: string
  } | null
}

interface AttendanceItemListPayload<T> {
  items?: T[]
}

interface UseAttendanceAdminLeavePoliciesOptions {
  adminForbidden: Ref<boolean>
  requestForm: AttendanceAdminRequestFormLike
  apiFetch?: ApiFetchFn
  confirm?: ConfirmFn
  getOrgId?: () => string | undefined
  setStatus?: SetStatusFn
  setStatusFromError?: SetStatusFromErrorFn
  tr?: Translate
}

function defaultTranslate(en: string): string {
  return en
}

function buildOrgQuery(orgId?: string): URLSearchParams {
  const query = new URLSearchParams()
  const normalizedOrgId = typeof orgId === 'string' ? orgId.trim() : ''
  if (normalizedOrgId) query.set('orgId', normalizedOrgId)
  return query
}

function createApiError(response: { status: number }, payload: unknown, fallbackMessage: string): AttendanceApiError {
  const rawPayload = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rawError = rawPayload.error && typeof rawPayload.error === 'object'
    ? rawPayload.error as Record<string, unknown>
    : {}
  const message = typeof rawError.message === 'string' && rawError.message.trim()
    ? rawError.message.trim()
    : fallbackMessage
  const error = new Error(message) as AttendanceApiError
  error.status = Number(response.status) || 0
  if (typeof rawError.code === 'string' && rawError.code.trim()) {
    error.code = rawError.code.trim().toUpperCase()
  }
  return error
}

function createForbiddenError(message: string): AttendanceApiError {
  const error = new Error(message) as AttendanceApiError
  error.status = 403
  error.code = 'FORBIDDEN'
  return error
}

async function readJson<T = unknown>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T
  } catch {
    return null
  }
}

function formatApprovalSteps(steps: AttendanceApprovalStep[]): string {
  return JSON.stringify(Array.isArray(steps) ? steps : [], null, 2)
}

function parseApprovalStepsInput(value: string): AttendanceApprovalStep[] | null {
  if (!value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed.filter(item => item && typeof item === 'object') as AttendanceApprovalStep[]
  } catch {
    return null
  }
}

export function useAttendanceAdminLeavePolicies({
  adminForbidden,
  requestForm,
  apiFetch = defaultApiFetch,
  confirm = (message: string) => window.confirm(message),
  getOrgId = () => undefined,
  setStatus = () => undefined,
  setStatusFromError,
  tr = defaultTranslate,
}: UseAttendanceAdminLeavePoliciesOptions) {
  const leaveTypes = ref<AttendanceLeaveType[]>([])
  const leaveTypeLoading = ref(false)
  const leaveTypeSaving = ref(false)
  const leaveTypeEditingId = ref<string | null>(null)
  const leaveTypeForm = reactive({
    code: '',
    name: '',
    paid: true,
    requiresApproval: true,
    requiresAttachment: false,
    defaultMinutesPerDay: 480,
    isActive: true,
  })

  const overtimeRules = ref<AttendanceOvertimeRule[]>([])
  const overtimeRuleLoading = ref(false)
  const overtimeRuleSaving = ref(false)
  const overtimeRuleEditingId = ref<string | null>(null)
  const overtimeRuleForm = reactive({
    name: '',
    minMinutes: 0,
    roundingMinutes: 15,
    maxMinutesPerDay: 600,
    requiresApproval: true,
    isActive: true,
  })

  const approvalFlows = ref<AttendanceApprovalFlow[]>([])
  const approvalFlowLoading = ref(false)
  const approvalFlowSaving = ref(false)
  const approvalFlowEditingId = ref<string | null>(null)
  const approvalFlowForm = reactive({
    name: '',
    requestType: 'leave',
    steps: '',
    isActive: true,
  })

  function forwardAdminError(error: unknown, fallbackMessage: string) {
    if (setStatusFromError) {
      setStatusFromError(error, fallbackMessage, 'admin')
      return
    }
    const message = error instanceof Error && error.message ? error.message : fallbackMessage
    setStatus(message, 'error')
  }

  function resetLeaveTypeForm() {
    leaveTypeEditingId.value = null
    leaveTypeForm.code = ''
    leaveTypeForm.name = ''
    leaveTypeForm.paid = true
    leaveTypeForm.requiresApproval = true
    leaveTypeForm.requiresAttachment = false
    leaveTypeForm.defaultMinutesPerDay = 480
    leaveTypeForm.isActive = true
  }

  function editLeaveType(item: AttendanceLeaveType) {
    leaveTypeEditingId.value = item.id
    leaveTypeForm.code = item.code
    leaveTypeForm.name = item.name
    leaveTypeForm.paid = item.paid
    leaveTypeForm.requiresApproval = item.requiresApproval
    leaveTypeForm.requiresAttachment = item.requiresAttachment
    leaveTypeForm.defaultMinutesPerDay = item.defaultMinutesPerDay
    leaveTypeForm.isActive = item.isActive
  }

  async function loadLeaveTypes() {
    leaveTypeLoading.value = true
    try {
      const query = buildOrgQuery(getOrgId())
      const response = await apiFetch(`/api/attendance/leave-types?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceItemListPayload<AttendanceLeaveType>>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to load leave types', '加载请假类型失败'))
      }
      adminForbidden.value = false
      leaveTypes.value = data.data?.items || []
      if (!requestForm.leaveTypeId && leaveTypes.value.length > 0) {
        requestForm.leaveTypeId = leaveTypes.value[0].id
      }
    } catch (error) {
      forwardAdminError(error, tr('Failed to load leave types', '加载请假类型失败'))
    } finally {
      leaveTypeLoading.value = false
    }
  }

  async function saveLeaveType() {
    leaveTypeSaving.value = true
    const isEditing = Boolean(leaveTypeEditingId.value)
    try {
      if (!leaveTypeForm.code.trim() || !leaveTypeForm.name.trim()) {
        throw new Error(tr('Code and name are required', '编码和名称为必填项'))
      }
      const payload = {
        code: leaveTypeForm.code.trim(),
        name: leaveTypeForm.name.trim(),
        paid: leaveTypeForm.paid,
        requiresApproval: leaveTypeForm.requiresApproval,
        requiresAttachment: leaveTypeForm.requiresAttachment,
        defaultMinutesPerDay: Number(leaveTypeForm.defaultMinutesPerDay) || 0,
        isActive: leaveTypeForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/leave-types/${leaveTypeEditingId.value}`
        : '/api/attendance/leave-types'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceLeaveType>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to save leave type', '保存请假类型失败'))
      }
      adminForbidden.value = false
      await loadLeaveTypes()
      resetLeaveTypeForm()
      setStatus(
        isEditing
          ? tr('Leave type updated.', '请假类型已更新。')
          : tr('Leave type created.', '请假类型已创建。')
      )
    } catch (error) {
      forwardAdminError(error, tr('Failed to save leave type', '保存请假类型失败'))
    } finally {
      leaveTypeSaving.value = false
    }
  }

  async function deleteLeaveType(id: string) {
    if (!confirm(tr('Delete this leave type?', '确认删除该请假类型吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/leave-types/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceLeaveType>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to delete leave type', '删除请假类型失败'))
      }
      adminForbidden.value = false
      await loadLeaveTypes()
      setStatus(tr('Leave type deleted.', '请假类型已删除。'))
    } catch (error) {
      forwardAdminError(error, tr('Failed to delete leave type', '删除请假类型失败'))
    }
  }

  function resetOvertimeRuleForm() {
    overtimeRuleEditingId.value = null
    overtimeRuleForm.name = ''
    overtimeRuleForm.minMinutes = 0
    overtimeRuleForm.roundingMinutes = 15
    overtimeRuleForm.maxMinutesPerDay = 600
    overtimeRuleForm.requiresApproval = true
    overtimeRuleForm.isActive = true
  }

  function editOvertimeRule(item: AttendanceOvertimeRule) {
    overtimeRuleEditingId.value = item.id
    overtimeRuleForm.name = item.name
    overtimeRuleForm.minMinutes = item.minMinutes
    overtimeRuleForm.roundingMinutes = item.roundingMinutes
    overtimeRuleForm.maxMinutesPerDay = item.maxMinutesPerDay
    overtimeRuleForm.requiresApproval = item.requiresApproval
    overtimeRuleForm.isActive = item.isActive
  }

  async function loadOvertimeRules() {
    overtimeRuleLoading.value = true
    try {
      const query = buildOrgQuery(getOrgId())
      const response = await apiFetch(`/api/attendance/overtime-rules?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceItemListPayload<AttendanceOvertimeRule>>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to load overtime rules', '加载加班规则失败'))
      }
      adminForbidden.value = false
      overtimeRules.value = data.data?.items || []
      if (!requestForm.overtimeRuleId && overtimeRules.value.length > 0) {
        requestForm.overtimeRuleId = overtimeRules.value[0].id
      }
    } catch (error) {
      forwardAdminError(error, tr('Failed to load overtime rules', '加载加班规则失败'))
    } finally {
      overtimeRuleLoading.value = false
    }
  }

  async function saveOvertimeRule() {
    overtimeRuleSaving.value = true
    const isEditing = Boolean(overtimeRuleEditingId.value)
    try {
      if (!overtimeRuleForm.name.trim()) {
        throw new Error(tr('Name is required', '名称为必填项'))
      }
      const payload = {
        name: overtimeRuleForm.name.trim(),
        minMinutes: Number(overtimeRuleForm.minMinutes) || 0,
        roundingMinutes: Number(overtimeRuleForm.roundingMinutes) || 1,
        maxMinutesPerDay: Number(overtimeRuleForm.maxMinutesPerDay) || 0,
        requiresApproval: overtimeRuleForm.requiresApproval,
        isActive: overtimeRuleForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/overtime-rules/${overtimeRuleEditingId.value}`
        : '/api/attendance/overtime-rules'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceOvertimeRule>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to save overtime rule', '保存加班规则失败'))
      }
      adminForbidden.value = false
      await loadOvertimeRules()
      resetOvertimeRuleForm()
      setStatus(
        isEditing
          ? tr('Overtime rule updated.', '加班规则已更新。')
          : tr('Overtime rule created.', '加班规则已创建。')
      )
    } catch (error) {
      forwardAdminError(error, tr('Failed to save overtime rule', '保存加班规则失败'))
    } finally {
      overtimeRuleSaving.value = false
    }
  }

  async function deleteOvertimeRule(id: string) {
    if (!confirm(tr('Delete this overtime rule?', '确认删除该加班规则吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/overtime-rules/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceOvertimeRule>>(response)
      if (!response.ok || !data?.ok) {
        throw createApiError(response, data, tr('Failed to delete overtime rule', '删除加班规则失败'))
      }
      adminForbidden.value = false
      await loadOvertimeRules()
      setStatus(tr('Overtime rule deleted.', '加班规则已删除。'))
    } catch (error) {
      forwardAdminError(error, tr('Failed to delete overtime rule', '删除加班规则失败'))
    }
  }

  function resetApprovalFlowForm() {
    approvalFlowEditingId.value = null
    approvalFlowForm.name = ''
    approvalFlowForm.requestType = 'leave'
    approvalFlowForm.steps = ''
    approvalFlowForm.isActive = true
  }

  function editApprovalFlow(flow: AttendanceApprovalFlow) {
    approvalFlowEditingId.value = flow.id
    approvalFlowForm.name = flow.name
    approvalFlowForm.requestType = flow.requestType
    approvalFlowForm.steps = formatApprovalSteps(flow.steps)
    approvalFlowForm.isActive = flow.isActive
  }

  async function loadApprovalFlows() {
    approvalFlowLoading.value = true
    try {
      const query = buildOrgQuery(getOrgId())
      const response = await apiFetch(`/api/attendance/approval-flows?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceItemListPayload<AttendanceApprovalFlow>>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to load approval flows', '加载审批流程失败'))
      }
      adminForbidden.value = false
      approvalFlows.value = data.data?.items || []
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load approval flows', '加载审批流程失败')
      setStatus(message, 'error')
    } finally {
      approvalFlowLoading.value = false
    }
  }

  async function saveApprovalFlow() {
    approvalFlowSaving.value = true
    const isEditing = Boolean(approvalFlowEditingId.value)
    try {
      if (!approvalFlowForm.name.trim()) {
        throw new Error(tr('Name is required', '名称为必填项'))
      }
      const steps = parseApprovalStepsInput(approvalFlowForm.steps)
      if (steps === null) {
        throw new Error(tr('Invalid steps JSON', '步骤 JSON 格式无效'))
      }
      const payload = {
        name: approvalFlowForm.name.trim(),
        requestType: approvalFlowForm.requestType,
        steps,
        isActive: approvalFlowForm.isActive,
        orgId: getOrgId(),
      }
      const endpoint = isEditing
        ? `/api/attendance/approval-flows/${approvalFlowEditingId.value}`
        : '/api/attendance/approval-flows'
      const response = await apiFetch(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceApprovalFlow>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to save approval flow', '保存审批流程失败'))
      }
      adminForbidden.value = false
      await loadApprovalFlows()
      resetApprovalFlowForm()
      setStatus(
        isEditing
          ? tr('Approval flow updated.', '审批流程已更新。')
          : tr('Approval flow created.', '审批流程已创建。')
      )
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to save approval flow', '保存审批流程失败')
      setStatus(message, 'error')
    } finally {
      approvalFlowSaving.value = false
    }
  }

  async function deleteApprovalFlow(id: string) {
    if (!confirm(tr('Delete this approval flow?', '确认删除该审批流程吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/approval-flows/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceApprovalFlow>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error?.message || tr('Failed to delete approval flow', '删除审批流程失败'))
      }
      adminForbidden.value = false
      await loadApprovalFlows()
      setStatus(tr('Approval flow deleted.', '审批流程已删除。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to delete approval flow', '删除审批流程失败')
      setStatus(message, 'error')
    }
  }

  return {
    leaveTypes,
    leaveTypeLoading,
    leaveTypeSaving,
    leaveTypeEditingId,
    leaveTypeForm,
    resetLeaveTypeForm,
    editLeaveType,
    loadLeaveTypes,
    saveLeaveType,
    deleteLeaveType,
    overtimeRules,
    overtimeRuleLoading,
    overtimeRuleSaving,
    overtimeRuleEditingId,
    overtimeRuleForm,
    resetOvertimeRuleForm,
    editOvertimeRule,
    loadOvertimeRules,
    saveOvertimeRule,
    deleteOvertimeRule,
    approvalFlows,
    approvalFlowLoading,
    approvalFlowSaving,
    approvalFlowEditingId,
    approvalFlowForm,
    resetApprovalFlowForm,
    editApprovalFlow,
    loadApprovalFlows,
    saveApprovalFlow,
    deleteApprovalFlow,
  }
}
