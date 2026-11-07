import { onScopeDispose, ref, watch } from 'vue'
import { apiFetch as sendApiFetch } from '../../utils/api'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import { ATTENDANCE_RULES_ME_OMIT_HEADERS } from './rulesMeContract'
import {
  parseFixedScheduleAdmin, parseFixedScheduleSelf,
  type FixedScheduleAudience, type FixedScheduleEffectiveness,
} from './attendanceFixedScheduleEffectiveness'

interface Options {
  audience: () => FixedScheduleAudience
  groupId: () => string | null | undefined
  contextKey?: () => string
  expectedOrgId?: () => string | null | undefined
  enabled?: () => boolean
  apiFetch?: typeof sendApiFetch
}
export function useAttendanceFixedScheduleEffectiveness(options: Options) {
  const session = useAttendanceSessionGuard()
  const fetch = session.wrapFetch(options.apiFetch ?? sendApiFetch)
  const status = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const data = ref<FixedScheduleEffectiveness | null>(null)
  let sequence = 0
  let disposed = false
  let controller: AbortController | null = null
  const authSession = ref(readAuthSessionSignature())
  const updateAuthSession = () => {
    session.isCurrent()
    authSession.value = readAuthSessionSignature()
  }
  const unsubscribe = onAuthSessionSwitch(updateAuthSession)
  if (typeof window !== 'undefined') window.addEventListener('storage', updateAuthSession)
  const context = () => JSON.stringify([
    options.audience(), options.groupId() ?? '', options.contextKey?.() ?? '', options.expectedOrgId?.() ?? '',
    options.enabled?.() ?? true, session.stale.value, authSession.value,
  ])
  function invalidate() {
    sequence += 1
    controller?.abort()
    controller = null
    data.value = null
  }
  async function load(): Promise<void> {
    invalidate()
    const request = sequence
    const key = context()
    const requestSession = readAuthSessionSignature()
    const groupId = options.groupId()
    const audience = options.audience()
    const expectedOrgId = options.expectedOrgId?.()
    if (disposed) return
    if (options.enabled?.() === false) { status.value = 'idle'; return }
    if (!groupId || !session.isCurrent()) { status.value = 'unavailable'; return }
    status.value = 'loading'
    controller = new AbortController()
    const current = () => !disposed && request === sequence && key === context()
      && requestSession === readAuthSessionSignature() && session.isCurrent()
    try {
      const response = await fetch('/api/attendance/groups/' + encodeURIComponent(groupId)
        + '/fixed-schedule/effectiveness' + (audience === 'self' ? '/me' : ''), {
        method: 'GET',
        signal: controller.signal,
        // Signed identity remains authoritative. An explicit context assertion must
        // match it server-side; ambient identity hints never select the subject.
        ...(expectedOrgId ? { headers: { 'x-org-id': expectedOrgId } } : {}),
        omitHeaders: expectedOrgId
          ? ATTENDANCE_RULES_ME_OMIT_HEADERS.filter(name => name !== 'x-org-id')
          : ATTENDANCE_RULES_ME_OMIT_HEADERS,
        suppressUnauthorizedRedirect: true,
      })
      if (!current()) return
      if (!response.ok) { status.value = 'unavailable'; return }
      const payload: unknown = await response.json()
      if (!current()) return
      const parsed = audience === 'self' ? parseFixedScheduleSelf(payload, groupId) : parseFixedScheduleAdmin(payload, groupId)
      data.value = parsed
      status.value = parsed ? 'ready' : 'unavailable'
    } catch {
      if (!current()) return
      data.value = null
      status.value = 'unavailable'
    }
  }
  watch(context, () => {
    // Vue patches individual props synchronously. Clear immediately, but dispatch
    // only after that patch settles so an intermediate enabled/context pair
    // cannot issue a request that the final props prohibit.
    invalidate()
    status.value = options.enabled?.() === false ? 'idle'
      : !options.groupId() || session.stale.value ? 'unavailable' : 'loading'
    const queued = sequence
    const key = context()
    void Promise.resolve().then(() => {
      if (!disposed && queued === sequence && key === context() && status.value === 'loading') void load()
    })
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    unsubscribe()
    if (typeof window !== 'undefined') window.removeEventListener('storage', updateAuthSession)
    invalidate()
  })
  return { status, data, load }
}
