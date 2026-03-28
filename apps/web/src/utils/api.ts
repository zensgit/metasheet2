/**
 * API utilities for frontend-backend communication
 */

import { normalizePreLoginRedirect, shouldSkipPreLoginRedirectQuery } from './authRedirect'

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

const TOKEN_STORAGE_KEYS = ['auth_token', 'jwt', 'devToken'] as const
const USER_STATE_KEYS = ['metasheet_features', 'metasheet_product_mode', 'user_permissions', 'user_roles'] as const
let authRedirecting = false

export interface ApiFetchOptions extends RequestInit {
  suppressUnauthorizedRedirect?: boolean
}

/**
 * Get the API base URL from environment or default to relative path
 */
export function getApiBase(): string {
  const envValue = (key: 'VITE_API_URL' | 'VITE_API_BASE') => {
    const fromMeta = import.meta.env[key]
    if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) return fromMeta
    const fromProcess = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.[key]
    if (typeof fromProcess === 'string' && fromProcess.trim().length > 0) return fromProcess
    return ''
  }

  const apiUrl = envValue('VITE_API_URL') || envValue('VITE_API_BASE')
  if (apiUrl) return apiUrl

  if (typeof window !== 'undefined') {
    const origin = window?.location?.origin
    if (typeof origin === 'string' && origin.trim().length > 0) {
      return origin
    }
  }

  return 'http://localhost:8900'
}

export function getStoredAuthToken(): string {
  if (typeof localStorage === 'undefined') return ''
  for (const key of TOKEN_STORAGE_KEYS) {
    const value = localStorage.getItem(key)
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return ''
}

export function clearStoredAuthState(): void {
  if (typeof localStorage === 'undefined') return
  for (const key of TOKEN_STORAGE_KEYS) {
    localStorage.removeItem(key)
  }
  for (const key of USER_STATE_KEYS) {
    localStorage.removeItem(key)
  }
}

/**
 * Build authorization headers for authenticated requests
 */
export function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const resolvedToken = typeof token === 'string' ? token : getStoredAuthToken()
  if (resolvedToken.trim().length > 0) {
    headers.Authorization = `Bearer ${resolvedToken}`
  }
  return headers
}

function isAuthRoute(path: string): boolean {
  if (path.includes('/api/auth/login')) return true
  if (path.includes('/api/auth/register')) return true
  if (path.includes('/api/auth/dev-token')) return true
  return false
}

function buildLoginRedirectUrl(): string {
  if (typeof window === 'undefined') return '/login'
  const current = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}` || '/'
  if (current.startsWith('/login')) return '/login'
  if (shouldSkipPreLoginRedirectQuery(current)) return '/login'
  const redirect = normalizePreLoginRedirect(current)
  return `/login?redirect=${encodeURIComponent(redirect)}`
}

function handleUnauthorized(path: string): void {
  if (typeof window === 'undefined' || authRedirecting || isAuthRoute(path)) {
    return
  }
  authRedirecting = true
  window.setTimeout(() => {
    authRedirecting = false
  }, 3000)
  clearStoredAuthState()
  const loginUrl = buildLoginRedirectUrl()
  if (typeof window.location?.replace === 'function') {
    window.location.replace(loginUrl)
  } else {
    window.location.href = loginUrl
  }
}

/**
 * Make an authenticated fetch request
 */
export async function apiFetch(
  path: string,
  options: ApiFetchOptions = {},
): Promise<Response> {
  const base = getApiBase()
  const { suppressUnauthorizedRedirect = false, ...requestOptions } = options
  const headers = new Headers({
    ...authHeaders(),
    ...(requestOptions.headers || {}),
  })
  const body = requestOptions.body
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  if (!isFormData && body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${base}${path}`, {
    ...requestOptions,
    headers,
  })

  if (response.status === 401 && !suppressUnauthorizedRedirect) {
    handleUnauthorized(path)
  }

  return response
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
