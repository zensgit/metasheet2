import { reactive, ref, type Ref } from 'vue'
import { apiFetch as baseApiFetch } from '../../utils/api'

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
  const attendanceGroupLoading = ref(false)
  const attendanceGroupSaving = ref(false)
  const attendanceGroupMemberLoading = ref(false)
  const attendanceGroupMemberSaving = ref(false)

  const ruleSets = ref<AttendanceRuleSet[]>([])
  const ruleTemplateSystemText = ref('[]')
  const ruleTemplateLibraryText = ref('[]')
  const ruleTemplateVersions = ref<AttendanceRuleTemplateVersion[]>([])
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

  function resetRuleSetForm() {
    ruleSetEditingId.value = null
    ruleSetForm.name = ''
    ruleSetForm.description = ''
    ruleSetForm.version = 1
    ruleSetForm.scope = 'org'
    ruleSetForm.isDefault = false
    ruleSetForm.config = '{}'
  }

  function editRuleSet(item: AttendanceRuleSet) {
    ruleSetEditingId.value = item.id
    ruleSetForm.name = item.name
    ruleSetForm.description = item.description ?? ''
    ruleSetForm.version = item.version ?? 1
    ruleSetForm.scope = item.scope ?? 'org'
    ruleSetForm.isDefault = item.isDefault ?? false
    ruleSetForm.config = JSON.stringify(item.config ?? {}, null, 2)
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
      setStatus?.(tr('Rule set template loaded.', '规则集模板已加载。'))
    } catch (error: unknown) {
      setStatus?.((error as Error)?.message || tr('Failed to load rule set template', '加载规则集模板失败'), 'error')
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
        code: attendanceGroupForm.code.trim() || null,
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
    resetAttendanceGroupForm,
    resetRuleSetForm,
    resolveRuleSetName,
    restoreRuleTemplates,
    ruleSetEditingId,
    ruleSetForm,
    ruleSetLoading,
    ruleSetSaving,
    ruleSets,
    ruleTemplateLibraryText,
    ruleTemplateLoading,
    ruleTemplateRestoring,
    ruleTemplateSaving,
    ruleTemplateSystemText,
    ruleTemplateVersions,
    saveAttendanceGroup,
    saveRuleSet,
    saveRuleTemplates,
  }
}
