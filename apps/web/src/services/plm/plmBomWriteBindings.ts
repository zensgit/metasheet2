import { apiFetch } from '../../utils/api'

export interface PlmBomWriteBinding {
  id: string
  ownerId: string
  metaTenantId: string | null
  dataSourceId: string
  connectionId: string
  subjectId: string
  targetOrigin: string
  yuantusTenantId: string
  yuantusOrgId: string
  workspaceId: string | null
  scopeKind: string
  grantId: string
  generation: number
  expiresAt: string
  bound: boolean
  remoteRevokeState: string | null
  previousGrantRevokeState: string | null
}

const BASE = '/api/me/plm-bom-write-bindings'
const YUW_GRANT = /^yuw_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET_KEYS = new Set([
  'encrypted_grant',
  'encryptedGrant',
  'grant',
  'token',
  'ciphertext',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'authorization',
])

const messages: Record<string, string> = {
  PLM_BOM_WRITE_DISABLED: '此部署尚未启用个人 BOM 写入。',
  PLM_BOM_WRITE_UNAUTHORIZED: '登录会话已失效，请重新登录。',
  PLM_BOM_WRITE_FORBIDDEN: '当前账号不能使用该数据源的个人 BOM 写入授权。',
  PLM_BOM_WRITE_NOT_FOUND: '未找到这条个人 BOM 写入授权。',
  PLM_BOM_WRITE_INVALID: '授权信息无效，请检查后重新输入。',
  PLM_BOM_WRITE_UNAVAILABLE: '暂时无法完成个人 BOM 写入授权操作，请稍后重试。',
  INVALID_RESPONSE: '授权状态无法读取，请稍后重试。',
  REQUEST_FAILED: '操作未完成，请稍后重试。',
}

export class PlmBomWriteBindingError extends Error {
  readonly code: string
  constructor(code: string) {
    super(messages[code] ?? messages.REQUEST_FAILED)
    this.code = messages[code] ? code : 'REQUEST_FAILED'
    this.name = 'PlmBomWriteBindingError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  return value.trim()
}

function nullableText(value: unknown): string | null {
  if (value === null) return null
  return text(value)
}

/** Native `wire_text` for `personalBomWriteBindingInput.connectionId`: 1–128 code points, no NUL. */
function connectionRegistrationId(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\u0000')) return null
  let count = 0
  for (let index = 0; index < trimmed.length; index += 1) {
    const unit = trimmed.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = trimmed.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        count += 1
        index += 1
        continue
      }
      return null
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return null
    count += 1
  }
  if (count < 1 || count > 128) return null
  return trimmed
}

function assertNoSecrets(row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    if (SECRET_KEYS.has(key)) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
    const value = row[key]
    if (typeof value === 'string' && (YUW_GRANT.test(value) || value.startsWith('yua_'))) {
      throw new PlmBomWriteBindingError('INVALID_RESPONSE')
    }
  }
}

/**
 * The management page is the one `personalBomWriteManagementUrl()` returns:
 * an http(s) origin, pathname `/personal-approval-grants`, and hash exactly `#bom-write`.
 * A bare approval URL, another hash, a query, or userinfo is refused.
 * This does not add or rewrite the hash.
 */
export function personalBomWriteManagementUrl(value: unknown): string {
  let url: URL
  try {
    url = new URL(text(value))
  } catch {
    throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  }
  const liveBomWritePage = url.pathname === '/personal-approval-grants' && url.hash === '#bom-write'
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || !liveBomWritePage) {
    throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  }
  return url.href
}

function binding(value: unknown): PlmBomWriteBinding {
  const row = object(value)
  assertNoSecrets(row)
  if (typeof row.bound !== 'boolean') throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  const expiresAt = text(row.expiresAt)
  if (!Number.isFinite(Date.parse(expiresAt))) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  const generation = row.generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  }
  const id = text(row.id)
  if (!UUID.test(id)) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  const grantId = text(row.grantId)
  if (YUW_GRANT.test(grantId) || grantId.startsWith('yua_') || grantId.startsWith('yuw_')) {
    throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  }
  return {
    id,
    ownerId: text(row.ownerId),
    metaTenantId: nullableText(row.metaTenantId),
    dataSourceId: text(row.dataSourceId),
    connectionId: text(row.connectionId),
    subjectId: text(row.subjectId),
    targetOrigin: text(row.targetOrigin),
    yuantusTenantId: text(row.yuantusTenantId),
    yuantusOrgId: text(row.yuantusOrgId),
    workspaceId: nullableText(row.workspaceId),
    scopeKind: text(row.scopeKind),
    grantId,
    generation,
    expiresAt,
    bound: row.bound,
    remoteRevokeState: nullableText(row.remoteRevokeState),
    previousGrantRevokeState: nullableText(row.previousGrantRevokeState),
  }
}

async function call(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, {
      method,
      signal,
      cache: 'no-store',
      suppressUnauthorizedRedirect: true,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new PlmBomWriteBindingError('PLM_BOM_WRITE_UNAVAILABLE')
  }
  const payload = await response.json().catch(() => null) as { ok?: unknown; error?: { code?: unknown }; data?: unknown } | null
  if (!response.ok || payload?.ok !== true) {
    const code = payload?.error?.code
    throw new PlmBomWriteBindingError(typeof code === 'string' ? code : 'REQUEST_FAILED')
  }
  return payload.data
}

export async function listPlmBomWriteBindings(signal?: AbortSignal): Promise<PlmBomWriteBinding[]> {
  const data = await call(BASE, 'GET', undefined, signal)
  if (!Array.isArray(data)) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  return data.map(binding)
}

export async function getPlmBomWriteManagementUrl(dataSourceId: string, signal?: AbortSignal): Promise<string> {
  const id = dataSourceId.trim()
  if (!id) throw new PlmBomWriteBindingError('PLM_BOM_WRITE_INVALID')
  const data = object(await call(`${BASE}/management-url?dataSourceId=${encodeURIComponent(id)}`, 'GET', undefined, signal))
  if (Object.keys(data).some((key) => key !== 'url')) throw new PlmBomWriteBindingError('INVALID_RESPONSE')
  return personalBomWriteManagementUrl(data.url)
}

export async function bindPlmBomWriteGrant(
  dataSourceId: string,
  connectionId: string,
  grant: string,
  signal?: AbortSignal,
): Promise<PlmBomWriteBinding> {
  const id = dataSourceId.trim()
  const connection = connectionRegistrationId(connectionId)
  const secret = grant.trim()
  if (!id || !connection || secret.startsWith('yua_') || !YUW_GRANT.test(secret)) {
    throw new PlmBomWriteBindingError('PLM_BOM_WRITE_INVALID')
  }
  return binding(await call(BASE, 'POST', {
    dataSourceId: id,
    connectionId: connection,
    grant: secret,
  }, signal))
}

export async function unbindPlmBomWriteBinding(id: string, signal?: AbortSignal): Promise<PlmBomWriteBinding> {
  const bindingId = id.trim()
  if (!UUID.test(bindingId)) throw new PlmBomWriteBindingError('PLM_BOM_WRITE_INVALID')
  return binding(await call(`${BASE}/${encodeURIComponent(bindingId)}`, 'DELETE', undefined, signal))
}

export async function retryPlmBomWriteRetiredRevocations(signal?: AbortSignal): Promise<void> {
  await call(`${BASE}/retired-revocations/retry`, 'POST', {}, signal)
}
