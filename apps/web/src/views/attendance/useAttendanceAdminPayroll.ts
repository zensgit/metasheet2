import { reactive, ref, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'

type ApiFetchFn = typeof baseApiFetch
type Translate = (en: string, zh: string) => string
type ConfirmFn = (message: string) => boolean
type SetStatusFn = (message: string, kind?: 'info' | 'error') => void
type DownloadFileFn = (blob: Blob, filename: string) => void

export interface AttendancePayrollTemplate {
  id: string
  orgId?: string
  name: string
  timezone: string
  startDay: number
  endDay: number
  endMonthOffset: number
  autoGenerate: boolean
  config?: Record<string, any>
  isDefault: boolean
}

export interface AttendancePayrollCycle {
  id: string
  orgId?: string
  templateId?: string | null
  name?: string | null
  startDate: string
  endDate: string
  status: string
  metadata?: Record<string, any>
}

export interface AttendancePayrollSummary {
  total_days: number
  total_minutes: number
  total_late_minutes?: number
  total_early_leave_minutes?: number
  normal_days: number
  late_days: number
  early_leave_days: number
  late_early_days: number
  partial_days: number
  absent_days: number
  adjusted_days: number
  off_days: number
  leave_minutes?: number
  overtime_minutes?: number
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

interface PayrollCycleGeneratePayload {
  created?: unknown[]
  skipped?: unknown[]
}

interface PayrollSummaryPayload {
  summary?: AttendancePayrollSummary | null
}

interface PayrollTemplateFormState {
  name: string
  timezone: string
  startDay: number
  endDay: number
  endMonthOffset: number
  autoGenerate: boolean
  isDefault: boolean
  config: string
}

interface PayrollCycleFormState {
  templateId: string
  name: string
  anchorDate: string
  startDate: string
  endDate: string
  status: string
}

interface PayrollCycleGenerateFormState {
  templateId: string
  anchorDate: string
  count: number
  status: string
  namePrefix: string
  metadata: string
}

export interface UseAttendanceAdminPayrollOptions {
  adminForbidden: Ref<boolean>
  tr: Translate
  defaultTimezone: string
  todayDate: string
  apiFetch?: ApiFetchFn
  confirm?: ConfirmFn
  downloadFile?: DownloadFileFn
  getOrgId?: () => string | undefined
  getUserId?: () => string | undefined
  setStatus?: SetStatusFn
}

function buildQuery(params: Record<string, string | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value && value.length > 0) {
      query.set(key, value)
    }
  })
  return query
}

async function readJson<T = unknown>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T
  } catch {
    return null
  }
}

function extractErrorMessage(payload: unknown, fallbackMessage: string): string {
  if (!payload || typeof payload !== 'object') return fallbackMessage
  const error = (payload as { error?: { message?: string } | null }).error
  if (error?.message && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  return fallbackMessage
}

function parseJsonConfig(value: string): Record<string, any> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>
    }
    return null
  } catch {
    return null
  }
}

function defaultConfirm(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return window.confirm(message)
}

function defaultDownloadFile(blob: Blob, filename: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function useAttendanceAdminPayroll({
  adminForbidden,
  tr,
  defaultTimezone,
  todayDate,
  apiFetch = baseApiFetch,
  confirm = defaultConfirm,
  downloadFile = defaultDownloadFile,
  getOrgId = () => undefined,
  getUserId = () => undefined,
  setStatus = () => undefined,
}: UseAttendanceAdminPayrollOptions) {
  const payrollTemplateLoading = ref(false)
  const payrollTemplateSaving = ref(false)
  const payrollCycleLoading = ref(false)
  const payrollCycleSaving = ref(false)
  const payrollCycleGenerating = ref(false)
  const payrollCycleGenerateResult = ref<{ created: number; skipped: number } | null>(null)

  const payrollTemplates = ref<AttendancePayrollTemplate[]>([])
  const payrollCycles = ref<AttendancePayrollCycle[]>([])

  const payrollTemplateEditingId = ref<string | null>(null)
  const payrollCycleEditingId = ref<string | null>(null)
  const payrollCycleSummary = ref<AttendancePayrollSummary | null>(null)

  const payrollTemplateForm = reactive<PayrollTemplateFormState>({
    name: '',
    timezone: defaultTimezone,
    startDay: 1,
    endDay: 30,
    endMonthOffset: 0,
    autoGenerate: true,
    isDefault: false,
    config: '{}',
  })

  const payrollCycleForm = reactive<PayrollCycleFormState>({
    templateId: '',
    name: '',
    anchorDate: '',
    startDate: '',
    endDate: '',
    status: 'open',
  })

  const payrollCycleGenerateForm = reactive<PayrollCycleGenerateFormState>({
    templateId: '',
    anchorDate: todayDate,
    count: 1,
    status: 'open',
    namePrefix: '',
    metadata: '{}',
  })

  function resetPayrollTemplateForm() {
    payrollTemplateEditingId.value = null
    payrollTemplateForm.name = ''
    payrollTemplateForm.timezone = defaultTimezone
    payrollTemplateForm.startDay = 1
    payrollTemplateForm.endDay = 30
    payrollTemplateForm.endMonthOffset = 0
    payrollTemplateForm.autoGenerate = true
    payrollTemplateForm.isDefault = false
    payrollTemplateForm.config = '{}'
  }

  function editPayrollTemplate(item: AttendancePayrollTemplate) {
    payrollTemplateEditingId.value = item.id
    payrollTemplateForm.name = item.name
    payrollTemplateForm.timezone = item.timezone
    payrollTemplateForm.startDay = item.startDay
    payrollTemplateForm.endDay = item.endDay
    payrollTemplateForm.endMonthOffset = item.endMonthOffset
    payrollTemplateForm.autoGenerate = item.autoGenerate
    payrollTemplateForm.isDefault = item.isDefault
    payrollTemplateForm.config = JSON.stringify(item.config ?? {}, null, 2)
  }

  async function loadPayrollTemplates() {
    payrollTemplateLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/payroll-templates?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceItemListPayload<AttendancePayrollTemplate>>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to load payroll templates', '加载计薪模板失败')))
      }
      adminForbidden.value = false
      payrollTemplates.value = data.data?.items ?? []
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load payroll templates', '加载计薪模板失败')
      setStatus(message, 'error')
    } finally {
      payrollTemplateLoading.value = false
    }
  }

  async function savePayrollTemplate() {
    payrollTemplateSaving.value = true
    try {
      const config = parseJsonConfig(payrollTemplateForm.config)
      if (!config) {
        throw new Error(tr('Payroll template config must be valid JSON', '计薪模板配置必须是合法 JSON'))
      }
      const payload = {
        name: payrollTemplateForm.name.trim(),
        timezone: payrollTemplateForm.timezone.trim() || defaultTimezone,
        startDay: Number(payrollTemplateForm.startDay) || 1,
        endDay: Number(payrollTemplateForm.endDay) || 30,
        endMonthOffset: Number(payrollTemplateForm.endMonthOffset) || 0,
        autoGenerate: payrollTemplateForm.autoGenerate,
        isDefault: payrollTemplateForm.isDefault,
        config,
        orgId: getOrgId(),
      }
      const isEditing = Boolean(payrollTemplateEditingId.value)
      const response = await apiFetch(
        isEditing
          ? `/api/attendance/payroll-templates/${payrollTemplateEditingId.value}`
          : '/api/attendance/payroll-templates',
        {
          method: isEditing ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        },
      )
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<AttendancePayrollTemplate>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to save payroll template', '保存计薪模板失败')))
      }
      adminForbidden.value = false
      resetPayrollTemplateForm()
      await loadPayrollTemplates()
      setStatus(tr('Payroll template saved.', '计薪模板已保存。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to save payroll template', '保存计薪模板失败')
      setStatus(message, 'error')
    } finally {
      payrollTemplateSaving.value = false
    }
  }

  async function deletePayrollTemplate(id: string) {
    if (!confirm(tr('Delete this payroll template?', '确认删除该计薪模板吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/payroll-templates/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<AttendancePayrollTemplate>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to delete payroll template', '删除计薪模板失败')))
      }
      adminForbidden.value = false
      await loadPayrollTemplates()
      setStatus(tr('Payroll template deleted.', '计薪模板已删除。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to delete payroll template', '删除计薪模板失败')
      setStatus(message, 'error')
    }
  }

  function resetPayrollCycleForm() {
    payrollCycleEditingId.value = null
    payrollCycleForm.templateId = ''
    payrollCycleForm.name = ''
    payrollCycleForm.anchorDate = ''
    payrollCycleForm.startDate = ''
    payrollCycleForm.endDate = ''
    payrollCycleForm.status = 'open'
    payrollCycleSummary.value = null
  }

  function resetPayrollCycleGenerateForm() {
    payrollCycleGenerateForm.templateId = ''
    payrollCycleGenerateForm.anchorDate = todayDate
    payrollCycleGenerateForm.count = 1
    payrollCycleGenerateForm.status = 'open'
    payrollCycleGenerateForm.namePrefix = ''
    payrollCycleGenerateForm.metadata = '{}'
    payrollCycleGenerateResult.value = null
  }

  function editPayrollCycle(item: AttendancePayrollCycle) {
    payrollCycleEditingId.value = item.id
    payrollCycleForm.templateId = item.templateId ?? ''
    payrollCycleForm.name = item.name ?? ''
    payrollCycleForm.anchorDate = ''
    payrollCycleForm.startDate = item.startDate
    payrollCycleForm.endDate = item.endDate
    payrollCycleForm.status = item.status ?? 'open'
    payrollCycleSummary.value = null
  }

  async function loadPayrollCycles() {
    payrollCycleLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/payroll-cycles?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceItemListPayload<AttendancePayrollCycle>>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to load payroll cycles', '加载计薪周期失败')))
      }
      adminForbidden.value = false
      payrollCycles.value = data.data?.items ?? []
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load payroll cycles', '加载计薪周期失败')
      setStatus(message, 'error')
    } finally {
      payrollCycleLoading.value = false
    }
  }

  async function generatePayrollCycles() {
    payrollCycleGenerating.value = true
    try {
      const anchorDate = payrollCycleGenerateForm.anchorDate
      if (!anchorDate) {
        throw new Error(tr('Anchor date is required for generation', '生成周期需要锚点日期'))
      }
      const metadata = parseJsonConfig(payrollCycleGenerateForm.metadata)
      if (!metadata) {
        throw new Error(tr('Metadata must be valid JSON', '元数据必须是合法 JSON'))
      }
      const payload: Record<string, any> = {
        templateId: payrollCycleGenerateForm.templateId || undefined,
        anchorDate,
        count: payrollCycleGenerateForm.count,
        status: payrollCycleGenerateForm.status,
        namePrefix: payrollCycleGenerateForm.namePrefix.trim() || undefined,
        metadata,
        orgId: getOrgId(),
      }
      const response = await apiFetch('/api/attendance/payroll-cycles/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<PayrollCycleGeneratePayload>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to generate payroll cycles', '生成计薪周期失败')))
      }
      const created = Array.isArray(data.data?.created) ? data.data.created.length : 0
      const skipped = Array.isArray(data.data?.skipped) ? data.data.skipped.length : 0
      payrollCycleGenerateResult.value = { created, skipped }
      adminForbidden.value = false
      await loadPayrollCycles()
      setStatus(tr('Payroll cycles generated.', '计薪周期已生成。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to generate payroll cycles', '生成计薪周期失败')
      setStatus(message, 'error')
    } finally {
      payrollCycleGenerating.value = false
    }
  }

  async function savePayrollCycle() {
    payrollCycleSaving.value = true
    try {
      const payload: Record<string, any> = {
        templateId: payrollCycleForm.templateId || undefined,
        name: payrollCycleForm.name.trim() || undefined,
        anchorDate: payrollCycleForm.anchorDate || undefined,
        startDate: payrollCycleForm.startDate || undefined,
        endDate: payrollCycleForm.endDate || undefined,
        status: payrollCycleForm.status,
        orgId: getOrgId(),
      }
      const isEditing = Boolean(payrollCycleEditingId.value)
      const response = await apiFetch(
        isEditing
          ? `/api/attendance/payroll-cycles/${payrollCycleEditingId.value}`
          : '/api/attendance/payroll-cycles',
        {
          method: isEditing ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        },
      )
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<AttendancePayrollCycle>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to save payroll cycle', '保存计薪周期失败')))
      }
      adminForbidden.value = false
      resetPayrollCycleForm()
      await loadPayrollCycles()
      setStatus(tr('Payroll cycle saved.', '计薪周期已保存。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to save payroll cycle', '保存计薪周期失败')
      setStatus(message, 'error')
    } finally {
      payrollCycleSaving.value = false
    }
  }

  async function deletePayrollCycle(id: string) {
    if (!confirm(tr('Delete this payroll cycle?', '确认删除该计薪周期吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/payroll-cycles/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<AttendancePayrollCycle>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to delete payroll cycle', '删除计薪周期失败')))
      }
      adminForbidden.value = false
      await loadPayrollCycles()
      payrollCycleSummary.value = null
      setStatus(tr('Payroll cycle deleted.', '计薪周期已删除。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to delete payroll cycle', '删除计薪周期失败')
      setStatus(message, 'error')
    }
  }

  async function loadPayrollCycleSummary() {
    const cycleId = payrollCycleEditingId.value
    if (!cycleId) {
      setStatus(tr('Select or create a payroll cycle first.', '请先选择或创建计薪周期。'), 'error')
      return
    }
    try {
      const query = buildQuery({ orgId: getOrgId(), userId: getUserId() })
      const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary?${query.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error('Admin permissions required')
      }
      const data = await readJson<ApiEnvelope<PayrollSummaryPayload>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to load payroll summary', '加载计薪汇总失败')))
      }
      adminForbidden.value = false
      payrollCycleSummary.value = data.data?.summary ?? null
      setStatus(tr('Payroll summary loaded.', '计薪汇总已加载。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load payroll summary', '加载计薪汇总失败')
      setStatus(message, 'error')
    }
  }

  async function exportPayrollCycleSummary() {
    const cycleId = payrollCycleEditingId.value
    if (!cycleId) {
      setStatus(tr('Select or create a payroll cycle first.', '请先选择或创建计薪周期。'), 'error')
      return
    }
    try {
      const query = buildQuery({ orgId: getOrgId(), userId: getUserId() })
      const response = await apiFetch(`/api/attendance/payroll-cycles/${cycleId}/summary/export?${query.toString()}`)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || tr('Failed to export payroll summary', '导出计薪汇总失败'))
      }
      const blob = await response.blob()
      downloadFile(blob, `payroll-cycle-${cycleId}.csv`)
      setStatus(tr('Payroll summary exported.', '计薪汇总已导出。'))
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to export payroll summary', '导出计薪汇总失败')
      setStatus(message, 'error')
    }
  }

  function payrollTemplateName(templateId?: string | null): string {
    if (!templateId) return tr('Manual', '手工')
    const found = payrollTemplates.value.find(item => item.id === templateId)
    return found?.name ?? templateId
  }

  return {
    payrollTemplateLoading,
    payrollTemplateSaving,
    payrollCycleLoading,
    payrollCycleSaving,
    payrollCycleGenerating,
    payrollCycleGenerateResult,
    payrollTemplates,
    payrollCycles,
    payrollTemplateEditingId,
    payrollCycleEditingId,
    payrollCycleSummary,
    payrollTemplateForm,
    payrollCycleForm,
    payrollCycleGenerateForm,
    payrollTemplateName,
    resetPayrollTemplateForm,
    editPayrollTemplate,
    loadPayrollTemplates,
    savePayrollTemplate,
    deletePayrollTemplate,
    resetPayrollCycleForm,
    resetPayrollCycleGenerateForm,
    editPayrollCycle,
    loadPayrollCycles,
    generatePayrollCycles,
    savePayrollCycle,
    deletePayrollCycle,
    loadPayrollCycleSummary,
    exportPayrollCycleSummary,
  }
}
