import { computed, reactive, ref, watch, type Ref } from 'vue'
import { apiFetch } from '../../utils/api'

type ProvisionRole = 'employee' | 'approver' | 'admin'
type ProvisionStatusKind = 'info' | 'error'
type Translate = (en: string, zh: string) => string

interface PermissionUserResponse {
  userId: string
  permissions: string[]
  isAdmin: boolean
  degraded?: boolean
}

interface AttendanceAdminUserSearchItem {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
}

interface AttendanceAdminUserProfileSummary {
  id: string
  email: string
  name: string | null
}

interface AttendanceAdminBatchResolveItem {
  id: string
  email: string
  name: string | null
  is_active: boolean
}

interface AttendanceAdminRoleTemplate {
  id: ProvisionRole
  roleId: string
  permissions: string[]
  description: string
}

interface AttendanceAdminBatchResolvePayload {
  requested: number
  items: AttendanceAdminBatchResolveItem[]
  missing: string[]
  inactive: string[]
  affected: string[]
  unchanged: string[]
}

interface UseAttendanceAdminProvisioningOptions {
  adminForbidden: Ref<boolean>
  tr: Translate
}

const PROVISION_STATUS_TIMEOUT_MS = 6000
const PROVISION_ROLE_PERMISSIONS: Record<ProvisionRole, string[]> = {
  employee: ['attendance:read', 'attendance:write'],
  approver: ['attendance:read', 'attendance:approve'],
  admin: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin'],
}

function setTimedMessage(messageRef: Ref<string>, kindRef: Ref<ProvisionStatusKind>, message: string, kind: ProvisionStatusKind) {
  kindRef.value = kind
  messageRef.value = message
  if (!message) return
  globalThis.setTimeout(() => {
    if (messageRef.value === message) {
      messageRef.value = ''
    }
  }, PROVISION_STATUS_TIMEOUT_MS)
}

export function isAttendanceAdminUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
}

export function parseAttendanceAdminUserIdList(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = String(raw || '')
    .split(/[,\s;]+/g)
    .map((value) => value.trim())
    .filter(Boolean)

  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    if (isAttendanceAdminUuid(token)) {
      valid.push(token)
    } else {
      invalid.push(token)
    }
  }

  return { valid, invalid }
}

export function normalizeAttendanceAdminUserProfile(
  value: unknown,
  fallbackUserId: string,
): AttendanceAdminUserProfileSummary | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = String(raw.id || raw.userId || raw.user_id || fallbackUserId || '')
  const email = String(raw.email || '')
  const name = raw.name === null || raw.name === undefined ? null : String(raw.name)
  if (!id || !email) return null
  return { id, email, name }
}

export function normalizeAttendanceAdminBatchResolvePayload(
  payload: unknown,
  requestedUserIds: string[],
): AttendanceAdminBatchResolvePayload {
  const rawPayload = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {}
  const requested = Number(rawPayload.requested ?? requestedUserIds.length) || requestedUserIds.length
  const itemsRaw = Array.isArray(rawPayload.items) ? rawPayload.items : []
  const items: AttendanceAdminBatchResolveItem[] = []
  const seen = new Set<string>()

  for (const entry of itemsRaw) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const id = String(raw.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    items.push({
      id,
      email: String(raw.email || ''),
      name: raw.name === null || raw.name === undefined ? null : String(raw.name),
      is_active: Boolean(raw.is_active),
    })
  }

  const fallbackMissing = requestedUserIds.filter((userId) => !seen.has(userId))
  const missingRaw = Array.isArray(rawPayload.missingUserIds)
    ? rawPayload.missingUserIds.map((value) => String(value || '').trim())
    : fallbackMissing
  const inactiveRaw = Array.isArray(rawPayload.inactiveUserIds)
    ? rawPayload.inactiveUserIds.map((value) => String(value || '').trim())
    : items.filter((item) => !item.is_active).map((item) => item.id)
  const affectedRaw = Array.isArray(rawPayload.affectedUserIds)
    ? rawPayload.affectedUserIds.map((value) => String(value || '').trim())
    : []
  const unchangedRaw = Array.isArray(rawPayload.unchangedUserIds)
    ? rawPayload.unchangedUserIds.map((value) => String(value || '').trim())
    : []

  return {
    requested,
    items,
    missing: Array.from(new Set(missingRaw.filter(Boolean))),
    inactive: Array.from(new Set(inactiveRaw.filter(Boolean))),
    affected: Array.from(new Set(affectedRaw.filter(Boolean))),
    unchanged: Array.from(new Set(unchangedRaw.filter(Boolean))),
  }
}

export function useAttendanceAdminProvisioning({ adminForbidden, tr }: UseAttendanceAdminProvisioningOptions) {
  const provisionLoading = ref(false)
  const provisionHasLoaded = ref(false)
  const provisionStatusMessage = ref('')
  const provisionStatusKind = ref<ProvisionStatusKind>('info')
  const provisionPermissions = ref<string[]>([])
  const provisionUserIsAdmin = ref(false)
  const provisionRoles = ref<string[]>([])
  const provisionUserProfile = ref<AttendanceAdminUserProfileSummary | null>(null)
  const provisionRoleTemplates = ref<AttendanceAdminRoleTemplate[]>([])
  const provisionSearchQuery = ref('')
  const provisionSearchResults = ref<AttendanceAdminUserSearchItem[]>([])
  const provisionSearchLoading = ref(false)
  const provisionSearchHasSearched = ref(false)
  const provisionSearchPage = ref(1)
  const provisionSearchTotal = ref(0)
  const provisionSearchPageSize = 10
  const provisionSearchHasNext = computed(() => {
    return provisionSearchPage.value * provisionSearchPageSize < provisionSearchTotal.value
  })
  const provisionBatchLoading = ref(false)
  const provisionBatchPreviewLoading = ref(false)
  const provisionBatchUserIdsText = ref('')
  const provisionBatchRole = ref<ProvisionRole>('employee')
  const provisionBatchStatusMessage = ref('')
  const provisionBatchStatusKind = ref<ProvisionStatusKind>('info')
  const provisionBatchParsed = computed(() => parseAttendanceAdminUserIdList(provisionBatchUserIdsText.value))
  const provisionBatchIds = computed(() => provisionBatchParsed.value.valid)
  const provisionBatchInvalidIds = computed(() => provisionBatchParsed.value.invalid)
  const provisionBatchPreviewRequested = ref(0)
  const provisionBatchPreviewItems = ref<AttendanceAdminBatchResolveItem[]>([])
  const provisionBatchPreviewMissingIds = ref<string[]>([])
  const provisionBatchPreviewInactiveIds = ref<string[]>([])
  const provisionBatchAffectedIds = ref<string[]>([])
  const provisionBatchUnchangedIds = ref<string[]>([])
  const provisionBatchPreviewHasResult = computed(() => {
    return provisionBatchPreviewRequested.value > 0
      || provisionBatchPreviewItems.value.length > 0
      || provisionBatchPreviewMissingIds.value.length > 0
  })
  const provisionForm = reactive({
    userId: '',
    role: 'employee' as ProvisionRole,
  })

  function setProvisionStatus(message: string, kind: ProvisionStatusKind = 'info') {
    setTimedMessage(provisionStatusMessage, provisionStatusKind, message, kind)
  }

  function setProvisionBatchStatus(message: string, kind: ProvisionStatusKind = 'info') {
    setTimedMessage(provisionBatchStatusMessage, provisionBatchStatusKind, message, kind)
  }

  function applyProvisionBatchResolvePayload(payload: unknown, requestedUserIds: string[]) {
    const normalized = normalizeAttendanceAdminBatchResolvePayload(payload, requestedUserIds)
    provisionBatchPreviewRequested.value = normalized.requested
    provisionBatchPreviewItems.value = normalized.items
    provisionBatchPreviewMissingIds.value = normalized.missing
    provisionBatchPreviewInactiveIds.value = normalized.inactive
    provisionBatchAffectedIds.value = normalized.affected
    provisionBatchUnchangedIds.value = normalized.unchanged
  }

  function clearProvisionBatchPreview() {
    provisionBatchPreviewRequested.value = 0
    provisionBatchPreviewItems.value = []
    provisionBatchPreviewMissingIds.value = []
    provisionBatchPreviewInactiveIds.value = []
    provisionBatchAffectedIds.value = []
    provisionBatchUnchangedIds.value = []
  }

  function applyProvisionAccessPayload(payload: unknown, fallbackUserId: string) {
    const raw = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {}
    provisionPermissions.value = Array.isArray(raw.permissions) ? raw.permissions.map((value) => String(value)) : []
    provisionUserIsAdmin.value = Boolean(raw.isAdmin)
    provisionRoles.value = Array.isArray(raw.roles) ? raw.roles.map((value) => String(value)) : []
    provisionUserProfile.value = normalizeAttendanceAdminUserProfile(raw.user, fallbackUserId)
  }

  async function loadProvisionRoleTemplates() {
    try {
      const response = await apiFetch('/api/attendance-admin/role-templates')
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      if (response.status === 404) return
      const data = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok || !data?.ok) return
      const templates = Array.isArray((data.data as Record<string, unknown> | undefined)?.templates)
        ? (data.data as Record<string, unknown>).templates as AttendanceAdminRoleTemplate[]
        : []
      provisionRoleTemplates.value = templates
    } catch {
      // Non-blocking: the UI still supports the built-in role ids.
    }
  }

  async function searchProvisionUsers(page: number) {
    const query = provisionSearchQuery.value.trim()
    provisionSearchHasSearched.value = true
    if (!query) {
      provisionSearchResults.value = []
      provisionSearchTotal.value = 0
      provisionSearchPage.value = 1
      setProvisionStatus(tr('Enter a search query (email/name/id).', '请输入搜索关键词（邮箱/姓名/ID）。'), 'error')
      return
    }

    provisionSearchLoading.value = true
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(provisionSearchPageSize),
      })
      const response = await apiFetch(`/api/attendance-admin/users/search?${params.toString()}`)
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok || !data?.ok) {
        const error = data?.error as Record<string, unknown> | undefined
        throw new Error(String(error?.message || tr('Failed to search users', '搜索用户失败')))
      }

      const payload = data.data as Record<string, unknown> | undefined
      const items = Array.isArray(payload?.items) ? payload.items as AttendanceAdminUserSearchItem[] : []
      provisionSearchResults.value = items
      provisionSearchTotal.value = Number(payload?.total ?? items.length) || 0
      provisionSearchPage.value = Number(payload?.page ?? page) || page
    } catch (error: unknown) {
      setProvisionStatus((error as Error)?.message || tr('Failed to search users', '搜索用户失败'), 'error')
    } finally {
      provisionSearchLoading.value = false
    }
  }

  function selectProvisionUser(user: AttendanceAdminUserSearchItem) {
    provisionForm.userId = user.id
    provisionUserProfile.value = { id: user.id, email: user.email, name: user.name }
    provisionHasLoaded.value = true
    void loadProvisioningUser()
  }

  async function fetchProvisioningUser(userId: string) {
    provisionRoles.value = []
    const response = await apiFetch(`/api/permissions/user/${encodeURIComponent(userId)}`)
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }
    const data = await response.json() as PermissionUserResponse & Record<string, unknown>
    if (!response.ok) {
      throw new Error(String(data.error || data.message || tr('Failed to load permissions', '加载权限失败')))
    }
    provisionPermissions.value = Array.isArray(data.permissions) ? data.permissions : []
    provisionUserIsAdmin.value = Boolean(data.isAdmin)
  }

  async function fetchProvisioningUserAccess(userId: string) {
    const response = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/access`)
    if (response.status === 404) {
      await fetchProvisioningUser(userId)
      return
    }
    if (response.status === 403) {
      adminForbidden.value = true
      throw new Error(tr('Admin permissions required', '需要管理员权限'))
    }

    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok || !data?.ok) {
      const error = data?.error as Record<string, unknown> | undefined
      throw new Error(String(error?.message || tr('Failed to load user access', '加载用户访问权限失败')))
    }
    applyProvisionAccessPayload(data.data, userId)
  }

  async function loadProvisioningUser() {
    const userId = provisionForm.userId.trim()
    provisionHasLoaded.value = true
    if (!isAttendanceAdminUuid(userId)) {
      setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
      return
    }

    provisionLoading.value = true
    try {
      await fetchProvisioningUserAccess(userId)
      setProvisionStatus(
        tr(`Loaded ${provisionPermissions.value.length} permission(s).`, `已加载 ${provisionPermissions.value.length} 项权限。`),
      )
    } catch (error: unknown) {
      setProvisionStatus((error as Error)?.message || tr('Failed to load permissions', '加载权限失败'), 'error')
    } finally {
      provisionLoading.value = false
    }
  }

  async function grantProvisioningRole() {
    const userId = provisionForm.userId.trim()
    provisionHasLoaded.value = true
    if (!isAttendanceAdminUuid(userId)) {
      setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
      return
    }

    provisionLoading.value = true
    try {
      const role = provisionForm.role
      const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/assign`, {
        method: 'POST',
        body: JSON.stringify({ template: role }),
      })
      if (modern.status !== 404) {
        if (modern.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const modernData = await modern.json().catch(() => null) as Record<string, unknown> | null
        if (!modern.ok || !modernData?.ok) {
          const error = modernData?.error as Record<string, unknown> | undefined
          throw new Error(String(error?.message || tr('Failed to assign role', '分配角色失败')))
        }
        applyProvisionAccessPayload(modernData.data, userId)
        setProvisionStatus(tr(`Role '${role}' assigned.`, `角色 '${role}' 已分配。`))
        return
      }

      for (const permission of PROVISION_ROLE_PERMISSIONS[role] || []) {
        const response = await apiFetch('/api/permissions/grant', {
          method: 'POST',
          body: JSON.stringify({ userId, permission }),
        })
        if (response.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const data = await response.json().catch(() => null) as Record<string, unknown> | null
        if (!response.ok) {
          throw new Error(String(data?.error || data?.message || tr(`Failed to grant ${permission}`, `授予权限 ${permission} 失败`)))
        }
      }
      await fetchProvisioningUser(userId)
      setProvisionStatus(tr(`Role '${role}' granted.`, `角色 '${role}' 已授权。`))
    } catch (error: unknown) {
      setProvisionStatus((error as Error)?.message || tr('Failed to grant role', '授权角色失败'), 'error')
    } finally {
      provisionLoading.value = false
    }
  }

  async function revokeProvisioningRole() {
    const userId = provisionForm.userId.trim()
    provisionHasLoaded.value = true
    if (!isAttendanceAdminUuid(userId)) {
      setProvisionStatus(tr('Please enter a valid UUID for User ID.', '请输入有效的用户 ID（UUID）。'), 'error')
      return
    }

    provisionLoading.value = true
    try {
      const role = provisionForm.role
      const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/unassign`, {
        method: 'POST',
        body: JSON.stringify({ template: role }),
      })
      if (modern.status !== 404) {
        if (modern.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const modernData = await modern.json().catch(() => null) as Record<string, unknown> | null
        if (!modern.ok || !modernData?.ok) {
          const error = modernData?.error as Record<string, unknown> | undefined
          throw new Error(String(error?.message || tr('Failed to remove role', '移除角色失败')))
        }
        applyProvisionAccessPayload(modernData.data, userId)
        setProvisionStatus(tr(`Role '${role}' removed.`, `角色 '${role}' 已移除。`))
        return
      }

      for (const permission of PROVISION_ROLE_PERMISSIONS[role] || []) {
        const response = await apiFetch('/api/permissions/revoke', {
          method: 'POST',
          body: JSON.stringify({ userId, permission }),
        })
        if (response.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const data = await response.json().catch(() => null) as Record<string, unknown> | null
        if (!response.ok && response.status !== 404) {
          throw new Error(String(data?.error || data?.message || tr(`Failed to revoke ${permission}`, `撤销权限 ${permission} 失败`)))
        }
      }
      await fetchProvisioningUser(userId)
      setProvisionStatus(tr(`Role '${role}' revoked.`, `角色 '${role}' 已撤销。`))
    } catch (error: unknown) {
      setProvisionStatus((error as Error)?.message || tr('Failed to revoke role', '撤销角色失败'), 'error')
    } finally {
      provisionLoading.value = false
    }
  }

  async function previewProvisionBatchUsers() {
    provisionBatchStatusMessage.value = ''
    const { valid, invalid } = parseAttendanceAdminUserIdList(provisionBatchUserIdsText.value)
    if (invalid.length) {
      setProvisionBatchStatus(
        tr(
          `Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
          `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
        ),
        'error',
      )
      return
    }
    if (valid.length === 0) {
      setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
      clearProvisionBatchPreview()
      return
    }

    provisionBatchPreviewLoading.value = true
    try {
      const response = await apiFetch('/api/attendance-admin/users/batch/resolve', {
        method: 'POST',
        body: JSON.stringify({ userIds: valid }),
      })
      if (response.status === 404) {
        clearProvisionBatchPreview()
        provisionBatchPreviewRequested.value = valid.length
        setProvisionBatchStatus(tr('Batch preview API not available on this deployment.', '当前部署不支持批量预览 API。'), 'error')
        return
      }
      if (response.status === 403) {
        adminForbidden.value = true
        throw new Error(tr('Admin permissions required', '需要管理员权限'))
      }

      const data = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok || !data?.ok) {
        const error = data?.error as Record<string, unknown> | undefined
        throw new Error(String(error?.message || tr('Failed to preview batch users', '批量预览用户失败')))
      }

      applyProvisionBatchResolvePayload(data.data, valid)
      const found = provisionBatchPreviewItems.value.length
      const missing = provisionBatchPreviewMissingIds.value.length
      const inactive = provisionBatchPreviewInactiveIds.value.length
      const kind = missing > 0 ? 'error' : 'info'
      setProvisionBatchStatus(
        tr(
          `Preview ready: found ${found}/${valid.length}, missing ${missing}, inactive ${inactive}.`,
          `预览完成：找到 ${found}/${valid.length}，缺失 ${missing}，停用 ${inactive}。`,
        ),
        kind,
      )
    } catch (error: unknown) {
      setProvisionBatchStatus((error as Error)?.message || tr('Failed to preview batch users', '批量预览用户失败'), 'error')
    } finally {
      provisionBatchPreviewLoading.value = false
    }
  }

  async function grantProvisioningRoleBatch() {
    provisionBatchStatusMessage.value = ''
    const role = provisionBatchRole.value
    const { valid, invalid } = parseAttendanceAdminUserIdList(provisionBatchUserIdsText.value)
    if (invalid.length) {
      setProvisionBatchStatus(
        tr(
          `Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
          `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
        ),
        'error',
      )
      return
    }
    if (valid.length === 0) {
      setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
      return
    }

    provisionBatchLoading.value = true
    try {
      const batch = await apiFetch('/api/attendance-admin/users/batch/roles/assign', {
        method: 'POST',
        body: JSON.stringify({ userIds: valid, template: role }),
      })
      if (batch.status !== 404) {
        if (batch.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const batchData = await batch.json().catch(() => null) as Record<string, unknown> | null
        if (!batch.ok || !batchData?.ok) {
          const error = batchData?.error as Record<string, unknown> | undefined
          throw new Error(String(error?.message || tr('Failed to batch assign role', '批量分配角色失败')))
        }
        applyProvisionBatchResolvePayload(batchData.data, valid)
        const payload = batchData.data as Record<string, unknown> | undefined
        const updated = Number(payload?.updated ?? 0) || 0
        const eligible = Number(payload?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
        const missing = provisionBatchPreviewMissingIds.value.length
        const inactive = provisionBatchPreviewInactiveIds.value.length
        const unchanged = provisionBatchUnchangedIds.value.length
        const kind = missing > 0 ? 'error' : 'info'
        setProvisionBatchStatus(
          tr(
            `Role '${role}' assigned to ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`,
            `角色 '${role}' 已分配给 ${updated}/${eligible} 个可处理用户。未变更 ${unchanged}。缺失 ${missing}，停用 ${inactive}。`,
          ),
          kind,
        )
        return
      }

      const failed: string[] = []
      let updated = 0
      for (const userId of valid) {
        try {
          const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/assign`, {
            method: 'POST',
            body: JSON.stringify({ template: role }),
          })
          if (modern.status !== 404) {
            if (modern.status === 403) {
              adminForbidden.value = true
              throw new Error(tr('Admin permissions required', '需要管理员权限'))
            }
            const modernData = await modern.json().catch(() => null) as Record<string, unknown> | null
            if (!modern.ok || !modernData?.ok) {
              const error = modernData?.error as Record<string, unknown> | undefined
              throw new Error(String(error?.message || tr('Failed to assign role', '分配角色失败')))
            }
            updated += 1
            continue
          }

          for (const permission of PROVISION_ROLE_PERMISSIONS[role] || []) {
            const response = await apiFetch('/api/permissions/grant', {
              method: 'POST',
              body: JSON.stringify({ userId, permission }),
            })
            if (response.status === 403) {
              adminForbidden.value = true
              throw new Error(tr('Admin permissions required', '需要管理员权限'))
            }
            const data = await response.json().catch(() => null) as Record<string, unknown> | null
            if (!response.ok) {
              throw new Error(String(data?.error || data?.message || tr(`Failed to grant ${permission}`, `授予权限 ${permission} 失败`)))
            }
          }
          updated += 1
        } catch {
          failed.push(userId)
        }
      }

      const message = failed.length
        ? tr(
            `Role '${role}' assigned to ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
            `角色 '${role}' 已分配给 ${updated}/${valid.length} 个用户。失败：${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
          )
        : tr(`Role '${role}' assigned to ${updated}/${valid.length} user(s).`, `角色 '${role}' 已分配给 ${updated}/${valid.length} 个用户。`)
      setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
    } catch (error: unknown) {
      setProvisionBatchStatus((error as Error)?.message || tr('Failed to batch assign role', '批量分配角色失败'), 'error')
    } finally {
      provisionBatchLoading.value = false
    }
  }

  async function revokeProvisioningRoleBatch() {
    provisionBatchStatusMessage.value = ''
    const role = provisionBatchRole.value
    const { valid, invalid } = parseAttendanceAdminUserIdList(provisionBatchUserIdsText.value)
    if (invalid.length) {
      setProvisionBatchStatus(
        tr(
          `Invalid UUID(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
          `无效 UUID：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`,
        ),
        'error',
      )
      return
    }
    if (valid.length === 0) {
      setProvisionBatchStatus(tr('Please enter at least one valid User ID (UUID).', '请至少输入一个有效的用户 ID（UUID）。'), 'error')
      return
    }

    provisionBatchLoading.value = true
    try {
      const batch = await apiFetch('/api/attendance-admin/users/batch/roles/unassign', {
        method: 'POST',
        body: JSON.stringify({ userIds: valid, template: role }),
      })
      if (batch.status !== 404) {
        if (batch.status === 403) {
          adminForbidden.value = true
          throw new Error(tr('Admin permissions required', '需要管理员权限'))
        }
        const batchData = await batch.json().catch(() => null) as Record<string, unknown> | null
        if (!batch.ok || !batchData?.ok) {
          const error = batchData?.error as Record<string, unknown> | undefined
          throw new Error(String(error?.message || tr('Failed to batch remove role', '批量移除角色失败')))
        }
        applyProvisionBatchResolvePayload(batchData.data, valid)
        const payload = batchData.data as Record<string, unknown> | undefined
        const updated = Number(payload?.updated ?? 0) || 0
        const eligible = Number(payload?.eligible ?? (valid.length - provisionBatchPreviewMissingIds.value.length)) || 0
        const missing = provisionBatchPreviewMissingIds.value.length
        const inactive = provisionBatchPreviewInactiveIds.value.length
        const unchanged = provisionBatchUnchangedIds.value.length
        const kind = missing > 0 ? 'error' : 'info'
        setProvisionBatchStatus(
          tr(
            `Role '${role}' removed from ${updated}/${eligible} eligible user(s). Unchanged ${unchanged}. Missing ${missing}, inactive ${inactive}.`,
            `角色 '${role}' 已从 ${updated}/${eligible} 个可处理用户移除。未变更 ${unchanged}。缺失 ${missing}，停用 ${inactive}。`,
          ),
          kind,
        )
        return
      }

      const failed: string[] = []
      let updated = 0
      for (const userId of valid) {
        try {
          const modern = await apiFetch(`/api/attendance-admin/users/${encodeURIComponent(userId)}/roles/unassign`, {
            method: 'POST',
            body: JSON.stringify({ template: role }),
          })
          if (modern.status !== 404) {
            if (modern.status === 403) {
              adminForbidden.value = true
              throw new Error(tr('Admin permissions required', '需要管理员权限'))
            }
            const modernData = await modern.json().catch(() => null) as Record<string, unknown> | null
            if (!modern.ok || !modernData?.ok) {
              const error = modernData?.error as Record<string, unknown> | undefined
              throw new Error(String(error?.message || tr('Failed to remove role', '移除角色失败')))
            }
            updated += 1
            continue
          }

          for (const permission of PROVISION_ROLE_PERMISSIONS[role] || []) {
            const response = await apiFetch('/api/permissions/revoke', {
              method: 'POST',
              body: JSON.stringify({ userId, permission }),
            })
            if (response.status === 403) {
              adminForbidden.value = true
              throw new Error(tr('Admin permissions required', '需要管理员权限'))
            }
            const data = await response.json().catch(() => null) as Record<string, unknown> | null
            if (!response.ok && response.status !== 404) {
              throw new Error(String(data?.error || data?.message || tr(`Failed to revoke ${permission}`, `撤销权限 ${permission} 失败`)))
            }
          }
          updated += 1
        } catch {
          failed.push(userId)
        }
      }

      const message = failed.length
        ? tr(
            `Role '${role}' removed from ${updated}/${valid.length} user(s). Failed: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
            `角色 '${role}' 已从 ${updated}/${valid.length} 个用户移除。失败：${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
          )
        : tr(`Role '${role}' removed from ${updated}/${valid.length} user(s).`, `角色 '${role}' 已从 ${updated}/${valid.length} 个用户移除。`)
      setProvisionBatchStatus(message, failed.length ? 'error' : 'info')
    } catch (error: unknown) {
      setProvisionBatchStatus((error as Error)?.message || tr('Failed to batch remove role', '批量移除角色失败'), 'error')
    } finally {
      provisionBatchLoading.value = false
    }
  }

  function clearProvisionBatch() {
    provisionBatchUserIdsText.value = ''
    provisionBatchStatusMessage.value = ''
    provisionBatchStatusKind.value = 'info'
    provisionBatchPreviewLoading.value = false
    clearProvisionBatchPreview()
  }

  watch([provisionBatchUserIdsText, provisionBatchRole], () => {
    clearProvisionBatchPreview()
  })

  return {
    clearProvisionBatch,
    grantProvisioningRole,
    grantProvisioningRoleBatch,
    loadProvisionRoleTemplates,
    loadProvisioningUser,
    previewProvisionBatchUsers,
    provisionBatchAffectedIds,
    provisionBatchIds,
    provisionBatchInvalidIds,
    provisionBatchLoading,
    provisionBatchPreviewHasResult,
    provisionBatchPreviewInactiveIds,
    provisionBatchPreviewItems,
    provisionBatchPreviewLoading,
    provisionBatchPreviewMissingIds,
    provisionBatchPreviewRequested,
    provisionBatchRole,
    provisionBatchStatusKind,
    provisionBatchStatusMessage,
    provisionBatchUnchangedIds,
    provisionBatchUserIdsText,
    provisionForm,
    provisionHasLoaded,
    provisionLoading,
    provisionPermissions,
    provisionRoleTemplates,
    provisionRoles,
    provisionSearchHasNext,
    provisionSearchHasSearched,
    provisionSearchLoading,
    provisionSearchPage,
    provisionSearchQuery,
    provisionSearchResults,
    provisionSearchTotal,
    provisionStatusKind,
    provisionStatusMessage,
    provisionUserIsAdmin,
    provisionUserProfile,
    revokeProvisioningRole,
    revokeProvisioningRoleBatch,
    searchProvisionUsers,
    selectProvisionUser,
  }
}
