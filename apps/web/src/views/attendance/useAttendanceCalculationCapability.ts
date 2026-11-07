import { onScopeDispose, readonly, ref, watch } from 'vue'
import { onAuthPrincipalChange, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'

// A local invalidation epoch, never an authorization value. Read permission through the
// caller's existing auth predicate; storage notifications can represent an A-B-A transition.
export function useAttendanceCalculationCapability(canRead: () => boolean) {
  const epoch = ref(0)
  const invalidate = () => { epoch.value += 1 }
  const unsubscribe = onAuthPrincipalChange(invalidate)
  const keys = new Set<string>([
    ...TOKEN_KEYS, 'user_roles', 'user_permissions', 'tenantId', 'workspaceId', EXPLICIT_SESSION_ORG_KEY,
  ])
  const onStorage = (event: StorageEvent) => {
    if (event.key == null || keys.has(event.key)) invalidate()
  }
  window.addEventListener('storage', onStorage)
  watch(canRead, invalidate, { flush: 'sync' })
  onScopeDispose(() => {
    unsubscribe()
    window.removeEventListener('storage', onStorage)
  })
  return readonly(epoch)
}
