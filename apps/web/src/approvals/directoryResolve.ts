import { reactive } from 'vue'
import { ApprovalDirectoryResolveError, resolveApprovalDirectoryUsers } from './api'

/**
 * member-display-identity (2026-08-19; tightened 2026-08-19 per owner decision — role resolution
 * stays admin-only) — a shared, session-lifetime, module-singleton cache of resolved member
 * display names, sitting in front of the `/api/approvals/directory/resolve` batch endpoint (USERS
 * ONLY — there is no participant-reachable role resolver; role ids render as a values-free count,
 * never a name, on every viewer-facing surface). Every viewer-facing site that used to render a
 * raw assigneeId (or a values-free-but-anonymous ordinal like "成员 N") calls
 * `ensureUserNamesResolved` with the ids it has in view, then reads `getResolvedUserName` from a
 * `computed` — Vue's reactivity on a `reactive()` object tracks a property read even before that
 * property exists, so a computed that reads `resolvedUserNames[id]` before resolution completes
 * re-evaluates automatically once the batch fetch lands and sets it.
 *
 * TRI-STATE per id:
 *   - absent from the cache entirely -> never requested, OR a fetch is in flight (including its
 *                                        P3-3 bounded in-place retries — see flushUsers below), OR
 *                                        every retry attempt was exhausted and it is waiting for a
 *                                        FUTURE `ensureUserNamesResolved` call to try again (a
 *                                        thrown/non-OK fetch result, other than 401/403, leaves
 *                                        every id in that batch absent rather than caching a false
 *                                        confirmed-miss).
 *   - `null`                          -> requested, CONFIRMED unresolved: either the server
 *                                        answered and the id was not in the result (inactive user /
 *                                        blank name / nonexistent id), or the request came back
 *                                        401/403 (the caller structurally lacks
 *                                        approvals:read|write|act, or the session is gone — no
 *                                        retry will change that).
 *   - a non-empty string              -> the resolved display name
 *
 * Callers MUST treat "absent" and "null" identically for RENDERING (both are getResolvedXName
 * returning `null`) — never render a name-shaped id ahead of confirmation, and never leave a
 * flow-changing selector option enabled before resolution confirms a real name. This is
 * deliberately conservative: a brief "not yet resolved" window renders the SAME fallback as a
 * permanently-unresolved id, so there is no flash of an enabled-then-disabled option. The
 * absent/null distinction only matters to `ensureUserNamesResolved`'s OWN re-fetch decision (via
 * `hasOwnProperty`), never to a display.
 *
 * SCOPE: this cache carries no per-viewer org/tenant partition, because the underlying directory
 * machinery (`searchDirectoryUsers`/`resolveDirectoryUsersByIds`) carries none either (scoped only
 * by `is_active` + the RBAC capability union on the route) — see approval-directory.ts. A name
 * cached under one viewer's session and reused within the SAME browser tab for a different
 * logged-in viewer (without a full page reload, which resets this module) is a theoretical latent
 * concern this PR does not newly introduce or newly widen; every read still passes through the
 * SAME per-request RBAC guard, this cache only avoids repeat network round trips within one
 * session.
 *
 * TEST HYGIENE: `__resetResolvedDirectoryNamesForTests` clears this singleton — every spec that
 * mounts a resolver-consuming component MUST call it in `beforeEach`, or an earlier test's
 * resolved name leaks into a later test's assertions (a no-discriminating-power false green).
 */
export const resolvedUserNames = reactive<Record<string, string | null>>({})

const RESOLVE_CHUNK = 50
// P3-3 fix (member-display-identity gate report, 2026-08-19; retry redesign 2026-08-19): a
// TRANSIENT failure (see the catch below) is retried IN PLACE, up to this many total attempts per
// batch group, before flushUsers gives up on that group for THIS call. Deliberately a bounded
// IMMEDIATE retry with NO real-time delay between attempts (no setTimeout/backoff) -- the earlier
// draft of this fix used a real-timer-based retry, but this module is a session-lifetime
// singleton shared across every mounted test in the same spec file, and a background real timer
// left running past a test's own microtask-flush window would fire during a LATER, unrelated
// test and silently pollute its apiFetch call-count assertions (a cross-test leak the timer-based
// design could not avoid without a persistent module-level cancel handle, which reintroduces the
// exact "did every test's beforeEach actually reset this" fragility `__resetResolvedDirectoryNamesForTests`
// exists to prevent). An immediate retry costs nothing extra when the server is healthy (the
// common case never enters the catch at all) and turns a genuine one-shot network blip / 5xx into
// a self-healing resolve without ANY external trigger -- closing the gap the previous "the next
// ensureUserNamesResolved call... re-queues and retries it" comment claimed but did not actually
// deliver (there is no render-driven or timer-driven trigger anywhere on the consuming pages; see
// the pages' own `watch(..., { immediate: true })` callers, which fire once on mount and again
// only when THEIR OWN reactive deps change -- a resolve failure changes neither).
const RESOLVE_MAX_ATTEMPTS = 3
const pendingUserIds = new Set<string>()
let userFlushScheduled = false

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function flushUsers(): Promise<void> {
  const ids = Array.from(pendingUserIds)
  pendingUserIds.clear()
  userFlushScheduled = false
  if (ids.length === 0) return
  for (const group of chunk(ids, RESOLVE_CHUNK)) {
    let resolved: Array<{ id: string; name: string }> | null = null
    let terminal = false
    for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt += 1) {
      try {
        resolved = await resolveApprovalDirectoryUsers(group)
        break
      } catch (error) {
        // A thrown/non-OK fetch is NOT automatically a confirmed miss. Only a TERMINAL failure --
        // 401/403, meaning the caller structurally lacks approvals:read|write|act or the session
        // is gone -- is cached as `null` (a caller who can never succeed here degrades the same
        // way an id the server has no name for does, and retrying cannot help). Every OTHER
        // failure (network drop, timeout, 5xx, a malformed test mock throwing) is TRANSIENT and
        // retried in place (P3-3), up to RESOLVE_MAX_ATTEMPTS total attempts for this group.
        const status = error instanceof ApprovalDirectoryResolveError ? error.status : undefined
        if (status === 401 || status === 403) {
          terminal = true
          break
        }
        // Transient -- fall through to the next attempt (or, once attempts are exhausted, out of
        // this loop with `resolved` still null).
      }
    }
    if (terminal) {
      for (const id of group) resolvedUserNames[id] = null
      continue
    }
    if (resolved === null) {
      // Every in-place retry attempt failed transiently. Leave every id in this group ABSENT from
      // resolvedUserNames (not a confirmed miss) so a LATER `ensureUserNamesResolved` call -- e.g.
      // the user re-fetching detail/history via an unrelated action -- still retries it fresh.
      // Rendering stays fail-closed regardless -- getResolvedUserName treats "absent" and "null"
      // identically -- only the RETRY behavior differs.
      continue
    }
    const found = new Set<string>()
    for (const row of resolved) {
      if (!row || typeof row.id !== 'string' || !row.id) continue
      found.add(row.id)
      resolvedUserNames[row.id] = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
    }
    // A successful response (the server answered, no failure was thrown) naming none of these ids
    // is a CONFIRMED miss -- cache null so this id is not repeatedly re-fetched forever.
    for (const id of group) if (!found.has(id)) resolvedUserNames[id] = null
  }
}

/**
 * Queues every not-yet-known id in `ids` for a batch resolve (microtask-debounced so multiple
 * `ensure` calls made synchronously in the same reactivity flush collapse into one request), and
 * is a no-op for ids already resolved OR already confirmed-unresolved OR already in flight. Safe
 * to call from a `watch(..., { immediate: true })` on every render of the ids the caller has in
 * view — never call it from inside a `computed` getter (that would mutate a dependency of the
 * computed that reads it).
 */
export function ensureUserNamesResolved(ids: Iterable<string | null | undefined>): void {
  let scheduled = false
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) continue
    if (Object.prototype.hasOwnProperty.call(resolvedUserNames, id)) continue
    if (pendingUserIds.has(id)) continue
    pendingUserIds.add(id)
    scheduled = true
  }
  if (!scheduled || userFlushScheduled) return
  userFlushScheduled = true
  void Promise.resolve().then(flushUsers)
}

/** `null` covers BOTH "not yet resolved" and "confirmed unresolved" — see the tri-state doc above. */
export function getResolvedUserName(id: string | null | undefined): string | null {
  if (!id) return null
  const value = resolvedUserNames[id]
  return typeof value === 'string' ? value : null
}

/**
 * Given a list of ids and a "get resolved name" lookup, returns the joined names ONLY if every id
 * resolved to a real name — otherwise `null` (the caller falls back to a values-free count). This
 * mirrors the existing `cancelledAssigneesLabel` (ApprovalDetailView.vue) all-or-nothing
 * convention: a partial name list padded with placeholders reads as a formatting bug, not a
 * redaction, so a display either shows the full real picture or an honest count.
 */
export function joinIfAllResolved(
  ids: readonly string[],
  getName: (id: string) => string | null,
): string[] | null {
  if (ids.length === 0) return []
  const names: string[] = []
  for (const id of ids) {
    const name = getName(id)
    if (!name) return null
    names.push(name)
  }
  return names
}

/** Test-only: clears the module-singleton cache + any queued-but-not-yet-flushed ids. Every spec
 *  that mounts a component consuming this module MUST call this in `beforeEach` — otherwise an
 *  earlier test's resolved name (or confirmed-unresolved marker) leaks into a later test and makes
 *  a discriminating negative pass for the wrong reason. */
export function __resetResolvedDirectoryNamesForTests(): void {
  for (const key of Object.keys(resolvedUserNames)) delete resolvedUserNames[key]
  pendingUserIds.clear()
  userFlushScheduled = false
}
