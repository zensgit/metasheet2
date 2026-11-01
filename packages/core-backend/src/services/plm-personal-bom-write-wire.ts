import { createHash } from 'node:crypto'
import { z } from 'zod'

/** Independent of PLM_APPROVAL_CARD_ENABLED. Exact literal only; default off. */
export function isPlmPersonalBomWriteEnabled(): boolean {
  return process.env.PLM_PERSONAL_BOM_WRITE_ENABLED === 'true'
}

/** Python `len` is Unicode code points. A lone surrogate is not UTF-8, so it is rejected. */
function codePointLength(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        count += 1
        index += 1
        continue
      }
      return -1
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return -1
    count += 1
  }
  return count
}

/**
 * Native `wire_text`: non-empty UTF-8, code-point length <= maximum, NUL rejected.
 * Printable non-ASCII is valid. This is not an ASCII whitelist.
 */
function wireText(value: string, maximum = 128): boolean {
  if (!value || value.includes('\u0000')) return false
  const length = codePointLength(value)
  return length >= 1 && length <= maximum
}

/** Header text: native wire length, UTF-8 allowed, C0 and DEL rejected. */
function headerText(value: string, maximum = 128): boolean {
  return wireText(value, maximum) && ![...value].some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

/**
 * One opaque URL segment. Native item ids are unbounded strings: meta_items.id is String,
 * and PATCH part_id / bom_line_id have no max_length. The 128-code-point header cap does not apply.
 * Slash, question mark, hash, and backslash stay out. Native answers 401 for encoded ?/#,
 * and those characters would retarget the URL. Other accepted characters are percent-encoded
 * only when the URL is built.
 */
function opaquePathSegment(value: string): boolean {
  if (!value || value.includes('\u0000')) return false
  if (codePointLength(value) < 1) return false
  if (/[/?#\\]/.test(value)) return false
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

const text = z.string().refine((value) => wireText(value))
const subject = z.string().regex(/^[1-9][0-9]{0,17}$/)
const utc = z.string().datetime()
const pathId = z.string().refine(opaquePathSegment)
export const YUW_GRANT = /^yuw_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/
const SECRETISH = /yua_|yuw_|bearer\s|enc:/i
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/

export class PlmPersonalBomWriteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: SanitizedNativeConflict,
    readonly received = false,
  ) {
    super(code)
    this.name = 'PlmPersonalBomWriteError'
  }
}

export function requirePlmPersonalBomWrite(): void {
  if (!isPlmPersonalBomWriteEnabled()) throw new PlmPersonalBomWriteError(404, 'PLM_BOM_WRITE_DISABLED')
}

export const personalBomWriteGrantSchema = z
  .object({
    schema: z.literal('yuantus.plm-bom-write-binding.v1'),
    grant_id: z.string().regex(/^[0-9a-f]{32}$/),
    connection_id: text,
    tenant_id: text,
    org_id: text,
    auth_user_id: subject,
    expires_at: utc,
    purpose: z.literal('bom_write'),
  })
  .strict()

export const personalBomWriteBindingInput = z
  .object({
    dataSourceId: z.string().min(1).max(256).refine((value) => /^[\x20-\x7e]+$/.test(value)),
    connectionId: text,
    grant: z.string().regex(YUW_GRANT),
  })
  .strict()

/**
 * Trusted Meta caller. `metaTenantId` is explicit null or a nonempty string.
 * A future route may set null only for a known legacy_private policy when authenticated context is absent.
 * It copies JWT `req.authenticatedTenantId` and does not infer a tenant from `req.user`, a header, the body, or the Yuantus tenant.
 */
export interface PersonalBomWriteActor {
  userId: string
  metaTenantId: string | null
}

export type PersonalBomWriteOperation = 'verify' | 'revoke' | 'line' | 'eco-intent'
export interface PersonalBomWriteTarget {
  partId: string
  bomLineId?: string
  idempotencyKey?: string
  ifMatch?: string
}
export interface PreparedPersonalBomWriteCall {
  method: 'POST' | 'DELETE' | 'PATCH'
  path: string
  body?: unknown
  idempotencyKey?: string
  ifMatch?: string
}

/** Same authenticated page as approval. The hash selects bom_write; the page calls the write API. */
export function personalBomWriteManagementUrl(origin: URL): string {
  const url = new URL('/personal-approval-grants', origin)
  url.hash = 'bom-write'
  return url.href
}

export function grantPublicId(token: string): string {
  const match = YUW_GRANT.exec(token)
  if (!match) throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  return match[1]
}

export interface ResolvedPersistedPlmSource {
  origin: URL
  tenantId: string
  orgId: string
}

/** Host that actually receives the personal bearer. Path, query, and userinfo are not part of it. */
export interface PersonalBomWriteAuthority {
  origin: string
  tenantId: string
  orgId: string
}

/** Accept only a canonical origin string. A path or a second host cannot ride along. */
export function trustedRequestOrigin(value: string): URL {
  const fail = (): never => {
    throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }
  if (typeof value !== 'string' || value.length < 8 || value.length > 300) fail()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail()
  }
  const loopback =
    process.env.NODE_ENV === 'test' &&
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !loopback)
  )
    fail()
  return url
}

function invalid(): never {
  throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
}

function scopeAliases(headers: unknown, name: string, option: unknown): string | undefined {
  const values: unknown[] = []
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === name) values.push(value)
    }
  }
  if (option !== undefined) values.push(option)
  if (!values.length) return undefined
  if (
    values.some(
      (value) => typeof value !== 'string' || !headerText(value) || value.trim() !== value,
    )
  )
    return undefined
  return new Set(values).size === 1 ? (values[0] as string) : undefined
}

/** Persisted source config only. Global config, env, and adapter cache are not consulted. */
export function resolvePersistedPlmSource(config: unknown): ResolvedPersistedPlmSource {
  const fail = (): never => {
    throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail()
  const source = config as {
    type?: unknown
    connection?: unknown
    options?: { apiMode?: unknown; tenantId?: unknown; orgId?: unknown }
  }
  if (source.type !== 'plm' || source.options?.apiMode !== 'yuantus') fail()
  const connection = source.connection
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) fail()
  const raw = connection as { url?: unknown; baseURL?: unknown; headers?: unknown }
  const primary = typeof raw.url === 'string' ? raw.url : raw.baseURL
  if (typeof primary !== 'string') return fail()
  let origin: URL
  try {
    origin = new URL(primary)
    if (typeof raw.url === 'string' && typeof raw.baseURL === 'string' && new URL(raw.url).href !== new URL(raw.baseURL).href)
      fail()
  } catch (error) {
    if (error instanceof PlmPersonalBomWriteError) throw error
    fail()
  }
  const loopback =
    process.env.NODE_ENV === 'test' &&
    origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  // Root only. Personal transport keeps URL.origin and would drop a prefix that
  // global READ of this Source still uses. Parsed `https://host` and `https://host/`
  // are both pathname '/'. Any other parsed pathname is rejected. This tightens
  // persisted sources that previously carried an ignored prefix.
  if (
    (origin.protocol !== 'https:' && !loopback) ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    fail()
  const tenantId = scopeAliases(raw.headers, 'x-tenant-id', source.options?.tenantId)
  const orgId = scopeAliases(raw.headers, 'x-org-id', source.options?.orgId)
  if (!tenantId || !orgId) fail()
  return { origin, tenantId, orgId }
}

export function normalizeMetaTenant(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > 128 || !/^[\x20-\x7e]+$/.test(trimmed))
    throw new PlmPersonalBomWriteError(403, 'PLM_BOM_WRITE_FORBIDDEN')
  return trimmed
}

const LINE_KEYS = ['quantity', 'uom', 'find_num', 'refdes'] as const

/**
 * JSON body cell. Native stores the scalar as given: empty is a value, and there is
 * no header length and no ASCII whitelist. NUL is not a text scalar. A lone surrogate is not Unicode.
 */
function jsonCellText(value: string): boolean {
  if (value.includes('\u0000')) return false
  return codePointLength(value) >= 0
}

export function linePatchBody(input: unknown): Record<string, string | number | null> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  const source = input as Record<string, unknown>
  const body: Record<string, string | number | null> = {}
  for (const key of LINE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (key === 'quantity') {
      if (typeof value === 'boolean' || (value !== null && typeof value !== 'number' && typeof value !== 'string'))
        throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
      if (typeof value === 'string' && !jsonCellText(value))
        throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    } else if (value !== null && (typeof value !== 'string' || !jsonCellText(value))) {
      throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    }
    body[key] = value as string | number | null
  }
  if (!Object.keys(body).length) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  return body
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  return value
}

/** Allowed personal write set from native 13e5: verify, self-revoke, line PATCH, eco-intent POST. */
export function preparePersonalBomWriteCall(
  operation: PersonalBomWriteOperation,
  connectionId: string,
  data?: unknown,
  target?: PersonalBomWriteTarget,
): PreparedPersonalBomWriteCall {
  if (!wireText(connectionId)) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  if (operation === 'verify') {
    if (target || data !== undefined) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    return { method: 'POST', path: '/api/v1/plm-bom-write-grant/verify', body: { connection_id: connectionId } }
  }
  if (operation === 'revoke') {
    if (target || data !== undefined) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    return { method: 'DELETE', path: '/api/v1/plm-bom-write-grant/grant' }
  }
  if (!target) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  const part = pathId.safeParse(target.partId)
  if (!part.success) invalid()
  const partId = part.data
  const key = idempotencyKey(target.idempotencyKey)
  let ifMatch: string | undefined
  if (target.ifMatch !== undefined) {
    if (typeof target.ifMatch !== 'string' || !headerText(target.ifMatch))
      throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    ifMatch = target.ifMatch
  }
  if (operation === 'line') {
    const line = pathId.safeParse(target.bomLineId)
    if (!line.success) invalid()
    const bomLineId = line.data
    return {
      method: 'PATCH',
      path: `/api/v1/bom/multitable/${encodeURIComponent(partId)}/lines/${encodeURIComponent(bomLineId)}`,
      body: linePatchBody(data),
      idempotencyKey: key,
      ifMatch,
    }
  }
  if (operation === 'eco-intent') {
    if (data !== undefined || target.bomLineId !== undefined || ifMatch !== undefined)
      throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    return {
      method: 'POST',
      path: `/api/v1/bom/multitable/${encodeURIComponent(partId)}/eco-intent`,
      idempotencyKey: key,
    }
  }
  throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
}

export interface SanitizedNativeConflict {
  code?: string
  message?: string
  state?: string | null
  eco_required?: boolean
  locked_via?: 'ancestor'
  locked_item_id?: string
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value || value.length > max) return undefined
  if (/[\u0000-\u001f\u007f]/.test(value) || SECRETISH.test(value)) return undefined
  return value
}

/** Keep native business conflict fields. Drop every other field, including any secret. */
export function sanitizeNativeConflict(body: string): SanitizedNativeConflict | undefined {
  if (Buffer.byteLength(body) > 8192) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const detail: SanitizedNativeConflict = {}
  const error = record.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = safeText((error as { code?: unknown }).code, 64)
    if (code && SAFE_CODE.test(code)) detail.code = code
  }
  const raw = record.detail
  if (typeof raw === 'string') {
    const message = safeText(raw, 500)
    if (message) detail.message = message
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const item = raw as Record<string, unknown>
    const code = safeText(item.code, 64)
    const message = safeText(item.message, 500)
    if (code && SAFE_CODE.test(code)) detail.code = code
    if (message) detail.message = message
    if (item.state === null) detail.state = null
    else {
      const state = safeText(item.state, 64)
      if (state) detail.state = state
    }
    if (typeof item.eco_required === 'boolean') detail.eco_required = item.eco_required
    if (item.locked_via === 'ancestor') detail.locked_via = 'ancestor'
    const locked = safeText(item.locked_item_id, 128)
    if (locked) detail.locked_item_id = locked
  }
  return Object.keys(detail).length ? detail : undefined
}

export function personalBomWriteHttpError(status: number, body: string): PlmPersonalBomWriteError {
  const detail = sanitizeNativeConflict(body)
  const code =
    status === 401
      ? 'PLM_BOM_WRITE_UNAUTHORIZED'
      : status === 403
        ? 'PLM_BOM_WRITE_FORBIDDEN'
        : status === 404
          ? 'PLM_BOM_WRITE_NOT_FOUND'
          : status === 409
            ? 'PLM_BOM_WRITE_CONFLICT'
            : status === 412
              ? 'PLM_BOM_WRITE_PRECONDITION'
              : status === 400 || status === 422
                ? 'PLM_BOM_WRITE_INVALID'
                : 'PLM_BOM_WRITE_UNAVAILABLE'
  return new PlmPersonalBomWriteError(status, code, detail, true)
}

const lineSuccess = z.object({ ok: z.literal(true), bom_line_id: pathId }).strict()
const ecoSuccess = z
  .object({
    eco_id: z.string().min(1).max(128),
    state: text,
    attached: z.boolean(),
    source_version_id: z.string().min(1).max(128).nullable(),
    target_version_id: z.string().min(1).max(128).nullable(),
  })
  .strict()

export function parsePersonalBomWriteSuccess(
  operation: PersonalBomWriteOperation,
  status: number,
  body: string,
): unknown {
  if (Buffer.byteLength(body) > 8192) throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
  if (operation === 'revoke') {
    if (status !== 204 || body.trim())
      throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
    return null
  }
  let parsed: unknown
  try {
    parsed = body ? JSON.parse(body) : null
  } catch {
    throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
  }
  if (operation === 'verify') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
    return parsed
  }
  const schema = operation === 'line' ? lineSuccess : ecoSuccess
  const result = schema.safeParse(parsed)
  if (!result.success) throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
  return result.data
}

export interface NativeWriteScope {
  purpose: 'bom_write'
  targetOrigin: string
  connectionId: string
  yuantusTenantId: string
  yuantusOrgId: string
  subjectId: string
}

export interface FrozenNativeOperation extends NativeWriteScope {
  operationKind: 'line' | 'eco-intent'
  ownerId: string
  dataSourceId: string
  metaTenantId: string | null
  partId: string
  bomLineId: string | null
  clientKeySha256: string
  payloadFingerprint: string
  providerIdempotencyKey: string
}

export interface FrozenDispatchAttempt {
  bindingGeneration: number
  attempt: number
  providerIdempotencyKey: string
  nativeMaterial: string
  nativeScopeKey: string
}

export interface BindingAuthorizationView {
  ownerId: string
  dataSourceId: string
  metaTenantId: string | null
  targetOrigin: string
  connectionId: string
  yuantusTenantId: string
  yuantusOrgId: string
  subjectId: string
  grantId?: string
  generation?: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** SHA-256 of the caller key. The raw key is not a storage or log field. */
export function clientKeySha256(clientKey: string): string {
  return sha256(clientKey)
}

/** Python `json.dumps(..., separators=(",", ":"), ensure_ascii=True)` for string-or-null tuples. */
function pythonJson(values: readonly (string | null)[]): string {
  return `[${values.map((value) => (value === null ? 'null' : `"${escapePythonString(value)}"`)).join(',')}]`
}

function escapePythonString(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
      out += `\\u${unit.toString(16).padStart(4, '0')}\\u${next.toString(16).padStart(4, '0')}`
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    if (unit === 0x22) out += '\\"'
    else if (unit === 0x5c) out += '\\\\'
    else if (unit === 0x08) out += '\\b'
    else if (unit === 0x0c) out += '\\f'
    else if (unit === 0x0a) out += '\\n'
    else if (unit === 0x0d) out += '\\r'
    else if (unit === 0x09) out += '\\t'
    else if (unit < 0x20) out += `\\u${unit.toString(16).padStart(4, '0')}`
    else if (unit < 0x80) out += value[index]
    else out += `\\u${unit.toString(16).padStart(4, '0')}`
  }
  return out
}

/** Server key for the native Idempotency-Key. Grant id, payload, part, and attempt are not inputs. */
export function providerIdempotencyKey(parts: {
  operationKind: 'line' | 'eco-intent'
  ownerId: string
  dataSourceId: string
  metaTenantId: string | null
  targetOrigin: string
  connectionId: string
  yuantusTenantId: string
  yuantusOrgId: string
  subjectId: string
  clientKey: string
}): string {
  return sha256(
    pythonJson([
      'metasheet.plm-personal-bom-write-client.v1',
      parts.operationKind,
      parts.ownerId,
      parts.dataSourceId,
      parts.metaTenantId,
      parts.targetOrigin,
      parts.connectionId,
      parts.yuantusTenantId,
      parts.yuantusOrgId,
      parts.subjectId,
      parts.clientKey,
    ]),
  )
}

export function nativeLineHashMaterial(scope: NativeWriteScope, providerKey: string): string {
  return pythonJson([
    scope.purpose,
    'line',
    scope.connectionId,
    scope.yuantusTenantId,
    scope.yuantusOrgId,
    scope.subjectId,
    providerKey,
  ])
}

export function nativeEcoHashMaterial(scope: NativeWriteScope, partId: string, providerKey: string): string {
  return pythonJson([
    scope.purpose,
    'eco-intent',
    scope.connectionId,
    scope.yuantusTenantId,
    scope.yuantusOrgId,
    scope.subjectId,
    partId,
    providerKey,
  ])
}

export function nativeScopeKey(material: string): string {
  for (let index = 0; index < material.length; index += 1) {
    if (material.charCodeAt(index) > 0x7f) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  }
  return createHash('sha256').update(material, 'ascii').digest('hex')
}

export function canonicalPayload(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalPayload(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPayload(record[key])}`)
      .join(',')}}`
  }
  throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
}

export function freezeNativeOperation(input: {
  operationKind: 'line' | 'eco-intent'
  ownerId: string
  dataSourceId: string
  metaTenantId: string | null
  targetOrigin: string
  connectionId: string
  yuantusTenantId: string
  yuantusOrgId: string
  subjectId: string
  partId: string
  bomLineId: string | null
  clientKey: string
  payload: unknown
}): FrozenNativeOperation {
  const providerKey = providerIdempotencyKey({
    operationKind: input.operationKind,
    ownerId: input.ownerId,
    dataSourceId: input.dataSourceId,
    metaTenantId: input.metaTenantId,
    targetOrigin: input.targetOrigin,
    connectionId: input.connectionId,
    yuantusTenantId: input.yuantusTenantId,
    yuantusOrgId: input.yuantusOrgId,
    subjectId: input.subjectId,
    clientKey: input.clientKey,
  })
  return {
    purpose: 'bom_write',
    operationKind: input.operationKind,
    ownerId: input.ownerId,
    dataSourceId: input.dataSourceId,
    metaTenantId: input.metaTenantId,
    targetOrigin: input.targetOrigin,
    connectionId: input.connectionId,
    yuantusTenantId: input.yuantusTenantId,
    yuantusOrgId: input.yuantusOrgId,
    subjectId: input.subjectId,
    partId: input.partId,
    bomLineId: input.bomLineId,
    clientKeySha256: clientKeySha256(input.clientKey),
    payloadFingerprint: sha256(canonicalPayload(input.payload)),
    providerIdempotencyKey: providerKey,
  }
}

export function freezeDispatchAttempt(
  frozen: FrozenNativeOperation,
  bindingGeneration: number,
  attempt: number,
): FrozenDispatchAttempt {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  if (!Number.isInteger(bindingGeneration) || bindingGeneration < 1)
    throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  const nativeMaterial =
    frozen.operationKind === 'line'
      ? nativeLineHashMaterial(frozen, frozen.providerIdempotencyKey)
      : nativeEcoHashMaterial(frozen, frozen.partId, frozen.providerIdempotencyKey)
  return {
    bindingGeneration,
    attempt,
    providerIdempotencyKey: frozen.providerIdempotencyKey,
    nativeMaterial,
    nativeScopeKey: nativeScopeKey(nativeMaterial),
  }
}

/** Same native person may continue. Another subject, scope, source, or Meta tenant may not. */
export function bindingAuthorizesFrozen(current: BindingAuthorizationView, frozen: FrozenNativeOperation): boolean {
  return (
    current.ownerId === frozen.ownerId &&
    current.dataSourceId === frozen.dataSourceId &&
    current.metaTenantId === frozen.metaTenantId &&
    current.targetOrigin === frozen.targetOrigin &&
    current.connectionId === frozen.connectionId &&
    current.yuantusTenantId === frozen.yuantusTenantId &&
    current.yuantusOrgId === frozen.yuantusOrgId &&
    current.subjectId === frozen.subjectId
  )
}

export const personalBomWriteFreezeInput = z
  .object({
    operationKind: z.enum(['line', 'eco-intent']),
    partId: pathId,
    bomLineId: pathId.optional(),
    clientKey: z.string().min(1).max(128).refine((value) => /^[\x20-\x7e]+$/.test(value)),
    patch: z.unknown().optional(),
  })
  .strict()

export const personalBomWriteDispatchInput = z
  .object({
    operationKind: z.enum(['line', 'eco-intent']),
    partId: pathId,
    bomLineId: pathId.optional(),
    clientKey: z.string().min(1).max(128).refine((value) => /^[\x20-\x7e]+$/.test(value)),
    patch: z.unknown().optional(),
    ifMatch: z.string().refine((value) => headerText(value)).optional(),
  })
  .strict()

export interface PersonalBomWriteDispatchRequest {
  operationKind: 'line' | 'eco-intent'
  partId: string
  bomLineId: string | null
  clientKeySha256: string
  ifMatch: string | null
  requestBody: string
  payloadFingerprint: string
  /** Used only to hash the provider key on first insert. Not stored. */
  clientKey: string
}

/** Canonical effective body. Absence is the JSON token null, not an empty object. */
export function readPersonalBomWriteDispatch(input: unknown): PersonalBomWriteDispatchRequest {
  const parsed = personalBomWriteDispatchInput.safeParse(input)
  if (!parsed.success) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  const request = parsed.data
  if (request.operationKind === 'line') {
    if (!request.bomLineId) throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
    const requestBody = canonicalPayload(linePatchBody(request.patch))
    return {
      operationKind: 'line',
      partId: request.partId,
      bomLineId: request.bomLineId,
      clientKeySha256: clientKeySha256(request.clientKey),
      ifMatch: request.ifMatch ?? null,
      requestBody,
      payloadFingerprint: sha256(requestBody),
      clientKey: request.clientKey,
    }
  }
  if (request.bomLineId !== undefined || request.patch !== undefined || request.ifMatch !== undefined)
    throw new PlmPersonalBomWriteError(422, 'PLM_BOM_WRITE_INVALID')
  const requestBody = canonicalPayload(null)
  return {
    operationKind: 'eco-intent',
    partId: request.partId,
    bomLineId: null,
    clientKeySha256: clientKeySha256(request.clientKey),
    ifMatch: null,
    requestBody,
    payloadFingerprint: sha256(requestBody),
    clientKey: request.clientKey,
  }
}

export function acceptedPersonalBomWriteResult(
  operation: 'line' | 'eco-intent',
  value: unknown,
): { ok: true; bom_line_id: string } | {
  eco_id: string
  state: string
  attached: boolean
  source_version_id: string | null
  target_version_id: string | null
} {
  if (operation === 'line') {
    const parsed = lineSuccess.safeParse(value)
    if (!parsed.success) throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
    return parsed.data as { ok: true; bom_line_id: string }
  }
  const parsed = ecoSuccess.safeParse(value)
  if (!parsed.success) throw new PlmPersonalBomWriteError(503, 'PLM_BOM_WRITE_UNAVAILABLE', undefined, true)
  return parsed.data as {
    eco_id: string
    state: string
    attached: boolean
    source_version_id: string | null
    target_version_id: string | null
  }
}

export interface PersonalBomWriteTransport {
  personalBomWriteManagementUrl(sourceConfig: unknown): string
  personalBomWriteRequest(
    operation: PersonalBomWriteOperation,
    grant: string,
    connectionId: string,
    authority: PersonalBomWriteAuthority,
    data?: unknown,
    target?: PersonalBomWriteTarget,
  ): Promise<unknown>
}
