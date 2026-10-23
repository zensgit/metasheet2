/**
 * MetaSheet consumer of the native managed-login provider.
 * Native keeps identity, PLM data and approval authority. This module stores an
 * explicit owner mapping and a short-lived read delegation. It does not copy
 * native roles or share API credentials with legacy sources.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { encryptStoredSecretValue, decryptStoredSecretValue } from '../security/encrypted-secrets'

export const MANAGED_COMPANION_PURPOSE = 'plm_managed_companion'
export const MANAGED_COMPANION_SCOPE = 'bom_review_read'
export const MANAGED_COMPANION_MAX_TTL_SECONDS = 600
export const MANAGED_EXCHANGE_ABORT_SECONDS = 8
export const MANAGED_INTENT_TTL_SECONDS = 300
export const MANAGED_FIXED_RETURN_PATH = '/plm/bom-review'
export const MANAGED_INTENT_COOKIE = 'ms_plm_managed_intent'
export const MANAGED_NONCE_COOKIE = 'ms_plm_managed_nonce'
export const MANAGED_SESSION_COOKIE = 'ms_plm_managed_session'

const PUBLIC_QUERY_KEYS = [
  'client_id',
  'callback',
  'origin',
  'tenant_id',
  'org_id',
  'issuer',
  'root_part_id',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

export class ManagedCompanionRefusal extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message = 'Managed companion request refused') {
    super(message)
    this.name = 'ManagedCompanionRefusal'
    this.status = status
    this.code = code
  }
}

export function isPlmManagedCompanionEnabled(): boolean {
  return process.env.PLM_MANAGED_COMPANION_ENABLED === 'true'
}

export function isManagedCompanionPurpose(value: unknown): boolean {
  return value === MANAGED_COMPANION_PURPOSE
}

export function explicitDatabaseUrl(): string | null {
  const raw = process.env.DATABASE_URL
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export type ManagedClientRegistration = {
  issuer: string
  clientId: string
  clientSecret: string
  callback: string
  origin: string
  nativeTenantId: string
  nativeOrgId: string
  nativeBaseUrl: string
}

const CLIENT_KEYS = [
  'issuer',
  'clientId',
  'clientSecret',
  'callback',
  'origin',
  'nativeTenantId',
  'nativeOrgId',
  'nativeBaseUrl',
] as const

function absoluteHttpUrl(value: string, allowPath: boolean): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  const https = url.protocol === 'https:'
  const httpLoopback = url.protocol === 'http:' && loopback
  if ((!https && !httpLoopback) || url.username || url.password || url.search || url.hash) {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  }
  if (!allowPath && url.pathname !== '/') {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  }
  if (allowPath && url.pathname.includes('//')) {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  }
  return value
}

export function managedClientRegistry(): ManagedClientRegistration[] {
  const raw = process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  }
  if (!Array.isArray(parsed)) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
    }
    const record = item as Record<string, unknown>
    if (Object.keys(record).sort().join() !== [...CLIENT_KEYS].sort().join()) {
      throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
    }
    const row = {} as Record<string, string>
    for (const key of CLIENT_KEYS) {
      const value = record[key]
      if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
        throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_REGISTRATION_INVALID')
      }
      row[key] = value
    }
    return {
      issuer: absoluteHttpUrl(row.issuer, true),
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      callback: absoluteHttpUrl(row.callback, true),
      origin: absoluteHttpUrl(row.origin, false).replace(/\/$/, ''),
      nativeTenantId: row.nativeTenantId,
      nativeOrgId: row.nativeOrgId,
      nativeBaseUrl: absoluteHttpUrl(row.nativeBaseUrl, false).replace(/\/$/, ''),
    }
  })
}

export function registrationFor(input: {
  issuer: string
  nativeTenantId: string
  nativeOrgId: string
}): ManagedClientRegistration {
  const found = managedClientRegistry().filter((row) =>
    row.issuer === input.issuer
    && row.nativeTenantId === input.nativeTenantId
    && row.nativeOrgId === input.nativeOrgId)
  if (found.length !== 1) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REGISTRATION_MISMATCH')
  return found[0]
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function sourceFingerprint(input: {
  type: string
  origin: string
  ownerId: string
  rootPartId: string
  tenantId: string | null
  workspaceId: string | null
  scopeKind: string | null
}): string {
  return sha256Hex(JSON.stringify({
    type: input.type,
    origin: input.origin,
    ownerId: input.ownerId,
    rootPartId: input.rootPartId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    scopeKind: input.scopeKind,
  }))
}

function persistentScopeValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function originOfSourceConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const connection = (config as { connection?: unknown }).connection
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return null
  const record = connection as { url?: unknown; baseURL?: unknown }
  const raw = typeof record.url === 'string' ? record.url : typeof record.baseURL === 'string' ? record.baseURL : ''
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function buildManagedLoginNavigation(registration: ManagedClientRegistration, input: {
  rootPartId: string
  state: string
  codeChallenge: string
  continuityHint?: 'hour'
}): string {
  const url = new URL('/managed-login', registration.nativeBaseUrl)
  const fields: Record<(typeof PUBLIC_QUERY_KEYS)[number], string> = {
    client_id: registration.clientId,
    callback: registration.callback,
    origin: registration.origin,
    tenant_id: registration.nativeTenantId,
    org_id: registration.nativeOrgId,
    issuer: registration.issuer,
    root_part_id: input.rootPartId,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  }
  for (const key of PUBLIC_QUERY_KEYS) url.searchParams.append(key, fields[key])
  if (input.continuityHint === 'hour') url.searchParams.append('continuity_hint', 'hour')
  return url.toString()
}

export type ManagedSourceClass =
  | { kind: 'unbound' }
  | { kind: 'schema-missing' }
  | { kind: 'unavailable' }
  | { kind: 'bound'; row: ManagedBindingRow }

export type ManagedBindingRow = {
  data_source_id: string
  link_id: string
  generation: number
  binding_status: string
  source_fingerprint: string
  frozen_origin: string
  frozen_root_part_id: string
  link_status: string
  link_generation: number
  meta_user_id: string
  meta_tenant_id: string
  meta_org_id: string
  native_auth_user_id: string
  native_tenant_id: string
  native_org_id: string
  installation_issuer: string
  client_origin: string
  root_part_id: string
  owner_user_id: string
  source_type: string
  owner_id: string
  config: unknown
  is_active: boolean
  deleted_at: string | null
  tenant_id: string | null
  workspace_id: string | null
  scope_kind: string | null
}

type Reader = (sourceId: string) => Promise<ManagedSourceClass>
let readerOverride: Reader | null = null

export function setManagedBindingReaderForTests(reader: Reader | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ManagedCompanionRefusal(500, 'PLM_MANAGED_TEST_READER_REFUSED')
  }
  readerOverride = reader
}

let sharedTransportCalls = 0
const sharedTransportPaths: string[] = []

export function resetSharedTransportAudit(): void {
  sharedTransportCalls = 0
  sharedTransportPaths.length = 0
}

export function readSharedTransportAudit(): { calls: number; paths: string[] } {
  return { calls: sharedTransportCalls, paths: [...sharedTransportPaths] }
}

export function noteSharedTransportCall(path: string): void {
  sharedTransportCalls += 1
  sharedTransportPaths.push(path)
}

const BINDING_SQL = `
SELECT b.data_source_id, b.link_id, b.generation, b.status AS binding_status, b.source_fingerprint,
       b.frozen_origin, b.frozen_root_part_id, l.status AS link_status, l.generation AS link_generation,
       l.meta_user_id, l.meta_tenant_id, l.meta_org_id, l.native_auth_user_id, l.native_tenant_id,
       l.native_org_id, l.installation_issuer, l.client_origin, l.root_part_id, l.owner_user_id,
       d.type AS source_type, d.owner_id, d.config, d.is_active, d.deleted_at,
       d.tenant_id, d.workspace_id, d.scope_kind
FROM plm_managed_source_bindings b
JOIN plm_managed_identity_links l ON l.id = b.link_id
LEFT JOIN data_sources d ON d.id = b.data_source_id
WHERE b.data_source_id = $1`

export async function classifyManagedSource(sourceId: string): Promise<ManagedSourceClass> {
  if (readerOverride) return readerOverride(sourceId)
  // Only a successful binding query with no row proves an unbound legacy source.
  // A disabled or removed flag, a missing DATABASE_URL, a missing schema, or an
  // outage is not that proof and must not open shared credentials.
  if (!explicitDatabaseUrl()) return { kind: 'unavailable' }
  try {
    const result = await query<ManagedBindingRow & QueryResultRow>(BINDING_SQL, [sourceId])
    const row = result.rows[0]
    if (!row) return { kind: 'unbound' }
    return { kind: 'bound', row }
  } catch (error) {
    if (isDatabaseSchemaError(error)) return { kind: 'schema-missing' }
    return { kind: 'unavailable' }
  }
}

export async function assertLegacySharedTransportAllowed(sourceId: string): Promise<void> {
  const classified = await classifyManagedSource(sourceId)
  if (classified.kind === 'unbound') return
  const code = classified.kind === 'schema-missing'
    ? 'PLM_MANAGED_SCHEMA_MISSING'
    : classified.kind === 'unavailable'
      ? 'PLM_MANAGED_BINDING_UNAVAILABLE'
      : 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'
  throw new ManagedCompanionRefusal(403, code)
}

export async function enterLegacySharedTransport<T>(sourceId: string, path: string, run: () => Promise<T>): Promise<T> {
  await assertLegacySharedTransportAllowed(sourceId)
  noteSharedTransportCall(path)
  return run()
}

export function sealCredential(plaintext: string): string {
  if (!plaintext.startsWith('yur_')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  const sealed = encryptStoredSecretValue(plaintext)
  if (!sealed.startsWith('enc:')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  return sealed
}

export function openCredential(sealed: string): string {
  if (!sealed.startsWith('enc:')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  const opened = decryptStoredSecretValue(sealed)
  if (!opened.startsWith('yur_')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  return opened
}

export function readRequestCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || header.length === 0) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    if (key !== name) continue
    const value = part.slice(separator + 1).trim()
    if (!value) return null
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }
  return null
}

export function cookieSecureFor(callback: string): boolean {
  return callback.startsWith('https://')
}

/** Live source identity. A config flag is not consulted and is not authority. */
export function bindingFingerprintMatches(row: ManagedBindingRow): boolean {
  if (row.binding_status !== 'active' || row.link_status !== 'active') return false
  if (row.generation !== row.link_generation) return false
  if (row.source_type !== 'plm' || row.is_active !== true || row.deleted_at) return false
  if (!row.owner_id || row.owner_id !== row.meta_user_id || row.owner_user_id !== row.meta_user_id) return false
  const origin = originOfSourceConfig(row.config)
  // Frozen PLM origin is the native installation. The OAuth client origin is a separate namespace.
  if (!origin || origin !== row.frozen_origin) return false
  if (!row.frozen_root_part_id || row.frozen_root_part_id !== row.root_part_id) return false
  const live = sourceFingerprint({
    type: row.source_type,
    origin,
    ownerId: row.owner_id,
    rootPartId: row.root_part_id,
    tenantId: persistentScopeValue(row.tenant_id),
    workspaceId: persistentScopeValue(row.workspace_id),
    scopeKind: persistentScopeValue(row.scope_kind),
  })
  return live === row.source_fingerprint
}
