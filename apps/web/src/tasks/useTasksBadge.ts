/**
 * Polling composable behind the top-nav tasks badge (design lock §5.2 "红点：常驻
 * `<span data-testid="tasks-todo-badge">` 三态；不照抄审批 `applyCount(0)`").
 *
 * Three states, deliberately NOT collapsed into a number:
 *   - 'loading'     nothing answered yet (mount, or the read has not settled).
 *   - 'ready'       the server answered a trustworthy count (possibly 0 — a genuinely empty
 *                   pending list IS `count: 0`, and that is a real, renderable answer).
 *   - 'unavailable' the read failed outright (network error, 403, 404, any non-2xx) OR degraded
 *                   with `reason: 'org_missing'` — `tasksApi.fetchPendingCount` folds all of these
 *                   into a non-`ok` result kind. The count is UNKNOWN here, not zero: a caller must
 *                   never render '0' for this state (that is exactly the `applyCount(0)` collapse
 *                   the lock calls out and forbids — see `TasksTodoBadge.vue`, which renders an
 *                   empty `data-count` for this state, never `"0"`).
 *
 * Polling: every 60s, but the fetch itself is skipped while the document is hidden (a background
 * tab does not need a fresh count, and it would just be discarded on the next visible tick). This
 * is a SKIP, not a pause of the timer — simpler to test and to reason about, and the 60s interval
 * still exists as a single steady clock rather than one that is torn down and rebuilt around every
 * visibility flip.
 *
 * Generation-guarded like this codebase's other transition-safe composables
 * (`useApprovalAdminCapability`): a response that arrives after a newer request was issued, or
 * after the component owning this composable has unmounted, writes nothing.
 *
 * A 404 means the feature itself is off (there is no `/api/tasks/pending-count` route to ask), not
 * a transient failure — polling every 60s in that case is a request that can never succeed again
 * for the life of this session. The polling timer is torn down the first time a 404 lands, the same
 * way `onUnmounted` tears it down; `refresh()` itself stays callable afterward (a `notifyTasksChanged`
 * nudge or a manual retry can still ask once), only the STEADY clock stops.
 *
 * Also listens on `tasksBadgeBus` so a task the viewer just created/completed/reopened is reflected
 * without waiting out the rest of the current 60s window.
 */
import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { fetchPendingCount } from './tasksApi'
import { onTasksChanged } from './tasksBadgeBus'

export type TasksBadgeState = 'loading' | 'ready' | 'unavailable'

export interface TasksBadgeHandle {
  state: Ref<TasksBadgeState>
  count: Ref<number | null>
}

const POLL_INTERVAL_MS = 60_000

function isTabVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function useTasksBadge(): TasksBadgeHandle {
  const state = ref<TasksBadgeState>('loading')
  const count = ref<number | null>(null)

  let disposed = false
  let generation = 0
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    generation += 1
    const mine = generation
    // `fetchPendingCount` is contracted to never throw, but this composable is a nav-shell
    // surface — the same defensive posture as `ApprovalTodoBadge`'s realtime guard — so a thrown
    // rejection is treated exactly like any other non-`ok` result (`unavailable`), not left to
    // become an unhandled rejection that could take the shell down with it.
    let result: Awaited<ReturnType<typeof fetchPendingCount>>
    try {
      result = await fetchPendingCount()
    } catch {
      result = { kind: 'error', status: 0 }
    }
    // Superseded by a newer poll, or the badge is gone — this answer describes neither any more.
    if (disposed || mine !== generation) return

    if (result.kind === 'ok') {
      state.value = 'ready'
      count.value = result.count
    } else {
      state.value = 'unavailable'
      count.value = null
      // See this module's docblock — a 404 means the route does not exist at all, so the steady
      // poll is stopped for good. Any other failure (network error, 403, org_missing, …) keeps
      // polling: those are all conditions that can change on the NEXT tick (session recovers,
      // caller picks an org, network comes back).
      if (result.kind === 'not_found' && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
  }

  function poll(): void {
    if (!isTabVisible()) return
    void refresh()
  }

  let unsubscribeTasksChanged: (() => void) | null = null

  onMounted(() => {
    void refresh()
    timer = setInterval(poll, POLL_INTERVAL_MS)
    unsubscribeTasksChanged = onTasksChanged(() => void refresh())
  })

  onUnmounted(() => {
    disposed = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (unsubscribeTasksChanged) {
      unsubscribeTasksChanged()
      unsubscribeTasksChanged = null
    }
  })

  return { state, count }
}
