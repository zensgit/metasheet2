import { inject, onScopeDispose, provide, readonly, ref, type InjectionKey } from 'vue'
import { getAuthPrincipalKey, onAuthPrincipalChange } from './authPrincipal'
import type { apiFetch } from '../utils/api'

type AttendanceFetch = typeof apiFetch
const STALE_SESSION = 'ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED'

// An immutable page scope, not an authorization grant. The server still checks
// the signed session and membership. Never recapture identity inside a callback.
export function createAttendanceSessionGuard(orgId: string, readIdentity = getAuthPrincipalKey) {
  const identity = readIdentity()
  const stale = ref(false)

  function assertCurrent(): void {
    try {
      if (readIdentity() !== identity) stale.value = true
    } catch { stale.value = true }
    if (stale.value) throw new Error(STALE_SESSION)
  }

  function invalidate(): void { stale.value = true }

  function isCurrent(): boolean {
    try { assertCurrent(); return true } catch { return false }
  }

  function guardResponse(response: Response): Response {
    return new Proxy(response, {
      get(target, property) {
        if (property === 'clone') return () => {
          assertCurrent()
          return guardResponse(target.clone())
        }
        if (property === 'json' || property === 'text' || property === 'blob') {
          return async () => {
            assertCurrent()
            const value = await target[property]()
            assertCurrent()
            return value
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  function wrapFetch(send: AttendanceFetch): AttendanceFetch {
    return async (path, options) => {
      assertCurrent()
      const response = await (options === undefined ? send(path) : send(path, options))
      // A request already sent may have completed server-side. This check only
      // prevents its result being delivered into a different page session.
      assertCurrent()
      return guardResponse(response)
    }
  }

  return { orgId, stale: readonly(stale), assertCurrent, isCurrent, invalidate, wrapFetch }
}

type AttendanceSessionGuard = ReturnType<typeof createAttendanceSessionGuard>
export const attendanceSessionGuardKey: InjectionKey<AttendanceSessionGuard> = Symbol('attendance-session-guard')

export function provideAttendanceSessionGuard(orgId: string): AttendanceSessionGuard {
  const inherited = inject(attendanceSessionGuardKey, null)
  if (inherited) return inherited
  const guard = createAttendanceSessionGuard(orgId)
  provide(attendanceSessionGuardKey, guard)
  const unsubscribe = onAuthPrincipalChange(() => {
    try { guard.assertCurrent() } catch { /* The stale ref presents the reload affordance. */ }
  })
  onScopeDispose(() => { guard.invalidate(); unsubscribe() })
  return guard
}

export function useAttendanceSessionGuard(): AttendanceSessionGuard {
  const guard = inject(attendanceSessionGuardKey, null)
  if (!guard) throw new Error('ATTENDANCE_SESSION_SCOPE_REQUIRED')
  return guard
}
