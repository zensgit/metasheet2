/**
 * Inputs and refusals of API token issuance (create and rotate).
 *
 * This module reads no database, so route tests that replace the token service still get these
 * classes and helpers.
 */

/** The session that asked for the token, as read from the bearer token that authenticated it. */
export type ApiTokenIssuanceCredential = Readonly<{
  /** `access_generation` of the authenticated user row. */
  expectedAccessGeneration: number
  /** Trimmed `sid` claim, or null only when the authenticating token carries none. */
  sessionId: string | null
  /** `iat` claim in seconds, or null only when the authenticating token carries no usable one. */
  issuedAt: number | null
}>

export const AUTHENTICATION_CHANGED_MESSAGE = 'Authentication changed; please sign in again'

export type ApiTokenIssuanceRefusalCode =
  | 'AUTHENTICATION_CHANGED'
  | 'API_TOKEN_ISSUANCE_BUSY'
  | 'API_TOKEN_ISSUANCE_UNAVAILABLE'

export class ApiTokenIssuanceError extends Error {
  readonly code: ApiTokenIssuanceRefusalCode
  readonly statusCode: number

  constructor(code: ApiTokenIssuanceRefusalCode, statusCode: number, message: string) {
    super(message)
    this.name = 'ApiTokenIssuanceError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** The session or account changed after authentication; the caller must sign in again. */
export function issuanceAuthenticationChanged(): ApiTokenIssuanceError {
  return new ApiTokenIssuanceError('AUTHENTICATION_CHANGED', 409, AUTHENTICATION_CHANGED_MESSAGE)
}

/** The user lock was not available in time. Nothing was written; the caller may retry. */
export function issuanceBusy(): ApiTokenIssuanceError {
  return new ApiTokenIssuanceError('API_TOKEN_ISSUANCE_BUSY', 409, 'API token issuance is busy; retry shortly')
}

/** The issuance transaction did not run at the required isolation level. Nothing was written. */
export function issuanceUnavailable(): ApiTokenIssuanceError {
  return new ApiTokenIssuanceError('API_TOKEN_ISSUANCE_UNAVAILABLE', 503, 'API token issuance is unavailable')
}

const CREDENTIAL_KEYS = 'expectedAccessGeneration,issuedAt,sessionId'

/**
 * Exact shape check, run before any SQL. Missing, extra or mistyped keys are refused; null is
 * accepted for `sessionId` and `issuedAt` only as explicit values.
 */
export function requireIssuanceCredential(value: unknown): ApiTokenIssuanceCredential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw issuanceAuthenticationChanged()
  const keys = Reflect.ownKeys(value).map((key) => String(key)).sort().join(',')
  if (keys !== CREDENTIAL_KEYS) throw issuanceAuthenticationChanged()
  const record = value as Record<string, unknown>
  const expectedAccessGeneration = record.expectedAccessGeneration
  const sessionId = record.sessionId
  const issuedAt = record.issuedAt
  if (typeof expectedAccessGeneration !== 'number' || !Number.isSafeInteger(expectedAccessGeneration) || expectedAccessGeneration < 0) {
    throw issuanceAuthenticationChanged()
  }
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim() !== sessionId)) {
    throw issuanceAuthenticationChanged()
  }
  if (issuedAt !== null && (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt * 1000))) {
    throw issuanceAuthenticationChanged()
  }
  return Object.freeze({
    expectedAccessGeneration,
    sessionId: sessionId as string | null,
    issuedAt: issuedAt as number | null,
  })
}

/**
 * Builds the credential from the verified claims of the bearer token that authenticated the
 * request. The subject must be the authenticated user. `sid` is normalized the way session
 * verification normalizes it; `iat` is used only when it is a finite number of seconds.
 */
export function issuanceCredentialFromSessionClaims(
  claims: unknown,
  authenticatedUserId: string,
  expectedAccessGeneration: number,
): ApiTokenIssuanceCredential {
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw issuanceAuthenticationChanged()
  const payload = claims as Record<string, unknown>
  const subject = payload.userId || payload.id || payload.sub
  if (typeof subject !== 'string' || subject.trim().length === 0 || subject.trim() !== authenticatedUserId) {
    throw issuanceAuthenticationChanged()
  }
  const sid = payload.sid
  const iat = payload.iat
  return requireIssuanceCredential({
    expectedAccessGeneration,
    sessionId: typeof sid === 'string' && sid.trim().length > 0 ? sid.trim() : null,
    issuedAt: typeof iat === 'number' && Number.isFinite(iat * 1000) ? iat : null,
  })
}
