/**
 * Session verification accepts only session tokens.
 *
 * A session token is a signed claim set that carries no payload `type` claim. Every purpose-bound token
 * this service issues states its purpose in a payload `type` claim, and none of them is a session, so a
 * claim set that carries `type` (any value, of any JSON type) is never a session token.
 *
 * The rule reads the payload claim only. The JOSE header is not consulted.
 */
export function isSessionTokenPayload(payload: unknown): payload is Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  return !('type' in payload)
}
