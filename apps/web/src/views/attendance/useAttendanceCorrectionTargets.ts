import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import type { createAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import type { apiFetch } from '../../utils/api'
import { parseCorrectionTargets, projectCorrectionTargets, type Result } from './attendanceCorrectionTargets'

export function useAttendanceCorrectionTargets(input: {
  workDate: () => string; userId: () => string; orgId: () => string; requestType: () => string
  inAt: () => string; outAt: () => string; enabled: () => boolean
  guard: ReturnType<typeof createAttendanceSessionGuard>; fetch: typeof apiFetch
}) {
  const result = ref<Result | null>(null)
  const loading = ref(false)
  const error = ref('')
  const chosen = reactive<{ checkIn: number | null; checkOut: number | null }>({ checkIn: null, checkOut: null })
  let generation = 0
  function clear(): void {
    result.value = null
    chosen.checkIn = null
    chosen.checkOut = null
    error.value = ''
    loading.value = false
  }
  async function refresh(): Promise<void> {
    const current = ++generation
    clear()
    const date = input.workDate()
    const user = input.userId()
    const org = input.orgId()
    const type = input.requestType()
    const matches = () => current === generation && input.guard.isCurrent() && input.enabled()
      && date === input.workDate() && user === input.userId() && org === input.orgId()
      && org === input.guard.orgId && type === input.requestType()
    if (!input.enabled() || !user || !date || !input.guard.isCurrent() || org !== input.guard.orgId) return
    loading.value = true
    try {
      const response = await input.fetch('/api/attendance/correction-targets?workDate=' + encodeURIComponent(date), { method: 'GET' })
      const body = await response.json()
      if (!matches()) return
      if (!response.ok) {
        error.value = typeof body?.error?.code === 'string' ? body.error.code : 'ATTENDANCE_CORRECTION_UNAVAILABLE'
        return
      }
      result.value = parseCorrectionTargets(body)
      if (!result.value) error.value = 'ATTENDANCE_CORRECTION_TARGET_INVALID'
    } catch {
      if (matches()) error.value = 'ATTENDANCE_CORRECTION_UNAVAILABLE'
    } finally { if (current === generation) loading.value = false }
  }
  watch([input.workDate, input.userId, input.orgId, input.requestType, input.enabled], () => { void refresh() }, { immediate: true, flush: 'sync' })
  watch(input.inAt, value => { if (!value) chosen.checkIn = null }, { flush: 'sync' })
  watch(input.outAt, value => { if (!value) chosen.checkOut = null }, { flush: 'sync' })
  watch(input.guard.stale, () => { ++generation; clear() }, { flush: 'sync' })
  onScopeDispose(() => { ++generation; clear() })
  const requested = computed(() => ({ checkIn: !!input.inAt(), checkOut: !!input.outAt() }))
  const payload = computed(() => result.value ? projectCorrectionTargets(result.value, chosen, requested.value) : null)
  const ready = computed(() => input.guard.isCurrent() && !loading.value && !error.value && !!result.value
    && (result.value.posture === 'legacy_projection_only' || !!payload.value))
  function stale(): void { ++generation; clear(); error.value = 'ATTENDANCE_CORRECTION_TARGET_STALE' }
  return { result, loading, error, chosen, requested, payload, ready, refresh, stale }
}
