/**
 * The session a realtime connection is bound to.
 *
 * A connection that is subject to continuous authorization is bound, at the handshake, to the verified
 * claims of the credential it presented: session class, user, organization, issue time and, when the
 * credential carries one, the registered session. Every later check reads the committed facts for
 * exactly this binding; nothing about the binding is taken from client messages.
 *
 * Pure module: the session classifier is passed in, so importing this file loads nothing else.
 */

export type RealtimeSessionClass = 'ordinary' | 'strict'

export type VerifiedSessionClassification = 'none' | 'standard' | 'strict' | 'conflict'
export type SessionClassifier = (payload: unknown) => VerifiedSessionClassification

export interface RealtimeSessionBinding {
  readonly sessionClass: RealtimeSessionClass
  readonly userId: string
  /** Organization claim of the credential; null when the credential carries none. */
  readonly organizationId: string | null
  /** Issue time of the credential in seconds; null when the credential carries none. */
  readonly issuedAtSeconds: number | null
  /** Expiry of the credential in seconds; null when the credential carries none. */
  readonly expiresAtSeconds: number | null
  /** Registered session id; null for a credential issued without one. */
  readonly sessionId: string | null
  /** The verified claims, frozen. A strict session is re-verified from these. */
  readonly claims: Readonly<Record<string, unknown>>
}

function textClaim(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function secondsClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Binds verified session claims. `payload` must already have passed signature and expiry
 * verification as a session token; this function only classifies and extracts. A claim set that is
 * not exactly an ordinary or a strict session yields null.
 */
export function bindVerifiedSessionClaims(
  payload: unknown,
  classify: SessionClassifier,
): RealtimeSessionBinding | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const classification = classify(payload)
  if (classification !== 'standard' && classification !== 'strict') return null
  const claims = payload as Record<string, unknown>
  const userId = textClaim(claims.userId) ?? textClaim(claims.id) ?? textClaim(claims.sub)
  if (!userId) return null
  const sessionId = textClaim(claims.sid)
  const organizationId = textClaim(claims.tenantId)
  if (classification === 'strict' && (!sessionId || !organizationId)) return null
  return Object.freeze({
    sessionClass: classification === 'strict' ? 'strict' : 'ordinary',
    userId,
    organizationId,
    issuedAtSeconds: secondsClaim(claims.iat),
    expiresAtSeconds: secondsClaim(claims.exp),
    sessionId,
    claims: Object.freeze({ ...claims }),
  })
}

/**
 * Identity of a binding for de-duplication inside one authority read. Two connections opened with
 * credentials of the same class, user, organization, session and issue time are the same subject.
 */
export function bindingKey(binding: RealtimeSessionBinding): string {
  return JSON.stringify([
    binding.sessionClass,
    binding.userId,
    binding.organizationId,
    binding.sessionId,
    binding.issuedAtSeconds,
  ])
}
