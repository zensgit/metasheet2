/**
 * API utilities for frontend-backend communication
 */

// Vite environment type declaration
declare global {
  interface ImportMetaEnv {
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
  // In development, use VITE_API_BASE if set
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE as string
  }
  // In production or when not set, use relative path (same origin)
  return ''
}

/**
 * Build authorization headers for authenticated requests
 */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token')
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
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
