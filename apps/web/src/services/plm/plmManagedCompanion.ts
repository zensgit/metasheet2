import { apiFetch } from '../../utils/api'

const SECRET = /yur_|code_verifier|clientSecret|client_secret/

export class PlmManagedCompanionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlmManagedCompanionError'
  }
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (SECRET.test(text)) throw new PlmManagedCompanionError('托管登录响应被拒绝')
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    throw new PlmManagedCompanionError('托管登录响应无法读取')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PlmManagedCompanionError('托管登录响应无法读取')
  }
  return body as Record<string, unknown>
}

export function followManagedNavigation(url: string): void {
  window.location.assign(url)
}

export async function startManagedLogin(dataSourceId: string, rootPartId: string): Promise<{ navigationUrl: string }> {
  const response = await apiFetch('/api/plm/managed-login/start', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ dataSourceId, rootPartId }),
  })
  const body = await readBody(response)
  const navigationUrl = body.navigationUrl
  if (!response.ok || body.ok !== true || typeof navigationUrl !== 'string' || SECRET.test(navigationUrl)) {
    throw new PlmManagedCompanionError('托管登录未能开始')
  }
  return { navigationUrl }
}

export async function unlinkManagedSource(dataSourceId: string): Promise<{ state: string }> {
  const response = await apiFetch('/api/plm/managed-login/unlink', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ dataSourceId }),
  })
  const body = await readBody(response)
  if (!response.ok || body.ok !== true || (body.state !== 'pending' && body.state !== 'acked')) {
    throw new PlmManagedCompanionError('解除托管尚未完成')
  }
  return { state: body.state }
}

export async function readManagedStatus(dataSourceId: string): Promise<{
  linked: boolean
  pendingRevoke: boolean
  generation: number | null
}> {
  const response = await apiFetch(`/api/plm/managed-login/session?dataSourceId=${encodeURIComponent(dataSourceId)}`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readBody(response)
  if (!response.ok || body.ok !== true) throw new PlmManagedCompanionError('托管状态无法读取')
  return {
    linked: body.linked === true,
    pendingRevoke: body.pendingRevoke === true,
    generation: typeof body.generation === 'number' ? body.generation : null,
  }
}
