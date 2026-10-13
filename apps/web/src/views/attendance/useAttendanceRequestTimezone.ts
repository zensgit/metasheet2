import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import type { createAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import type { apiFetch } from '../../utils/api'
import { resolveAttendanceWallTime } from './attendanceWallTime'
import { parseAttendanceTimezoneTarget, resolveTargetRequestInstant, type AttendanceTimezoneTarget } from './attendanceTimezoneTarget'

export function useAttendanceRequestTimezone(input: {
  workDate: () => string
  userId: () => string
  enabled: () => boolean
  inAt: () => string
  outAt: () => string
  originals: () => { requestedInAt: string; requestedOutAt: string } | null
  guard: ReturnType<typeof createAttendanceSessionGuard>
  fetch: typeof apiFetch
}) {
  const target = ref<AttendanceTimezoneTarget | null>(null)
  const loading = ref(false)
  const failed = ref(false)
  const selected = reactive({ inAt: '', outAt: '' })
  let generation = 0
  async function refresh(): Promise<void> {
    const current = ++generation
    target.value = null
    selected.inAt = ''
    selected.outAt = ''
    failed.value = false
    loading.value = false
    const workDate = input.workDate()
    const userId = input.userId()
    if (!input.enabled() || !userId || !input.guard.isCurrent()) return
    loading.value = true
    try {
      const response = await input.fetch('/api/attendance/timezone-context/me?workDate=' + encodeURIComponent(workDate), { method: 'GET' })
      const body = await response.json()
      if (current !== generation || !input.guard.isCurrent()) return
      const parsed = response.ok && body?.ok === true
        ? parseAttendanceTimezoneTarget(body, { orgId: input.guard.orgId, userId, workDate }) : null
      if (!parsed) { failed.value = true; return }
      target.value = parsed
    } catch {
      if (current === generation && input.guard.isCurrent()) failed.value = true
    } finally { if (current === generation) loading.value = false }
  }
  watch([input.workDate, input.userId, input.enabled], () => { void refresh() }, { immediate: true, flush: 'sync' })
  watch(input.inAt, () => { selected.inAt = '' }, { flush: 'sync' })
  watch(input.outAt, () => { selected.outAt = '' }, { flush: 'sync' })
  watch(input.guard.stale, () => {
    ++generation
    target.value = null
    loading.value = false
    failed.value = false
    selected.inAt = ''
    selected.outAt = ''
  }, { flush: 'sync' })
  onScopeDispose(() => { ++generation; target.value = null })
  const ready = computed(() => Boolean(target.value && input.guard.isCurrent()
    && target.value.workDate === input.workDate() && target.value.userId === input.userId()
    && target.value.orgId === input.guard.orgId))
  const resolved = computed(() => ({
    inAt: resolveAttendanceWallTime(input.inAt(), target.value?.timezone ?? ''),
    outAt: resolveAttendanceWallTime(input.outAt(), target.value?.timezone ?? ''),
  }))
  function times(): { requestedInAt: string; requestedOutAt: string; expectedTimezoneContextFingerprint: string } | null {
    if (!ready.value || !target.value) return null
    const original = input.originals()
    const requestedInAt = input.inAt() ? resolveTargetRequestInstant(
      input.inAt(), target.value.timezone, selected.inAt || undefined, original?.requestedInAt,
    ) : ''
    const requestedOutAt = input.outAt() ? resolveTargetRequestInstant(
      input.outAt(), target.value.timezone, selected.outAt || undefined, original?.requestedOutAt,
    ) : ''
    return requestedInAt === null || requestedOutAt === null ? null : {
      requestedInAt, requestedOutAt, expectedTimezoneContextFingerprint: target.value.contextFingerprint,
    }
  }
  return { target, loading, failed, selected, resolved, ready, refresh, times }
}
