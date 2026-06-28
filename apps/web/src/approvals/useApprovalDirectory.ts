import { ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../utils/api'

/**
 * Read-only directory lookups for the approval-authoring assignee picker (POST-GATE Lane A,
 * P1-static-picker). Mirrors the STRUCTURE of useAttendanceAdminUsers (apiFetch DI default,
 * loading/status refs, ensure*Visible placeholder synthesis) but targets the two
 * approval-templates:manage-scoped endpoints landed alongside it:
 *   GET /api/approval-templates/directory/users?q=&limit=
 *   GET /api/approval-templates/directory/roles
 *
 * IMPORTANT shape difference vs the attendance endpoint: these return a BARE object
 * ({ users } / { roles }), NOT the { ok, data: { items } } envelope. This composable parses
 * the bare shape directly — it must NOT copy useAttendanceAdminUsers's data.data.items path.
 *
 * The picker never owns the carrier: the View derives selected[] from step.idsText via
 * parseIdsText and writes back via .join(', '). ensure*OptionVisible synthesizes a placeholder
 * option for any id that is in idsText but absent from the fetched page, so a pre-existing or
 * free-text/unknown id stays a selectable chip and is never silently dropped.
 */

type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export interface DirectoryUserOption {
  id: string
  name: string
  email: string
}

export interface DirectoryRoleOption {
  id: string
  name: string
}

export interface UseApprovalDirectoryOptions {
  apiFetch?: ApiFetchFn
}

const FORBIDDEN_MESSAGE = '需要 approval-templates:manage 权限'
const USERS_FAILED_MESSAGE = '加载用户目录失败'
const ROLES_FAILED_MESSAGE = '加载角色目录失败'
const FORMULA_ROLES_FAILED_MESSAGE = '加载审批可用角色失败'

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function asUserOptions(value: unknown): DirectoryUserOption[] {
  if (!Array.isArray(value)) return []
  const options: DirectoryUserOption[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) continue
    options.push({
      id,
      name: typeof record.name === 'string' ? record.name : '',
      email: typeof record.email === 'string' ? record.email : '',
    })
  }
  return options
}

function asRoleOptions(value: unknown): DirectoryRoleOption[] {
  if (!Array.isArray(value)) return []
  const options: DirectoryRoleOption[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id) continue
    options.push({ id, name: typeof record.name === 'string' ? record.name : '' })
  }
  return options
}

export function useApprovalDirectory({ apiFetch = defaultApiFetch }: UseApprovalDirectoryOptions = {}) {
  const users = ref<DirectoryUserOption[]>([])
  const roles = ref<DirectoryRoleOption[]>([])
  // CURATED-VOCABULARY (RA-1b): the roles an author may route on in a formula `requester.role in [...]`
  // condition — i.e. `approval_usable = true`. SEPARATE from `roles` (the static_role approver picker,
  // which intentionally lists ALL roles). Never merge the two — that boundary is the ratified scope.
  const formulaRoles = ref<DirectoryRoleOption[]>([])
  const usersLoading = ref(false)
  const rolesLoading = ref(false)
  const formulaRolesLoading = ref(false)
  const statusMessage = ref('')

  async function searchUsers(q: string): Promise<void> {
    usersLoading.value = true
    statusMessage.value = ''
    try {
      const params = new URLSearchParams()
      const normalizedQuery = q.trim()
      if (normalizedQuery) {
        params.set('q', normalizedQuery)
      }
      params.set('limit', '20')
      const response = await apiFetch(`/api/approval-templates/directory/users?${params.toString()}`)
      if (response.status === 403) {
        users.value = []
        statusMessage.value = FORBIDDEN_MESSAGE
        return
      }
      const data = await readJson(response)
      if (!response.ok || !data) {
        throw new Error(USERS_FAILED_MESSAGE)
      }
      users.value = asUserOptions(data.users)
    } catch (error: unknown) {
      statusMessage.value = error instanceof Error && error.message ? error.message : USERS_FAILED_MESSAGE
    } finally {
      usersLoading.value = false
    }
  }

  // Loads ALL roles for the SHARED static_role approver picker (correct — static_role assignee selection is
  // NOT curated). The DEDICATED formula `requester.role` picker uses `loadFormulaRoles()` below instead.
  async function loadRoles(): Promise<void> {
    rolesLoading.value = true
    statusMessage.value = ''
    try {
      const response = await apiFetch('/api/approval-templates/directory/roles')
      if (response.status === 403) {
        roles.value = []
        statusMessage.value = FORBIDDEN_MESSAGE
        return
      }
      const data = await readJson(response)
      if (!response.ok || !data) {
        throw new Error(ROLES_FAILED_MESSAGE)
      }
      roles.value = asRoleOptions(data.roles)
    } catch (error: unknown) {
      statusMessage.value = error instanceof Error && error.message ? error.message : ROLES_FAILED_MESSAGE
    } finally {
      rolesLoading.value = false
    }
  }

  // CURATED-VOCABULARY (RA-1b): the DEDICATED formula `requester.role` picker. Hits the curated endpoint
  // `GET /api/approval-templates/directory/formula-roles` (approval_usable=true only), so an author is GUIDED
  // to insert only curated roles into `requester.role in [...]` — matching the publish + dry-run HARD GATE
  // (which is the actual security boundary; this picker is authoring convenience). Mirrors `loadRoles` exactly
  // but MUST stay separate from it / `roles` (static_role): never merge the curated and full role sets.
  async function loadFormulaRoles(): Promise<void> {
    formulaRolesLoading.value = true
    statusMessage.value = ''
    try {
      const response = await apiFetch('/api/approval-templates/directory/formula-roles')
      if (response.status === 403) {
        formulaRoles.value = []
        statusMessage.value = FORBIDDEN_MESSAGE
        return
      }
      const data = await readJson(response)
      if (!response.ok || !data) {
        throw new Error(FORMULA_ROLES_FAILED_MESSAGE)
      }
      formulaRoles.value = asRoleOptions(data.roles)
    } catch (error: unknown) {
      statusMessage.value = error instanceof Error && error.message ? error.message : FORMULA_ROLES_FAILED_MESSAGE
    } finally {
      formulaRolesLoading.value = false
    }
  }

  // Synthesize a placeholder option so an id present in idsText but absent from the fetched
  // page still renders as a selectable chip (no silent drop of pre-existing / free-text ids).
  function ensureUserOptionVisible(id: string): void {
    const normalized = id.trim()
    if (!normalized) return
    if (users.value.some((option) => option.id === normalized)) return
    users.value = [{ id: normalized, name: '', email: '' }, ...users.value]
  }

  function ensureRoleOptionVisible(id: string): void {
    const normalized = id.trim()
    if (!normalized) return
    if (roles.value.some((option) => option.id === normalized)) return
    roles.value = [{ id: normalized, name: '' }, ...roles.value]
  }

  function formatUserLabel(user: DirectoryUserOption): string {
    const primary = user.name.trim() || user.id
    const email = user.email.trim()
    return email ? `${primary} · ${email}` : primary
  }

  function formatRoleLabel(role: DirectoryRoleOption): string {
    return role.name.trim() || role.id
  }

  return {
    users,
    roles,
    formulaRoles,
    usersLoading,
    rolesLoading,
    formulaRolesLoading,
    statusMessage,
    searchUsers,
    loadRoles,
    loadFormulaRoles,
    ensureUserOptionVisible,
    ensureRoleOptionVisible,
    formatUserLabel,
    formatRoleLabel,
  }
}
