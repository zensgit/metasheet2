import { ref } from 'vue'
import type { AuthState } from './plmPanelModels'

type TokenPayload = Record<string, unknown> & {
  exp?: number
}

type UsePlmAuthStatusOptions = {
  storage?: Pick<Storage, 'getItem'>
}

export function decodeJwtPayload(token: string): TokenPayload | null {
  const segments = token.split('.')
  if (segments.length < 2) return null
  const payload = segments[1]
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(atob(padded))
  } catch (_err) {
    return null
  }
}

export function resolveTokenStatus(
  token: string,
  now: number = Date.now(),
): { state: AuthState; expiresAt: number | null } {
  if (!token) {
    return { state: 'missing', expiresAt: null }
  }
  const payload = decodeJwtPayload(token)
  const expSeconds = payload?.exp
  if (!expSeconds) {
    return { state: 'invalid', expiresAt: null }
  }
  const expMs = expSeconds * 1000
  const timeLeftMs = expMs - now
  if (timeLeftMs <= 0) {
    return { state: 'expired', expiresAt: expMs }
  }
  if (timeLeftMs <= 10 * 60 * 1000) {
    return { state: 'expiring', expiresAt: expMs }
  }
  return { state: 'valid', expiresAt: expMs }
}

export function usePlmAuthStatus(options: UsePlmAuthStatusOptions = {}) {
  const storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)

  const authState = ref<AuthState>('missing')
  const authExpiresAt = ref<number | null>(null)
  const plmAuthState = ref<AuthState>('missing')
  const plmAuthExpiresAt = ref<number | null>(null)
  const plmAuthLegacy = ref(false)
  const authError = ref('')

  let authTimer: number | undefined

  function refreshAuthStatus() {
    const metaToken = storage?.getItem('auth_token') || ''
    const metaStatus = resolveTokenStatus(metaToken)
    authState.value = metaStatus.state
    authExpiresAt.value = metaStatus.expiresAt

    const plmToken = storage?.getItem('plm_token') || ''
    const legacyToken = storage?.getItem('jwt') || ''
    plmAuthLegacy.value = !plmToken && Boolean(legacyToken)
    const plmStatus = resolveTokenStatus(plmToken || legacyToken)
    plmAuthState.value = plmStatus.state
    plmAuthExpiresAt.value = plmStatus.expiresAt
  }

  function handleAuthError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (!message.includes('401')) return
    refreshAuthStatus()
    if (authState.value === 'valid' || authState.value === 'expiring') {
      authState.value = 'invalid'
    }
    authError.value = `鉴权失败（${message.replace('API error: ', '')}）。请刷新 Token。`
  }

  function startAuthStatusPolling() {
    refreshAuthStatus()
    if (typeof window === 'undefined') return
    authTimer = window.setInterval(refreshAuthStatus, 30000)
    window.addEventListener('storage', refreshAuthStatus)
  }

  function stopAuthStatusPolling() {
    if (typeof window === 'undefined') return
    if (authTimer) {
      window.clearInterval(authTimer)
      authTimer = undefined
    }
    window.removeEventListener('storage', refreshAuthStatus)
  }

  return {
    authState,
    authExpiresAt,
    plmAuthState,
    plmAuthExpiresAt,
    plmAuthLegacy,
    authError,
    refreshAuthStatus,
    handleAuthError,
    startAuthStatusPolling,
    stopAuthStatusPolling,
  }
}
