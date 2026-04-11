import { computed, readonly, ref } from 'vue'
import { useAuth } from '../composables/useAuth'
import type { ApprovalProductPermission } from '../types/approval'

type ApprovalAccessSnapshot = {
  isAdmin: boolean
  permissions: string[]
}

const currentAccess = ref<ApprovalAccessSnapshot>({
  isAdmin: false,
  permissions: [],
})

let listenersBound = false

function refreshApprovalAccess() {
  const auth = useAuth()
  const snapshot = auth.getAccessSnapshot()
  currentAccess.value = {
    isAdmin: snapshot.isAdmin,
    permissions: [...snapshot.permissions],
  }
}

function bindApprovalAccessRefresh() {
  if (listenersBound || typeof window === 'undefined') return
  const refresh = () => refreshApprovalAccess()
  window.addEventListener('storage', refresh)
  window.addEventListener('focus', refresh)
  listenersBound = true
}

function hasPermission(permission: ApprovalProductPermission): boolean {
  const access = currentAccess.value
  return access.isAdmin || access.permissions.includes(permission)
}

export function useApprovalPermissions() {
  bindApprovalAccessRefresh()
  refreshApprovalAccess()

  const canRead = computed(() => hasPermission('approvals:read'))
  const canWrite = computed(() => hasPermission('approvals:write'))
  const canAct = computed(() => hasPermission('approvals:act'))
  const canManageTemplates = computed(() => hasPermission('approval-templates:manage'))

  return {
    permissions: readonly(currentAccess),
    hasPermission,
    canRead,
    canWrite,
    canAct,
    canManageTemplates,
    refresh: refreshApprovalAccess,
  }
}
