import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { apiFetch } from '../utils/api'
import { onAuthPrincipalChange } from './authPrincipal'
import { useAuth } from './useAuth'

// Adapted from #5145's explicit list/switch flow. No default-login filtering,
// stored choice restoration or history/punch organization mutation.
export function useSessionOrg() {
  const auth = useAuth()
  const loading = ref(false)
  const switching = ref(false)
  const errorMessage = ref('')
  const orgs = ref<string[]>([])
  const currentOrgId = ref<string | null>(null)
  let generation = 0
  let listRequest = 0
  const invalidate = onAuthPrincipalChange(() => {
    generation++
    orgs.value = []
    currentOrgId.value = null
    errorMessage.value = ''
  })
  if (getCurrentScope()) onScopeDispose(() => { generation++; invalidate() })

  async function loadSessionOrgs() {
    const token = auth.getToken()
    const started = generation
    const request = ++listRequest
    const current = () => started === generation && token === auth.getToken() && request === listRequest
    loading.value = true
    errorMessage.value = ''
    try {
      if (!token) return
      const response = await apiFetch('/api/auth/session-orgs', { suppressUnauthorizedRedirect: true })
      const payload = await response.json()
      if (!current()) return
      if (!response.ok || payload?.success !== true || !Array.isArray(payload.data?.orgs)
        || !payload.data.orgs.every((org: unknown) => typeof org === 'string' && org.length > 0)
        || !(payload.data.currentOrgId === null || payload.data.orgs.includes(payload.data.currentOrgId))) {
        throw new Error('SESSION_ORGS_UNAVAILABLE')
      }
      orgs.value = payload.data.orgs
      currentOrgId.value = payload.data.currentOrgId
    } catch {
      if (current()) errorMessage.value = 'SESSION_ORGS_UNAVAILABLE'
    } finally {
      if (request === listRequest) loading.value = false
    }
  }

  async function switchSessionOrg(orgId: string): Promise<boolean> {
    const chosen = orgId.trim()
    const token = auth.getToken()
    if (!chosen || !token || switching.value) return false
    const started = generation
    const current = () => started === generation && token === auth.getToken()
    switching.value = true
    errorMessage.value = ''
    try {
      const response = await apiFetch('/api/auth/session-org', {
        method: 'POST', body: JSON.stringify({ orgId: chosen }), suppressUnauthorizedRedirect: true,
      })
      const payload = await response.json()
      if (!current()) return false
      const data = payload?.data
      if (!response.ok || payload?.success !== true || data?.currentOrgId !== chosen
        || typeof data?.token !== 'string'
        || !auth.setExplicitSessionOrg(data.token, chosen, token)) {
        throw new Error('SESSION_ORG_SWITCH_REFUSED')
      }
      currentOrgId.value = chosen
      return true
    } catch {
      if (current()) errorMessage.value = 'SESSION_ORG_SWITCH_REFUSED'
      return false
    } finally { switching.value = false }
  }

  return {
    loading, switching, errorMessage, orgs, currentOrgId,
    selectedOrgId: computed(() => currentOrgId.value ?? ''),
    hasMultipleOrgs: computed(() => orgs.value.length > 1),
    loadSessionOrgs, switchSessionOrg,
  }
}
