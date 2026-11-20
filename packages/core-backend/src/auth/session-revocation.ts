import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { sessionRevisionAllows } from './session-revision'

export interface SessionRevocationSnapshot {
  revokedAfter: string
  updatedAt: string
  updatedBy: string | null
  reason: string | null
}

type SessionRevocationRow = {
  revoked_after: string | Date
  updated_at: string | Date
  updated_by: string | null
  reason: string | null
}

export async function getSessionRevocationSnapshot(userId: string): Promise<SessionRevocationSnapshot | null> {
  try {
    const result = await query<SessionRevocationRow>(
      `SELECT revoked_after, updated_at, updated_by, reason
       FROM user_session_revocations
       WHERE user_id = $1`,
      [userId],
    )
    const row = result.rows[0]
    if (!row) return null

    return {
      revokedAfter: new Date(row.revoked_after).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
      reason: row.reason,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function revokeUserSessions(
  userId: string,
  options: {
    updatedBy: string
    reason: string
  },
): Promise<SessionRevocationSnapshot | null> {
  try {
    const result = await query<SessionRevocationRow>(
      `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason)
       VALUES ($1, NOW(), NOW(), $2, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET revoked_after = GREATEST(user_session_revocations.revoked_after, EXCLUDED.revoked_after),
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by,
           reason = EXCLUDED.reason
       RETURNING revoked_after, updated_at, updated_by, reason`,
      [userId, options.updatedBy, options.reason],
    )
    const row = result.rows[0]
    if (!row) return null

    return {
      revokedAfter: new Date(row.revoked_after).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
      reason: row.reason,
    }
  } catch (error) {
    if (isDatabaseSchemaError(error)) {
      return null
    }
    throw error
  }
}

export async function isUserSessionRevoked(userId: string, evidence: number | Parameters<typeof sessionRevisionAllows>[0]): Promise<boolean> {
  const claims = typeof evidence === 'number' ? { iat: evidence } : evidence
  const result = await query<{ revision: string; revoked_after: Date }>(
    'SELECT revision, revoked_after FROM user_session_revocations WHERE user_id = $1', [userId],
  )
  return !sessionRevisionAllows(claims, result.rows[0])
}
