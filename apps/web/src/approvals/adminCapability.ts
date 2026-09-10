/**
 * The client half of the DB-backed "approval administrator" capability
 * (`GET /api/approvals/admin/capability`; see
 * `packages/core-backend/src/services/approval-admin-capability.ts` for why the three admin
 * predicates in this system disagree and which one that route answers).
 *
 * THREE STATES, NOT TWO. `unavailable` is deliberately NOT folded into `denied`. Folding it in
 * would reproduce the defect this closes at one level up: a real administrator hitting a transport
 * failure would be shown a state asserting something about their rights that the read never
 * established. Every consumer must render `unavailable` as "the server did not confirm", never as
 * "you are not an administrator".
 *
 * CACHING, AND WHOSE ANSWER IS CACHED. A definitive answer (`granted` / `denied`) is cached so the
 * nav entry and the page share ONE request. `unavailable` is NOT cached — a transient blip must not
 * hide an administrator's entry for the rest of the session.
 *
 * Both of those come from `composables/authPrincipal.ts` rather than from `useAuth`: it is a
 * dependency-free leaf, so importing it here cannot break the many specs that replace `useAuth`
 * wholesale with a hand-built stub. See that module for the measurement behind that choice.
 *
 * The cache is PER PRINCIPAL, guarded two independent ways, because an answer about one account is
 * a statement about a different account the moment the session changes:
 *
 *   1. KEYED. Every read compares `getAuthPrincipalKey()` against the key the cached answer was
 *      resolved under and refetches on any difference — including `null`, i.e. signed out. This is
 *      what covers a principal swap this process never performed, such as another tab writing a new
 *      token into the shared `localStorage`.
 *   2. INVALIDATED ON AUTH TRANSITIONS. `onAuthPrincipalChange` fires from `useAuth`'s single
 *      session-reset funnel — login, sign-out, the 401 path that clears the token with no
 *      navigation, dev-token refresh, invite acceptance. This is what covers the case the key
 *      cannot see: the SAME subject re-authenticating (a refreshed token carries the same `sub`, so
 *      the key is unchanged) after their rights changed server-side.
 *
 * Neither mechanism subsumes the other, and each is pinned by its own test.
 *
 * MOUNTED CONSUMERS ARE TOLD, NOT ONLY THE CACHE (round-4 item 2). Clearing the cache changes
 * nothing for a component that already resolved: it holds the answer in its own state and never
 * asks again. That left a mounted page and a rendered nav entry showing the PREVIOUS principal's
 * rights after an identity change — measured in round 3, not predicted. `onApprovalAdminCapability-
 * Invalidated` re-publishes the transition to those consumers, and the ORDER is the point: this
 * module's own listener drops the cache FIRST and notifies AFTER, so a consumer that re-reads from
 * inside the notification cannot be served the answer the notification is about. Subscribing the
 * consumers directly to `onAuthPrincipalChange` would make that ordering depend on listener
 * registration order, which is not a property any of them can see.
 *
 * WHAT IS STILL NOT COVERED, stated rather than implied: a DB change to an unchanged, still-signed-in
 * principal's `users` row is picked up at the next auth transition or page load, not immediately.
 * The answer is advisory chrome — it decides whether an entry and a queue surface are OFFERED. Every
 * actual gate is server-side and re-evaluated per request: `rbacGuard('approvals:admin')` on the
 * mutation and the list scope on the projection.
 *
 * AN EARLIER REVISION OF THIS DOCBLOCK CLAIMED "both logout paths in this app are full navigations
 * (`window.location.assign` / `.replace`), so the cache cannot outlive the principal it was resolved
 * for." That was false and is the reason for everything above: there is no `location.replace` logout
 * at all, `bootstrapSession`'s 401 branch calls `clearToken()` with no navigation, and both the
 * router guard and `LoginView` move between principals with SPA transitions.
 */
import { apiGet } from '../utils/api'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../composables/authPrincipal'

export type ApprovalAdminCapability = 'granted' | 'denied' | 'unavailable'

export const APPROVAL_ADMIN_CAPABILITY_PATH = '/api/approvals/admin/capability'

type CachedAnswer = {
  /** The principal the in-flight/settled answer belongs to. `null` is a real key: "no session". */
  principal: string | null
  answer: Promise<ApprovalAdminCapability>
}

let cached: CachedAnswer | null = null

/** Uncached single read. Exported for tests and for a caller that must not reuse a prior answer. */
export async function fetchApprovalAdminCapability(): Promise<ApprovalAdminCapability> {
  try {
    const response = await apiGet<unknown>(APPROVAL_ADMIN_CAPABILITY_PATH)
    const root = response && typeof response === 'object' ? response as Record<string, unknown> : null
    if (!root) return 'unavailable'
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
    const value = data.isApprovalAdmin
    // Anything that is not a boolean is an answer this client does not understand — reported as
    // "could not determine", never coerced.
    if (typeof value !== 'boolean') return 'unavailable'
    return value ? 'granted' : 'denied'
  } catch {
    return 'unavailable'
  }
}

function currentPrincipalKey(): string | null {
  try {
    return getAuthPrincipalKey()
  } catch {
    // A storage read can throw (Safari private mode, a disabled-cookies profile). Treating that as
    // "no identifiable principal" is the safe direction: `null` never equals a real key, so the
    // answer is refetched rather than a stranger's being reused.
    return null
  }
}

export function resolveApprovalAdminCapability(): Promise<ApprovalAdminCapability> {
  const principal = currentPrincipalKey()
  if (cached && cached.principal === principal) return cached.answer
  const entry: CachedAnswer = {
    principal,
    answer: fetchApprovalAdminCapability().then((result) => {
      // Only ever clear THIS entry. A late `unavailable` from a superseded principal's read must
      // not evict the answer that replaced it.
      if (result === 'unavailable' && cached === entry) cached = null
      return result
    }),
  }
  cached = entry
  return entry.answer
}

/** Test seam; also the correct call for a surface that has just changed principal. */
export function resetApprovalAdminCapabilityCache(): void {
  cached = null
}

type CapabilityInvalidationListener = () => void

const invalidationListeners = new Set<CapabilityInvalidationListener>()

/**
 * Subscribe to "the answer you are holding is about a principal this process no longer has".
 * Returns an unsubscribe, which a mounted consumer MUST call on teardown — an unmounted component
 * that keeps re-reading is a leak, and in a shared test process it issues requests into a
 * neighbouring test's call count.
 *
 * The listener is fired AFTER the cache has been dropped (see the docblock above), so re-reading
 * from inside it is the correct and only thing a consumer needs to do.
 */
export function onApprovalAdminCapabilityInvalidated(listener: CapabilityInvalidationListener): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

// The production subscriber. Registered at module scope so it is active for the whole lifetime of
// every surface that can consult this capability, with no per-component wiring to forget: the nav
// entry and the page both reach the cache through `resolveApprovalAdminCapability`, and neither is
// mounted at the moment most transitions happen. Never unsubscribed — the module lives as long as
// the app does, and the listener only clears this module's own cache and tells this module's own
// consumers.
onAuthPrincipalChange(() => {
  // ORDER IS LOAD-BEARING: drop, then tell. Reversed, a consumer re-reading inside the notification
  // is served the cached answer that belongs to the principal that just went away.
  resetApprovalAdminCapabilityCache()
  // Iterate a copy: a listener that unsubscribes itself must not perturb this iteration.
  for (const listener of Array.from(invalidationListeners)) {
    try {
      listener()
    } catch (err) {
      // Chrome must never be able to break an auth transition.
      console.warn('[approvals] admin-capability invalidation listener failed', err)
    }
  }
})
