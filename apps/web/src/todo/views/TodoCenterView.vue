<template>
  <div class="todo-center" data-testid="todo-center">
    <h1 class="todo-center__title">{{ isZh ? '待办中心' : 'Todo Center' }}</h1>

    <p
      v-if="loadFailed"
      class="todo-center__status todo-center__status--failed"
      data-testid="todo-center-load-failed"
      role="alert"
    >
      {{ isZh ? '待办列表暂时无法加载,请稍后重试' : 'Could not load your to-dos right now. Please try again later.' }}
    </p>

    <template v-else>
      <section
        v-for="group in groups"
        :key="group.source"
        class="todo-center__group"
        :data-testid="`todo-center-group-${group.source}`"
      >
        <h2 class="todo-center__group-title">{{ sourceLabel(group.source) }}</h2>

        <!-- 判据 B negative control: `unavailable` and "checked, zero items" must never share a
             DOM shape — one says "could not tell", the other says "told you: none". -->
        <p
          v-if="group.status === 'unavailable'"
          class="todo-center__status todo-center__status--unavailable"
          data-testid="todo-center-group-unavailable"
          role="status"
        >
          {{ isZh ? '该来源暂时无法查询' : 'This source could not be checked right now' }}
        </p>
        <p
          v-else-if="group.items.length === 0"
          class="todo-center__status todo-center__status--empty"
          data-testid="todo-center-group-empty"
        >
          {{ isZh ? '暂无待办' : 'Nothing pending' }}
        </p>
        <ul v-else class="todo-center__items">
          <li v-for="item in group.items" :key="item.id" class="todo-center__item">
            <!-- P3-6 (gate `impl-gate-B2-round1-20260918.md`): a source-produced href that is not a
                 site-relative path renders INERT (this branch), never a `<router-link>` that would
                 silently resolve to a no-op/broken route — see `isSameOriginRelativeHref`'s docblock
                 below for why this is not an open-redirect fix (`router-link` never treats the string
                 as a URL to follow). -->
            <span
              v-if="!item.navigable"
              class="todo-center__item-link todo-center__item-link--unlinkable"
              data-testid="todo-center-item-unlinkable"
            >
              <span class="todo-center__item-title">{{ item.title }}</span>
              <span
                v-if="item.actionable === false"
                class="todo-center__pill todo-center__pill--view-only"
                data-testid="todo-center-item-view-only"
              >{{ isZh ? '仅查看' : 'View only' }}</span>
            </span>
            <router-link v-else :to="item.href" class="todo-center__item-link" data-testid="todo-center-item">
              <span class="todo-center__item-title">{{ item.title }}</span>
              <!-- 判据 C′: an item the viewer cannot currently act on renders visibly differently
                   from an actionable one (a view-only pill), never the same shape. Absent when the
                   source has no such notion (item.actionable === undefined) — nothing to render. -->
              <span
                v-if="item.actionable === false"
                class="todo-center__pill todo-center__pill--view-only"
                data-testid="todo-center-item-view-only"
              >{{ isZh ? '仅查看' : 'View only' }}</span>
            </router-link>
          </li>
        </ul>
      </section>

      <p
        v-if="groups.length === 0"
        class="todo-center__status"
        data-testid="todo-center-no-sources"
      >
        {{ isZh ? '暂无可用的待办来源' : 'No todo sources are registered' }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
// Todo Center page (B-2 phase 2, todo-center-design-lock v2.14 §4 front-end half).
//
// GROUPING RULE, and why it is the one thing this file must get right: groups are derived from
// `response.sources` (every registered source name, each already carrying its own `ok`/`unavailable`
// status), NOT from `response.items`. An `unavailable` source contributes zero items by
// construction (`pending-source-registry.ts`'s fail-closed catch) — deriving groups from `items`
// alone would make that source's group silently vanish, rendering byte-identical to "checked this
// source, it had nothing" (`ok` + 0 items). Lock §5 判据 B's negative control names exactly this:
// the two must never share a DOM shape. `sources`-driven grouping is what keeps them apart.
//
// 判据 E (代数守卫): copied WHOLE from `ApprovalTodoBadge.vue`'s mechanism (not re-derived item by
// item — see that file's docblock for why the microtask defer + `hasSession()` gate around the
// re-read are load-bearing, not incidental). Two independent monotonic-generation bumps:
//   * `refresh()`'s own bump discards a stale response when the transition issues its OWN new read
//     (a session remains — org/account switch).
//   * the auth-transition listener's bump discards a stale response when the transition issues NO
//     new read of its own (sign-out — nothing else would supersede the in-flight read).
// Both clear the rendered state synchronously on transition so the departing principal's list never
// lingers for the width of the new read.
//
// REALTIME (B-2 step 8): also subscribed to `todo:counts-updated`, same as the badge — but this
// page cannot reuse the badge's `applyResult()`-on-push shortcut, because the push payload is
// `{ count, sources }` (see `useTodoCountsRealtime`'s file-level note): no `items`. This page's
// entire content IS the item list, so the only correct reaction to a push is to re-run the SAME
// generation-guarded `refresh()` that mount and the auth-transition listener already use — not a
// second, payload-shaped judgment. `handleCountsUpdated` therefore does nothing but call `refresh()`.
//
// DELIBERATE DIVERGENCE from `ApprovalCenterView`'s G-B2-11 ("新待办到达刷新 pill",
// `src/approvals/newTodoPill.ts`): that surface deliberately does NOT auto-reload on a push, because
// an unannounced reload would silently wipe the operator's in-progress `selectedPending`
// multi-select mid-triage. This page has no analogous state — no selection, no in-progress edit,
// every row a plain navigation link — so G-B2-11's rationale does not transfer, and a direct
// `refresh()` is used instead of a click-to-refresh pill. Stated explicitly rather than left as an
// unexplained inconsistency between the two 待办 surfaces for a reviewer to trip over.
//
// `acceptPushes` closes the SAME sign-out half `ApprovalTodoBadge.vue` closes, copied WHOLE for the
// same reason: the socket connects with the token read once and is never reconnected on a
// transition, so a push can land on the still-open socket after sign-out. Without the gate, that
// push would call `refresh()` and issue a read for a departed principal.
//
// ORG-SWITCH HALF — corrects a claim made elsewhere, does not itself close the gap: both
// `ApprovalTodoBadge.vue`'s docblock and `ce417a250` (this branch) state `setExplicitSessionOrg`
// does not call `resetSessionBootstrap`/`notifyAuthPrincipalChange`. That is no longer true of the
// code both were written against — `setExplicitSessionOrg`'s success path DOES call it
// (`useAuth.ts:301`, inside the function at `useAuth.ts:265-303`; `resetSessionBootstrap` calls
// `notifyAuthPrincipalChange()` unconditionally at `useAuth.ts:142`), added by `5f4b643b78`
// ("fix(attendance): fence explicit organization session consumers", 2026-09-08) — an ancestor of
// this branch's base, predating both texts that assert the opposite:
//   grep -n 'resetSessionBootstrap(true, false, true)' apps/web/src/composables/useAuth.ts
// If accurate end-to-end, an org switch fires the SAME `onAuthPrincipalChange` this file's E1/E2
// tests already exercise via the generic listener, which would also cover the REST re-read half of
// an org switch (narrowing, not closing, the badge's documented gap) — but the SOCKET itself still
// authenticates with the pre-switch token and is never reconnected on any transition, so a push
// landing on it after a switch is a distinct, still-unverified risk from the REST race. NOT proven
// end-to-end here through a real `setExplicitSessionOrg()` call — left for a dedicated unit rather
// than asserted either way beyond the grep above.
//
// Wrapped in try/catch like the badge, for a different reason: `router-view` in `App.vue` carries
// no `ShellChromeBoundary` (that only wraps nav-shell children), so a throw from this composable's
// setup would not be isolated to this route the way the badge's throw is isolated to the nav — it
// would propagate up uncaught. Losing it degrades the page to "loads once on mount and on auth
// transitions", which is still a correct, honest page.
//
// HREF GUARD (fix round 2, gate `impl-gate-B2-round1-20260918.md` P3-6): `approval-pending-source.ts`
// only ever produces `/approvals/<id>` today, so this is defensive, not a fix for an observed
// production bug — but the lock leaves `href`'s shape unconstrained for any FUTURE source
// registered ahead of this one. This is NOT an open-redirect fix: `router-link`'s `:to` resolves
// whatever string it is given as an internal ROUTE PATH via `router.resolve`, it never navigates
// the browser to an arbitrary URL, so an absolute/off-site href cannot make this page leave the
// site. The actual failure mode is SILENCE — a non-route-shaped string resolves to a no-op or a
// broken route, and the row still looks like a normal, clickable link. Lock §4's literal text
// ("点击 `href` 导航") describes the navigation mechanism when it happens; it does not require every
// row to render as a link, so a malformed href renders the row INERT (no `<router-link>`, see
// template) plus a `console.error` so the condition is discoverable — never a link that quietly
// does nothing on click.
import { onMounted, onUnmounted, ref } from 'vue'
import { getTodoItems, type PendingItem, type PendingSourceStatus, type TodoItemsResponse } from '../api'
import { useLocale } from '../../composables/useLocale'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../../composables/authPrincipal'
import { useTodoCountsRealtime, type TodoCountsUpdatedPayload } from '../useTodoCountsRealtime'

interface RenderableItem extends PendingItem {
  // Precomputed once per `applyResult()` call (not re-evaluated per render in the template) —
  // whether `href` is safe to hand to `router-link`. See the HREF GUARD file-level note.
  navigable: boolean
}

interface TodoGroup {
  source: string
  status: PendingSourceStatus
  items: RenderableItem[]
}

// A site-relative path: starts with exactly one leading `/` (not `//`, which a browser/router can
// treat as protocol-relative), not a backslash variant of the same trick, and carries no URL scheme
// (`javascript:`, `https:`, ...) before its first `/`/`?`/`#` — rejected defensively even though
// `router-link` would not execute it as a URL. Local to this component: it is not exported, and it
// is not the shared `isTodoResponseDegraded`-style rule the badge and this page both apply — this
// page is the only consumer of `item.href`, so there is nothing to centralize (see `todo/api.ts`'s
// corrected docblock for the sibling mistake of overclaiming a shared rule that had only one user).
function isSameOriginRelativeHref(href: string): boolean {
  if (typeof href !== 'string' || href.length === 0) return false
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return false
  return !/^\/[^/?#]*:/.test(href)
}

const SOURCE_LABELS_ZH: Record<string, string> = { approval: '审批' }
const SOURCE_LABELS_EN: Record<string, string> = { approval: 'Approvals' }

function hasSession(): boolean {
  try {
    return getAuthPrincipalKey() !== null
  } catch {
    // A storage read can throw (Safari private mode). "Cannot tell" is not "signed out", so the
    // re-read is still issued and the server decides — same rationale as the badge's identical guard.
    return true
  }
}

const { isZh } = useLocale()

const groups = ref<TodoGroup[]>([])
const loadFailed = ref(false)

function sourceLabel(source: string): string {
  const table = isZh.value ? SOURCE_LABELS_ZH : SOURCE_LABELS_EN
  return table[source] ?? source
}

function applyResult(response: TodoItemsResponse | null): void {
  if (response === null) {
    // The aggregation endpoint itself threw (a bug in the aggregator, not a per-source outage —
    // `routes/todo.ts` reserves 500 for exactly that case) or the read never reached the server.
    // Discriminable from every per-source `unavailable` group: this is "the whole page failed",
    // not "one source could not be checked".
    loadFailed.value = true
    groups.value = []
    return
  }
  loadFailed.value = false
  groups.value = Object.entries(response.sources).map(([source, status]) => ({
    source,
    status,
    items: response.items
      .filter((item) => item.source === source)
      .map((item) => {
        const navigable = isSameOriginRelativeHref(item.href)
        if (!navigable) {
          // Discoverable, not silent — see HREF GUARD file-level note.
          console.error(`[todo-center] source "${source}" produced a non-site-relative href; rendering item "${item.id}" inert instead of linking to it: ${item.href}`)
        }
        return { ...item, navigable }
      }),
  }))
}

let generation = 0
let disposed = false

async function refresh(): Promise<void> {
  generation += 1
  const mine = generation
  try {
    const result = await getTodoItems()
    if (mine !== generation) return // superseded — see 判据 E note above
    applyResult(result)
  } catch {
    if (mine !== generation) return
    applyResult(null)
  }
}

// Sign-out half of 判据 E for the push path (see file-level note): starts `true` so mount-time and
// steady-state pushes are unaffected; set by the auth-transition listener's own deferred check
// below, NOT re-derived from live storage at push time — same rationale as the badge's identical
// flag.
let acceptPushes = true

// The push carries no items (`{ count, sources }`) — re-running `refresh()` is the only correct
// reaction; see the file-level note for why this is not a second judgment on the payload.
function handleCountsUpdated(_payload: TodoCountsUpdatedPayload): void {
  if (!acceptPushes) return
  void refresh()
}

// Isolated for the same reason `ApprovalTodoBadge.vue` isolates this call — see file-level note.
try {
  useTodoCountsRealtime({ onCountsUpdated: handleCountsUpdated })
} catch {
  // No realtime refresh for this session; refresh() on mount and on auth transitions still keeps
  // the list current.
}

const unsubscribeAuthPrincipal = onAuthPrincipalChange(() => {
  generation += 1
  groups.value = []
  loadFailed.value = false
  void Promise.resolve().then(() => {
    if (disposed) return
    if (!hasSession()) {
      // Sign-out CONFIRMED: retire any push landing on the still-open socket too, same as the REST
      // re-read is retired above.
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
.todo-center {
  padding: 16px 24px;
}

.todo-center__title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 16px;
}

.todo-center__group {
  margin-bottom: 24px;
}

.todo-center__group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-secondary, #666);
  margin: 0 0 8px;
}

.todo-center__status {
  font-size: 13px;
  color: var(--el-text-color-secondary, #666);
  margin: 0;
}

.todo-center__status--unavailable {
  color: var(--el-color-warning, #e6a23c);
}

.todo-center__status--failed {
  color: var(--el-color-danger, #f56c6c);
}

.todo-center__items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.todo-center__item {
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.todo-center__item-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 4px;
  text-decoration: none;
  color: inherit;
}

.todo-center__item-link--unlinkable {
  color: var(--el-text-color-secondary, #666);
  cursor: default;
}

.todo-center__pill {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9px;
  background: var(--el-fill-color-light, #f0f2f5);
  color: var(--el-text-color-secondary, #666);
  white-space: nowrap;
}
</style>
