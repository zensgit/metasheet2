/**
 * Minimal pub/sub letting a successful task mutation (create/complete/reopen, in `TasksView`) nudge
 * the nav badge (`TasksTodoBadge`/`useTasksBadge`, mounted in `App.vue`'s nav) to refresh
 * immediately instead of waiting for its next 60s poll.
 *
 * Deliberately NOT `provide`/`inject`: the badge lives in `App.vue`'s nav and `TasksView` is
 * rendered under `<router-view>` — both are descendants of `App.vue`, but the badge itself is a
 * separate component instance with no template ref exposed across that boundary, so there is
 * nothing for `inject()` in `TasksView` to attach to without adding one. A tiny module-level event
 * is the simplest thing that actually connects two unrelated component trees; `useTasksBadge`
 * subscribes on mount and unsubscribes on unmount, same lifecycle discipline as its poll timer.
 */
type Listener = () => void

const listeners = new Set<Listener>()

/** Registers `listener` to be called on every `notifyTasksChanged()`. Returns an unsubscribe
 *  function — callers MUST invoke it on teardown (see `useTasksBadge`'s `onUnmounted`) so a
 *  disposed composable instance is never called back into. */
export function onTasksChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fired after a task mutation the viewer just made succeeds. Safe to call with zero subscribers
 *  (e.g. the badge is not mounted, or is hidden on a public route) — this is a plain notification,
 *  never a queue. */
export function notifyTasksChanged(): void {
  for (const listener of listeners) listener()
}
