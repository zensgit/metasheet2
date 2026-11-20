import { authService } from '../auth/AuthService'
import { sessionRevisionAllows } from '../auth/session-revision'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'

export type StrictPrincipalQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

type PrincipalRow = {
  id: string
  role: string | null
  is_active: boolean | null
  activation_status: string | null
  deleted_at: string | Date | null
  purged_at: string | Date | null
}

/** Read the database identity without AuthService's development profile fallback. */
export async function readStrictPrincipal(query: StrictPrincipalQuery, userId: string): Promise<PrincipalRow | null> {
  const result = await query(
    'SELECT id, role, is_active, activation_status, deleted_at, purged_at FROM users WHERE id = $1',
    [userId],
  )
  const user = result.rows[0] as PrincipalRow | undefined
  if (!user || user.is_active !== true || evaluateUserAuthenticationGate(user)) return null
  return user
}

/**
 * authenticate validates the signature and builds the request context; its trusted-token path can
 * bypass the session database checks. Repeat those checks strictly here on the caller's executor.
 * Missing session schema must throw, rather than inheriting the legacy helpers' missing-table fallback.
 */
export async function validateStrictSession(
  query: StrictPrincipalQuery,
  token: string,
  requestUserId: string,
): Promise<boolean> {
  const payload = authService.readTokenPayload(token)
  if (!payload) return false
  const tokenUserId = payload.userId || payload.id || payload.sub
  if (typeof tokenUserId !== 'string' || tokenUserId.trim() !== requestUserId) return false
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return false
  const principal = await readStrictPrincipal(query, requestUserId)
  if (!principal) return false

  await query('SELECT id, user_id, revoked_at FROM user_sessions LIMIT 0')
  const revocations = await query('SELECT revoked_after, revision FROM user_session_revocations WHERE user_id = $1', [requestUserId])
  if (!sessionRevisionAllows(payload, revocations.rows[0] as Parameters<typeof sessionRevisionAllows>[1])) return false
  // Legacy session JWTs may have no sid. When present, it must name a live row.
  if (payload.sid !== undefined) {
    if (typeof payload.sid !== 'string' || !payload.sid.trim()) return false
    const sessions = await query(
      'SELECT 1 FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL LIMIT 1',
      [payload.sid.trim(), requestUserId],
    )
    if (sessions.rows.length !== 1) return false
  }
  return true
}

/** The live RBAC membership itself is required; raw users.role and claims are insufficient. */
export async function hasLiveRbacAdmin(query: StrictPrincipalQuery, userId: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin'])
  return result.rows.length > 0
}
