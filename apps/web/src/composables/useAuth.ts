export function useAuth() {
  function getToken(): string | null {
    try {
      return (
        (typeof localStorage !== 'undefined' &&
          (localStorage.getItem('jwt') ||
            localStorage.getItem('devToken') ||
            localStorage.getItem('auth_token'))) ||
        null
      )
    } catch {
      return null
    }
  }

  function setToken(token: string) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('jwt', token)
    } catch {}
  }

  function clearToken() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem('jwt')
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
