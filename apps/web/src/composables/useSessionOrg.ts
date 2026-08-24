import { computed, ref } from 'vue'
import { apiFetch } from '../utils/api'
import {
  persistSessionOrgChoice,
  sessionOrgChoiceForUser,
} from '../utils/sessionOrgChoice'
import { useAuth } from './useAuth'

export type SessionOrgSnapshot = {
  orgs: string[]
  currentOrgId: string | null
}

function readOrgId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseSessionOrgSnapshot(payload: unknown): SessionOrgSnapshot {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
  const orgs = Array.isArray(data.orgs)
    ? data.orgs.map((item) => readOrgId(item)).filter((item): item is string => Boolean(item))
    : []
  return {
    orgs,
    currentOrgId: readOrgId(data.currentOrgId),
  }
}

export function useSessionOrg() {
  const auth = useAuth()
  const loading = ref(false)
  const switching = ref(false)
  const errorMessage = ref('')
  const orgs = ref<string[]>([])
  const currentOrgId = ref<string | null>(null)

  const hasMultipleOrgs = computed(() => orgs.value.length > 1)
  const selectedOrgId = computed(() => currentOrgId.value ?? '')

  async function loadSessionOrgs(): Promise<SessionOrgSnapshot> {
    loading.value = true
    errorMessage.value = ''
    try {
      const response = await apiFetch('/api/auth/session-orgs', {
        suppressUnauthorizedRedirect: true,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to load organizations')
      }
      const snapshot = parseSessionOrgSnapshot(payload)
      orgs.value = snapshot.orgs
      currentOrgId.value = snapshot.currentOrgId
      return snapshot
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : 'Failed to load organizations'
      return { orgs: orgs.value, currentOrgId: currentOrgId.value }
    } finally {
      loading.value = false
    }
  }

  async function switchSessionOrg(orgId: string): Promise<boolean> {
    const trimmed = orgId.trim()
    if (!trimmed || switching.value) return false
    switching.value = true
    errorMessage.value = ''
    try {
      const response = await apiFetch('/api/auth/session-org', {
        method: 'POST',
        body: JSON.stringify({ orgId: trimmed }),
        suppressUnauthorizedRedirect: true,
      })
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null
      if (!response.ok || !payload?.success) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to switch organization')
      }
      const data = payload.data && typeof payload.data === 'object'
        ? payload.data as Record<string, unknown>
        : {}
      const token = typeof data.token === 'string' ? data.token : ''
      const chosen = readOrgId(data.currentOrgId) ?? trimmed
      const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : null
      const userId = typeof user?.id === 'string' ? user.id : (await auth.getCurrentUserId())

      if (token) {
        auth.setToken(token, { persistInjectedTenantHint: false })
      }
      if (userId) {
        persistSessionOrgChoice(userId, chosen)
      }
      currentOrgId.value = chosen
      if (!orgs.value.includes(chosen)) {
        orgs.value = [...orgs.value, chosen].sort()
      }
      return true
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : 'Failed to switch organization'
      return false
    } finally {
      switching.value = false
    }
  }

  async function restoreExplicitSessionOrg(): Promise<boolean> {
    const userId = await auth.getCurrentUserId()
    const chosen = sessionOrgChoiceForUser(userId)
    if (!chosen) return false
    if (currentOrgId.value === chosen) return true
    return switchSessionOrg(chosen)
  }

  return {
    loading,
    switching,
    errorMessage,
    orgs,
    currentOrgId,
    selectedOrgId,
    hasMultipleOrgs,
    loadSessionOrgs,
    switchSessionOrg,
    restoreExplicitSessionOrg,
  }
}
