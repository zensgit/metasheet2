// S7-5 / OD-S7-6: load org-scoped directory readiness for the approval-flow
// authoring warning. Uses the attendance:admin values-free seam only — never
// platform-admin directory endpoints that delegated attendance admins cannot call.
//
// Host max is authoritative: maxManagerChainLevels stays null until the endpoint
// returns it (no local fallback constant). Blank org input maps to the plugin's
// DEFAULT_ORG_ID so the common default-org authoring path still loads readiness.

import { ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'
import { ATTENDANCE_DEFAULT_ORG_ID } from './attendanceApprovalSteps'

type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export interface AttendanceDirectoryReadiness {
  hasLinkedDirectoryAccounts: boolean
  maxManagerChainLevels: number
}

interface UseAttendanceApprovalDirectoryReadinessOptions {
  apiFetch?: ApiFetchFn
  endpoint?: string
}

const DEFAULT_ENDPOINT = '/api/attendance-admin/directory-readiness'

/** Resolve the org the readiness probe should use (blank → plugin DEFAULT_ORG_ID). */
export function resolveAttendanceReadinessOrgId(orgId: string | null | undefined): string {
  const normalized = typeof orgId === 'string' ? orgId.trim() : ''
  return normalized.length > 0 ? normalized : ATTENDANCE_DEFAULT_ORG_ID
}

export function useAttendanceApprovalDirectoryReadiness({
  apiFetch = defaultApiFetch,
  endpoint = DEFAULT_ENDPOINT,
}: UseAttendanceApprovalDirectoryReadinessOptions = {}) {
  const hasLinkedDirectoryAccounts: Ref<boolean | null> = ref(null)
  /** Host-authoritative cap; null until a successful readiness response for the current org. */
  const maxManagerChainLevels: Ref<number | null> = ref(null)
  const loading = ref(false)
  const lastOrgId = ref<string | null>(null)
  const errorMessage = ref('')
  // Monotonic request id: an older in-flight response must not overwrite a newer org's state.
  let requestSeq = 0

  function resetToUnknown(): void {
    hasLinkedDirectoryAccounts.value = null
    maxManagerChainLevels.value = null
  }

  async function loadReadiness(orgId: string | null | undefined): Promise<AttendanceDirectoryReadiness | null> {
    const normalized = resolveAttendanceReadinessOrgId(orgId)
    const seq = ++requestSeq
    lastOrgId.value = normalized
    // Drop any previous org's readiness/max immediately so a stale max cannot
    // author manager_at_level against the wrong cap while the new request is in flight.
    resetToUnknown()
    loading.value = true
    errorMessage.value = ''
    try {
      const params = new URLSearchParams({ orgId: normalized })
      const response = await apiFetch(`${endpoint}?${params.toString()}`)
      // Stale-response guard: a later loadReadiness (different org or re-entry) wins.
      if (seq !== requestSeq || lastOrgId.value !== normalized) {
        return null
      }
      if (!response.ok) {
        resetToUnknown()
        errorMessage.value = `directory-readiness HTTP ${response.status}`
        return null
      }
      const body = await response.json().catch(() => null) as
        | { ok?: boolean; data?: Partial<AttendanceDirectoryReadiness> }
        | null
      if (seq !== requestSeq || lastOrgId.value !== normalized) {
        return null
      }
      const data = body?.ok && body.data ? body.data : null
      if (
        !data
        || typeof data.hasLinkedDirectoryAccounts !== 'boolean'
        || typeof data.maxManagerChainLevels !== 'number'
        || !Number.isInteger(data.maxManagerChainLevels)
        || data.maxManagerChainLevels < 1
      ) {
        resetToUnknown()
        errorMessage.value = 'directory-readiness malformed'
        return null
      }
      hasLinkedDirectoryAccounts.value = data.hasLinkedDirectoryAccounts
      maxManagerChainLevels.value = data.maxManagerChainLevels
      return {
        hasLinkedDirectoryAccounts: data.hasLinkedDirectoryAccounts,
        maxManagerChainLevels: data.maxManagerChainLevels,
      }
    } catch (err) {
      if (seq !== requestSeq || lastOrgId.value !== normalized) {
        return null
      }
      resetToUnknown()
      errorMessage.value = err instanceof Error ? err.message : 'directory-readiness failed'
      return null
    } finally {
      if (seq === requestSeq) {
        loading.value = false
      }
    }
  }

  return {
    hasLinkedDirectoryAccounts,
    maxManagerChainLevels,
    loading,
    lastOrgId,
    errorMessage,
    loadReadiness,
  }
}
