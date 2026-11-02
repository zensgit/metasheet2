import { apiFetch } from '../../utils/api'

export interface PlmApprovalBinding {
  id: string
  connectionId: string
  subjectId: string
  tenantId: string
  orgId: string
  grantId: string
  expiresAt: string
  bound: boolean
  unresolvedCount: number
}

export interface PlmApprovalListedBinding extends PlmApprovalBinding {
  canUse: boolean
}

export interface PlmApprovalBindings {
  connection: { id: string; label: string; grantManagementUrl: string | null }
  bindings: PlmApprovalListedBinding[]
}

const BASE = '/api/me/plm-approval-bindings'
const messages: Record<string, string> = {
  PLM_CARD_DISABLED: '此部署尚未启用 Yuantus 审批连接。',
  PLM_CARD_UNAUTHORIZED: '登录会话已失效，请重新登录。',
  PLM_BINDING_REQUIRED: '请先绑定有效的 Yuantus 个人授权。',
  PLM_BINDING_CONFLICT: '该连接已有历史操作，请使用原 Yuantus 账号及相同租户、组织重新绑定。',
  PLM_PROVIDER_UNAVAILABLE: '暂时无法连接 Yuantus，请稍后重试。',
  PLM_PROVIDER_FORBIDDEN: 'Yuantus 拒绝了当前个人授权，请检查有效期及权限。',
  PLM_CARD_INVALID_INPUT: '授权信息无效，请检查后重新输入。',
}

export class PlmApprovalBindingError extends Error {
  readonly code: string
  constructor(code: string) {
    super(messages[code] ?? '操作未完成，请刷新连接状态后重试。')
    this.code = code
    this.name = 'PlmApprovalBindingError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlmApprovalBindingError('INVALID_RESPONSE')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new PlmApprovalBindingError('INVALID_RESPONSE')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new PlmApprovalBindingError('INVALID_RESPONSE')
  return value
}
function managementUrl(value: unknown): string | null {
  if (value === null) return null
  let url: URL
  try { url = new URL(text(value)) } catch { throw new PlmApprovalBindingError('INVALID_RESPONSE') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/personal-approval-grants') throw new PlmApprovalBindingError('INVALID_RESPONSE')
  return url.href
}
function binding(value: unknown): PlmApprovalBinding {
  const row = object(value)
  if (typeof row.bound !== 'boolean' || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) {
    throw new PlmApprovalBindingError('INVALID_RESPONSE')
  }
  // Project metadata explicitly; an unexpected response field never carries a credential into UI state.
  return {
    id: text(row.id), connectionId: text(row.connectionId), subjectId: text(row.subjectId),
    tenantId: text(row.tenantId), orgId: text(row.orgId), grantId: text(row.grantId),
    expiresAt: row.expiresAt, bound: row.bound, unresolvedCount: count(row.unresolvedCount),
  }
}
function listedBinding(value: unknown): PlmApprovalListedBinding {
  const row = object(value)
  if (typeof row.canUse !== 'boolean') throw new PlmApprovalBindingError('INVALID_RESPONSE')
  return { ...binding(row), canUse: row.canUse }
}

async function call(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, {
      method, signal, cache: 'no-store', suppressUnauthorizedRedirect: true,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new PlmApprovalBindingError('PLM_PROVIDER_UNAVAILABLE')
  }
  if (method === 'DELETE' && response.status === 204) return null
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    const code = payload?.error?.code
    throw new PlmApprovalBindingError(typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code) ? code : 'REQUEST_FAILED')
  }
  return payload.data
}

export async function getPlmApprovalBindings(signal?: AbortSignal): Promise<PlmApprovalBindings> {
  const data = object(await call(BASE, 'GET', undefined, signal))
  const connection = object(data.connection)
  if (!Array.isArray(data.bindings)) throw new PlmApprovalBindingError('INVALID_RESPONSE')
  const grantManagementUrl = managementUrl(connection.grantManagementUrl)
  const id = text(connection.id)
  const bindings = data.bindings.map(listedBinding)
  // canUse true cannot describe a stale connection, an unbound row, or a missing management URL.
  if (bindings.some((row) => row.canUse && (row.connectionId !== id || row.bound === false || grantManagementUrl === null))) {
    throw new PlmApprovalBindingError('INVALID_RESPONSE')
  }
  return { connection: { id, label: text(connection.label), grantManagementUrl }, bindings }
}
export async function bindPlmApprovalGrant(connectionId: string, grant: string, signal?: AbortSignal): Promise<PlmApprovalBinding> {
  return binding(await call(BASE, 'POST', { connectionId, grant }, signal))
}
export async function unbindPlmApprovalGrant(id: string, signal?: AbortSignal): Promise<void> {
  await call(`${BASE}/${encodeURIComponent(id)}`, 'DELETE', undefined, signal)
}
export async function syncPlmApprovalTasks(id: string, signal?: AbortSignal): Promise<{ taskCount: number; retiredCount: number }> {
  const data = object(await call(`${BASE}/${encodeURIComponent(id)}/sync`, 'POST', {}, signal))
  return { taskCount: count(data.taskCount), retiredCount: count(data.retiredCount) }
}
export async function reconcilePlmApprovalCommands(id: string, signal?: AbortSignal): Promise<{ settled: number; pending: number; admissionRequired: number }> {
  const data = object(await call(`${BASE}/${encodeURIComponent(id)}/reconcile`, 'POST', {}, signal))
  return { settled: count(data.settled), pending: count(data.pending), admissionRequired: count(data.admissionRequired) }
}
