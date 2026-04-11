/**
 * Approval Permissions Composable
 *
 * Provides reactive permission checks for approval UI gating.
 * Currently hardcoded to true (mock) — will be wired to real RBAC later.
 */
import { computed, ref } from 'vue'
import type { ApprovalProductPermission } from '../types/approval'
import { APPROVAL_PRODUCT_PERMISSIONS } from '../types/approval'

/**
 * Mock permissions array — replace with real permission source when RBAC is wired.
 */
const currentPermissions = ref<readonly ApprovalProductPermission[]>([...APPROVAL_PRODUCT_PERMISSIONS])

function hasPermission(perm: ApprovalProductPermission): boolean {
  return currentPermissions.value.includes(perm)
}

export function useApprovalPermissions() {
  const canRead = computed(() => hasPermission('approvals:read'))
  const canWrite = computed(() => hasPermission('approvals:write'))
  const canAct = computed(() => hasPermission('approvals:act'))
  const canManageTemplates = computed(() => hasPermission('approval-templates:manage'))

  return {
    permissions: currentPermissions,
    hasPermission,
    canRead,
    canWrite,
    canAct,
    canManageTemplates,
  }
}
