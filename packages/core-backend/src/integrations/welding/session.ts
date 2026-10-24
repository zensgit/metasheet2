import { authService } from '../../auth/AuthService'
import { query } from '../../db/pg'
import { WeldingError, weldingAvailable, type WeldingProvider } from './provider'

export interface WeldingSession {
  userId: string
  tenantId: string
  sid: string
  iat: number
  exp: number
}

export async function requireWeldingSession(token: string, authenticatedTenantId: string | undefined, config: WeldingProvider, original?: WeldingSession): Promise<WeldingSession> {
  weldingAvailable()
  try {
    const user = await authService.verifyToken(token)
    const payload = authService.readTokenPayload(token)
    const now = Math.floor(Date.now() / 1000)
    if (!user || user.must_change_password === true || !payload || typeof user.id !== 'string' || !user.id || user.id.length > 255 ||
      typeof payload.sid !== 'string' || !payload.sid.trim() || payload.sid !== payload.sid.trim() || payload.sid.length > 255 ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat <= 0 || payload.iat > now || payload.exp <= now || payload.exp <= payload.iat ||
      payload.tenantId !== config.metasheetTenantId || user.tenantId !== config.metasheetTenantId || authenticatedTenantId !== config.metasheetTenantId ||
      (payload.userId || payload.id || payload.sub) !== user.id) throw new Error()
    if (await authService.resolveSessionTenantId(user.id, user.tenantId) !== user.tenantId) throw new Error()
    const session = { userId: user.id, tenantId: user.tenantId, sid: payload.sid, iat: payload.iat, exp: payload.exp }
    if (original && (Object.keys(original) as (keyof WeldingSession)[]).some(key => session[key] !== original[key])) throw new Error()
    const result = await query(
      `SELECT s.id FROM user_sessions s
       LEFT JOIN user_session_revocations r ON r.user_id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2
         AND s.revoked_at IS NULL AND s.expires_at > NOW()
         AND isfinite(s.expires_at)
         AND (r.user_id IS NULL OR (isfinite(r.revoked_after) AND r.revoked_after < to_timestamp($3)))
       LIMIT 1`,
      [session.sid, session.userId, session.iat],
    )
    if (result.rows.length !== 1 || result.rows[0].id !== session.sid) throw new Error()
    return session
  } catch {
    throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
  }
}
