import { clearStoredAuthToken, getStoredAuthToken, setStoredAuthToken } from '../utils/api'

export function useAuth() {
  function getToken(): string | null {
    try {
      return getStoredAuthToken()
    } catch {
      return null
    }
  }

  function setToken(token: string) {
    try {
      setStoredAuthToken(token)
    } catch {}
  }

  function clearToken() {
    try {
      clearStoredAuthToken()
    } catch {}
  }

  function buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    // Dev/test fallback aligns with backend flag behaviour
    if (!headers['Authorization']) headers['x-user-id'] = 'dev-user'
    return headers
  }

  return { getToken, setToken, clearToken, buildAuthHeaders }
}
