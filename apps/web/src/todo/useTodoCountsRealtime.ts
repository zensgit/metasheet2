/**
 * Todo Center realtime counts (B-2 phase 2, todo-center-design-lock v2.14 §4).
 *
 * Subscribes to `todo:counts-updated` — the push `services/todo-realtime.ts`'s
 * `publishTodoCountsUpdate` fires by calling `pendingSourceRegistry.countPendingForUser`, the EXACT
 * SAME registry method `GET /api/todo/count` reads (see that backend module's own docblock). This
 * is what makes the switch away from `approval:counts-updated` correct rather than merely
 * different: that event is computed by `approval-realtime.ts`'s `computeApprovalPendingCounts`, a
 * pre-existing, KNOWN-DIVERGENT second copy of the pending predicate (it omits the handler-node
 * exclusion `approval-pending-query.ts` carries — the exact defect class B-1's fix-round P1-1
 * removed an earlier `todo:counts-updated` wiring for). Subscribing this badge to BOTH events would
 * re-admit that divergence into the rendered number; this module and `ApprovalTodoBadge.vue` use
 * ONLY this one.
 *
 * Copied WHOLE (socket lifecycle, `import.meta.env.MODE !== 'test'` mount guard, the
 * `connectionPromise` de-duplication, the `disconnected` teardown flag) from
 * `approvals/useApprovalCountsRealtime.ts` rather than re-derived — those are all load-bearing:
 * dropping the MODE guard would make every spec that mounts a component using this composable
 * (including every spec importing `App.vue`) open a real socket under vitest.
 *
 * NOT merged into `useApprovalCountsRealtime`: the two events carry different contracts —
 * `todo:counts-updated`'s payload is `{ count, sources }` (per pending-SOURCE-NAME status, e.g.
 * `{ approval: 'ok' }`), `approval:counts-updated`'s is `{ count, unreadCount,
 * countsBySourceSystem }` (per approval SOURCE-SYSTEM bucket: platform/plm/all). A shared composable
 * would have to branch on payload shape internally; two small modules that each own one wire format
 * is simpler than one that owns two.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'
import type { PendingSourceStatus } from './api'

export interface TodoCountsUpdatedPayload {
  count: number
  sources: Record<string, PendingSourceStatus>
  /** See `todo/api.ts`'s `TodoCountResponse` note: not emitted by the backend today, carried
   *  through so a future emitter does not require a second normalizer. */
  degraded?: boolean
  reason?: string
  updatedAt?: string
}

interface UseTodoCountsRealtimeOptions {
  onCountsUpdated: (payload: TodoCountsUpdatedPayload) => void
}

function stripApiSuffix(pathname: string): string {
  if (pathname === '/api') return '/'
  if (pathname.endsWith('/api')) return pathname.slice(0, -4) || '/'
  return pathname
}

export function resolveTodoCountsRealtimeBaseUrl(apiBase = getApiBase()): string {
  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8900'
  const url = new URL(apiBase, fallbackOrigin)
  url.pathname = stripApiSuffix(url.pathname)
  return url.toString().replace(/\/$/, '')
}

function normalizeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** `null` if `value` is not an object, or if ANY entry's status is not one of the two known
 *  strings — a push half-shaped like the real contract is not "mostly trustworthy", it is
 *  malformed, same verdict as a push with no `sources` at all. */
function normalizeSources(value: unknown): Record<string, PendingSourceStatus> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const sources: Record<string, PendingSourceStatus> = {}
  for (const [source, status] of Object.entries(record)) {
    if (status !== 'ok' && status !== 'unavailable') return null
    sources[source] = status
  }
  return sources
}

/**
 * `null` for anything that does not match the contract, rather than a best-effort partial
 * reconstruction. A push missing `sources` or carrying a non-numeric `count` must not become a
 * THIRD way to show "不可用" alongside the two `ApprovalTodoBadge.vue`'s 判据 B already covers (a
 * thrown REST read, an explicit `degraded`/`unavailable` response body) — the caller simply never
 * fires for it, exactly as `useApprovalCountsRealtime`'s own `normalizePayload` does for its shape.
 */
function normalizePayload(payload: unknown): TodoCountsUpdatedPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const count = normalizeCount(record.count)
  const sources = normalizeSources(record.sources)
  if (count === null || sources === null) return null
  return {
    count,
    sources,
    degraded: record.degraded === true,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

export function useTodoCountsRealtime(options: UseTodoCountsRealtimeOptions) {
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

    connectionPromise = (async () => {
      try {
        const token = auth.getToken()
        if (disconnected || !token) return null

        const nextSocket = io(resolveTodoCountsRealtimeBaseUrl(), {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          auth: { token },
        })

        nextSocket.on('todo:counts-updated', (payload: unknown) => {
          const normalized = normalizePayload(payload)
          if (normalized) options.onCountsUpdated(normalized)
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
    if (import.meta.env.MODE !== 'test') void ensureSocket()
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
