import { computed, reactive, ref, type Ref } from 'vue'
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

export interface AttendancePayrollSummaryFieldOption {
  code: string
  name: string
  unit: string
  formula?: boolean
  source?: string
}

interface AttendanceReportFieldPayload {
  items?: unknown[]
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
  summaryFieldCodes: string[]
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

export const ATTENDANCE_PAYROLL_SUMMARY_BASE_FIELD_OPTIONS: readonly AttendancePayrollSummaryFieldOption[] = Object.freeze([
  { code: 'total_minutes', name: '总工作分钟', unit: 'minutes', source: 'system' },
  { code: 'leave_minutes', name: '请假分钟', unit: 'minutes', source: 'system' },
  { code: 'overtime_minutes', name: '加班分钟', unit: 'minutes', source: 'system' },
  { code: 'total_late_minutes', name: '总迟到分钟', unit: 'minutes', source: 'system' },
  { code: 'total_early_leave_minutes', name: '总早退分钟', unit: 'minutes', source: 'system' },
  { code: 'total_days', name: '应出勤天数', unit: 'days', source: 'system' },
  { code: 'normal_days', name: '正常天数', unit: 'days', source: 'system' },
  { code: 'late_days', name: '迟到天数', unit: 'days', source: 'system' },
  { code: 'early_leave_days', name: '早退天数', unit: 'days', source: 'system' },
  { code: 'late_early_days', name: '迟到早退天数', unit: 'days', source: 'system' },
  { code: 'partial_days', name: '不完整天数', unit: 'days', source: 'system' },
  { code: 'absent_days', name: '旷工天数', unit: 'days', source: 'system' },
  { code: 'adjusted_days', name: '调整天数', unit: 'days', source: 'system' },
  { code: 'off_days', name: '休息天数', unit: 'days', source: 'system' },
  { code: 'expected_attendance_days', name: '应出勤天数', unit: 'days', source: 'system' },
  { code: 'attendance_days', name: '出勤天数', unit: 'days', source: 'system' },
  { code: 'rest_days', name: '休息天数', unit: 'days', source: 'system' },
  { code: 'work_duration', name: '工作时长', unit: 'minutes', source: 'system' },
  { code: 'late_count', name: '迟到次数', unit: 'count', source: 'system' },
  { code: 'late_duration', name: '迟到时长', unit: 'minutes', source: 'system' },
  { code: 'early_leave_count', name: '早退次数', unit: 'count', source: 'system' },
  { code: 'early_leave_duration', name: '早退时长', unit: 'minutes', source: 'system' },
  { code: 'absenteeism_days', name: '旷工天数', unit: 'days', source: 'system' },
  { code: 'leave_duration', name: '请假时长', unit: 'minutes', source: 'system' },
  { code: 'overtime_approval_duration', name: '加班审批时长', unit: 'minutes', source: 'system' },
])

function objectValue(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined
  return (source as Record<string, unknown>)[key]
}

function uniquePayrollSummaryFieldCodes(values: unknown[]): string[] {
  const seen = new Set<string>()
  const codes: string[] = []
  values.forEach((item) => {
    const candidate = item && typeof item === 'object'
      ? objectValue(item, 'code')
        ?? objectValue(item, 'fieldCode')
        ?? objectValue(item, 'field_code')
        ?? objectValue(item, 'metric')
      : item
    if (item && typeof item === 'object' && objectValue(item, 'enabled') === false) return
    const code = typeof candidate === 'string' ? candidate.trim() : ''
    if (!code || seen.has(code)) return
    seen.add(code)
    codes.push(code)
  })
  return codes
}

export function extractPayrollSummaryFieldCodes(config: Record<string, unknown> | null | undefined): string[] {
  const raw = objectValue(config, 'summaryFieldCodes')
    ?? objectValue(config, 'summaryFields')
    ?? objectValue(config, 'payrollSummaryFieldCodes')
    ?? objectValue(config, 'payrollSummaryFields')
    ?? objectValue(config, 'summary_field_codes')
    ?? objectValue(config, 'summary_fields')
  return Array.isArray(raw) ? uniquePayrollSummaryFieldCodes(raw) : []
}

export function applyPayrollSummaryFieldsToConfig(
  config: Record<string, unknown>,
  fieldCodes: string[],
): Record<string, unknown> {
  const next = { ...config }
  delete next.summaryFieldCodes
  delete next.summaryFields
  delete next.payrollSummaryFieldCodes
  delete next.payrollSummaryFields
  delete next.summary_field_codes
  delete next.summary_fields
  const codes = uniquePayrollSummaryFieldCodes(fieldCodes)
  if (codes.length > 0) {
    next.summaryFields = codes
  }
  return next
}

export function buildPayrollSummaryFieldOptionsFromReportFields(payload: unknown): AttendancePayrollSummaryFieldOption[] {
  const items = Array.isArray(objectValue(payload, 'items'))
    ? objectValue(payload, 'items') as unknown[]
    : []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const formulaEnabled = objectValue(item, 'formulaEnabled') === true
    const formulaScope = String(objectValue(item, 'formulaScope') || '').trim()
    const enabled = objectValue(item, 'enabled') !== false
    const visible = objectValue(item, 'reportVisible') !== false
    if (!formulaEnabled || formulaScope !== 'summary' || !enabled || !visible) return []
    const code = String(objectValue(item, 'code') || '').trim()
    if (!code) return []
    return [{
      code,
      name: String(objectValue(item, 'name') || code),
      unit: String(objectValue(item, 'unit') || objectValue(item, 'formulaOutputType') || 'text'),
      formula: true,
      source: String(objectValue(item, 'source') || 'formula'),
    }]
  })
}

export function mergePayrollSummaryFieldOptions(
  options: AttendancePayrollSummaryFieldOption[],
): AttendancePayrollSummaryFieldOption[] {
  const merged = new Map<string, AttendancePayrollSummaryFieldOption>()
  ATTENDANCE_PAYROLL_SUMMARY_BASE_FIELD_OPTIONS.forEach(option => merged.set(option.code, { ...option }))
  options.forEach((option) => {
    if (!option.code) return
    merged.set(option.code, {
      code: option.code,
      name: option.name || option.code,
      unit: option.unit || 'text',
      formula: option.formula === true,
      source: option.source || (option.formula ? 'formula' : 'system'),
    })
  })
  return [...merged.values()]
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
  const payrollSummaryFieldOptions = ref<AttendancePayrollSummaryFieldOption[]>(
    mergePayrollSummaryFieldOptions([]),
  )
  const payrollSummaryFieldOptionsLoading = ref(false)

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
    summaryFieldCodes: [],
  })

  const payrollSummarySelectedFieldOptions = computed(() => {
    const optionMap = new Map(payrollSummaryFieldOptions.value.map(option => [option.code, option]))
    return payrollTemplateForm.summaryFieldCodes.map(code => optionMap.get(code) ?? {
      code,
      name: code,
      unit: 'text',
      source: 'template',
    })
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

  const payrollCycleManualPeriodRequired = computed(() => !payrollCycleForm.templateId)
  const payrollCycleManualPeriodComplete = computed(() =>
    Boolean(payrollCycleForm.startDate && payrollCycleForm.endDate)
  )
  const payrollCycleCanSave = computed(() =>
    Boolean(payrollCycleForm.templateId) || payrollCycleManualPeriodComplete.value
  )
  const payrollCycleValidationHint = computed(() => {
    if (!payrollCycleManualPeriodRequired.value) return ''
    if (!payrollCycleForm.startDate && !payrollCycleForm.endDate) {
      return tr(
        'Select a payroll template, or enter both start and end dates for a manual cycle.',
        '请选择计薪模板，或为手工周期填写开始和结束日期。',
      )
    }
    if (!payrollCycleForm.startDate) {
      return tr(
        'Enter a start date for this manual payroll cycle.',
        '请填写手工计薪周期的开始日期。',
      )
    }
    if (!payrollCycleForm.endDate) {
      return tr(
        'Enter an end date for this manual payroll cycle.',
        '请填写手工计薪周期的结束日期。',
      )
    }
    return ''
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
    payrollTemplateForm.summaryFieldCodes = []
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
    payrollTemplateForm.summaryFieldCodes = extractPayrollSummaryFieldCodes(item.config)
  }

  function isPayrollSummaryFieldSelected(code: string): boolean {
    return payrollTemplateForm.summaryFieldCodes.includes(code)
  }

  function togglePayrollSummaryFieldCode(code: string, checked?: boolean) {
    const normalized = code.trim()
    if (!normalized) return
    const selected = isPayrollSummaryFieldSelected(normalized)
    const shouldSelect = checked ?? !selected
    if (shouldSelect && !selected) {
      payrollTemplateForm.summaryFieldCodes = [...payrollTemplateForm.summaryFieldCodes, normalized]
      return
    }
    if (!shouldSelect && selected) {
      payrollTemplateForm.summaryFieldCodes = payrollTemplateForm.summaryFieldCodes.filter(item => item !== normalized)
    }
  }

  function movePayrollSummaryFieldCode(code: string, direction: -1 | 1) {
    const index = payrollTemplateForm.summaryFieldCodes.indexOf(code)
    if (index < 0) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= payrollTemplateForm.summaryFieldCodes.length) return
    const next = [...payrollTemplateForm.summaryFieldCodes]
    const current = next[index]
    next[index] = next[nextIndex]
    next[nextIndex] = current
    payrollTemplateForm.summaryFieldCodes = next
  }

  async function loadPayrollSummaryFieldOptions() {
    payrollSummaryFieldOptionsLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const suffix = query.toString()
      const response = await apiFetch(`/api/attendance/report-fields${suffix ? `?${suffix}` : ''}`)
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const data = await readJson<ApiEnvelope<AttendanceReportFieldPayload>>(response)
      if (!response.ok || !data?.ok) {
        throw new Error(extractErrorMessage(data, tr('Failed to load payroll summary fields', '加载计薪汇总字段失败')))
      }
      adminForbidden.value = false
      payrollSummaryFieldOptions.value = mergePayrollSummaryFieldOptions(
        buildPayrollSummaryFieldOptionsFromReportFields(data.data),
      )
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load payroll summary fields', '加载计薪汇总字段失败')
      setStatus(message, 'error')
    } finally {
      payrollSummaryFieldOptionsLoading.value = false
    }
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
      if (!payrollTemplateForm.name.trim()) {
        throw new Error(tr('Payroll template name is required', '计薪模板名称为必填项'))
      }
      const config = parseJsonConfig(payrollTemplateForm.config)
      if (!config) {
        throw new Error(tr('Payroll template config must be valid JSON', '计薪模板配置必须是合法 JSON'))
      }
      const configWithSummaryFields = applyPayrollSummaryFieldsToConfig(
        config,
        payrollTemplateForm.summaryFieldCodes,
      )
      const payload = {
        name: payrollTemplateForm.name.trim(),
        timezone: payrollTemplateForm.timezone.trim() || defaultTimezone,
        startDay: Number(payrollTemplateForm.startDay) || 1,
        endDay: Number(payrollTemplateForm.endDay) || 30,
        endMonthOffset: Number(payrollTemplateForm.endMonthOffset) || 0,
        autoGenerate: payrollTemplateForm.autoGenerate,
        isDefault: payrollTemplateForm.isDefault,
        config: configWithSummaryFields,
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
    if (!payrollCycleCanSave.value) {
      setStatus(
        payrollCycleValidationHint.value || tr('Payroll cycle dates are required.', '计薪周期日期为必填项。'),
        'error',
      )
      return
    }

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
      const savedCycle = data.data ?? null
      const savedCycleId = savedCycle?.id ?? payrollCycleEditingId.value
      await loadPayrollCycles()
      const selectedCycle = savedCycleId
        ? payrollCycles.value.find(item => item.id === savedCycleId) ?? savedCycle
        : savedCycle
      if (selectedCycle?.id) {
        editPayrollCycle(selectedCycle)
      } else {
        resetPayrollCycleForm()
      }
      setStatus(tr('Payroll cycle saved and selected.', '计薪周期已保存并已选中。'))
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
    payrollSummaryFieldOptions,
    payrollSummaryFieldOptionsLoading,
    payrollSummarySelectedFieldOptions,
    payrollTemplateEditingId,
    payrollCycleEditingId,
    payrollCycleSummary,
    payrollTemplateForm,
    payrollCycleForm,
    payrollCycleGenerateForm,
    payrollCycleCanSave,
    payrollCycleManualPeriodRequired,
    payrollCycleValidationHint,
    payrollTemplateName,
    resetPayrollTemplateForm,
    editPayrollTemplate,
    isPayrollSummaryFieldSelected,
    togglePayrollSummaryFieldCode,
    movePayrollSummaryFieldCode,
    loadPayrollSummaryFieldOptions,
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
