/**
 * WHOSE SESSION IS THIS, and how a module that caches a per-principal answer is told it changed.
 *
 * WHY THIS IS ITS OWN MODULE, and not two more exports on `useAuth`. Both things here are needed by
 * leaf modules that cache something derived from the current principal — today
 * `approvals/adminCapability.ts`, which must not serve one account's "you are an approval
 * administrator" to the next. Reaching them through `useAuth` would make every such leaf depend on
 * that module's whole surface, and 55 specs in `apps/web/tests` replace `useAuth` with a hand-built
 * stub rather than a partial mock. Any leaf importing `useAuth` therefore breaks the IMPORT of
 * anything those specs mount — measured, not predicted: an earlier revision that imported `useAuth`
 * from `adminCapability` reddened four spec files, one of them (`approvalMobileDetailActions`)
 * outside the required lane entirely, and would have grown a new landmine for every future stub.
 * These definitions have no dependencies of their own, so nothing needs to stub them.
 *
 * `useAuth` OWNS THE TRANSITIONS AND STILL DOES. It imports the same definitions (there is exactly
 * one `parseJwtPayload` and one `readStoredToken` in this app, and they live here) and calls
 * `notifyAuthPrincipalChange` from its single session-reset funnel. This module publishes; it never
 * decides when a transition happened.
 *
 * NOTHING HERE IS AN AUTHORIZATION VALUE. The key is derived client-side from a token this client
 * cannot verify, and is only ever compared for equality. Every real gate is server-side.
 */

/** The storage keys a session token may be found under, in priority order. */
export const TOKEN_KEYS = ['auth_token', 'jwt', 'devToken'] as const

export function readStoredToken(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    for (const key of TOKEN_KEYS) {
      const value = localStorage.getItem(key)
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
    }
    return null
  } catch {
    return null
  }
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const json = atob(normalized)
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * A stable identity for "whose session is this process holding right now", for modules that cache a
 * per-principal answer and must not serve one principal's answer to the next.
 *
 * Shape, in order: the token's subject claim when there is one (`sub` / `userId` / `id` — the same
 * three `useAuth`'s `extractUserId` reads off the session user, so the two agree on what "the user
 * id" means), otherwise the token STRING. The fallback is the point: a token this client cannot
 * parse still distinguishes two principals, so an unparseable token degrades to "refetch whenever
 * the token changes" rather than to "no key at all". `null` means no session — itself a distinct
 * key, so an answer resolved while signed in is not reused after the token is cleared.
 *
 * SUBJECT-KEYED BY CHOICE. A token refresh for the same person keeps the key, so it does not force a
 * re-read on every refresh. What that leaves uncovered — the same person's rights changing
 * server-side under an unchanged subject — is exactly what `onAuthPrincipalChange` below covers,
 * because a refresh goes through `useAuth`'s `setToken`. Neither mechanism subsumes the other.
 */
export function getAuthPrincipalKey(): string | null {
  const token = readStoredToken()
  if (!token) return null
  const payload = parseJwtPayload(token)
  const subject = payload?.sub ?? payload?.userId ?? payload?.id
  if (typeof subject === 'string' && subject.trim().length > 0) return `sub:${subject.trim()}`
  if (typeof subject === 'number' && Number.isFinite(subject)) return `sub:${subject}`
  return `token:${token}`
}

type AuthPrincipalChangeListener = () => void

const principalChangeListeners = new Set<AuthPrincipalChangeListener>()

/**
 * Subscribe to "the session this process was holding is no longer the session it holds". Returns an
 * unsubscribe.
 *
 * Listeners are NOTIFIED, never asked: the callback takes no arguments and its return value is
 * ignored, so a subscriber can only invalidate its own state — it can neither veto a transition nor
 * read the principal from here. A throwing listener is logged and the rest still run; auth state
 * must never depend on a subscriber behaving.
 *
 * NOT A REPLACEMENT FOR KEYING. This fires only on transitions THIS process performs. A principal
 * swap that bypasses `useAuth`'s setters — another tab writing the shared `localStorage` — produces
 * no notification at all, so a per-principal cache must ALSO key on `getAuthPrincipalKey()` and
 * re-check it on read.
 */
export function onAuthPrincipalChange(listener: AuthPrincipalChangeListener): () => void {
  principalChangeListeners.add(listener)
  return () => {
    principalChangeListeners.delete(listener)
  }
}

/** Called by `useAuth`'s session-reset funnel — the one place that knows a transition happened. */
export function notifyAuthPrincipalChange(): void {
  // Iterate a copy: a listener that unsubscribes itself must not perturb this iteration.
  for (const listener of Array.from(principalChangeListeners)) {
    try {
      listener()
    } catch (err) {
      console.warn('[auth] principal-change listener failed', err)
    }
  }
}
