import { computed, shallowRef, type ComputedRef } from 'vue'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../composables/authPrincipal'
import { useAuth } from '../composables/useAuth'
import { apiFetch } from '../utils/api'
import { normalizePreLoginRedirect, shouldSkipPreLoginRedirectQuery } from '../utils/authRedirect'
import type { AccountCenterResponse, AccountCenterResponseParser } from './accountCenterContract'

export type AccountCenterReadState = 'idle' | 'loading' | 'ready' | 'disabled' | 'error'

export interface AccountCenterRead {
  state: ComputedRef<AccountCenterReadState>
  snapshot: ComputedRef<AccountCenterResponse | null>
  refresh: () => Promise<void>
  dispose: () => void
}

// Construction is idle with no IO. Each host refreshes on mount and disposes on
// unmount; instances do not share snapshots. Session changes clear data without polling.
// Error bodies may be { error: { code } } or { ok: false, error: { code, message } }.
export function useAccountCenterRead(parse: AccountCenterResponseParser): AccountCenterRead {
  const state = shallowRef<AccountCenterReadState>('idle')
  const snapshot = shallowRef<AccountCenterResponse | null>(null)
  const { clearToken } = useAuth()
  let sequence = 0
  let controller: AbortController | null = null
  let disposed = false
  let session = readAuthSessionSignature()

  function invalidate(): void {
    sequence += 1
    controller?.abort()
    controller = null
    snapshot.value = null
    state.value = 'idle'
    session = readAuthSessionSignature()
  }

  function sessionChanged(): void {
    if (!disposed && session !== readAuthSessionSignature()) invalidate()
  }

  const unsubscribe = onAuthSessionSwitch(sessionChanged)
  window.addEventListener('storage', sessionChanged)

  async function refresh(): Promise<void> {
    if (disposed) return
    invalidate()
    const request = sequence
    controller = new AbortController()
    const signal = controller.signal
    state.value = 'loading'

    function current(): boolean {
      if (disposed || request !== sequence) return false
      sessionChanged()
      return request === sequence
    }

    try {
      const response = await apiFetch('/api/me/external-identities', {
        method: 'GET', signal, cache: 'no-store', suppressUnauthorizedRedirect: true,
      })
      if (!current()) return
      if (response.status === 401) {
        state.value = 'error'
        clearToken()
        const path = `${window.location.pathname}${window.location.search}${window.location.hash}`
        const target = shouldSkipPreLoginRedirectQuery(path)
          ? '/login' : `/login?redirect=${encodeURIComponent(normalizePreLoginRedirect(path))}`
        window.location.replace(target)
        return
      }
      if (response.status === 404) {
        state.value = 'disabled'
        return
      }
      const body: unknown = await response.json()
      if (!current()) return
      if (response.status === 200) {
        const parsed = parse(body)
        snapshot.value = parsed
        state.value = parsed ? 'ready' : 'error'
        return
      }
      state.value = 'error'
      const code = body && typeof body === 'object' && 'error' in body
        && body.error && typeof body.error === 'object' && 'code' in body.error
        ? body.error.code : undefined
      if (response.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
        window.location.replace('/force-password-change')
      }
    } catch {
      if (current()) {
        snapshot.value = null
        state.value = 'error'
      }
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    invalidate()
    unsubscribe()
    window.removeEventListener('storage', sessionChanged)
  }

  return {
    state: computed(() => state.value),
    snapshot: computed(() => snapshot.value),
    refresh,
    dispose,
  }
}
