import { readExplicitSession } from '../utils/explicitSessionOrg'

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
 * Ordinary sessions remain SUBJECT-KEYED BY CHOICE. A token refresh for the same person keeps the key, so it does not force a
 * re-read on every refresh. What that leaves uncovered — the same person's rights changing
 * server-side under an unchanged subject — is exactly what `onAuthPrincipalChange` below covers,
 * because a refresh goes through `useAuth`'s `setToken`. Neither mechanism subsumes the other.
 * An explicitly selected current session additionally binds tenant and a fresh switch epoch.
 * That key changes synchronously even before another tab receives a storage event, including
 * A-B-A switches that issue the same token text. Invalid/partial explicit metadata throws;
 * callers must not treat it as a valid ordinary session or an authorization grant.
 */
export function getAuthPrincipalKey(): string | null {
  const token = readStoredToken()
  const explicit = readExplicitSession(token, token ? parseJwtPayload(token) : null)
  if (explicit) return JSON.stringify(['explicit', explicit.actor, explicit.tenantId, explicit.epoch])
  if (!token) return null
  const payload = parseJwtPayload(token)
  const subject = payload?.sub ?? payload?.userId ?? payload?.id
  if (typeof subject === 'string' && subject.trim().length > 0) return `sub:${subject.trim()}`
  if (typeof subject === 'number' && Number.isFinite(subject)) return `sub:${subject}`
  return `token:${token}`
}

export function explicitSessionOrg(token: string | null): string | null {
  const current = readStoredToken()
  // Check the barrier even for an override: no request escapes a partial switch.
  const explicit = readExplicitSession(current, current ? parseJwtPayload(current) : null)
  return token === current ? explicit?.tenantId ?? null : null
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

/**
 * The identity of the session this process is holding, for the purpose of "is this still the same
 * session?" — the principal key AND the token text it came from.
 *
 * Both halves are needed and neither subsumes the other. The key alone is deliberately STABLE
 * across a token refresh for the same subject (see `getAuthPrincipalKey`), so it cannot see the
 * same person's rights being re-issued; the token alone cannot see the explicit-session marker
 * being installed or cleared around an unchanged token. Unreadable explicit metadata (a partial
 * switch, which `getAuthPrincipalKey` throws on) collapses to one constant: it is not a session,
 * so it compares equal to itself and differs from every real one.
 */
function readAuthSessionSignature(): string {
  let key: string | null
  try {
    key = getAuthPrincipalKey()
  } catch {
    return 'invalid'
  }
  // JSON, not a delimiter: the two halves are joined unambiguously without introducing a
  // separator character into the source at all. An earlier revision used a NUL byte here,
  // which is a legal string literal that nothing in the type-check, build or test run can
  // see — but it makes git classify this file as BINARY, so every diff and every
  // secret-scan silently skips it (finding_raw_nul_in_domain_constants).
  return JSON.stringify([key, readStoredToken()])
}

/**
 * Subscribe to "the session actually CHANGED", as opposed to `onAuthPrincipalChange`'s "the reset
 * funnel ran". Returns an unsubscribe, same as its base.
 *
 * The funnel announces every reset, including ones that change nothing about WHOSE session this
 * is — most commonly `bootstrapSession`'s no-token branch, which fires on any page with no
 * session at all, repeatedly. A subscriber that DROPS state (rather than merely marking a cache
 * dirty) cannot use the raw signal: it would throw away the current session's own data every time
 * something bootstrapped. Callers that clear rendered state want this; callers that only
 * invalidate a cached answer can keep using `onAuthPrincipalChange` directly.
 */
export function onAuthSessionSwitch(listener: AuthPrincipalChangeListener): () => void {
  let last = readAuthSessionSignature()
  let scheduled = false
  // Deferring the read (below) means a microtask can already be queued when the caller
  // unsubscribes — unsubscribing from the base signal cannot cancel it. Without this flag that
  // queued callback still fires, into a subscriber that has just been torn down; for a component
  // that re-fetches on a session switch, that is a request issued for a page that no longer
  // exists. The unsubscribe has to close the deferred window too, not just the subscription.
  let disposed = false
  const unsubscribe = onAuthPrincipalChange(() => {
    // Read the signature one microtask LATER, never at notification time. `useAuth`'s funnel is
    // called FIRST and the storage write follows it in the same synchronous run (`setToken`:
    // `resetSessionBootstrap(...)` then `localStorage.setItem('auth_token', …)`; `clearToken`:
    // the same order around `removeItem`), so at notification time storage still holds the
    // OUTGOING session and comparing then would report "nothing changed" for every sign-in and
    // sign-out. A microtask cannot interleave with that synchronous run, so by the time this
    // callback executes the new session is fully written — and no frame can be painted in
    // between, so subscribers that clear rendered state are still clearing it before it is seen.
    // `scheduled` coalesces the several notifications one transition can produce into one read.
    if (scheduled || disposed) return
    scheduled = true
    void Promise.resolve().then(() => {
      scheduled = false
      if (disposed) return
      const next = readAuthSessionSignature()
      if (next === last) return
      last = next
      listener()
    })
  })
  return () => {
    disposed = true
    unsubscribe()
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
