import { apiFetch } from '../utils/api'

/**
 * Thrown for every transport or HTTP failure. The message stays the closed token
 * `request_failed` (existing callers match on it); `status` is the HTTP status (0 for
 * a network failure) and `code` is `ORG_CONTEXT_REQUIRED` for the org-context gate's
 * 403, else `request_failed`. No other part of an error body is ever surfaced.
 */
export class ElearningAppRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code = 'request_failed') {
    super('request_failed')
    this.name = 'ElearningAppRequestError'
    this.status = status
    this.code = code
  }
}

async function readFailureCode(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).error === 'ORG_CONTEXT_REQUIRED') {
      return 'ORG_CONTEXT_REQUIRED'
    }
  } catch { /* Non-JSON error bodies stay opaque. */ }
  return 'request_failed'
}

export interface ElearningAppInstallation {
  status: 'not-installed' | 'inactive' | 'active'
  notificationsEnabled: boolean
  canManage: boolean
}

export function parseElearningAppInstallation(value: unknown): ElearningAppInstallation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_response')
  }
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 3
    || !Object.hasOwn(row, 'status') || !Object.hasOwn(row, 'notificationsEnabled')
    || !Object.hasOwn(row, 'canManage') || typeof row.canManage !== 'boolean'
    || !['not-installed', 'inactive', 'active'].includes(row.status as string)
    || typeof row.notificationsEnabled !== 'boolean') {
    throw new Error('invalid_response')
  }
  return { status: row.status as ElearningAppInstallation['status'], notificationsEnabled: row.notificationsEnabled, canManage: row.canManage }
}

async function request(method: 'GET' | 'POST' | 'PUT', body?: object): Promise<ElearningAppInstallation> {
  let response: Response
  try {
    response = await apiFetch('/api/elearning-app/installation', {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new ElearningAppRequestError(0)
  }
  if (!response.ok) throw new ElearningAppRequestError(response.status, await readFailureCode(response))
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('invalid_response')
  }
  return parseElearningAppInstallation(payload)
}

export const getElearningAppInstallation = () => request('GET')
export const installElearningApp = () => request('POST', {})
export function updateElearningAppInstallation(enabled: boolean, notificationsEnabled: boolean) {
  if (typeof enabled !== 'boolean' || typeof notificationsEnabled !== 'boolean') {
    throw new Error('invalid_input')
  }
  return request('PUT', { enabled, notificationsEnabled })
}
