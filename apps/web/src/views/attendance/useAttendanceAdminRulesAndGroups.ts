import { computed, reactive, ref, watch, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'
import { generateAttendanceCode } from './attendanceCode'

type ApiFetchFn = typeof baseApiFetch
type Translate = (en: string, zh: string) => string
type ConfirmFn = (message: string) => boolean
type SetStatusFn = (message: string, kind?: 'info' | 'error') => void

export interface AttendanceRuleSet {
  id: string
  orgId?: string
  name: string
  description?: string | null
  version: number
  scope: string
  config?: Record<string, any>
  isDefault: boolean
}

export interface AttendanceRuleTemplateVersion {
  id: string
  version: number
  createdAt?: string | null
  createdBy?: string | null
  sourceVersionId?: string | null
  itemCount?: number | null
  templates?: unknown[] | null
}

export interface AttendanceRuleBuilderState {
  source: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  workingDays: string
}

export interface AttendanceRuleSetPreviewInput {
  eventType: 'check_in' | 'check_out'
  occurredAt: string
  workDate?: string
  userId?: string
}

export interface AttendanceRuleSetPreviewItem {
  userId: string
  workDate: string
  firstInAt: string | null
  lastOutAt: string | null
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  status: string
  isWorkingDay?: boolean
  source?: unknown
}

export interface AttendanceRuleSetPreviewResult {
  ruleSetId: string | null
  totalEvents: number
  preview: AttendanceRuleSetPreviewItem[]
  config: Record<string, unknown>
  notes: string[]
}

export interface AttendanceRuleSetPreviewSummary {
  totalRows: number
  cleanRows: number
  flaggedRows: number
  lateRows: number
  earlyLeaveRows: number
  missingCheckInRows: number
  missingCheckOutRows: number
  nonWorkingDayRows: number
  abnormalStatusRows: number
  totalLateMinutes: number
  totalEarlyLeaveMinutes: number
  averageWorkMinutes: number
}

export interface AttendanceRuleSetPreviewRecommendation {
  key: 'raiseLateGrace' | 'raiseEarlyGrace' | 'reviewWorkingDays' | 'reviewMissingPunches' | 'reviewAbnormalStatuses'
  severity: 'info' | 'warning' | 'critical'
  affectedRows: number
  suggestedMinutes?: number
}

export interface AttendanceGroup {
  id: string
  orgId?: string
  name: string
  code?: string | null
  timezone: string
  ruleSetId?: string | null
  description?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface AttendanceGroupMember {
  id: string
  groupId: string
  userId: string
  createdAt?: string
}

interface ApiEnvelope<T> {
  ok?: boolean
  data?: T
  error?: {
    message?: string
  } | null
}

interface RuleSetListPayload {
  items?: AttendanceRuleSet[]
}

interface RuleTemplatesPayload {
  system?: unknown[]
  library?: unknown[]
  versions?: AttendanceRuleTemplateVersion[]
  templates?: unknown[]
}

interface RuleSetPreviewPayload {
  ruleSetId?: string | null
  totalEvents?: number
  preview?: unknown[]
  config?: Record<string, unknown>
  notes?: unknown[]
}

interface AttendanceGroupsPayload {
  items?: AttendanceGroup[]
}

interface AttendanceGroupMembersPayload {
  items?: AttendanceGroupMember[]
}

interface RuleSetFormState {
  name: string
  description: string
  version: number
  scope: string
  isDefault: boolean
  config: string
}

interface AttendanceGroupFormState {
  name: string
  code: string
  timezone: string
  ruleSetId: string
  description: string
}

export interface UseAttendanceAdminRulesAndGroupsOptions {
  tr: Translate
  adminForbidden?: Ref<boolean>
  apiFetch?: ApiFetchFn
  confirm?: ConfirmFn
  defaultTimezone: string
  getOrgId?: () => string | undefined
  setStatus?: SetStatusFn
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function defaultConfirm(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return window.confirm(message)
}

function parseJsonConfig(value: string): Record<string, any> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, any>
    return null
  } catch {
    return null
  }
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeNullableText(value: unknown): string | null {
  const text = normalizeText(value)
  return text.length > 0 ? text : null
}

function normalizeFiniteNumber(value: unknown, fallback = 0): number {
  const raw = typeof value === 'string' && value.trim().length === 0 ? Number.NaN : Number(value)
  return Number.isFinite(raw) ? raw : fallback
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function parseRuleBuilderWorkingDays(value: string): number[] {
  return Array.from(new Set(
    normalizeStringList(value)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6),
  ))
}

function formatRuleBuilderWorkingDays(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(', ')
  }
  return ''
}

function normalizeRuleSetPreviewInput(value: unknown): AttendanceRuleSetPreviewInput | null {
  const item = asObject(value)
  if (!item) return null
  const eventType = normalizeText(item.eventType)
  if (eventType !== 'check_in' && eventType !== 'check_out') return null
  const occurredAt = normalizeText(item.occurredAt)
  if (!occurredAt) return null
  const previewItem: AttendanceRuleSetPreviewInput = {
    eventType,
    occurredAt,
  }
  const workDate = normalizeNullableText(item.workDate)
  if (workDate) previewItem.workDate = workDate
  const userId = normalizeNullableText(item.userId)
  if (userId) previewItem.userId = userId
  return previewItem
}

function parseRuleSetPreviewInputs(value: string): AttendanceRuleSetPreviewInput[] | null {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    const previewInputs = parsed.map((item) => normalizeRuleSetPreviewInput(item))
    if (previewInputs.some((item) => item === null)) return null
    return previewInputs.filter((item): item is AttendanceRuleSetPreviewInput => item !== null)
  } catch {
    return null
  }
}

function normalizeRuleSetPreviewItem(value: unknown): AttendanceRuleSetPreviewItem | null {
  const item = asObject(value)
  if (!item) return null
  return {
    userId: normalizeText(item.userId) || 'unknown',
    workDate: normalizeText(item.workDate),
    firstInAt: normalizeNullableText(item.firstInAt),
    lastOutAt: normalizeNullableText(item.lastOutAt),
    workMinutes: normalizeFiniteNumber(item.workMinutes),
    lateMinutes: normalizeFiniteNumber(item.lateMinutes),
    earlyLeaveMinutes: normalizeFiniteNumber(item.earlyLeaveMinutes),
    status: normalizeText(item.status) || 'unknown',
    isWorkingDay: typeof item.isWorkingDay === 'boolean' ? item.isWorkingDay : undefined,
    source: item.source,
  }
}

function normalizeRuleSetPreviewResult(value: unknown): AttendanceRuleSetPreviewResult {
  const item = asObject(value) ?? {}
  const preview = Array.isArray(item.preview)
    ? item.preview.map((entry) => normalizeRuleSetPreviewItem(entry)).filter(
      (entry): entry is AttendanceRuleSetPreviewItem => entry !== null,
    )
    : []
  const config = asObject(item.config) ?? {}
  const totalEvents = normalizeFiniteNumber(item.totalEvents, preview.length)
  return {
    ruleSetId: normalizeNullableText(item.ruleSetId),
    totalEvents,
    preview,
    config,
    notes: normalizeStringList(item.notes),
  }
}

function isNormalPreviewStatus(status: string): boolean {
  const normalized = normalizeText(status).toLowerCase()
  return normalized.length === 0 || normalized === 'normal' || normalized === 'ok' || normalized === 'off' || normalized === 'adjusted'
}

export function summarizeRuleSetPreviewResult(value: AttendanceRuleSetPreviewResult | null | undefined): AttendanceRuleSetPreviewSummary {
  const rows = Array.isArray(value?.preview) ? value.preview : []
  const totalWorkMinutes = rows.reduce((total, row) => total + Math.max(0, normalizeFiniteNumber(row.workMinutes, 0)), 0)
  const totalLateMinutes = rows.reduce((total, row) => total + Math.max(0, normalizeFiniteNumber(row.lateMinutes, 0)), 0)
  const totalEarlyLeaveMinutes = rows.reduce((total, row) => total + Math.max(0, normalizeFiniteNumber(row.earlyLeaveMinutes, 0)), 0)
  const missingCheckInRows = rows.filter((row) => !normalizeNullableText(row.firstInAt)).length
  const missingCheckOutRows = rows.filter((row) => !normalizeNullableText(row.lastOutAt)).length
  const lateRows = rows.filter((row) => normalizeFiniteNumber(row.lateMinutes, 0) > 0).length
  const earlyLeaveRows = rows.filter((row) => normalizeFiniteNumber(row.earlyLeaveMinutes, 0) > 0).length
  const nonWorkingDayRows = rows.filter((row) => row.isWorkingDay === false).length
  const abnormalStatusRows = rows.filter((row) => !isNormalPreviewStatus(row.status)).length
  const flaggedRows = rows.filter((row) => (
    normalizeFiniteNumber(row.lateMinutes, 0) > 0
    || normalizeFiniteNumber(row.earlyLeaveMinutes, 0) > 0
    || !normalizeNullableText(row.firstInAt)
    || !normalizeNullableText(row.lastOutAt)
    || row.isWorkingDay === false
    || !isNormalPreviewStatus(row.status)
  )).length
  return {
    totalRows: rows.length,
    cleanRows: Math.max(0, rows.length - flaggedRows),
    flaggedRows,
    lateRows,
    earlyLeaveRows,
    missingCheckInRows,
    missingCheckOutRows,
    nonWorkingDayRows,
    abnormalStatusRows,
    totalLateMinutes,
    totalEarlyLeaveMinutes,
    averageWorkMinutes: rows.length > 0 ? Math.round(totalWorkMinutes / rows.length) : 0,
  }
}

export function buildRuleSetPreviewRecommendations(
  value: AttendanceRuleSetPreviewResult | null | undefined,
  builderState: AttendanceRuleBuilderState,
): AttendanceRuleSetPreviewRecommendation[] {
  const rows = Array.isArray(value?.preview) ? value.preview : []
  const summary = summarizeRuleSetPreviewResult(value)
  const recommendations: AttendanceRuleSetPreviewRecommendation[] = []
  const maxLateMinutes = rows.reduce((max, row) => Math.max(max, normalizeFiniteNumber(row.lateMinutes, 0)), 0)
  const maxEarlyLeaveMinutes = rows.reduce((max, row) => Math.max(max, normalizeFiniteNumber(row.earlyLeaveMinutes, 0)), 0)
  const currentLateGrace = Math.max(0, normalizeFiniteNumber(builderState.lateGraceMinutes, 0))
  const currentEarlyGrace = Math.max(0, normalizeFiniteNumber(builderState.earlyGraceMinutes, 0))

  if (summary.lateRows > 0 && maxLateMinutes > 0) {
    recommendations.push({
      key: 'raiseLateGrace',
      severity: maxLateMinutes >= 15 ? 'critical' : 'warning',
      affectedRows: summary.lateRows,
      suggestedMinutes: currentLateGrace + maxLateMinutes,
    })
  }

  if (summary.earlyLeaveRows > 0 && maxEarlyLeaveMinutes > 0) {
    recommendations.push({
      key: 'raiseEarlyGrace',
      severity: maxEarlyLeaveMinutes >= 15 ? 'critical' : 'warning',
      affectedRows: summary.earlyLeaveRows,
      suggestedMinutes: currentEarlyGrace + maxEarlyLeaveMinutes,
    })
  }

  if (summary.nonWorkingDayRows > 0) {
    recommendations.push({
      key: 'reviewWorkingDays',
      severity: 'warning',
      affectedRows: summary.nonWorkingDayRows,
    })
  }

  const missingPunchRows = summary.missingCheckInRows + summary.missingCheckOutRows
  if (missingPunchRows > 0) {
    recommendations.push({
      key: 'reviewMissingPunches',
      severity: summary.missingCheckOutRows > 0 ? 'critical' : 'warning',
      affectedRows: missingPunchRows,
    })
  }

  if (summary.abnormalStatusRows > 0) {
    recommendations.push({
      key: 'reviewAbnormalStatuses',
      severity: summary.abnormalStatusRows === rows.length ? 'critical' : 'info',
      affectedRows: summary.abnormalStatusRows,
    })
  }

  return recommendations
}

function parseTemplateLibrary(value: string): any[] | null {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const templates = (parsed as any).templates ?? (parsed as any).library
      if (Array.isArray(templates)) return templates
    }
    return null
  } catch {
    return null
  }
}

function validateTemplateLibrarySchema(templates: any[]): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  templates.forEach((template, index) => {
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      errors.push(`[${index}] template must be an object`)
      return
    }
    if (typeof template.name !== 'string' || template.name.trim().length === 0) {
      errors.push(`[${index}].name must be a non-empty string`)
    }
    if (!Array.isArray(template.rules)) {
      errors.push(`[${index}].rules must be an array`)
    } else {
      template.rules.forEach((rule: any, ruleIndex: number) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          errors.push(`[${index}].rules[${ruleIndex}] must be an object`)
        }
      })
    }
    if (template.params !== undefined && !Array.isArray(template.params)) {
      errors.push(`[${index}].params must be an array when provided`)
    } else if (Array.isArray(template.params)) {
      template.params.forEach((param: any, paramIndex: number) => {
        if (!param || typeof param !== 'object' || Array.isArray(param)) {
          errors.push(`[${index}].params[${paramIndex}] must be an object`)
        } else if (typeof param.key !== 'string' || param.key.trim().length === 0) {
          errors.push(`[${index}].params[${paramIndex}].key must be a non-empty string`)
        }
      })
    }
  })
  return { ok: errors.length === 0, errors }
}

function parseUserIdList(value: string): string[] {
  if (!value) return []
  return Array.from(new Set(
    value
      .split(/[\n,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ))
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

export function useAttendanceAdminRulesAndGroups({
  tr,
  adminForbidden,
  apiFetch = baseApiFetch,
  confirm = defaultConfirm,
  defaultTimezone,
  getOrgId = () => undefined,
  setStatus,
}: UseAttendanceAdminRulesAndGroupsOptions) {
  const adminForbiddenRef = adminForbidden ?? ref(false)
  const ruleSetLoading = ref(false)
  const ruleSetSaving = ref(false)
  const ruleTemplateLoading = ref(false)
  const ruleTemplateSaving = ref(false)
  const ruleTemplateRestoring = ref(false)
  const ruleTemplateVersionLoading = ref(false)
  const attendanceGroupLoading = ref(false)
  const attendanceGroupSaving = ref(false)
  const attendanceGroupMemberLoading = ref(false)
  const attendanceGroupMemberSaving = ref(false)

  const ruleSets = ref<AttendanceRuleSet[]>([])
  const ruleTemplateSystemText = ref('[]')
  const ruleTemplateLibraryText = ref('[]')
  const ruleTemplateVersions = ref<AttendanceRuleTemplateVersion[]>([])
  const selectedRuleTemplateVersionId = ref('')
  const attendanceGroups = ref<AttendanceGroup[]>([])
  const attendanceGroupMembers = ref<AttendanceGroupMember[]>([])

  const ruleSetEditingId = ref<string | null>(null)
  const attendanceGroupEditingId = ref<string | null>(null)
  const attendanceGroupMemberGroupId = ref('')
  const attendanceGroupMemberUserIds = ref('')

  const ruleSetForm = reactive<RuleSetFormState>({
    name: '',
    description: '',
    version: 1,
    scope: 'org',
    isDefault: false,
    config: '{}',
  })

  const attendanceGroupForm = reactive<AttendanceGroupFormState>({
    name: '',
    code: '',
    timezone: defaultTimezone,
    ruleSetId: '',
    description: '',
  })

  const selectedRuleTemplateVersion = computed(
    () => ruleTemplateVersions.value.find((item) => item.id === selectedRuleTemplateVersionId.value) ?? null,
  )

  const ruleBuilderSource = ref('')
  const ruleBuilderTimezone = ref(defaultTimezone)
  const ruleBuilderWorkStartTime = ref('09:00')
  const ruleBuilderWorkEndTime = ref('18:00')
  const ruleBuilderLateGraceMinutes = ref(10)
  const ruleBuilderEarlyGraceMinutes = ref(10)
  const ruleBuilderWorkingDays = ref('1, 2, 3, 4, 5')
  const ruleSetPreviewLoading = ref(false)
  const ruleSetPreviewError = ref('')
  const ruleSetPreviewEventsText = ref('[]')
  const ruleSetPreviewResult = ref<AttendanceRuleSetPreviewResult | null>(null)

  watch(
    () => attendanceGroupForm.name,
    (name) => {
      const trimmedName = name.trim()
      if (!trimmedName || attendanceGroupForm.code.trim().length > 0) return
      attendanceGroupForm.code = generateAttendanceCode(trimmedName, 'group')
    },
    { immediate: true },
  )

  watch(
    () => ruleSetForm.config,
    (config) => {
      syncRuleBuilderFromRuleSetConfig(config)
    },
    { immediate: true },
  )

  function resetRuleBuilderForm() {
    ruleBuilderSource.value = ''
    ruleBuilderTimezone.value = defaultTimezone
    ruleBuilderWorkStartTime.value = '09:00'
    ruleBuilderWorkEndTime.value = '18:00'
    ruleBuilderLateGraceMinutes.value = 10
    ruleBuilderEarlyGraceMinutes.value = 10
    ruleBuilderWorkingDays.value = '1, 2, 3, 4, 5'
  }

  function syncRuleBuilderFromRuleSetConfig(configInput: string | Record<string, unknown> | null | undefined = ruleSetForm.config) {
    const config = typeof configInput === 'string'
      ? parseJsonConfig(configInput)
      : (asObject(configInput) ?? {})
    if (!config) return false

    const rule = asObject(config.rule) ?? {}
    ruleBuilderSource.value = normalizeText(config.source ?? rule.source)
    ruleBuilderTimezone.value = normalizeText(rule.timezone) || defaultTimezone
    ruleBuilderWorkStartTime.value = normalizeText(rule.workStartTime) || '09:00'
    ruleBuilderWorkEndTime.value = normalizeText(rule.workEndTime) || '18:00'
    ruleBuilderLateGraceMinutes.value = Math.max(0, Math.floor(normalizeFiniteNumber(rule.lateGraceMinutes, 10)))
    ruleBuilderEarlyGraceMinutes.value = Math.max(0, Math.floor(normalizeFiniteNumber(rule.earlyGraceMinutes, 10)))
    ruleBuilderWorkingDays.value = formatRuleBuilderWorkingDays(rule.workingDays) || '1, 2, 3, 4, 5'
    return true
  }

  function buildRuleBuilderConfigDraft(baseConfig: Record<string, unknown> | null = null): Record<string, unknown> {
    const nextConfig: Record<string, unknown> = { ...(baseConfig ?? {}) }
    const rule = asObject(nextConfig.rule) ?? {}

    const source = ruleBuilderSource.value.trim()
    if (source.length > 0) {
      nextConfig.source = source
    } else {
      delete nextConfig.source
    }

    const timezone = ruleBuilderTimezone.value.trim()
    if (timezone.length > 0) {
      rule.timezone = timezone
    } else {
      delete rule.timezone
    }

    const workStartTime = ruleBuilderWorkStartTime.value.trim()
    if (workStartTime.length > 0) {
      rule.workStartTime = workStartTime
    } else {
      delete rule.workStartTime
    }

    const workEndTime = ruleBuilderWorkEndTime.value.trim()
    if (workEndTime.length > 0) {
      rule.workEndTime = workEndTime
    } else {
      delete rule.workEndTime
    }

    rule.lateGraceMinutes = Math.max(0, Math.floor(normalizeFiniteNumber(ruleBuilderLateGraceMinutes.value, 10)))
    rule.earlyGraceMinutes = Math.max(0, Math.floor(normalizeFiniteNumber(ruleBuilderEarlyGraceMinutes.value, 10)))

    const workingDays = parseRuleBuilderWorkingDays(ruleBuilderWorkingDays.value)
    if (workingDays.length > 0) {
      rule.workingDays = workingDays
    } else {
      delete rule.workingDays
    }

    if (Object.keys(rule).length > 0) {
      nextConfig.rule = rule
    } else {
      delete nextConfig.rule
    }

    return nextConfig
  }

  function applyRuleBuilderToRuleSetConfig() {
    const config = parseJsonConfig(ruleSetForm.config)
    if (!config) {
      throw new Error(tr('Rule set config must be valid JSON before applying builder changes', '应用构建器变更前，规则集配置必须是合法 JSON'))
    }
    const nextConfig = buildRuleBuilderConfigDraft(config)
    ruleSetForm.config = JSON.stringify(nextConfig, null, 2)
    syncRuleBuilderFromRuleSetConfig(nextConfig)
    return nextConfig
  }

  function resetRuleSetForm() {
    ruleSetEditingId.value = null
    ruleSetForm.name = ''
    ruleSetForm.description = ''
    ruleSetForm.version = 1
    ruleSetForm.scope = 'org'
    ruleSetForm.isDefault = false
    ruleSetForm.config = '{}'
    ruleSetPreviewError.value = ''
    ruleSetPreviewResult.value = null
    ruleSetPreviewEventsText.value = '[]'
    resetRuleBuilderForm()
  }

  function editRuleSet(item: AttendanceRuleSet) {
    ruleSetEditingId.value = item.id
    ruleSetForm.name = item.name
    ruleSetForm.description = item.description ?? ''
    ruleSetForm.version = item.version ?? 1
    ruleSetForm.scope = item.scope ?? 'org'
    ruleSetForm.isDefault = item.isDefault ?? false
    ruleSetForm.config = JSON.stringify(item.config ?? {}, null, 2)
    syncRuleBuilderFromRuleSetConfig(item.config ?? {})
    ruleSetPreviewResult.value = null
  }

  async function loadRuleSets() {
    ruleSetLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/rule-sets?${query.toString()}`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<RuleSetListPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load rule sets', '加载规则集失败')))
      }
      adminForbiddenRef.value = false
      ruleSets.value = Array.isArray(data.data?.items) ? data.data.items : []
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load rule sets', '加载规则集失败'), 'error')
    } finally {
      ruleSetLoading.value = false
    }
  }

  async function saveRuleSet() {
    ruleSetSaving.value = true
    try {
      if (!ruleSetForm.name.trim()) {
        throw new Error(tr('Rule set name is required', '规则集名称为必填项'))
      }
      const config = parseJsonConfig(ruleSetForm.config)
      if (!config) {
        throw new Error(tr('Rule set config must be valid JSON', '规则集配置必须是合法 JSON'))
      }

      const payload = {
        name: ruleSetForm.name.trim(),
        description: ruleSetForm.description.trim() || null,
        version: Number(ruleSetForm.version) || 1,
        scope: ruleSetForm.scope,
        isDefault: ruleSetForm.isDefault,
        config,
        orgId: getOrgId(),
      }
      const endpoint = ruleSetEditingId.value
        ? `/api/attendance/rule-sets/${ruleSetEditingId.value}`
        : '/api/attendance/rule-sets'
      const response = await apiFetch(endpoint, {
        method: ruleSetEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to save rule set', '保存规则集失败')))
      }

      adminForbiddenRef.value = false
      resetRuleSetForm()
      await loadRuleSets()
      setStatus?.(tr('Rule set saved.', '规则集已保存。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to save rule set', '保存规则集失败'), 'error')
    } finally {
      ruleSetSaving.value = false
    }
  }

  async function deleteRuleSet(id: string) {
    if (!confirm(tr('Delete this rule set?', '确认删除该规则集吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/rule-sets/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to delete rule set', '删除规则集失败')))
      }
      adminForbiddenRef.value = false
      await loadRuleSets()
      setStatus?.(tr('Rule set deleted.', '规则集已删除。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to delete rule set', '删除规则集失败'), 'error')
    }
  }

  async function loadRuleSetTemplate() {
    try {
      const response = await apiFetch('/api/attendance/rule-sets/template')
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<Record<string, unknown>> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load rule set template', '加载规则集模板失败')))
      }
      ruleSetForm.config = JSON.stringify(data.data ?? {}, null, 2)
      syncRuleBuilderFromRuleSetConfig(data.data ?? {})
      setStatus?.(tr('Rule set template loaded.', '规则集模板已加载。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load rule set template', '加载规则集模板失败'), 'error')
    }
  }

  async function previewRuleSet(options: {
    ruleSetId?: string | null
    config?: Record<string, unknown> | null
    events?: AttendanceRuleSetPreviewInput[] | null
  } = {}) {
    ruleSetPreviewLoading.value = true
    ruleSetPreviewError.value = ''
    try {
      const config = options.config ?? parseJsonConfig(ruleSetForm.config)
      if (!config) {
        throw new Error(tr('Rule set config must be valid JSON before previewing', '预览前，规则集配置必须是合法 JSON'))
      }

      const previewEvents = options.events ?? parseRuleSetPreviewInputs(ruleSetPreviewEventsText.value)
      if (!previewEvents) {
        throw new Error(tr('Preview events must be a valid JSON array', '预览事件必须是合法的 JSON 数组'))
      }

      const payload: Record<string, unknown> = { config }
      const ruleSetId = normalizeNullableText(options.ruleSetId ?? ruleSetEditingId.value)
      if (ruleSetId) {
        payload.ruleSetId = ruleSetId
      }
      if (previewEvents.length > 0) {
        payload.events = previewEvents
      }

      const response = await apiFetch('/api/attendance/rule-sets/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<RuleSetPreviewPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to preview rule set', '预览规则集失败')))
      }

      adminForbiddenRef.value = false
      const normalized = normalizeRuleSetPreviewResult(data.data)
      ruleSetPreviewResult.value = normalized
      if (normalized.config) {
        syncRuleBuilderFromRuleSetConfig(normalized.config)
      }
      setStatus?.(tr('Rule set preview loaded.', '规则集预览已加载。'))
      return normalized
    } catch (error: unknown) {
      ruleSetPreviewResult.value = null
      ruleSetPreviewError.value = (error as Error)?.message || tr('Failed to preview rule set', '预览规则集失败')
      setStatus?.(ruleSetPreviewError.value, 'error')
      return null
    } finally {
      ruleSetPreviewLoading.value = false
    }
  }

  async function loadRuleTemplates() {
    ruleTemplateLoading.value = true
    try {
      const response = await apiFetch('/api/attendance/rule-templates')
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<RuleTemplatesPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load rule templates', '加载规则模板失败')))
      }
      adminForbiddenRef.value = false
      ruleTemplateSystemText.value = JSON.stringify(Array.isArray(data.data?.system) ? data.data?.system : [], null, 2)
      ruleTemplateLibraryText.value = JSON.stringify(Array.isArray(data.data?.library) ? data.data?.library : [], null, 2)
      ruleTemplateVersions.value = Array.isArray(data.data?.versions) ? data.data.versions : []
      if (!ruleTemplateVersions.value.some((item) => item.id === selectedRuleTemplateVersionId.value)) {
        selectedRuleTemplateVersionId.value = ''
      }
      setStatus?.(tr('Rule templates loaded.', '规则模板已加载。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load rule templates', '加载规则模板失败'), 'error')
    } finally {
      ruleTemplateLoading.value = false
    }
  }

  async function saveRuleTemplates() {
    ruleTemplateSaving.value = true
    try {
      const templates = parseTemplateLibrary(ruleTemplateLibraryText.value)
      if (!templates) {
        throw new Error(tr('Template library must be valid JSON array', '模板库必须是合法 JSON 数组'))
      }
      const validation = validateTemplateLibrarySchema(templates)
      if (!validation.ok) {
        const preview = validation.errors.slice(0, 3).join('; ')
        throw new Error(tr(`Template schema errors: ${preview}`, `模板结构校验失败：${preview}`))
      }
      const response = await apiFetch('/api/attendance/rule-templates', {
        method: 'PUT',
        body: JSON.stringify({ templates }),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<RuleTemplatesPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to save rule templates', '保存规则模板失败')))
      }
      adminForbiddenRef.value = false
      ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? templates, null, 2)
      setStatus?.(tr('Rule templates saved.', '规则模板已保存。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to save rule templates', '保存规则模板失败'), 'error')
    } finally {
      ruleTemplateSaving.value = false
    }
  }

  async function restoreRuleTemplates(versionId: string) {
    if (!versionId) return
    if (!confirm(tr('Restore this template version? This will overwrite the current library.', '确认恢复该模板版本吗？当前模板库会被覆盖。'))) {
      return
    }
    ruleTemplateRestoring.value = true
    try {
      const response = await apiFetch('/api/attendance/rule-templates/restore', {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<RuleTemplatesPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to restore rule templates', '恢复规则模板失败')))
      }
      adminForbiddenRef.value = false
      ruleTemplateLibraryText.value = JSON.stringify(data.data?.templates ?? [], null, 2)
      await loadRuleTemplates()
      setStatus?.(tr('Rule templates restored.', '规则模板已恢复。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to restore rule templates', '恢复规则模板失败'), 'error')
    } finally {
      ruleTemplateRestoring.value = false
    }
  }

  function copySystemTemplates() {
    ruleTemplateLibraryText.value = ruleTemplateSystemText.value
    setStatus?.(tr('System templates copied to library.', '系统模板已复制到模板库。'))
  }

  async function openRuleTemplateVersion(versionId: string) {
    if (!versionId) return
    const current = ruleTemplateVersions.value.find((item) => item.id === versionId) ?? null
    if (current?.templates) {
      selectedRuleTemplateVersionId.value = versionId
      return
    }
    ruleTemplateVersionLoading.value = true
    try {
      const response = await apiFetch(`/api/attendance/rule-templates/versions/${encodeURIComponent(versionId)}`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceRuleTemplateVersion> | null
      if (!response.ok || !data?.ok || !data.data) {
        throw new Error(String(data?.error?.message || tr('Failed to load template version', '加载模板版本失败')))
      }
      ruleTemplateVersions.value = ruleTemplateVersions.value.map((item) => (
        item.id === versionId
          ? { ...item, ...data.data }
          : item
      ))
      selectedRuleTemplateVersionId.value = versionId
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load template version', '加载模板版本失败'), 'error')
    } finally {
      ruleTemplateVersionLoading.value = false
    }
  }

  function closeRuleTemplateVersionView() {
    selectedRuleTemplateVersionId.value = ''
  }

  function resetAttendanceGroupForm() {
    attendanceGroupEditingId.value = null
    attendanceGroupForm.name = ''
    attendanceGroupForm.code = ''
    attendanceGroupForm.timezone = defaultTimezone
    attendanceGroupForm.ruleSetId = ''
    attendanceGroupForm.description = ''
  }

  function editAttendanceGroup(item: AttendanceGroup) {
    attendanceGroupEditingId.value = item.id
    attendanceGroupForm.name = item.name
    attendanceGroupForm.code = item.code ?? ''
    attendanceGroupForm.timezone = item.timezone ?? defaultTimezone
    attendanceGroupForm.ruleSetId = item.ruleSetId ?? ''
    attendanceGroupForm.description = item.description ?? ''
  }

  function resolveRuleSetName(ruleSetId?: string | null): string {
    if (!ruleSetId) return tr('Default', '默认')
    return ruleSets.value.find((item) => item.id === ruleSetId)?.name ?? tr('Default', '默认')
  }

  async function loadAttendanceGroups() {
    attendanceGroupLoading.value = true
    try {
      const query = buildQuery({ orgId: getOrgId() })
      const response = await apiFetch(`/api/attendance/groups?${query.toString()}`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceGroupsPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load attendance groups', '加载考勤分组失败')))
      }
      adminForbiddenRef.value = false
      attendanceGroups.value = Array.isArray(data.data?.items) ? data.data.items : []
      const currentGroupExists = attendanceGroups.value.some((item) => item.id === attendanceGroupMemberGroupId.value)
      if (!currentGroupExists) {
        attendanceGroupMemberGroupId.value = attendanceGroups.value[0]?.id ?? ''
      }
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load attendance groups', '加载考勤分组失败'), 'error')
    } finally {
      attendanceGroupLoading.value = false
    }
  }

  async function saveAttendanceGroup() {
    attendanceGroupSaving.value = true
    try {
      const payload = {
        name: attendanceGroupForm.name.trim(),
        code: attendanceGroupForm.code.trim() || generateAttendanceCode(attendanceGroupForm.name, 'group'),
        timezone: attendanceGroupForm.timezone.trim() || defaultTimezone,
        ruleSetId: attendanceGroupForm.ruleSetId || null,
        description: attendanceGroupForm.description.trim() || null,
        orgId: getOrgId(),
      }
      if (!payload.name) {
        throw new Error(tr('Attendance group name is required', '考勤分组名称为必填项'))
      }
      const endpoint = attendanceGroupEditingId.value
        ? `/api/attendance/groups/${attendanceGroupEditingId.value}`
        : '/api/attendance/groups'
      const response = await apiFetch(endpoint, {
        method: attendanceGroupEditingId.value ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to save attendance group', '保存考勤分组失败')))
      }
      adminForbiddenRef.value = false
      resetAttendanceGroupForm()
      await loadAttendanceGroups()
      setStatus?.(tr('Attendance group saved.', '考勤分组已保存。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to save attendance group', '保存考勤分组失败'), 'error')
    } finally {
      attendanceGroupSaving.value = false
    }
  }

  async function loadAttendanceGroupMembers() {
    const groupId = attendanceGroupMemberGroupId.value
    if (!groupId) {
      attendanceGroupMembers.value = []
      return
    }
    attendanceGroupMemberLoading.value = true
    try {
      const response = await apiFetch(`/api/attendance/groups/${groupId}/members`)
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<AttendanceGroupMembersPayload> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to load group members', '加载分组成员失败')))
      }
      adminForbiddenRef.value = false
      attendanceGroupMembers.value = Array.isArray(data.data?.items) ? data.data.items : []
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load group members', '加载分组成员失败'), 'error')
    } finally {
      attendanceGroupMemberLoading.value = false
    }
  }

  async function addAttendanceGroupMembers() {
    const groupId = attendanceGroupMemberGroupId.value
    const userIds = parseUserIdList(attendanceGroupMemberUserIds.value)
    if (!groupId) {
      setStatus?.(tr('Select an attendance group first.', '请先选择考勤分组。'), 'error')
      return
    }
    if (userIds.length === 0) {
      setStatus?.(tr('Enter at least one user ID.', '请至少输入一个用户 ID。'), 'error')
      return
    }
    attendanceGroupMemberSaving.value = true
    try {
      const response = await apiFetch(`/api/attendance/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userIds }),
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to add group members', '添加分组成员失败')))
      }
      adminForbiddenRef.value = false
      attendanceGroupMemberUserIds.value = ''
      await loadAttendanceGroupMembers()
      setStatus?.(tr('Group members added.', '分组成员已添加。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to add group members', '添加分组成员失败'), 'error')
    } finally {
      attendanceGroupMemberSaving.value = false
    }
  }

  async function removeAttendanceGroupMember(userId: string) {
    const groupId = attendanceGroupMemberGroupId.value
    if (!groupId || !userId) return
    attendanceGroupMemberSaving.value = true
    try {
      const response = await apiFetch(`/api/attendance/groups/${groupId}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        return
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to remove group member', '移除分组成员失败')))
      }
      adminForbiddenRef.value = false
      await loadAttendanceGroupMembers()
      setStatus?.(tr('Group member removed.', '分组成员已移除。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to remove group member', '移除分组成员失败'), 'error')
    } finally {
      attendanceGroupMemberSaving.value = false
    }
  }

  async function deleteAttendanceGroup(id: string) {
    if (!confirm(tr('Delete this attendance group?', '确认删除该考勤分组吗？'))) return
    try {
      const response = await apiFetch(`/api/attendance/groups/${id}`, { method: 'DELETE' })
      if (response.status === 403) {
        adminForbiddenRef.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }
      const data = asObject(await response.json().catch(() => null)) as ApiEnvelope<unknown> | null
      if (!response.ok || !data?.ok) {
        throw new Error(String(data?.error?.message || tr('Failed to delete attendance group', '删除考勤分组失败')))
      }
      adminForbiddenRef.value = false
      await loadAttendanceGroups()
      setStatus?.(tr('Attendance group deleted.', '考勤分组已删除。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to delete attendance group', '删除考勤分组失败'), 'error')
    }
  }

  return {
    addAttendanceGroupMembers,
    applyRuleBuilderToRuleSetConfig,
    attendanceGroupEditingId,
    attendanceGroupForm,
    attendanceGroupLoading,
    attendanceGroupMemberGroupId,
    attendanceGroupMemberLoading,
    attendanceGroupMemberSaving,
    attendanceGroupMemberUserIds,
    attendanceGroupMembers,
    attendanceGroupSaving,
    attendanceGroups,
    copySystemTemplates,
    deleteAttendanceGroup,
    deleteRuleSet,
    editAttendanceGroup,
    editRuleSet,
    loadAttendanceGroupMembers,
    loadAttendanceGroups,
    loadRuleSetTemplate,
    loadRuleSets,
    loadRuleTemplates,
    removeAttendanceGroupMember,
    resetRuleBuilderForm,
    resetAttendanceGroupForm,
    resetRuleSetForm,
    resolveRuleSetName,
    restoreRuleTemplates,
    ruleBuilderSource,
    ruleBuilderTimezone,
    ruleBuilderLateGraceMinutes,
    ruleBuilderEarlyGraceMinutes,
    ruleBuilderWorkEndTime,
    ruleBuilderWorkStartTime,
    ruleBuilderWorkingDays,
    ruleSetEditingId,
    ruleSetForm,
    ruleSetLoading,
    ruleSetPreviewError,
    ruleSetPreviewEventsText,
    ruleSetPreviewLoading,
    ruleSetPreviewResult,
    ruleSetSaving,
    ruleSets,
    ruleTemplateLibraryText,
    ruleTemplateLoading,
    ruleTemplateRestoring,
    ruleTemplateSaving,
    ruleTemplateSystemText,
    ruleTemplateVersionLoading,
    ruleTemplateVersions,
    saveAttendanceGroup,
    saveRuleSet,
    saveRuleTemplates,
    previewRuleSet,
    resetRuleBuilder: resetRuleBuilderForm,
    selectedRuleTemplateVersion,
    selectedRuleTemplateVersionId,
    closeRuleTemplateVersionView,
    openRuleTemplateVersion,
    syncRuleBuilderFromRuleSetConfig,
  }
}
