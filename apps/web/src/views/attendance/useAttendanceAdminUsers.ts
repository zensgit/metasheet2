import { ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'

type Translate = (en: string, zh: string) => string
type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export interface AttendanceAdminUserSearchItem {
  id: string
  email: string
  name: string | null
  role: string
  is_active: boolean
  is_admin: boolean
  last_login_at: string | null
  created_at: string
}

interface UseAttendanceAdminUsersOptions {
  adminForbidden?: Ref<boolean>
  apiFetch?: ApiFetchFn
  tr?: Translate
}

function defaultTranslate(en: string): string {
  return en
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return null
  }
}

function formatUserLabel(user: AttendanceAdminUserSearchItem, tr: Translate): string {
  if (
    user.name === null
    && user.email === user.id
    && !user.role
    && user.created_at === ''
  ) {
    return `${tr('Current value', '当前值')}: ${user.id}`
  }
  const primary = user.name?.trim() || user.email.trim() || user.id
  const secondary = user.email.trim() && user.email.trim() !== primary ? user.email.trim() : user.id
  return user.id ? `${primary} · ${secondary}` : tr('Unknown user', '未知用户')
}

export function useAttendanceAdminUsers({
  adminForbidden,
  apiFetch = defaultApiFetch,
  tr = defaultTranslate,
}: UseAttendanceAdminUsersOptions = {}) {
  const users = ref<AttendanceAdminUserSearchItem[]>([])
  const searchQuery = ref('')
  const loading = ref(false)
  const statusMessage = ref('')

  async function loadUsers(query = searchQuery.value) {
    loading.value = true
    statusMessage.value = ''
    try {
      const params = new URLSearchParams()
      const normalizedQuery = query.trim()
      if (normalizedQuery) {
        params.set('q', normalizedQuery)
      }
      const response = await apiFetch(`/api/admin/users${params.size ? `?${params.toString()}` : ''}`)
      if (response.status === 403) {
        adminForbidden && (adminForbidden.value = true)
        users.value = []
        statusMessage.value = tr('Admin permissions required', '需要管理员权限')
        return
      }
      const data = await readJson(response)
      if (!response.ok || data?.ok !== true) {
        throw new Error(String((data?.error as Record<string, unknown> | undefined)?.message || tr('Failed to load users', '加载用户失败')))
      }

      const items = data?.data && typeof data.data === 'object'
        ? (data.data as Record<string, unknown>).items
        : []
      users.value = Array.isArray(items) ? items as AttendanceAdminUserSearchItem[] : []
    } catch (error: unknown) {
      statusMessage.value = error instanceof Error && error.message
        ? error.message
        : tr('Failed to load users', '加载用户失败')
    } finally {
      loading.value = false
    }
  }

  function ensureSelectedUserVisible(userId: string) {
    const normalizedUserId = userId.trim()
    if (!normalizedUserId) return
    if (users.value.some((item) => item.id === normalizedUserId)) return
    users.value = [
      {
        id: normalizedUserId,
        email: normalizedUserId,
        name: null,
        role: '',
        is_active: true,
        is_admin: false,
        last_login_at: null,
        created_at: '',
      },
      ...users.value,
    ]
  }

  return {
    ensureSelectedUserVisible,
    formatUserLabel: (user: AttendanceAdminUserSearchItem) => formatUserLabel(user, tr),
    loading,
    loadUsers,
    searchQuery,
    statusMessage,
    users,
  }
}
