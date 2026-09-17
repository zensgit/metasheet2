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
//   * It does NOT自行判断可见性: `isTodoResponseDegraded` is the one shared rule (also used by the
//     todo center page) for "render as unavailable rather than trust the number" — this component
//     does not invent a second version of that judgment (lock §3 hard constraint).
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
// VERIFIED WIRING, STATED PLAINLY: `notifyAuthPrincipalChange()` is called from exactly one place
// in `useAuth.ts` — `resetSessionBootstrap`, reached by `setToken` (login) and `clearToken`
// (sign-out/401). It is grepped, not assumed:
//   grep -n 'notifyAuthPrincipalChange' src/composables/useAuth.ts  →  one import line, one call
//   site, both inside `resetSessionBootstrap`.
// The explicit in-session org switch (`setExplicitSessionOrg`) does NOT call it — that function
// writes `auth_token`/`jwt` and installs the explicit-session marker directly, with no call to
// `resetSessionBootstrap` or `notifyAuthPrincipalChange` anywhere in its body. So today an org
// switch fires NO notification, and this guard — though it would handle one correctly if it fired —
// is not actually exercised by the org-switch code path in production. This is a PRE-EXISTING gap
// shared with `useApprovalAdminCapability`'s identical mechanism (same missing wiring, same blast
// radius), not something this commit introduces or can fix by itself: wiring
// `notifyAuthPrincipalChange()` into `setExplicitSessionOrg` is a change to a shared auth funnel
// with its own rollback path, and belongs to its own reviewed unit, not this one.
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
// NOT covered by this guard, and left as a separate, larger unit (see `remaining` in the commit
// this lands with): `useApprovalCountsRealtime`'s socket connects with the token read ONCE, at
// `ensureSocket()` time, and is never reconnected on an auth transition — only torn down on
// unmount. `handleCountsUpdated` below therefore has no generation check of its own; a push that
// arrives on the outgoing principal's still-open socket after a transition is not this commit's
// fix, it is the realtime trigger point's.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getTodoCount, isTodoResponseDegraded, type TodoCountResponse } from '../../todo/api'
import { useLocale } from '../../composables/useLocale'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../../composables/authPrincipal'
import { useApprovalCountsRealtime, type ApprovalCountsUpdatedPayload } from '../useApprovalCountsRealtime'

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

// Same scoping rule ApprovalCenterView.handleRealtimeCountsUpdated uses: prefer the per-source
// bucket for the scope being displayed, fall back to the payload root. The nav badge is unscoped,
// so its bucket is 'all'.
function handleCountsUpdated(payload: ApprovalCountsUpdatedPayload): void {
  const scoped = payload.countsBySourceSystem?.all ?? payload
  isUnavailable.value = false
  applyCount(scoped.count)
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
  useApprovalCountsRealtime({ onCountsUpdated: handleCountsUpdated })
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
    if (disposed || !hasSession()) return
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
