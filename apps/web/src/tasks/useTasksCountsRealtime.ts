/**
 * Tasks badge realtime invalidation (M4 design §8.2).
 *
 * Subscribes to `tasks:counts-updated`, the per-user push the task feature's socket fan-out sends
 * after a committed write that changed an input of the pending count, to every user who was an
 * assignee before or after the write (the emitter is PR-3c's
 * `packages/core-backend/src/services/task-counts-realtime.ts`, on its Draft branch, not on main;
 * the recipient rule is the pure module `packages/core-backend/src/tasks/task-realtime.ts`). The
 * server joins an authenticated socket to its user room at token verification (the collab
 * service's authenticated-user room); the client sends no join of its own and emits nothing.
 *
 * The payload is a BARE INVALIDATION SIGNAL. Nothing in it is read — not a count, not a task id.
 * `isCountsInvalidation` below is the one place that rule lives, written as a function so a spec
 * can pin it: EVERY value is one signal. The badge re-reads `/pending-count` itself, with its own
 * `x-viewer-time-zone` header, because the server cannot know the viewer's time zone when it
 * emits; a payload-carried count would also bypass `fetchPendingCount`'s `badgeScope` reading and
 * the badge's own generation guard.
 *
 * Socket lifecycle: at most one socket per mount. `ensureSocket()` returns the open socket, or the
 * attempt still in flight (`connectionPromise`), before it opens another. Without a token, or
 * after teardown, it returns null and keeps nothing, so a later `reconnect()` that has a token
 * opens the socket. It opens with `auth: { token }` on the default `path: '/socket.io'`,
 * transports `['websocket', 'polling']`, against the API base with a trailing `/api` segment
 * stripped. Unmount sets the `disconnected` teardown flag and closes the socket; nothing opens one
 * after that. The mount hook connects only when
 * `tasksRealtimePolicy.ts#shouldAutoConnectRealtime()` says so (every build except the test build);
 * the split lets a spec `vi.mock` the policy and make the "no socket while the feature is off" gate
 * a real assertion (§8.2, `[fe-11]`). This composable owns exactly one event contract (no payload
 * to parse) and serves no other subscription.
 *
 * Polling stays: the consumer (`useTasksBadge`) keeps its 60 s clock whether or not this socket is
 * connected (`[fe-08]`), so a dropped or never-opened socket degrades to 60 s freshness, never to
 * a stale badge, and so does a write handled by another backend process (the server's socket
 * adapter is in-process: only sockets on the process that handled the write hear it). The
 * consumer, not this composable, decides when to read: it folds the signals of one window into one
 * read (`[fe-51]`, ruled 2026-10-09). A late event after teardown is dropped here
 * (`disconnected`), so an unmounted badge never triggers a read.
 *
 * The token is read once, when the socket is opened, and socket.io's own reconnect re-sends that
 * same token. A reconnect after the session's token changed may then join no room, and the badge
 * lives on its clock until it is mounted again. An in-app sign-out or sign-in passes through
 * `/login`, a public route, which unmounts the badge: the old socket is closed and the next mount
 * opens one with the new token.
 *
 * Re-checked against PR-3c (M4 design §8.3, slice FE-c): the event name, the per-user room joined
 * by the server, the payload (a new `{}` on every send), the auth path (`auth.token`, the default
 * `/socket.io`) and the emit points match what this file was written to.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'
import { shouldAutoConnectRealtime } from './tasksRealtimePolicy'

// RULED(2026-10-07): [R16] — the event name, the per-user room, "the payload is not read,
// the client re-fetches". One constant, equal to the emitter's, and the only spelling of the name
// in apps/web/src (a source-scan cell pins that), so a rename is a one-line change (§8.3 item 1).
export const TASKS_COUNTS_UPDATED_EVENT = 'tasks:counts-updated'

export interface UseTasksCountsRealtimeOptions {
  /** Called once per received event, with NO arguments — there is nothing to pass. When to read
   *  is the caller's decision (`useTasksBadge` folds a window of signals into one read). */
  onCountsUpdated: () => void
}

function stripApiSuffix(pathname: string): string {
  if (pathname === '/api') return '/'
  if (pathname.endsWith('/api')) return pathname.slice(0, -4) || '/'
  return pathname
}

export function resolveTasksCountsRealtimeBaseUrl(apiBase = getApiBase()): string {
  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8900'
  const url = new URL(apiBase, fallbackOrigin)
  url.pathname = stripApiSuffix(url.pathname)
  return url.toString().replace(/\/$/, '')
}

/**
 * The payload rule, as a function so a spec can pin it: `undefined`, `null`, an object with or
 * without a `count`, a string — every value is exactly one invalidation signal, and nothing in it
 * is read. The parameter exists to document that it is ignored. PR-3c sends `{}` every time
 * (§8.3 item 2); a payload that ever carries fields changes nothing here unless the owner rules
 * otherwise.
 */
export function isCountsInvalidation(_payload: unknown): boolean {
  return true
}

export function useTasksCountsRealtime(options: UseTasksCountsRealtimeOptions) {
  const auth = useAuth()
  let socket: Socket | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null

  function cleanupSocket() {
    socket?.disconnect()
    socket = null
    connectionPromise = null
  }

  async function ensureSocket(): Promise<Socket | null> {
    if (socket) return socket
    if (connectionPromise) return connectionPromise
    // No token, or torn down: return before an attempt exists, so nothing is kept and the next
    // call that has a token opens the socket.
    const token = auth.getToken()
    if (disconnected || !token) return null

    connectionPromise = (async () => {
      try {
        const nextSocket = io(resolveTasksCountsRealtimeBaseUrl(), {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          auth: { token },
        })

        nextSocket.on(TASKS_COUNTS_UPDATED_EVENT, (payload: unknown) => {
          // A real client delivers nothing after `disconnect()`, but the rule must not depend on
          // the transport: an event that lands after teardown must not re-read for a badge that is
          // gone.
          if (disconnected) return
          if (isCountsInvalidation(payload)) options.onCountsUpdated()
        })

        socket = nextSocket
        return nextSocket
      } finally {
        connectionPromise = null
      }
    })()

    return connectionPromise
  }

  onMounted(() => {
    if (shouldAutoConnectRealtime()) void ensureSocket()
  })

  onBeforeUnmount(() => {
    disconnected = true
    cleanupSocket()
  })

  return {
    reconnect: ensureSocket,
    disconnect: cleanupSocket,
  }
}
