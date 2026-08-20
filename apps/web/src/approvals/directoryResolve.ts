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
// P3-3 fix (member-display-identity gate report, 2026-08-19; retry redesign 2026-08-19; BACKOFF
// fix 2026-08-21, Codex #4 P3): a TRANSIENT failure (see the catch below) is retried IN PLACE, up
// to this many total attempts per batch group, before flushUsers gives up on that group for THIS
// call. Attempts are spaced by a small, BOUNDED, CANCELLABLE delay (RESOLVE_RETRY_DELAY_MS below)
// rather than firing back-to-back with no real-time gap between them -- a genuinely transient
// outage (a load-balancer restart, a brief connection-pool exhaustion) that clears within roughly
// a second and a half now self-heals on its own, WITHOUT depending on something else noticing and
// making a second `ensureUserNamesResolved` call -- nothing on the consuming pages does that
// automatically (see the pages' own `watch(..., { immediate: true })` callers below, which fire
// once on mount and again only when THEIR OWN reactive deps change; a resolve failure changes
// neither).
//
// A prior revision of this comment argued for a ZERO-delay immediate retry specifically to dodge
// a real cross-test timer leak: this module is a session-lifetime singleton shared across every
// mounted test in the same spec file, and a background real timer left running past a test's own
// microtask-flush window would fire during a LATER, unrelated test and silently pollute its
// apiFetch call-count assertions. That objection is answered here, not sidestepped: every
// `setTimeout` this module schedules is tracked in `pendingRetryTimeouts`, and
// `__resetResolvedDirectoryNamesForTests` -- already REQUIRED in every consuming spec's
// `beforeEach`, per its own doc below -- cancels every one of them before the next test runs, so a
// delayed retry scheduled by one test can never fire into a LATER, unrelated one. Production code
// never calls that reset function, so this cancellation path exists purely for test isolation and
// changes no production behavior. Tests drive this with `vi.useFakeTimers()` +
// `vi.advanceTimersByTimeAsync` rather than real waits.
const RESOLVE_MAX_ATTEMPTS = 3
// Delay BEFORE each retry attempt (attempt 1 always fires immediately -- this array holds
// RESOLVE_MAX_ATTEMPTS - 1 entries, indexed by `attempt - 2`). Front-loaded (short, then longer)
// so a sub-second blip recovers fast while a slightly slower one still gets a real second chance;
// kept deliberately small (cumulative ~1.5s worst case) so a permanently-down endpoint still fails
// closed quickly rather than holding the id "in flight" for long.
const RESOLVE_RETRY_DELAY_MS = [300, 1200]
const pendingUserIds = new Set<string>()
let userFlushScheduled = false
// Every retry-delay timer currently scheduled. Cancellation (see
// __resetResolvedDirectoryNamesForTests) is always "clear everything outstanding", never a
// single id, so a Set of handles is enough -- no id-keyed bookkeeping needed.
const pendingRetryTimeouts = new Set<ReturnType<typeof setTimeout>>()
// In-flight dedup (2026-08-21, Codex #4 P3 gate finding): an id is a member of this set for the
// ENTIRE duration of its group's retry sequence, including every backoff delay -- not just while
// an individual `resolveApprovalDirectoryUsers` call is awaited. Before the backoff fix above, the
// window during which an id was in NEITHER `resolvedUserNames` NOR `pendingUserIds` (see
// `ensureUserNamesResolved`'s dedup checks) was microtask-short, bounded only by however long the
// actual fetch attempts took -- practically never wide enough for a second `ensureUserNamesResolved`
// call for the SAME id to land inside it. The backoff delays widen that window to ~1.5s worst
// case, which an ordinary keystroke or route change hits routinely -- and does so specifically
// DURING the outage the retry exists for. Without this set, that second call would start an
// independent 3-attempt retry chain for the same id, doubling (or worse, with more overlapping
// calls) the request volume against a server that is already struggling. `ensureUserNamesResolved`
// treats an in-flight id as a no-op (it will observe the in-flight chain's own result once it
// settles); the id is removed from this set the moment its chain concludes -- success, terminal,
// or exhausted -- so a call arriving AFTER the chain finishes unsuccessfully still retries fresh,
// preserving the existing "stays retryable for a LATER ensure call" contract.
const inFlightUserIds = new Set<string>()

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * A cancellable delay: resolves after `ms` real (or fake-timer) milliseconds, tracking its handle
 * in `pendingRetryTimeouts` so a test-time reset can cancel it. If cancelled before it fires, this
 * promise simply never resolves -- the `flushUsers` call awaiting it is abandoned along with the
 * reset, which is exactly what a test boundary should do (never let it complete into whatever the
 * NEXT test sets up). `ms <= 0` resolves synchronously (no timer at all) so the first attempt in
 * `flushUsers` never pays a scheduling cost.
 */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      pendingRetryTimeouts.delete(handle)
      resolve()
    }, ms)
    pendingRetryTimeouts.add(handle)
  })
}

async function flushUsers(): Promise<void> {
  const ids = Array.from(pendingUserIds)
  pendingUserIds.clear()
  userFlushScheduled = false
  if (ids.length === 0) return
  // In-flight dedup (see `inFlightUserIds`'s own doc above): the WHOLE flush's ids are marked
  // BEFORE the first `await` in the group loop below, and cleared in a single `finally` once
  // every group has settled -- not per group. Marking only the CURRENT group (an earlier revision
  // of this fix did exactly that) leaves every id in a LATER, not-yet-reached group unguarded for
  // the full duration of every EARLIER group's retry sequence -- for a >50-id flush (chunked by
  // RESOLVE_CHUNK), that is exactly the same class of gap this set exists to close, just shifted
  // to cross-group instead of cross-call. Marking the whole flush's ids up front trades a
  // narrower, real gap for a bounded, deliberate one: an id whose OWN group already concluded
  // (successfully or not) is not retryable by a fresh `ensureUserNamesResolved` call until every
  // OTHER group in this same flush also concludes -- at most a few backoff cycles' worth of
  // delay, never unbounded, and `resolvedUserNames`/`pendingUserIds` are unaffected (a
  // successfully-resolved id short-circuits `ensureUserNamesResolved` before it ever reaches the
  // `inFlightUserIds` check, so this only widens a RETRY-availability window, never masks an
  // already-known answer).
  for (const id of ids) inFlightUserIds.add(id)
  try {
    for (const group of chunk(ids, RESOLVE_CHUNK)) {
      let resolved: Array<{ id: string; name: string }> | null = null
      let terminal = false
      for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt += 1) {
        // Backoff (2026-08-21, Codex #4 P3): every retry attempt (not the first) waits before
        // firing, giving a transient outage real wall-clock time to clear on its own.
        if (attempt > 1) await delay(RESOLVE_RETRY_DELAY_MS[attempt - 2])
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
        // Every in-place retry attempt failed transiently. Leave every id in this group ABSENT
        // from resolvedUserNames (not a confirmed miss) so a LATER `ensureUserNamesResolved` call
        // -- e.g. the user re-fetching detail/history via an unrelated action -- still retries it
        // fresh once the whole-flush `finally` below has released it from `inFlightUserIds` (after
        // every OTHER group in this SAME flush has also settled -- see that finally's own doc for
        // why this is whole-flush, not per-group). Rendering stays fail-closed regardless --
        // getResolvedUserName treats "absent" and "null" identically -- only the RETRY behavior
        // differs.
        continue
      }
      const found = new Set<string>()
      for (const row of resolved) {
        if (!row || typeof row.id !== 'string' || !row.id) continue
        found.add(row.id)
        resolvedUserNames[row.id] = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
      }
      // A successful response (the server answered, no failure was thrown) naming none of these
      // ids is a CONFIRMED miss -- cache null so this id is not repeatedly re-fetched forever.
      for (const id of group) if (!found.has(id)) resolvedUserNames[id] = null
    }
  } finally {
    // Whole-flush release (see the marking comment above): every id from this flush, not just
    // the group last processed -- runs once every group has settled (or thrown), regardless of
    // outcome.
    for (const id of ids) inFlightUserIds.delete(id)
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
    // In-flight dedup (2026-08-21, Codex #4 P3 gate finding -- see `inFlightUserIds`'s own doc):
    // an id already mid-retry-sequence (including a backoff delay) is a no-op here, not a second
    // independent retry chain -- it will pick up the in-flight chain's own result.
    if (inFlightUserIds.has(id)) continue
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

/** Test-only: clears the module-singleton cache + any queued-but-not-yet-flushed ids, AND cancels
 *  every outstanding retry-backoff timer (2026-08-21 -- see `pendingRetryTimeouts`'s own doc
 *  above). Every spec that mounts a component consuming this module MUST call this in
 *  `beforeEach` — otherwise an earlier test's resolved name (or confirmed-unresolved marker), or a
 *  still-pending backoff delay, leaks into a later test: a resolved name makes a discriminating
 *  negative pass for the wrong reason, and an uncancelled timer would fire mid-way through an
 *  unrelated later test and silently add to ITS apiFetch call count. */
export function __resetResolvedDirectoryNamesForTests(): void {
  for (const key of Object.keys(resolvedUserNames)) delete resolvedUserNames[key]
  pendingUserIds.clear()
  userFlushScheduled = false
  for (const handle of pendingRetryTimeouts) clearTimeout(handle)
  pendingRetryTimeouts.clear()
  inFlightUserIds.clear()
}
