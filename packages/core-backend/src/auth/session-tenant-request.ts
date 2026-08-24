/** Exact ASCII sentinel used by the one-time user_orgs backfill. Not a user choice. */
export const DEFAULT_SESSION_ORG_ID = 'default'

/**
 * Login-time request filter (D6 R1 / F1).
 *
 * A persisted `'default'` tenant hint is injected by the web client on every
 * request including login, and every backfilled user has a legal `'default'`
 * membership. That combination is not evidence the user chose an org.
 *
 * Token verification / refresh / explicit session-org switch MUST NOT use this
 * helper — a minted `'default'` claim, or an explicit switcher choice, is a
 * real session value and stays membership-checked via resolveSessionTenantId.
 */
export function requestedTenantIdForLogin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed === DEFAULT_SESSION_ORG_ID) return undefined
  return trimmed
}
