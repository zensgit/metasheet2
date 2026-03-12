import { getApiBase } from '../utils/api'

const TOKEN_KEYS = ['auth_token', 'jwt', 'devToken'] as const

export function useAuth() {
  function readStoredToken(): string | null {
    try {
      if (typeof localStorage === 'undefined') return null
      for (const key of TOKEN_KEYS) {
        const value = localStorage.getItem(key)
        if (typeof value === 'string' && value.trim().length > 0) {
          return value
        }
      }
      return null
    } catch {
      return null
    }
  }

  function getToken(): string | null {
    return readStoredToken()
  }

  function setToken(token: string) {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem('auth_token', token)
      localStorage.setItem('jwt', token)
    } catch (err) {
      console.warn('[auth] failed to persist token in localStorage', err)
    }
  }

  function clearToken() {
    try {
      if (typeof localStorage === 'undefined') return
      for (const key of TOKEN_KEYS) {
        localStorage.removeItem(key)
      }
    } catch (err) {
      console.warn('[auth] failed to clear token from localStorage', err)
    }
  }

  async function refreshDevToken(): Promise<string | null> {
    if (import.meta.env.PROD) return null

    try {
      const response = await fetch(`${getApiBase()}/api/auth/dev-token`)
      if (!response.ok) return null

      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      const token =
        typeof payload.token === 'string'
          ? payload.token
          : payload.data && typeof payload.data === 'object' && typeof (payload.data as Record<string, unknown>).token === 'string'
            ? (payload.data as Record<string, unknown>).token as string
            : null

      if (!token) return null
      setToken(token)

      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('devToken', token)
      } catch (err) {
        console.warn('[auth] failed to persist devToken alias in localStorage', err)
      }

      return token
    } catch (err) {
      console.warn('[auth] failed to refresh dev token', err)
      return null
    }
  }

  async function ensureToken(): Promise<string | null> {
    const existing = getToken()
    if (existing) return existing
    return refreshDevToken()
  }

  function buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    // Dev/test fallback aligns with backend flag behaviour
    if (!headers['Authorization']) headers['x-user-id'] = 'dev-user'
    return headers
  }

  return { getToken, setToken, clearToken, refreshDevToken, ensureToken, buildAuthHeaders }
}
