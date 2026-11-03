/**
 * Polling composable behind the top-nav tasks badge (design lock §5.2: a persistent
 * `<span data-testid="tasks-todo-badge">` with three states, where a failed read is never shown as 0).
 *
 * Three states, deliberately NOT collapsed into a number:
 *   - 'loading'     nothing answered yet (mount, or the read has not settled).
 *   - 'ready'       the server answered a trustworthy count (possibly 0 — a genuinely empty
 *                   pending list IS `count: 0`, and that is a real, renderable answer).
 *   - 'unavailable' the read failed outright (network error, 403, 404, any non-2xx) OR degraded
 *                   with `reason: 'org_missing'` — `tasksApi.fetchPendingCount` folds all of these
 *                   into a non-`ok` result kind. The count is UNKNOWN here, not zero: a caller must
 *                   never render '0' for this state (folding "failed" into "zero" is exactly what
 *                   the lock forbids — see `TasksTodoBadge.vue`, which renders an
 *                   empty `data-count` for this state, never `"0"`).
 *
 * Polling: every 60s, but the fetch itself is skipped while the document is hidden (a background
 * tab does not need a fresh count, and it would just be discarded on the next visible tick). This
 * is a SKIP, not a pause of the timer — simpler to test and to reason about, and the 60s interval
 * still exists as a single steady clock rather than one that is torn down and rebuilt around every
 * visibility flip.
 *
 * Generation-guarded: a response that arrives after a newer request was issued, or
 * after the component owning this composable has unmounted, writes nothing.
 *
 * A 404 means the backend has no `/api/tasks/pending-count` route although the session says the
 * tasks feature is on (the badge is only mounted when it is, see App.vue's `canUseTasks`), e.g. a
 * tab kept open across a restart that switched TASKS_ENABLED off. It is not a transient failure —
 * polling every 60s while every attempt still 404s is a request that can never succeed. The polling timer is torn down the first time a 404 lands, the same way
 * `onUnmounted` tears it down; `refresh()` itself stays callable afterward (a `notifyTasksChanged`
 * nudge or a manual retry can still ask once), and if THAT later call comes back `ok`, the steady
 * 60s clock is restarted (see the `timer === null` check in `refresh()`'s `ok` branch) — the route
 * exists after all, so the poll should go back to sustaining itself instead of depending on a nudge
 * for the rest of the session.
 *
 * Also listens on `tasksBadgeBus` so a task the viewer just created/completed/reopened is reflected
 * without waiting out the rest of the current 60s window.
 *
 * M4 (design §8): two additions, nothing above changes.
 *   - `scope`: the server's `badgeScope`. `'off'` when a `ready` answer says the viewer switched
 *     the badge off, `'on'` for every other `ready` answer (key absent or any other value — the
 *     tolerant reading is `fetchPendingCount`'s), `null` while not `ready`. `count` is still the
 *     server's number in the `off` case (0), so "off" and "0 pending" stay distinct through `scope`,
 *     never through the count.
 *   - a `tasks:counts-updated` subscription (`useTasksCountsRealtime`): the push is an invalidation
 *     signal, nothing is read from it, and it ends in the same `refresh()` a `notifyTasksChanged`
 *     nudge calls. The 60s clock keeps running alongside it (`[fe-08]`): no "stop polling while the
 *     socket is up" state machine. The clock is REQUIRED, not only a reconnect fallback: the server
 *     sends the signal through an in-process socket adapter, so a write handled by another backend
 *     process reaches this tab only through the next poll. The composable registers its own mount /
 *     unmount hooks on this component instance, so the socket lives exactly as long as the badge:
 *     no badge (feature off, no `tasks:read`, a public route — `/login` included, which every
 *     in-app sign-out goes through) means no socket and no request.
 *
 * FE-c (design §8.2, re-checked against the emitter): a signal does not read at once. The first
 * signal opens a window of `TASKS_SIGNAL_WINDOW_MS`; every signal inside it is absorbed; when the
 * window closes, one `refresh()` runs (`[fe-51]`). The window is fixed from its first signal and
 * never pushed back, so a steady stream of signals is still read once per window. A read that
 * STARTS while a window is open — a poll tick, a bus nudge — is issued after every signal the
 * window absorbed, so it answers them and closes the window (`[fe-52]`): the viewer's own write,
 * which the server also signals to the viewer when they are an assignee, costs one read, not two,
 * when the signal lands first. A read already in flight when a signal arrives does not answer it
 * (the server may have answered it before the write committed); the window still closes with a
 * read of its own, and the generation guard drops the older answer if it lands later. `[fe-51]`
 * and `[fe-52]` were ruled on 2026-10-09 (gate 26 of the design lock); changing either now takes a
 * new ruling. The window's read runs in a hidden tab too (`[fe-53]`, still this PR's own choice):
 * the hidden-tab skip belongs to the clock, and a background tab still reads at most once per
 * window. Unmount closes an open window, so a window never reads for a badge that is gone.
 */
import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import { fetchPendingCount } from './tasksApi'
import { onTasksChanged } from './tasksBadgeBus'
import { useTasksCountsRealtime } from './useTasksCountsRealtime'

export type TasksBadgeState = 'loading' | 'ready' | 'unavailable'
export type TasksBadgeScope = 'on' | 'off'

/** [fe-51] ruled 2026-10-09 (gate 26): how long the first counts signal waits for more before the
 *  one read that answers them all. */
export const TASKS_SIGNAL_WINDOW_MS = 500

export interface TasksBadgeHandle {
  state: Ref<TasksBadgeState>
  count: Ref<number | null>
  scope: Ref<TasksBadgeScope | null>
}

const POLL_INTERVAL_MS = 60_000

function isTabVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function useTasksBadge(): TasksBadgeHandle {
  const state = ref<TasksBadgeState>('loading')
  const count = ref<number | null>(null)
  const scope = ref<TasksBadgeScope | null>(null)

  let disposed = false
  let generation = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let signalWindow: ReturnType<typeof setTimeout> | null = null

  function closeSignalWindow(): void {
    if (signalWindow !== null) {
      clearTimeout(signalWindow)
      signalWindow = null
    }
  }

  async function refresh(): Promise<void> {
    // [fe-52] ruled 2026-10-09 (gate 26): this read starts after every signal received so far, so
    // it answers them: an open window has nothing left to do. It is also what lets the next signal
    // open a new window once the window's own read has started.
    closeSignalWindow()
    generation += 1
    const mine = generation
    // `fetchPendingCount` is contracted to never throw, but this composable is a nav-shell
    // surface, so a thrown
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
      // ASSUMPTION(task-m4-fe): [D5] — only the literal `'off'` switches the badge off; the key
      // absent or anything else is `'on'` (`[fe-14]`, folded by `fetchPendingCount`).
      scope.value = result.badgeScope === 'off' ? 'off' : 'on'
      // P3(i): restart the steady clock if a prior 404 tore it down. `disposed` is already
      // checked above, so this never fires for an unmounted composable.
      if (timer === null) {
        timer = setInterval(poll, POLL_INTERVAL_MS)
      }
    } else {
      state.value = 'unavailable'
      count.value = null
      // The scope is part of the answer: with no trustworthy answer there is no scope either, so a
      // badge that was `off` and then lost its read reports neither `on` nor `off`.
      scope.value = null
      // See this module's docblock — a 404 means the route does not exist at all, so the steady
      // poll stops here; the `ok` branch above restarts it if a LATER refresh ever succeeds. Any
      // other failure (network error, 403, org_missing, …) never stops it in the first place:
      // those are all conditions that can change on the NEXT tick (session recovers, caller picks
      // an org, network comes back).
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

  // [fe-51] ruled 2026-10-09 (gate 26): one read per window, however many signals arrive in it.
  // [fe-53] The window's read is not skipped in a hidden tab.
  function onCountsSignal(): void {
    if (signalWindow !== null) return
    signalWindow = setTimeout(() => void refresh(), TASKS_SIGNAL_WINDOW_MS)
  }

  // M4 §8.2: a push is an invalidation signal that ends in the bus nudge's `refresh()`. Registered
  // here, inside the badge's own setup, so the socket is gated by the badge's mount (see the
  // docblock).
  useTasksCountsRealtime({ onCountsUpdated: onCountsSignal })

  onMounted(() => {
    void refresh()
    timer = setInterval(poll, POLL_INTERVAL_MS)
    unsubscribeTasksChanged = onTasksChanged(() => void refresh())
  })

  onUnmounted(() => {
    disposed = true
    closeSignalWindow()
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (unsubscribeTasksChanged) {
      unsubscribeTasksChanged()
      unsubscribeTasksChanged = null
    }
  })

  return { state, count, scope }
}
