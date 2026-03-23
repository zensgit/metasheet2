import { computed, reactive, ref, watch, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'
import { generateAttendanceCode } from './attendanceCode'

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

export interface AttendanceApprovalBuilderStep {
  id: string
  name: string
  approverUserIdsText: string
  approverRoleIdsText: string
}

export interface AttendanceApprovalFlowTemplateChoice {
  id: string
  label: string
  description: string
  steps: AttendanceApprovalStep[]
}

export interface AttendanceApprovalFlow {
  id: string
  orgId?: string
  name: string
  requestType: string
  workflowId?: string | null
  steps: AttendanceApprovalStep[]
  isActive: boolean
}

export interface AttendanceApprovalWorkflowSyncPreviewSummary {
  currentStepCount: number
  userTaskCount: number
  derivedStepCount: number
  unsupportedNodeCount: number
}

export interface AttendanceApprovalWorkflowSyncPreview {
  workflowId: string
  workflowName: string
  sourceMode?: string
  steps: AttendanceApprovalStep[]
  warnings: string[]
  summary: AttendanceApprovalWorkflowSyncPreviewSummary
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
}

function normalizeApprovalStepInput(value: unknown): AttendanceApprovalStep | null {
  if (!value || typeof value !== 'object') return null
  const rawValue = value as Record<string, unknown>
  const rawName = typeof rawValue.name === 'string' ? rawValue.name.trim() : ''
  const approverUserIds = normalizeStringArray(rawValue.approverUserIds ?? rawValue.approver_user_ids)
  const approverRoleIds = normalizeStringArray(rawValue.approverRoleIds ?? rawValue.approver_role_ids)
  return {
    ...(rawName ? { name: rawName } : {}),
    ...(approverUserIds.length > 0 ? { approverUserIds } : {}),
    ...(approverRoleIds.length > 0 ? { approverRoleIds } : {}),
  }
}

function parseApprovalStepsInput(value: string): AttendanceApprovalStep[] | null {
  if (!value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed
      .map((item) => normalizeApprovalStepInput(item))
      .filter((item): item is AttendanceApprovalStep => item !== null)
  } catch {
    return null
  }
}

function formatApprovalStepList(value: string[] | undefined): string {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : ''
}

function parseApprovalStepList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildApprovalFlowTemplateChoices(requestType: string, tr: Translate): AttendanceApprovalFlowTemplateChoice[] {
  const managerStep = {
    name: tr('Manager review', '直属主管审批'),
    approverRoleIds: ['manager'],
  }
  const hrStep = {
    name: tr('HR review', 'HR 审批'),
    approverRoleIds: ['hr'],
  }
  const payrollStep = {
    name: tr('Payroll review', '薪资审批'),
    approverRoleIds: ['payroll'],
  }
  const opsStep = {
    name: tr('Attendance ops review', '考勤运营审批'),
    approverRoleIds: ['attendance_admin'],
  }

  if (requestType === 'overtime') {
    return [
      {
        id: 'manager-only',
        label: tr('Manager only', '仅主管'),
        description: tr('One-step approval for standard overtime submissions.', '适用于标准加班申请的一步主管审批。'),
        steps: [managerStep],
      },
      {
        id: 'manager-payroll',
        label: tr('Manager -> Payroll', '主管 -> 薪资'),
        description: tr('Escalate approved overtime into payroll review before settlement.', '先主管审批，再进入薪资确认结算。'),
        steps: [managerStep, payrollStep],
      },
      {
        id: 'manager-ops-payroll',
        label: tr('Manager -> Ops -> Payroll', '主管 -> 运营 -> 薪资'),
        description: tr('Use when overtime affects attendance exceptions and final payroll payout.', '适用于同时影响考勤异常和薪资发放的加班流程。'),
        steps: [managerStep, opsStep, payrollStep],
      },
    ]
  }

  if (requestType === 'leave') {
    return [
      {
        id: 'manager-only',
        label: tr('Manager only', '仅主管'),
        description: tr('One-step approval for routine leave requests.', '适用于常规请假申请的一步主管审批。'),
        steps: [managerStep],
      },
      {
        id: 'manager-hr',
        label: tr('Manager -> HR', '主管 -> HR'),
        description: tr('Common path for annual, sick, and compensated leave.', '适用于年假、病假和调休等常见请假场景。'),
        steps: [managerStep, hrStep],
      },
      {
        id: 'manager-hr-ops',
        label: tr('Manager -> HR -> Ops', '主管 -> HR -> 运营'),
        description: tr('Add attendance operations when leave impacts roster corrections.', '适用于需要同步排班或考勤纠偏的请假场景。'),
        steps: [managerStep, hrStep, opsStep],
      },
    ]
  }

  return [
    {
      id: 'manager-only',
      label: tr('Manager only', '仅主管'),
      description: tr('Single approval gate for low-risk attendance requests.', '适用于低风险考勤申请的一步审批。'),
      steps: [managerStep],
    },
    {
      id: 'manager-ops',
      label: tr('Manager -> Ops', '主管 -> 运营'),
      description: tr('Use when attendance admins must validate the correction before closing the request.', '适用于需要考勤管理员二次校验的更正场景。'),
      steps: [managerStep, opsStep],
    },
    {
      id: 'manager-hr-ops',
      label: tr('Manager -> HR -> Ops', '主管 -> HR -> 运营'),
      description: tr('Escalate through HR before attendance operations for sensitive policy exceptions.', '适用于需要 HR 先行判断的敏感考勤例外场景。'),
      steps: [managerStep, hrStep, opsStep],
    },
  ]
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
  let nextApprovalStepId = 0

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
    workflowId: '',
    steps: '',
    isActive: true,
  })
  const approvalFlowBuilderSteps = ref<AttendanceApprovalBuilderStep[]>([])
  const approvalFlowBuilderError = ref('')
  const approvalFlowWorkflowSyncLoading = ref(false)
  const approvalFlowWorkflowSyncError = ref('')
  const approvalFlowWorkflowSyncPreview = ref<AttendanceApprovalWorkflowSyncPreview | null>(null)
  const approvalFlowBuilderSummary = computed(() => {
    const normalizedSteps = approvalFlowBuilderSteps.value
      .map((step) => buildApprovalStepFromBuilder(step))
      .filter((step): step is AttendanceApprovalStep => step !== null)
    const roleAssignmentCount = normalizedSteps.reduce(
      (sum, step) => sum + (step.approverRoleIds?.length ?? 0),
      0,
    )
    const directUserCount = normalizedSteps.reduce(
      (sum, step) => sum + (step.approverUserIds?.length ?? 0),
      0,
    )
    return {
      stepCount: normalizedSteps.length,
      roleAssignmentCount,
      directUserCount,
      placeholderCount: Math.max(approvalFlowBuilderSteps.value.length - normalizedSteps.length, 0),
    }
  })
  const approvalFlowTemplates = computed(() => buildApprovalFlowTemplateChoices(approvalFlowForm.requestType, tr))
  let syncingApprovalFlowBuilder = false

  function releaseApprovalFlowBuilderSyncLock() {
    Promise.resolve().then(() => {
      syncingApprovalFlowBuilder = false
    })
  }

  function createApprovalBuilderStep(step?: AttendanceApprovalStep): AttendanceApprovalBuilderStep {
    nextApprovalStepId += 1
    return {
      id: `approval-step-${nextApprovalStepId}`,
      name: step?.name ?? '',
      approverUserIdsText: formatApprovalStepList(step?.approverUserIds),
      approverRoleIdsText: formatApprovalStepList(step?.approverRoleIds),
    }
  }

  function buildApprovalStepFromBuilder(step: AttendanceApprovalBuilderStep): AttendanceApprovalStep | null {
    const name = step.name.trim()
    const approverUserIds = parseApprovalStepList(step.approverUserIdsText)
    const approverRoleIds = parseApprovalStepList(step.approverRoleIdsText)
    if (!name && approverUserIds.length === 0 && approverRoleIds.length === 0) return null
    return {
      ...(name ? { name } : {}),
      ...(approverUserIds.length > 0 ? { approverUserIds } : {}),
      ...(approverRoleIds.length > 0 ? { approverRoleIds } : {}),
    }
  }

  function syncApprovalFlowBuilderFromJson(value: string) {
    const parsed = parseApprovalStepsInput(value)
    if (parsed === null) {
      approvalFlowBuilderError.value = tr(
        'Fix the JSON fallback before editing with the visual builder.',
        '请先修复 JSON 兜底内容，再继续使用可视化审批构建器。',
      )
      return
    }
    syncingApprovalFlowBuilder = true
    approvalFlowBuilderSteps.value = parsed.map((step) => createApprovalBuilderStep(step))
    approvalFlowBuilderError.value = ''
    releaseApprovalFlowBuilderSyncLock()
  }

  function syncApprovalFlowJsonFromBuilder() {
    if (syncingApprovalFlowBuilder) return
    syncingApprovalFlowBuilder = true
    const steps = approvalFlowBuilderSteps.value
      .map((step) => buildApprovalStepFromBuilder(step))
      .filter((step): step is AttendanceApprovalStep => step !== null)
    approvalFlowForm.steps = formatApprovalSteps(steps)
    approvalFlowBuilderError.value = ''
    releaseApprovalFlowBuilderSyncLock()
  }

  function addApprovalFlowBuilderStep(step?: AttendanceApprovalStep) {
    approvalFlowBuilderSteps.value = [
      ...approvalFlowBuilderSteps.value,
      createApprovalBuilderStep(step),
    ]
  }

  function removeApprovalFlowBuilderStep(index: number) {
    approvalFlowBuilderSteps.value = approvalFlowBuilderSteps.value.filter((_, currentIndex) => currentIndex !== index)
  }

  function applyApprovalFlowTemplate(templateId: string) {
    const template = approvalFlowTemplates.value.find((item) => item.id === templateId)
    if (!template) return
    approvalFlowBuilderSteps.value = template.steps.map((step) => createApprovalBuilderStep(step))
  }

  function clearApprovalFlowWorkflowSyncPreview() {
    approvalFlowWorkflowSyncError.value = ''
    approvalFlowWorkflowSyncPreview.value = null
  }

  async function previewApprovalFlowWorkflowSync() {
    const flowId = approvalFlowEditingId.value
    const workflowId = approvalFlowForm.workflowId.trim()
    if (!flowId || !workflowId) {
      const message = tr('Link and save the approval flow before previewing workflow sync.', '请先保存并关联审批流程，再预览工作流同步结果。')
      approvalFlowWorkflowSyncError.value = message
      setStatus(message, 'error')
      return
    }

    approvalFlowWorkflowSyncLoading.value = true
    approvalFlowWorkflowSyncError.value = ''
    try {
      const query = buildOrgQuery(getOrgId())
      const queryText = query.toString()
      const response = await apiFetch(
        `/api/attendance/approval-flows/${flowId}/workflow-sync-preview${queryText ? `?${queryText}` : ''}`,
      )
      if (response.status === 403) {
        adminForbidden.value = true
        throw createForbiddenError(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceApprovalWorkflowSyncPreview>>(response)
      if (!response.ok || !data?.ok || !data.data) {
        throw createApiError(response, data, tr('Failed to preview workflow approval sync', '预览工作流审批同步失败'))
      }
      adminForbidden.value = false
      approvalFlowWorkflowSyncPreview.value = data.data
      setStatus(tr('Workflow sync preview ready.', '工作流同步预览已生成。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to preview workflow approval sync', '预览工作流审批同步失败')
      approvalFlowWorkflowSyncError.value = message
      approvalFlowWorkflowSyncPreview.value = null
      setStatus(message, 'error')
    } finally {
      approvalFlowWorkflowSyncLoading.value = false
    }
  }

  function applyApprovalFlowWorkflowSyncPreview() {
    const preview = approvalFlowWorkflowSyncPreview.value
    if (!preview) {
      const message = tr('Generate a workflow sync preview first.', '请先生成工作流同步预览。')
      approvalFlowWorkflowSyncError.value = message
      setStatus(message, 'error')
      return
    }
    approvalFlowBuilderSteps.value = preview.steps.map((step) => createApprovalBuilderStep(step))
    approvalFlowWorkflowSyncPreview.value = null
    approvalFlowWorkflowSyncError.value = ''
    setStatus(
      tr(
        'Workflow draft steps applied to the approval builder. Save the flow to persist them.',
        '工作流草稿步骤已应用到审批构建器，请保存审批流程以持久化。',
      ),
    )
  }

  function forwardAdminError(error: unknown, fallbackMessage: string) {
    if (setStatusFromError) {
      setStatusFromError(error, fallbackMessage, 'admin')
      return
    }
    const message = error instanceof Error && error.message ? error.message : fallbackMessage
    setStatus(message, 'error')
  }

  watch(
    () => leaveTypeForm.name,
    (name) => {
      const trimmedName = name.trim()
      if (!trimmedName || leaveTypeForm.code.trim().length > 0) return
      leaveTypeForm.code = generateAttendanceCode(trimmedName, 'leave')
    },
    { immediate: true },
  )

  watch(
    () => approvalFlowForm.steps,
    (value) => {
      if (syncingApprovalFlowBuilder) return
      syncApprovalFlowBuilderFromJson(value)
    },
    { immediate: true },
  )

  watch(
    approvalFlowBuilderSteps,
    () => {
      syncApprovalFlowJsonFromBuilder()
    },
    { deep: true },
  )

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
      if (!leaveTypeForm.name.trim()) {
        throw new Error(tr('Name is required', '名称为必填项'))
      }
      const payload = {
        code: leaveTypeForm.code.trim() || generateAttendanceCode(leaveTypeForm.name, 'leave'),
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
    approvalFlowForm.workflowId = ''
    approvalFlowForm.steps = ''
    approvalFlowForm.isActive = true
    clearApprovalFlowWorkflowSyncPreview()
  }

  function editApprovalFlow(flow: AttendanceApprovalFlow) {
    approvalFlowEditingId.value = flow.id
    approvalFlowForm.name = flow.name
    approvalFlowForm.requestType = flow.requestType
    approvalFlowForm.workflowId = typeof flow.workflowId === 'string' ? flow.workflowId : ''
    approvalFlowForm.steps = formatApprovalSteps(flow.steps)
    approvalFlowForm.isActive = flow.isActive
    clearApprovalFlowWorkflowSyncPreview()
  }

  function syncApprovalFlowCollection(flow: AttendanceApprovalFlow) {
    approvalFlows.value = approvalFlows.value.some((item) => item.id === flow.id)
      ? approvalFlows.value.map((item) => (item.id === flow.id ? flow : item))
      : [flow, ...approvalFlows.value]

    if (approvalFlowEditingId.value === flow.id) {
      approvalFlowForm.workflowId = typeof flow.workflowId === 'string' ? flow.workflowId : ''
    }
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

  async function linkApprovalFlowWorkflow(flowId: string, workflowId: string | null) {
    try {
      const response = await apiFetch(`/api/attendance/approval-flows/${flowId}/workflow-link`, {
        method: 'PUT',
        body: JSON.stringify({
          workflowId,
          orgId: getOrgId(),
        }),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = await readJson<ApiEnvelope<AttendanceApprovalFlow>>(response)
      if (!response.ok || !data?.ok || !data.data) {
        throw new Error(data?.error?.message || tr('Failed to update approval flow workflow link', '更新审批流程工作流关联失败'))
      }
      adminForbidden.value = false
      syncApprovalFlowCollection(data.data)
      if (approvalFlowEditingId.value === flowId) {
        clearApprovalFlowWorkflowSyncPreview()
      }
      setStatus(
        workflowId
          ? tr('Workflow draft linked to approval flow.', '工作流草稿已关联到审批流程。')
          : tr('Workflow draft link cleared.', '审批流程工作流关联已清除。'),
      )
      return data.data
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to update approval flow workflow link', '更新审批流程工作流关联失败')
      setStatus(message, 'error')
      throw error
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
    approvalFlowBuilderSteps,
    approvalFlowBuilderError,
    approvalFlowWorkflowSyncLoading,
    approvalFlowWorkflowSyncError,
    approvalFlowWorkflowSyncPreview,
    approvalFlowBuilderSummary,
    approvalFlowTemplates,
    addApprovalFlowBuilderStep,
    removeApprovalFlowBuilderStep,
    applyApprovalFlowTemplate,
    clearApprovalFlowWorkflowSyncPreview,
    previewApprovalFlowWorkflowSync,
    applyApprovalFlowWorkflowSyncPreview,
    resetApprovalFlowForm,
    editApprovalFlow,
    loadApprovalFlows,
    saveApprovalFlow,
    deleteApprovalFlow,
    linkApprovalFlowWorkflow,
  }
}
