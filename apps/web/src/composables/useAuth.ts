export function useAuth() {
  type FetchLike = typeof globalThis.fetch

  function getToken(): string | null {
    try {
      return (
        (typeof localStorage !== 'undefined' &&
          (localStorage.getItem('jwt') || localStorage.getItem('devToken'))) ||
        null
      )
    } catch {
      return null
    }
  }

  function setToken(token: string) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('jwt', token)
    } catch {
      return
    }
  }

  function clearToken() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('jwt')
        localStorage.removeItem('devToken')
      }
    } catch {
      return
    }
  }

  async function refreshDevToken(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<string> {
    const response = await fetchImpl('/api/auth/dev-token')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const payload = (await response.json()) as { token?: string }
    if (!payload.token) {
      throw new Error('Missing dev token')
    }

    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('devToken', payload.token)
    } catch {
      return payload.token
    }

    return payload.token
  }

  async function ensureToken(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<string> {
    const token = getToken()
    if (token) {
      return token
    }

    return refreshDevToken(fetchImpl)
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
