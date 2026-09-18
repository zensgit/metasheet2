<template>
  <span
    v-if="isUnavailable"
    class="approval-todo-badge approval-todo-badge--unavailable"
    data-testid="approval-todo-badge-unavailable"
    role="status"
    :aria-label="unavailableLabel"
    :title="unavailableLabel"
  >!</span>
  <span
    v-else-if="pendingCount > 0"
    class="approval-todo-badge"
    data-testid="approval-todo-badge"
    role="status"
    :aria-label="label"
    :title="label"
  >{{ displayCount }}</span>
</template>

<script setup lang="ts">
// P1b slice 1 — the app-level 待办 badge for the top-nav 审批中心 entry.
// B-2 (todo-center-design-lock v2.14 §4/判据 B) — repointed at the aggregation endpoint:
//
// WHAT IT REUSES, and what it deliberately does NOT do:
//   * The count is now the todo-center's own aggregate (`getTodoCount` → GET /api/todo/count),
//     which B-1 built by calling the SAME shared 待处理 query 审批中心's header already reads
//     (lock §3.0/§4 — zero-behavior-change reuse, not a second predicate). It is the total 待办
//     `count` — NOT any per-source `unreadCount`.
//   * It writes NOTHING. In particular it does not create or write a notification-inbox record:
//     the inbox is a multitable record-subscription model and approval tasks do not belong in it.
//   * It NEVER reloads a list. The existing no-auto-reload discipline (ApprovalCenterView's
//     G-B2-11 pill: a realtime push moves the count, never the rows) is preserved here by
//     construction — this component owns one number and renders it; it has no list to reload and
//     no router navigation of its own.
//   * It does NOT自行判断可见性: `isTodoResponseDegraded` is this component's one rule for "render
//     as unavailable rather than trust the number" — it does not invent a second version of that
//     judgment (lock §3 hard constraint). CORRECTED (fix round 2, gate `impl-gate-B2-round1-
//     20260918.md` P3-4): this line previously read "also used by the todo center page" — false;
//     `TodoCenterView.vue` imports neither this function nor `TodoCountResponse`, and its own
//     `TodoItemsResponse` has no `degraded` field for it to read (see `todo/api.ts`'s corrected
//     docblock for the full picture, including why this is not a second diverged rule).
//

// 判据 B (徽标格): a response with the legacy `degraded: true` flag OR any source reporting
// `unavailable` — and a thrown/rejected read, which carries the SAME "the count is not trustworthy"
// meaning — must render as a discriminable "不可用" state, never collapse to the same "0" a
// genuinely-empty todo list renders as. `degraded` itself is not emitted by `/api/todo/count` today
// (double-gated by `APPROVALS_OPTIONAL`, unreachable in this lane — see `todo/api.ts`), so this
// component's OWN spec is the only place that branch is exercised; it is stubbed there, not on a
// live backend path.
//
// The label is passed in by the caller rather than resolved here, so the nav keeps ONE i18n table
// (App.vue's `navLabels`) instead of growing a second one. The label carries no values — it names
// the surface ("待办审批" / "Pending approvals"); the badge text is the count alone.
//
// 判据 E (代数守卫, lock §5): a logout or an org switch must void any `getTodoCount()` read still
// in flight for the principal that is leaving. The MECHANISM below is general — it reacts to
// `onAuthPrincipalChange`, whoever fires it — copied WHOLE from `useApprovalAdminCapability`
// (round-7) rather than item-by-item (an earlier draft copied only the generation bump and dropped
// the microtask/`hasSession()` gate around the re-read, which is a real bug: `useAuth`'s reset
// funnel calls `notifyAuthPrincipalChange()` BEFORE it writes the new token to storage, so a
// re-read fired synchronously inside the notification would ask `/api/todo/count` with the
// OUTGOING session — an anonymous request on sign-out, or the departing principal's on a login.
// Deferring the re-read to a microtask lets that synchronous storage write land first).
//
// VERIFIED WIRING, STATED PLAINLY, CORRECTED (B-2 step 9): a prior version of this note claimed
// the explicit in-session org switch (`setExplicitSessionOrg`) does not call
// `notifyAuthPrincipalChange()` and so this guard is never exercised by an org switch in
// production. That claim was checked against a stale copy of `useAuth.ts` and is FALSE as of
// `5f4b643b78` (2026-09-08, predates this branch): `setExplicitSessionOrg` DOES call it, via
// `resetSessionBootstrap` right before its own `return true`.
//   grep -n 'resetSessionBootstrap(' src/composables/useAuth.ts  →  6 hits; one (`:123`) is the
//   function's own declaration, the other 5 are call sites: `setToken` (`:234`), `clearToken`
//   (`:249`), `setExplicitSessionOrg` (`:301`), the forced-relogin branch inside `bootstrapSession`
//   (`:412`), and the cross-tab `storage` event listener inside `observeExplicitSessionStorage`
//   (`:77`). CORRECTED (fix round 2, gate `impl-gate-B2-round1-20260918.md` P3-5): this line
//   previously said "4 call sites" and omitted the `:77` listener — that call is a genuine 5th
//   site, not a mistaken double-count of one of the other four, but it does not change the
//   conclusion below: it calls the SAME `resetSessionBootstrap`, which calls the SAME
//   `notifyAuthPrincipalChange()` this file's guard already reacts to generically.
// So an org switch DOES fire this notification, and this guard's reaction — the SAME generic
// `onAuthPrincipalChange` code whether the trigger is sign-out, login, or an org switch — IS
// exercised by it in production, not merely "would handle one correctly if it fired". Proven, not
// re-asserted: `apps/web/tests/useAuth.spec.ts`'s "fires the auth-principal-change notification
// synchronously on a successful org switch" test drives the REAL `setExplicitSessionOrg` (no mock
// of `onAuthPrincipalChange` itself) and is mutation-probed against that call site.
// One real, still-accurate asymmetry: `setToken`/`clearToken` call `resetSessionBootstrap` BEFORE
// writing `auth_token`/`jwt` to storage — the reason this file's own microtask defer below exists,
// so the synchronous storage write lands first. `setExplicitSessionOrg` writes storage FIRST and
// notifies LAST, so a subscriber reading storage synchronously inside the callback already sees
// the new org's token; the microtask defer is harmless for this transition but not load-bearing
// for it the way it is for login/sign-out.
// Checked, not merely assumed to share the same story: `useApprovalAdminCapability`'s identical
// mechanism (referenced below as where this one was copied from) makes NO claim about
// `setExplicitSessionOrg` at all —
//   grep -n 'setExplicitSessionOrg\|onAuthPrincipalChange' src/approvals/useApprovalAdminCapability.ts
//   → only `onAuthPrincipalChange` (the subscription itself), zero mentions of `setExplicitSessionOrg`
// — so there is no duplicated false claim in that file to correct alongside this one.
//
// Two INDEPENDENT bumps, each pinned by its own test because neither covers the other, for the two
// transitions THIS mechanism does receive:
//   * `refresh()`'s own bump discards a stale response when the transition issues its OWN new read
//     (login while already signed in, e.g. a dev-token refresh: a session remains, so a fresh read
//     for the new principal starts and can resolve before the outgoing read does).
//   * the listener's bump discards a stale response when the transition issues NO new read
//     (sign-out: `hasSession()` is false, so nothing supersedes the in-flight read from the inside —
//     without this second bump, that read's own `mine === generation` check would still pass when
//     it finally resolves, and it would paint the departed principal's count).
// The tests below name their scenario "principal swap, session present" / "sign-out, no session"
// rather than "org switch" precisely because the mechanism is generic to `onAuthPrincipalChange`
// and does not depend on which real caller fires it — see the wiring note above for what does.
//
// The listener also resets `pendingCount`/`isUnavailable` to their initial "nothing rendered"
// values synchronously — the translation of `useApprovalAdminCapability`'s "go back to `pending`
// first" into this component's two-state shape, so the outgoing principal's number never lingers
// for the width of the new read.
//
// NOW REPOINTED at `todo:counts-updated` (`useTodoCountsRealtime`, `../../todo/`) instead of
// `approval:counts-updated` — the former is computed by `pendingSourceRegistry.countPendingForUser`,
// the SAME function `getTodoCount()` above reads; the latter is computed by
// `approval-realtime.ts`'s `computeApprovalPendingCounts`, a pre-existing, KNOWN-DIVERGENT second
// copy of the pending predicate (missing the handler-node exclusion) — subscribing to both would
// re-admit that divergence into the rendered number. `handleCountsUpdated` reuses `applyResult()`
// (the SAME function `refresh()` calls) rather than inventing its own degraded/unavailable check,
// per the file-level "does NOT自行判断可见性" note above — the earlier version of this handler set
// `isUnavailable.value = false` unconditionally, which was itself a second, divergent judgment.
//
// PARTIALLY covered by a session guard, one gap left open and re-attributed correctly (the prior
// note here blamed "the realtime trigger point" — that unit is done now, and was never actually
// where this gap lives): `useTodoCountsRealtime`'s socket connects with the token read ONCE, at
// `ensureSocket()` time, and is never reconnected on an auth transition — only torn down on
// unmount. `handleCountsUpdated` below checks a local `acceptPushes` flag before painting.
// `acceptPushes` is NOT a live re-check of `hasSession()` at push time — most of this file's own
// tests never set an `auth_token` at all, and a live check would drop every push in every test that
// doesn't (a push arriving is not itself evidence of who is signed in). Instead it mirrors the
// REST re-read's OWN timing: the listener's deferred microtask below (the same one that decides
// whether to call `refresh()`) is the ONE place a transition's outcome — session remains, or not —
// is actually resolved, so that is where `acceptPushes` is set. This closes the SIGN-OUT half (a
// push landing on the still-open socket after a CONFIRMED sign-out is dropped, matching the
// listener's own synchronous zeroing — see the E3 test). The ORG-SWITCH half remains open:
// `onAuthPrincipalChange` DOES fire on a switch (see the corrected wiring note above), so the
// microtask explicitly sets `acceptPushes = true` (a session remains) rather than merely leaving it
// at its prior value — but the socket itself is never reconnected, so a push landing on the still-
// open socket afterward can still describe the departing principal's data. Closing that requires
// reconnecting the socket itself (re-authenticating with the new token) on the SAME
// `onAuthPrincipalChange` event this file already subscribes to for the REST half — a change to
// this composable's own connection lifecycle, not to the backend query, and a separate, larger unit
// than this commit.
//
// CHECKED (fix round 4, gate `impl-gate-B2-round1-20260918.md` P3-7 — this was previously left as
// an open question, not asserted either way; it is now): `todo:counts-updated`'s room is
// per-user only, NOT per-org (`buildAuthenticatedUserRoom(userId)` returns the literal string
// `auth-user:${userId}`, `CollabService.ts:8-10` — no tenant/org component). But the deeper
// reason a stale push here is harmless is that the COUNT ITSELF has no org dimension to be stale
// about, at any layer this pipeline touches:
//   grep -n 'tenant\|org' packages/core-backend/src/services/approval-pending-query.ts   → 0 hits
// the shared SQL both `GET /api/todo/count` and this push read never filters or groups by
// tenant/org. Every `PendingViewer`/`ApprovalPendingViewer` built on the way there
// (`routes/todo.ts`'s `resolveTodoViewer`, `pending-source-registry.ts`,
// `approval-pending-source.ts`'s `toApprovalPendingViewer`) carries only
// `{ actorId, roles, permissions }` — no tenant field exists to plumb through even if the query
// wanted one. THIS ALONE is enough for the conclusion below, independent of whether roles/
// permissions themselves happen to vary by org.
// Two more pieces, checked rather than assumed, that additionally rule out an org-varying
// `roles`/`permissions` INPUT to that query: (a) the org-switch endpoint itself
// (`routes/auth.ts`'s `POST /auth/session-org`) does not recompute them for the new org — its
// `tokenUser` is built as `{ ...user, tenantId: chosen }`, carrying the SAME `user.roles`/
// `user.permissions` forward, changing only `tenantId` — but that only proves THIS ONE TRANSITION
// doesn't change them, not that they are org-invariant in general; so (b) the production
// resolution path every authenticated request goes through (`AuthService.verifyToken` →
// `getUserById(userId)`, a `WHERE id = $1` query with no tenant condition, → `resolveRbacProfile`
// → `isAdmin(userId)`/`listUserPermissions(userId)` in `rbac/service.ts`) has NO tenant parameter
// anywhere in that chain's signatures — not "this switch happened not to change it", but there is
// no tenant input for it to vary BY, for any request, not only the one right after a switch.
// So for one signed-in user, this query returns the IDENTICAL number regardless of which org's
// token is currently active — there is no per-org value for a push (or a REST re-read) to be
// stale RELATIVE TO. A push landing on the still-open socket after an org switch is therefore not
// a wrong-org leak; it is the same org-invariant count the REST re-read would also return, before
// and after the switch.
// PRE-EXISTING, not introduced or worsened here: `approval:counts-updated` (`approval-realtime.ts`)
// reads the SAME query shape through the SAME room-building function and has always had this
// property. Whether "the todo/approval count spans every org a user belongs to, not just the
// currently-active one" is the right product behavior is a separate question this gap does not
// answer either way — orthogonal to P3-7, which was only about whether a STALE push could describe
// a DIFFERENT org's data than a fresh one would (it cannot, because there is no such difference).
// The socket-reconnection gap two paragraphs up remains open regardless of this finding — it is
// about which TOKEN authenticates the connection, not about what the query returns.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getTodoCount, isTodoResponseDegraded, type TodoCountResponse } from '../../todo/api'
import { useLocale } from '../../composables/useLocale'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../../composables/authPrincipal'
import { useTodoCountsRealtime, type TodoCountsUpdatedPayload } from '../../todo/useTodoCountsRealtime'

function hasSession(): boolean {
  try {
    return getAuthPrincipalKey() !== null
  } catch {
    // A storage read can throw (Safari private mode). "Cannot tell" is not "signed out", so the
    // re-read is still issued and the server decides — same rationale as
    // `useApprovalAdminCapability`'s identical guard.
    return true
  }
}

const props = withDefaults(defineProps<{
  label: string
  /** Counts above this render as `<overflowAt>+` so the nav pill cannot grow without bound. */
  overflowAt?: number
}>(), {
  overflowAt: 99,
})

const { isZh } = useLocale()

const pendingCount = ref(0)
// 判据 B: discriminable from "pendingCount === 0" — a genuinely empty todo list and "this read
// could not be trusted" must never render the same way.
const isUnavailable = ref(false)

const unavailableLabel = computed(() => (
  isZh.value ? `${props.label}(数据不可用)` : `${props.label} (data unavailable)`
))

function applyCount(value: unknown): void {
  pendingCount.value = typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

/** The one place both "the server said degraded" and "the read threw" collapse into the same
 *  discriminable state — see the 判据 B note above. `response` is `null` only when the read threw
 *  (no body to inspect), which is unavailable unconditionally, same as a degraded body. */
function applyResult(response: TodoCountResponse | null): void {
  if (response === null || isTodoResponseDegraded(response)) {
    isUnavailable.value = true
    pendingCount.value = 0
    return
  }
  isUnavailable.value = false
  applyCount(response.count)
}

const displayCount = computed(() => (
  pendingCount.value > props.overflowAt ? `${props.overflowAt}+` : String(pendingCount.value)
))

// Sign-out half of 判据 E for the push path (see file-level note): starts `true` so mount-time and
// steady-state pushes are unaffected; set by the auth-transition listener's own deferred check
// below, NOT re-derived from live storage at push time.
let acceptPushes = true

// `todo:counts-updated` carries the SAME shape `getTodoCount()` resolves to (`{ count, sources,
// degraded? }`), so the push path reuses `applyResult()` verbatim instead of a second judgment —
// see the file-level note above for why that matters and what the prior handler got wrong.
function handleCountsUpdated(payload: TodoCountsUpdatedPayload): void {
  // A push that lands on this still-open socket after a CONFIRMED sign-out must not repaint —
  // there is no principal left for it to describe, and the listener below has already zeroed the
  // rendered state.
  if (!acceptPushes) return
  applyResult(payload)
}

// P1b round 2, item (3): this component lives in the APP SHELL, so a throw here takes the whole
// nav down (`main.ts` installs no `app.config.errorHandler`). The realtime composable is the one
// call in this setup that reaches outside the component — it constructs a socket client and reads
// module state — so it is isolated. Losing it degrades the badge to "fetched once on mount", which
// is a correct, honest badge; letting it escape would blank the shell.
//
// This is one of TWO independent guards, deliberately not overlapping: `ShellChromeBoundary` in
// App.vue catches anything else in this component's setup or render, and each is pinned by its own
// test (a throwing composable — the badge still renders its count; a throwing component — the nav
// renders without the badge).
try {
  useTodoCountsRealtime({ onCountsUpdated: handleCountsUpdated })
} catch {
  // No realtime updates for this session; the mounted count below is still shown.
}

// 判据 E: monotonic generation. Bumped here on every call, and also by the auth-transition
// listener below (see the file-level note for why that second bump is not redundant).
let generation = 0
let disposed = false

async function refresh(): Promise<void> {
  generation += 1
  const mine = generation
  try {
    const result = await getTodoCount()
    // Superseded by a later refresh — either a fresh call, or the transition listener's own bump
    // — says nothing about the principal this badge now represents.
    if (mine !== generation) return
    applyResult(result)
  } catch {
    if (mine !== generation) return
    // 判据 B: a failed read is exactly as untrustworthy as a `degraded: true` response — both
    // must render the discriminable "不可用" state, NOT the same "0" an empty list renders as.
    // (The prior badge collapsed this to `applyCount(0)`, which is indistinguishable from
    // "genuinely nothing pending" — that collapse is what 判据 B's mutation restores to prove
    // this branch is load-bearing.)
    applyResult(null)
  }
}

const unsubscribeAuthPrincipal = onAuthPrincipalChange(() => {
  // Retire the outgoing principal's read in flight SYNCHRONOUSLY, before anything about the new
  // principal is decided — a sign-out issues no read of its own below, so without this bump
  // nothing would ever supersede a read still in flight from before the transition.
  generation += 1
  // The outgoing principal's number must not linger on screen for the width of the new read.
  pendingCount.value = 0
  isUnavailable.value = false
  // Deferred to a microtask: see the file-level note on why (the funnel writes the new token to
  // storage AFTER this notification fires).
  void Promise.resolve().then(() => {
    if (disposed) return
    if (!hasSession()) {
      // Sign-out CONFIRMED (not merely notified — see file-level note on `acceptPushes`): retire
      // any push landing on the still-open socket too, same as the REST re-read is retired below.
      acceptPushes = false
      return
    }
    acceptPushes = true
    void refresh()
  })
})

onMounted(() => {
  void refresh()
})

onUnmounted(() => {
  disposed = true
  unsubscribeAuthPrincipal()
})

defineExpose({ refresh })
</script>

<style scoped>
.approval-todo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--el-color-danger);
  color: var(--el-color-white);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
}

/* 判据 B: visually distinct from the numeric badge above so "不可用" is never mistaken for "0
   pending" (which renders no badge at all) or for a genuine count. */
.approval-todo-badge--unavailable {
  background: var(--el-color-warning);
}
</style>
