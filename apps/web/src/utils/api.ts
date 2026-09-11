/**
 * API utilities for frontend-backend communication
 */

import { normalizePreLoginRedirect, shouldSkipPreLoginRedirectQuery } from './authRedirect'
import { explicitSessionOrg } from '../composables/authPrincipal'
import { clearExplicitSessionOrg } from './explicitSessionOrg'
import { createNetworkUnavailableError } from './networkErrors'

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
const TENANT_HINT_KEYS = ['tenantId', 'workspaceId'] as const
const USER_STATE_KEYS = ['metasheet_features', 'metasheet_product_mode', 'user_permissions', 'user_roles'] as const
let authRedirecting = false

export interface ApiFetchOptions extends RequestInit {
  suppressUnauthorizedRedirect?: boolean
  /**
   * Header names to REMOVE after the global auth headers are applied. Needed for
   * self-service routes whose contract REJECTS subject-override headers instead of
   * ignoring them (e.g. attendance `rules/me`, SR-1): `authHeaders()` injects
   * `x-tenant-id` globally, and a caller cannot un-send it by overriding the value —
   * the guard fires on header PRESENCE. Deleting is the only spelling that honors
   * the route contract.
   */
  omitHeaders?: readonly string[]
}

function resolveWindowOrigin(): string {
  if (typeof window === 'undefined') return ''
  const origin = window?.location?.origin
  return typeof origin === 'string' && origin.trim().length > 0 ? origin.trim() : ''
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
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
  const browserOrigin = resolveWindowOrigin()
  if (apiUrl) {
    if (browserOrigin && isLoopbackUrl(apiUrl) && !isLoopbackUrl(browserOrigin)) {
      return browserOrigin
    }
    return apiUrl
  }

  if (browserOrigin) {
    return browserOrigin
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2 || typeof atob !== 'function') return null
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    return JSON.parse(atob(normalized)) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractTenantHintFromPayload(payload: Record<string, unknown> | null): string {
  if (!payload) return ''
  const raw = payload.tenantId ?? payload.workspaceId
  return typeof raw === 'string' ? raw.trim() : ''
}

function getStoredTenantHint(): string {
  if (typeof localStorage === 'undefined') return ''
  for (const key of TENANT_HINT_KEYS) {
    const value = localStorage.getItem(key)
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return ''
}

function getLocationTenantHint(): string {
  if (typeof window === 'undefined') return ''
  try {
    const params = new URLSearchParams(window.location.search || '')
    for (const key of TENANT_HINT_KEYS) {
      const value = params.get(key)
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim()
      }
    }
  } catch {
    return ''
  }
  return ''
}

export function clearStoredAuthState(): void {
  if (typeof localStorage === 'undefined') return
  for (const key of TOKEN_STORAGE_KEYS) {
    localStorage.removeItem(key)
  }
  for (const key of TENANT_HINT_KEYS) {
    localStorage.removeItem(key)
  }
  for (const key of USER_STATE_KEYS) {
    localStorage.removeItem(key)
  }
  clearExplicitSessionOrg()
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
  const tenantHint =
    explicitSessionOrg(resolvedToken) ||
    getStoredTenantHint() ||
    getLocationTenantHint() ||
    extractTenantHintFromPayload(decodeJwtPayload(resolvedToken))
  if (tenantHint) {
    headers['x-tenant-id'] = tenantHint
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

function handlePasswordChangeRequired(path: string): void {
  if (typeof window === 'undefined' || authRedirecting || isAuthRoute(path)) {
    return
  }
  if ((window.location?.pathname || '') === '/force-password-change') {
    return
  }
  authRedirecting = true
  window.setTimeout(() => {
    authRedirecting = false
  }, 3000)
  if (typeof window.location?.replace === 'function') {
    window.location.replace('/force-password-change')
  } else {
    window.location.href = '/force-password-change'
  }
}

/**
 * TRANSPORT-FAILURE HANDLING FOR THE ONE `fetch` CALL IN THIS APP'S API LAYER.
 *
 * Two separate things happen here, and they have different trigger sets on purpose:
 *
 * 1. TRANSLATION (all methods). A transport failure — backend down, connection
 *    reset, DNS/TLS failure — rejects with a `TypeError` carrying a browser engine
 *    literal ("Failed to fetch"). Callers put `e.message` straight on screen, so it
 *    is rewritten into `createNetworkUnavailableError` copy. An HTTP RESPONSE is
 *    never touched: 5xx still returns the Response unchanged, so
 *    `apiDefaultErrorMessage` keeps owning that copy.
 *
 * 2. RETRY (idempotent reads only). Only when the caller asked for GET/HEAD with no
 *    body. DELETE/PATCH/POST/PUT are NOT retried even once —
 *    a reset can happen AFTER the server committed the write, so a replay could
 *    double-apply it. Retrying a 5xx RESPONSE is likewise out of scope: an upgrade
 *    window would turn every open tab into a retry storm against a backend that just
 *    came up.
 *
 * Backoff waits are abortable: a caller that aborts during the pause gets an
 * AbortError immediately, not the copy above (an abort is not an outage).
 */
const NETWORK_RETRY_DELAYS_MS = [1200, 3500] as const

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** Transport-layer rejection: `fetch` rejects with a TypeError and nothing else. */
function isTransportError(error: unknown): boolean {
  if (isAbortError(error)) return false
  if (error instanceof TypeError) return true
  return (error as { name?: unknown } | null)?.name === 'TypeError'
}

function abortErrorFor(signal: AbortSignal | null | undefined): unknown {
  const reason = (signal as { reason?: unknown } | null | undefined)?.reason
  if (reason) return reason
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** GET/HEAD with no body. A body (JSON or FormData) also means the stream cannot be replayed. */
function isIdempotentRead(init: RequestInit): boolean {
  const method = String(init.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  return init.body == null
}

function waitUnlessAborted(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal))
      return
    }
    let onAbort: (() => void) | null = null
    const timer = setTimeout(() => {
      if (onAbort && typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      resolve()
    }, ms)
    if (typeof signal?.addEventListener === 'function') {
      onAbort = () => {
        clearTimeout(timer)
        reject(abortErrorFor(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function fetchWithTransportCopy(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal as AbortSignal | null | undefined
  const maxRetries = isIdempotentRead(init) ? NETWORK_RETRY_DELAYS_MS.length : 0
  let attempt = 0
  for (;;) {
    try {
      return await fetch(url, init)
    } catch (error) {
      // Aborts and non-transport throws (e.g. a caller-supplied fetch stub raising a
      // domain error) pass through untouched — only the transport literal is rewritten.
      if (!isTransportError(error)) throw error
      if (attempt >= maxRetries) throw createNetworkUnavailableError(error)
      // `waitUnlessAborted` is the SINGLE place abort is enforced for a retry: it
      // rejects immediately when the signal is already aborted, so a caller who
      // cancelled never buys another attempt (nor an outage message for their own
      // cancellation). Duplicating that check here would be untestable dead weight.
      await waitUnlessAborted(NETWORK_RETRY_DELAYS_MS[attempt], signal)
      attempt += 1
    }
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
  const { suppressUnauthorizedRedirect = false, omitHeaders = [], ...requestOptions } = options
  const headers = new Headers({
    ...authHeaders(),
    ...(requestOptions.headers || {}),
  })
  for (const name of omitHeaders) headers.delete(name)
  const body = requestOptions.body
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  if (!isFormData && body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetchWithTransportCopy(`${base}${path}`, {
    ...requestOptions,
    headers,
  })

  if (response.status === 401 && !suppressUnauthorizedRedirect) {
    handleUnauthorized(path)
  }

  if (response.status === 403 && !suppressUnauthorizedRedirect) {
    try {
      const payload = await response.clone().json() as Record<string, unknown>
      const error = payload.error as Record<string, unknown> | undefined
      if (error?.code === 'PASSWORD_CHANGE_REQUIRED') {
        handlePasswordChangeRequired(path)
      }
    } catch {
      // Ignore non-JSON 403 payloads.
    }
  }

  return response
}

/**
 * Make a GET request to the API
 */
export async function apiGet<T = any>(path: string, options?: ApiFetchOptions): Promise<T> {
  const response = await apiFetch(path, options)
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
