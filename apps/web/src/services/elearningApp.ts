import { apiFetch } from '../utils/api'

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
    throw new Error('request_failed')
  }
  if (!response.ok) throw new Error('request_failed')
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
