/**
 * Minimal pub/sub for "the viewer's task lists changed" (M4 frontend design §4.2, §4.3) — the same
 * shape as `tasksBadgeBus.ts`. A list write that succeeds calls `notifyListsChanged()` — on the list
 * page (`TaskListView`: rename, archive, unarchive), in the sidebar (create) and in the members
 * dialog (transfer, leave), a late ok included (`[fe-23]`, `[fe-32]`); every surface that shows the
 * viewer's lists re-reads on it: the `/tasks` lists sidebar (`TaskListsSidebar`) and the detail
 * page's "my lists" read (`TasksView`). Adding or removing a task, and the other member writes, do
 * not notify. Subscribers register on mount and MUST unsubscribe on unmount, so a disposed
 * component is never called back into.
 *
 * Not the badge bus: the badge does not count lists, and a list change never moves it.
 */
type Listener = () => void

const listeners = new Set<Listener>()

/** Registers `listener` to be called on every `notifyListsChanged()`. Returns the unsubscribe
 *  function. */
export function onListsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fired after a list write the viewer just made succeeds. Safe with zero subscribers — a plain
 *  notification, never a queue. */
export function notifyListsChanged(): void {
  for (const listener of Array.from(listeners)) listener()
}
