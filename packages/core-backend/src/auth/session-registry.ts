import crypto from 'crypto'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

type UserSessionRow = {
  id: string
  user_id: string
  issued_at: string | Date
  expires_at: string | Date
  last_seen_at: string | Date
  revoked_at: string | Date | null
  revoked_by: string | null
  revoke_reason: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: string | Date
  updated_at: string | Date
}

export type UserSessionRecord = {
  id: string
  userId: string
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
  revokedAt: string | null
  revokedBy: string | null
  revokeReason: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  updatedAt: string
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function mapRow(row: UserSessionRow): UserSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    issuedAt: toIso(row.issued_at) || new Date().toISOString(),
    expiresAt: toIso(row.expires_at) || new Date().toISOString(),
    lastSeenAt: toIso(row.last_seen_at) || new Date().toISOString(),
    revokedAt: toIso(row.revoked_at),
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  }
}

function buildSyntheticSession(userId: string, sessionId: string, expiresAt: string): UserSessionRecord {
  const now = new Date().toISOString()
  return {
    id: sessionId,
    userId,
    issuedAt: now,
    expiresAt,
    lastSeenAt: now,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ipAddress: null,
    userAgent: null,
    createdAt: now,
    updatedAt: now,
  }
}

export async function createUserSession(
  userId: string,
  options: {
    sessionId?: string
    expiresAt: string
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<UserSessionRecord | null> {
  const sessionId = options.sessionId?.trim() || crypto.randomUUID()

  try {
    const result = await query<UserSessionRow>(
      `INSERT INTO user_sessions (
         id,
         user_id,
         issued_at,
         expires_at,
         last_seen_at,
         revoked_at,
         revoked_by,
         revoke_reason,
         ip_address,
         user_agent,
         created_at,
         updated_at
       )
       VALUES ($1, $2, NOW(), $3::timestamptz, NOW(), NULL, NULL, NULL, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           expires_at = EXCLUDED.expires_at,
           last_seen_at = NOW(),
           revoked_at = NULL,
           revoked_by = NULL,
           revoke_reason = NULL,
           ip_address = COALESCE(EXCLUDED.ip_address, user_sessions.ip_address),
           user_agent = COALESCE(EXCLUDED.user_agent, user_sessions.user_agent),
           updated_at = NOW()
       RETURNING id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason, ip_address, user_agent, created_at, updated_at`,
      [sessionId, userId, options.expiresAt, options.ipAddress ?? null, options.userAgent ?? null],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : buildSyntheticSession(userId, sessionId, options.expiresAt)
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return buildSyntheticSession(userId, sessionId, options.expiresAt)
    }
    throw error
  }
}

export async function listUserSessions(userId: string): Promise<UserSessionRecord[]> {
  try {
    const result = await query<UserSessionRow>(
      `SELECT id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason, ip_address, user_agent, created_at, updated_at
       FROM user_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    )
    return result.rows.map(mapRow)
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return []
    }
    throw error
  }
}

export async function getUserSession(sessionId: string): Promise<UserSessionRecord | null> {
  try {
    const result = await query<UserSessionRow>(
      `SELECT id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason, ip_address, user_agent, created_at, updated_at
       FROM user_sessions
       WHERE id = $1`,
      [sessionId],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function revokeUserSession(
  sessionId: string,
  options: {
    revokedBy: string
    reason: string
  },
): Promise<UserSessionRecord | null> {
  try {
    const result = await query<UserSessionRow>(
      `UPDATE user_sessions
       SET revoked_at = NOW(),
           revoked_by = $2,
           revoke_reason = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason, ip_address, user_agent, created_at, updated_at`,
      [sessionId, options.revokedBy, options.reason],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function touchUserSession(
  sessionId: string,
  options: {
    ipAddress?: string | null
    userAgent?: string | null
    minIntervalMs?: number
  } = {},
): Promise<UserSessionRecord | null> {
  const minIntervalSeconds = Math.max(0, Math.floor((options.minIntervalMs ?? 60_000) / 1000))

  try {
    const result = await query<UserSessionRow>(
      `UPDATE user_sessions
       SET last_seen_at = NOW(),
           ip_address = COALESCE($2::text, user_sessions.ip_address),
           user_agent = COALESCE($3::text, user_sessions.user_agent),
           updated_at = NOW()
       WHERE id = $1
         AND revoked_at IS NULL
         AND (
           $4 = 0
           OR last_seen_at <= NOW() - make_interval(secs => $4)
           OR ($2::text IS NOT NULL AND ip_address IS DISTINCT FROM $2::text)
           OR ($3::text IS NOT NULL AND user_agent IS DISTINCT FROM $3::text)
         )
       RETURNING id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason, ip_address, user_agent, created_at, updated_at`,
      [sessionId, options.ipAddress ?? null, options.userAgent ?? null, minIntervalSeconds],
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function isUserSessionActive(userId: string, sessionId: string): Promise<boolean> {
  try {
    const result = await query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM user_sessions
         WHERE id = $1
           AND user_id = $2
           AND revoked_at IS NULL
       ) AS active`,
      [sessionId, userId],
    )
    return Boolean(result.rows[0]?.active)
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return true
    }
    throw error
  }
}
