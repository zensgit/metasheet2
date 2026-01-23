/**
 * API utilities for frontend-backend communication
 */

// Vite environment type declaration
declare global {
  interface ImportMetaEnv {
    VITE_API_URL?: string
    VITE_API_BASE?: string
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
  const storedToken =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem('auth_token') ||
        localStorage.getItem('jwt') ||
        localStorage.getItem('devToken')
      : null
  const resolvedToken = typeof token === 'string' ? token : storedToken ?? ''
  if (resolvedToken.trim().length > 0) {
    headers.Authorization = `Bearer ${resolvedToken}`
  }
  return headers
}

/**
 * Make an authenticated fetch request
 */
export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const base = getApiBase()
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(options.headers || {})
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
