/**
 * API utilities for frontend-backend communication
 */

// Vite environment type declaration
declare global {
  interface ImportMetaEnv {
    VITE_API_URL?: string
    VITE_API_BASE?: string
    VITE_AUTO_DEV_TOKEN?: string
    MODE: string
    DEV: boolean
    PROD: boolean
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

/**
 * Get the API base URL from environment or default to relative path
 */
export function getApiBase(): string {
  const envValue = (key: 'VITE_API_URL') => {
    const fromMeta = import.meta.env[key]
    if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) return fromMeta
    const fromProcess = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[key]
    if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) return fromProcess
    return ''
  }

  const apiUrl = envValue('VITE_API_URL')
  if (apiUrl) return apiUrl

  if (typeof window !== 'undefined') {
    const origin = window?.location?.origin
    if (typeof origin === 'string' && origin.trim().length > 0) {
      return origin
    }
  }

  return 'http://localhost:8900'
}

/**
 * Build authorization headers for authenticated requests
 */
export function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  const resolvedToken = typeof token === 'string' ? token : getStoredAuthToken() ?? ''
  if (resolvedToken.trim().length > 0) headers.Authorization = `Bearer ${resolvedToken}`
  return headers
}

const storedTokenKeys = ['auth_token', 'jwt', 'devToken'] as const
let devTokenPromise: Promise<string | null> | null = null
let devTokenFailed = false

export function getStoredAuthToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  for (const key of storedTokenKeys) {
    const value = localStorage.getItem(key)
    if (value && value.trim().length > 0) return value
  }
  return null
}

export function setStoredAuthToken(token: string) {
  if (typeof localStorage === 'undefined') return
  const value = token.trim()
  if (!value) return
  localStorage.setItem('auth_token', value)
  localStorage.setItem('jwt', value)
}

export function clearStoredAuthToken() {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem('auth_token')
  localStorage.removeItem('jwt')
  localStorage.removeItem('devToken')
}

function shouldAutoDevToken(): boolean {
  const setting = import.meta.env.VITE_AUTO_DEV_TOKEN
  if (setting === 'true') return true
  if (setting === 'false') return false
  return Boolean(import.meta.env.DEV)
}

async function maybeBootstrapDevToken(): Promise<string | null> {
  if (devTokenFailed || !shouldAutoDevToken()) return null
  const existing = getStoredAuthToken()
  if (existing) return existing
  if (!devTokenPromise) {
    devTokenPromise = (async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/auth/dev-token`)
        if (!response.ok) {
          devTokenFailed = true
          return null
        }
        const data = await response.json()
        if (typeof data?.token === 'string' && data.token.trim().length > 0) {
          setStoredAuthToken(data.token)
          return data.token
        }
      } catch {
        devTokenFailed = true
      }
      return null
    })()
  }
  const token = await devTokenPromise
  devTokenPromise = null
  return token
}

/**
 * Make an authenticated fetch request
 */
export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const base = getApiBase()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(options.headers || {})
  }
  if (!headers.Authorization) {
    const token = await maybeBootstrapDevToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  return fetch(`${base}${path}`, {
    ...options,
    headers
  })
}

/**
 * Make a GET request to the API
 */
export async function apiGet<T = any>(path: string): Promise<T> {
  const response = await apiFetch(path)
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

/**
 * Make a POST request to the API
 */
export async function apiPost<T = any>(path: string, data: any): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(data)
  })
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}
