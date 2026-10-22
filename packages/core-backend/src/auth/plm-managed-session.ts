/**
 * Purpose-specific Meta session for one managed read delegation.
 * Insert-once. Revocation is monotonic. This module does not call createUserSession
 * or getUserById, and it does not accept a trusted-claim shortcut.
 */
import * as jwt from 'jsonwebtoken'
import { query } from '../db/pg'
import { secretManager } from '../security/SecretManager'
import { resolveRuntimeJwtSecret } from '../security/auth-runtime-config'
import { evaluateUserAuthenticationGate } from './user-activation'
import { attachVerifiedTenantClaim } from './verified-tenant-claim'
import type { User } from './AuthService'
import {
  MANAGED_COMPANION_MAX_TTL_SECONDS,
  MANAGED_COMPANION_PURPOSE,
  MANAGED_COMPANION_SCOPE,
  ManagedCompanionRefusal,
  bindingFingerprintMatches,
  explicitDatabaseUrl,
  isManagedCompanionPurpose,
  isPlmManagedCompanionEnabled,
  registrationFor,
  type ManagedBindingRow,
} from '../services/plm-managed-companion'
import { nativeStatus } from '../services/plm-managed-native-http'

type ManagedPayload = {
  userId?: string
  email?: string
  role?: string
  tenantId?: string
  sid?: string
  purpose?: string
  exp?: number
}

function jwtSecret(): string {
  return resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return null
}

function permissionsOf(value: unknown): string[] {
  const source = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!Array.isArray(source)) return []
  return source.filter((item): item is string => typeof item === 'string')
}

export function isManagedCompanionToken(token: string): boolean {
  const decoded = jwt.decode(token)
  return !!decoded && typeof decoded === 'object' && isManagedCompanionPurpose((decoded as { purpose?: unknown }).purpose)
}

export function signManagedSessionToken(input: {
  userId: string
  email: string
  role: string
  tenantId: string
  sessionId: string
  expiresAt: Date
}): string {
  const exp = Math.floor(input.expiresAt.getTime() / 1000)
  const now = Math.floor(Date.now() / 1000)
  if (exp <= now || exp - now > MANAGED_COMPANION_MAX_TTL_SECONDS) {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_SESSION_EXPIRY_REFUSED')
  }
  return jwt.sign({
    userId: input.userId,
    email: input.email,
    role: input.role,
    tenantId: input.tenantId,
    sid: input.sessionId,
    purpose: MANAGED_COMPANION_PURPOSE,
    exp,
  }, jwtSecret())
}

const SESSION_SQL = `
SELECT s.id, s.expires_at, s.revoked_at, s.scope, s.native_subject, s.native_tenant_id, s.native_org_id,
       s.meta_user_id, s.meta_tenant_id, s.meta_org_id, s.root_part_id, s.client_origin,
       s.installation_issuer, s.client_id, s.generation, s.delegation_id, s.link_id, s.data_source_id,
       s.created_at, b.status AS binding_status, b.generation AS binding_generation, b.source_fingerprint,
       b.frozen_origin, b.frozen_root_part_id, b.link_id AS binding_link_id,
       l.status AS link_status, l.generation AS link_generation, l.native_auth_user_id, l.owner_user_id,
       l.meta_user_id AS link_meta_user, l.client_origin AS link_origin, l.root_part_id AS link_root,
       d.type AS source_type, d.owner_id, d.config, d.is_active, d.deleted_at,
       d.tenant_id, d.workspace_id, d.scope_kind
FROM plm_managed_sessions s
JOIN plm_managed_source_bindings b ON b.data_source_id = s.data_source_id
JOIN plm_managed_identity_links l ON l.id = s.link_id
LEFT JOIN data_sources d ON d.id = s.data_source_id
WHERE s.id = $1`

export async function verifyManagedCompanionToken(token: string): Promise<User | null> {
  let payload: ManagedPayload
  try {
    payload = jwt.verify(token, jwtSecret()) as ManagedPayload
  } catch {
    return null
  }
  if (!isManagedCompanionPurpose(payload.purpose)) return null
  if (!isPlmManagedCompanionEnabled()) return null
  if (!explicitDatabaseUrl()) return null
  const userId = text(payload.userId)
  const sessionId = text(payload.sid)
  const tenantId = payload.tenantId
  if (!userId || !sessionId || typeof tenantId !== 'string' || tenantId.trim() === '' || tenantId !== tenantId.trim()) {
    return null
  }
  try {
    const found = await query(SESSION_SQL, [sessionId])
    const row = found.rows[0]
    if (!row) return null
    if (text(row.meta_user_id) !== userId || text(row.meta_tenant_id) !== tenantId) return null
    if (row.revoked_at) return null
    if (text(row.scope) !== MANAGED_COMPANION_SCOPE) return null
    const expiresAt = asDate(row.expires_at)
    if (!expiresAt || expiresAt.getTime() <= Date.now()) return null
    if (payload.exp !== Math.floor(expiresAt.getTime() / 1000)) return null
    const createdAt = asDate(row.created_at)
    if (!createdAt || expiresAt.getTime() - createdAt.getTime() > MANAGED_COMPANION_MAX_TTL_SECONDS * 1000) return null
    if (text(row.link_status) !== 'active' || Number(row.link_generation) !== Number(row.generation)) return null
    if (text(row.native_subject) !== text(row.native_auth_user_id)) return null
    if (text(row.binding_link_id) !== text(row.link_id)) return null
    const binding = {
      data_source_id: text(row.data_source_id),
      link_id: text(row.link_id),
      generation: Number(row.generation),
      binding_status: text(row.binding_status),
      source_fingerprint: text(row.source_fingerprint),
      frozen_origin: text(row.frozen_origin),
      frozen_root_part_id: text(row.frozen_root_part_id),
      link_status: text(row.link_status),
      link_generation: Number(row.link_generation),
      meta_user_id: text(row.link_meta_user),
      meta_tenant_id: text(row.meta_tenant_id),
      meta_org_id: text(row.meta_org_id),
      native_auth_user_id: text(row.native_auth_user_id),
      native_tenant_id: text(row.native_tenant_id),
      native_org_id: text(row.native_org_id),
      installation_issuer: text(row.installation_issuer),
      client_origin: text(row.link_origin),
      root_part_id: text(row.link_root),
      owner_user_id: text(row.owner_user_id),
      source_type: text(row.source_type),
      owner_id: text(row.owner_id),
      config: row.config,
      is_active: row.is_active === true,
      deleted_at: row.deleted_at ? String(row.deleted_at) : null,
      tenant_id: typeof row.tenant_id === 'string' ? row.tenant_id : null,
      workspace_id: typeof row.workspace_id === 'string' ? row.workspace_id : null,
      scope_kind: typeof row.scope_kind === 'string' ? row.scope_kind : null,
    } satisfies ManagedBindingRow
    if (!bindingFingerprintMatches(binding)) return null
    const userResult = await query(
      `SELECT id, email, name, role, permissions, is_active, activation_status, must_change_password, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId],
    )
    const userRow = userResult.rows[0]
    if (!userRow) return null
    const user: User = {
      id: text(userRow.id),
      email: typeof userRow.email === 'string' ? userRow.email : null,
      name: text(userRow.name) || text(userRow.email) || userId,
      role: text(userRow.role) || 'user',
      permissions: permissionsOf(userRow.permissions),
      tenantId,
      is_active: userRow.is_active === true,
      must_change_password: userRow.must_change_password === true,
      activation_status: text(userRow.activation_status),
      created_at: asDate(userRow.created_at) ?? new Date(0),
      updated_at: asDate(userRow.updated_at) ?? new Date(0),
      managedSessionId: sessionId,
      managedPurpose: MANAGED_COMPANION_PURPOSE,
    }
    if (evaluateUserAuthenticationGate(user)) return null
    const member = await query(
      `SELECT uo.org_id
       FROM user_orgs uo
       JOIN users u ON u.id = uo.user_id
       WHERE uo.user_id = $1
         AND uo.org_id = ANY($2::text[])
         AND uo.is_active = true
         AND u.is_active = true`,
      [userId, [tenantId, text(row.meta_org_id)]],
    )
    const memberIds = new Set(member.rows.map((item) => text(item.org_id)))
    if (!memberIds.has(tenantId) || !memberIds.has(text(row.meta_org_id))) return null
    const registration = registrationFor({
      issuer: text(row.installation_issuer),
      nativeTenantId: text(row.native_tenant_id),
      nativeOrgId: text(row.native_org_id),
    })
    if (registration.clientId !== text(row.client_id)) return null
    const status = await nativeStatus(registration, text(row.delegation_id))
    if (!status || status.active !== true) return null
    if (status.subject !== text(row.native_subject)) return null
    if (status.scope !== MANAGED_COMPANION_SCOPE) return null
    if (status.root_part_id !== text(row.root_part_id) || status.client_origin !== text(row.client_origin)) return null
    if (status.delegation_id !== text(row.delegation_id)) return null
    if (status.tenant_id !== text(row.native_tenant_id) || status.org_id !== text(row.native_org_id)) return null
    if (status.client_id !== registration.clientId || status.issuer !== registration.issuer) return null
    attachVerifiedTenantClaim(user, { kind: 'present', value: tenantId })
    return user
  } catch {
    return null
  }
}

/** Locally live managed cookie identity. No native status call. Null is not another person. */
export async function readLiveManagedCookieIdentity(token: string): Promise<{
  userId: string
  tenantId: string
  sessionId: string
} | null> {
  if (!isPlmManagedCompanionEnabled() || !explicitDatabaseUrl()) return null
  let payload: ManagedPayload
  try {
    payload = jwt.verify(token, jwtSecret()) as ManagedPayload
  } catch {
    return null
  }
  if (!isManagedCompanionPurpose(payload.purpose)) return null
  const userId = text(payload.userId)
  const sessionId = text(payload.sid)
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId.trim() : ''
  if (!userId || !sessionId || !tenantId) return null
  try {
    const found = await query(
      `SELECT meta_user_id, meta_tenant_id, revoked_at, expires_at
       FROM plm_managed_sessions WHERE id = $1`,
      [sessionId],
    )
    const row = found.rows[0]
    const expiresAt = asDate(row?.expires_at)
    if (!row || row.revoked_at || !expiresAt || expiresAt.getTime() <= Date.now()) return null
    if (text(row.meta_user_id) !== userId || text(row.meta_tenant_id) !== tenantId) return null
    return { userId, tenantId, sessionId }
  } catch {
    return null
  }
}

export type ManagedContinuityMode = 'ordinary' | 'continuous'

/**
 * Persisted continuity after native verification has already succeeded.
 * Link generation stays the Meta revision. Credential generation is the native index.
 * Inconsistent rows fail closed instead of becoming renewable.
 */
export function persistedManagedContinuity(row: {
  generation: unknown
  linkGeneration: unknown
  continuityMode: unknown
  credentialGeneration: unknown
  intentId: unknown
}): {
  revision: number
  continuityMode: ManagedContinuityMode
  credentialGeneration: number | null
} | null {
  const revision = sqlInteger(row.generation)
  const linkRevision = sqlInteger(row.linkGeneration)
  if (revision === null || revision === undefined || revision < 1) return null
  if (linkRevision !== revision) return null
  const credential = sqlInteger(row.credentialGeneration)
  const intentId = sqlText(row.intentId)
  if (credential === undefined || intentId === undefined) return null
  if (row.continuityMode === 'ordinary') {
    if (credential !== null || intentId === null) return null
    return { revision, continuityMode: 'ordinary', credentialGeneration: null }
  }
  if (row.continuityMode === 'continuous') {
    if (credential === null || credential < 0 || credential > 7) return null
    if (credential === 0 && intentId === null) return null
    if (credential > 0 && intentId !== null) return null
    return { revision, continuityMode: 'continuous', credentialGeneration: credential }
  }
  return null
}

function sqlInteger(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value)
  return undefined
}

function sqlText(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

export async function describeManagedCookie(token: string): Promise<{
  user: User
  descriptor: {
    mode: 'managed-cookie'
    userId: string
    tenantId: string
    sessionId: string
    revision: number
    expiresAt: string
    continuityMode: ManagedContinuityMode
    credentialGeneration: number | null
  }
} | null> {
  const user = await verifyManagedCompanionToken(token)
  const rawSessionId = user?.managedSessionId
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  const tenantId = typeof user?.tenantId === 'string' ? user.tenantId.trim() : ''
  if (!user || !sessionId || !tenantId) return null
  try {
    const found = await query(
      `SELECT s.generation, s.expires_at, s.revoked_at, s.credential_generation, s.intent_id,
              l.continuity_mode, l.generation AS link_generation
       FROM plm_managed_sessions s
       JOIN plm_managed_identity_links l ON l.id = s.link_id
       WHERE s.id = $1`,
      [sessionId],
    )
    const row = found.rows[0]
    const expiresAt = asDate(row?.expires_at)
    if (!row || row.revoked_at || !expiresAt || expiresAt.getTime() <= Date.now()) return null
    const continuity = persistedManagedContinuity({
      generation: row.generation,
      linkGeneration: row.link_generation,
      continuityMode: row.continuity_mode,
      credentialGeneration: row.credential_generation,
      intentId: row.intent_id,
    })
    if (!continuity) return null
    return {
      user,
      descriptor: {
        mode: 'managed-cookie',
        userId: user.id,
        tenantId,
        sessionId,
        revision: continuity.revision,
        expiresAt: expiresAt.toISOString(),
        continuityMode: continuity.continuityMode,
        credentialGeneration: continuity.credentialGeneration,
      },
    }
  } catch {
    return null
  }
}

/** Client origin stored on the session, readable after expiry and with the flag off. */
export async function managedSessionClientOrigin(token: string): Promise<string | null> {
  if (!explicitDatabaseUrl()) return null
  let payload: ManagedPayload
  try {
    payload = jwt.verify(token, jwtSecret(), { ignoreExpiration: true }) as ManagedPayload
  } catch {
    return null
  }
  if (!isManagedCompanionPurpose(payload.purpose)) return null
  const sessionId = text(payload.sid)
  if (!sessionId) return null
  try {
    const found = await query(
      'SELECT client_origin FROM plm_managed_sessions WHERE id = $1 AND meta_user_id = $2',
      [sessionId, text(payload.userId)],
    )
    const origin = text(found.rows[0]?.client_origin)
    return origin || null
  } catch {
    return null
  }
}

export async function revokePresentedManagedSession(token: string): Promise<{
  userId: string
  sessionId: string
  revokedAt: string
} | null> {
  let payload: ManagedPayload
  try {
    payload = jwt.verify(token, jwtSecret(), { ignoreExpiration: true }) as ManagedPayload
  } catch {
    return null
  }
  if (!isManagedCompanionPurpose(payload.purpose)) return null
  if (!explicitDatabaseUrl()) return null
  const userId = text(payload.userId)
  const sessionId = text(payload.sid)
  if (!userId || !sessionId) return null
  try {
    const updated = await query(
      `UPDATE plm_managed_sessions
       SET revoked_at = now()
       WHERE id = $1 AND meta_user_id = $2 AND revoked_at IS NULL
       RETURNING revoked_at`,
      [sessionId, userId],
    )
    const revokedAt = updated.rows[0]?.revoked_at ?? null
    if (revokedAt) {
      return { userId, sessionId, revokedAt: new Date(revokedAt as string).toISOString() }
    }
    const existing = await query(
      'SELECT revoked_at FROM plm_managed_sessions WHERE id = $1 AND meta_user_id = $2',
      [sessionId, userId],
    )
    const prior = existing.rows[0]?.revoked_at
    if (!prior) return null
    return { userId, sessionId, revokedAt: new Date(prior as string).toISOString() }
  } catch {
    return null
  }
}
