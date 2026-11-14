import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { formatAnnualBalanceSubject } from './annualBalanceSubject'
import type { AttendancePersonnelIdentity } from './attendancePersonnelIdentity'
import type { createAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import type { apiFetch as sendApiFetch } from '../../utils/api'

interface AnnualLeaveBalanceLot {
  id: string
  leave_type_code: string
  amount_minutes: number
  remaining_minutes: number
  source_type: string
  source_id: string | null
  status: string
  granted_at: string | null
  expires_at: string | null
}
interface AnnualLeaveBalanceEvent {
  event_type: string
  delta_minutes: number
  source_type: string
  source_id: string | null
  balance_id: string
  occurred_at: string
}
export interface AnnualLeaveBalanceData {
  userId: string
  summary: { leaveTypeCode: string; grantedMinutes: number; remainingMinutes: number; exhaustedMinutes: number; expiredMinutes: number }
  activeLots: AnnualLeaveBalanceLot[]
  recentEvents: AnnualLeaveBalanceEvent[]
  eventLimit: number
}

interface AnnualBalanceOptions {
  orgId: Readonly<Ref<string>>
  globalScope: Readonly<Ref<boolean>>
  sessionGuard: Pick<ReturnType<typeof createAttendanceSessionGuard>, 'isCurrent' | 'stale'>
  apiFetch: typeof sendApiFetch
  adminForbidden: Ref<boolean>
  tr: (en: string, zh: string) => string
  onError: (error: unknown) => void
}

/** Manual annual balance queries own their subject; picker selection alone does not invalidate a read. */
export function useAttendanceAnnualBalance({ orgId, globalScope, sessionGuard, apiFetch, adminForbidden, tr, onError }: AnnualBalanceOptions) {
  const userId = ref('')
  const identity = ref<AttendancePersonnelIdentity | null>(null)
  const queriedIdentity = ref<AttendancePersonnelIdentity | null>(null)
  const loading = ref(false)
  const data = ref<AnnualLeaveBalanceData | null>(null)
  let epoch = 0
  const subjectLabel = computed(() => formatAnnualBalanceSubject(data.value?.userId, queriedIdentity.value, tr))

  function rememberIdentity(name: string): void {
    identity.value = { id: userId.value.trim(), name }
  }
  function invalidate(): void {
    epoch += 1
    data.value = null
    queriedIdentity.value = null
    identity.value = null
    loading.value = false
  }
  watch(userId, () => { identity.value = null }, { flush: 'sync' })
  // Synchronous history matters: A -> B -> A must not restore ownership to an old A request.
  watch([orgId, globalScope, sessionGuard.stale], invalidate, { flush: 'sync' })
  onScopeDispose(invalidate)

  // Existing annual/comp_time callers keep the same default and query order.
  async function load(leaveTypeCode: string = 'annual'): Promise<void> {
    const requestEpoch = ++epoch
    const target = userId.value.trim()
    const name = identity.value?.id === target ? { ...identity.value } : null
    const org = orgId.value.trim()
    const scope = globalScope.value
    const current = () => requestEpoch === epoch && org === orgId.value.trim()
      && scope === globalScope.value && sessionGuard.isCurrent()
    if (!current()) return
    data.value = null
    queriedIdentity.value = null
    loading.value = false
    if (!target) {
      onError(new Error(tr('Enter a user ID to view the annual leave balance', '请输入用户 ID 查询年假余额')))
      return
    }
    loading.value = true
    try {
      const query = new URLSearchParams()
      if (org) query.set('orgId', org)
      query.set('userId', target)
      query.set('leaveTypeCode', leaveTypeCode)
      const response = await apiFetch(`/api/attendance/leave-balances?${query.toString()}`)
      if (!current()) return
      if (response.status === 403) {
        adminForbidden.value = true
        return
      }
      const result = await response.json()
      if (!current()) return
      if (!response.ok || !result.ok) {
        onError(result)
        return
      }
      if (result.data?.userId !== target) {
        throw new Error(tr('Failed to load annual leave balance', '加载年假余额失败'))
      }
      adminForbidden.value = false
      queriedIdentity.value = name
      data.value = result.data as AnnualLeaveBalanceData
    } catch (error: unknown) {
      if (current()) onError(error)
    } finally {
      if (current()) loading.value = false
    }
  }

  return { userId, rememberIdentity, loading, data, subjectLabel, load }
}
