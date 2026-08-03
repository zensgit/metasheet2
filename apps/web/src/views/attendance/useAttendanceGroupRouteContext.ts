import { ref, watch, type Ref } from 'vue'
import type {
  AttendanceGroupRouteContext,
  AttendanceGroupRouteStep,
  AttendanceGroupRouteSurface,
} from '../../router/attendanceGroupContextRoute'
import { apiFetch as defaultApiFetch } from '../../utils/api'

export interface AttendanceAuthorizedGroup {
  id: string
  orgId?: string
  name: string
  code?: string | null
  timezone: string
  ruleSetId?: string | null
  description?: string | null
  memberCount?: number | null
  member_count?: number | null
  attendanceType?: 'fixed_shift' | 'scheduled_shift' | 'free_time' | null
  attendance_type?: 'fixed_shift' | 'scheduled_shift' | 'free_time' | null
  createdAt?: string
  updatedAt?: string
}

export type AttendanceGroupRouteContextState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      group: AttendanceAuthorizedGroup
      step: AttendanceGroupRouteStep
      surface: AttendanceGroupRouteSurface | null
      returnTo: string
    }
  | { kind: 'unavailable' }
  | { kind: 'error' }

type UseAttendanceGroupRouteContextOptions = {
  context: Readonly<Ref<AttendanceGroupRouteContext | null>>
  enabled: Readonly<Ref<boolean>>
  apiFetch?: typeof defaultApiFetch
}

function isAuthorizedGroup(value: unknown): value is AttendanceAuthorizedGroup {
  if (!value || typeof value !== 'object') return false
  const group = value as Partial<AttendanceAuthorizedGroup>
  return typeof group.id === 'string'
    && typeof group.name === 'string'
    && typeof group.timezone === 'string'
}

export function useAttendanceGroupRouteContext({
  context,
  enabled,
  apiFetch = defaultApiFetch,
}: UseAttendanceGroupRouteContextOptions) {
  const state = ref<AttendanceGroupRouteContextState>({ kind: 'loading' })
  let generation = 0

  async function probe(): Promise<void> {
    const currentContext = context.value
    const currentGeneration = ++generation

    if (!enabled.value) return
    if (!currentContext) {
      state.value = { kind: 'unavailable' }
      return
    }

    state.value = { kind: 'loading' }
    try {
      const response = await apiFetch(`/api/attendance/groups/${currentContext.groupId}`)
      if (currentGeneration !== generation) return
      if (response.status === 403 || response.status === 404) {
        state.value = { kind: 'unavailable' }
        return
      }
      if (!response.ok) {
        state.value = { kind: 'error' }
        return
      }
      const payload = await response.json()
      if (currentGeneration !== generation) return
      if (!payload?.ok || !isAuthorizedGroup(payload.data)) {
        state.value = { kind: 'error' }
        return
      }
      state.value = {
        kind: 'ready',
        group: payload.data,
        step: currentContext.step,
        surface: currentContext.surface,
        returnTo: currentContext.returnTo,
      }
    } catch {
      if (currentGeneration !== generation) return
      state.value = { kind: 'error' }
    }
  }

  watch([context, enabled], () => {
    void probe()
  }, { immediate: true })

  return { state, retry: probe }
}
