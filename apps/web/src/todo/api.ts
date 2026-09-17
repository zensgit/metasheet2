/**
 * Todo Center API Client (B-2 phase 2, todo-center-design-lock §3/§4).
 *
 * Typed wrappers over the aggregation endpoints B-1 shipped:
 *   GET /api/todo/items  — the grouped-by-source pending list (no body content, id + display
 *                            fields only, per lock §3 "不带正文").
 *   GET /api/todo/count  — the aggregate count the top-nav badge renders.
 *
 * Both responses carry a `sources` map (`'ok' | 'unavailable'` per registered source name) so a
 * caller can tell "zero pending" apart from "this source's own query failed" — lock §3's
 * fail-closed-and-discriminable hard constraint. Neither wrapper collapses that map: it is handed
 * through verbatim for the view/badge to render.
 *
 * `degraded` on `TodoCountResponse` mirrors the shape the PRE-EXISTING
 * `/api/approvals/pending-count` badge path already emits (`routes/approvals.ts` schema-error
 * fallback, `{ count: 0, unreadCount: 0, degraded: true }`) — the todo-center-design-lock's badge
 * criterion (§4/判据 B) requires the badge to treat `degraded: true` as equivalent to "unavailable"
 * even though `/api/todo/count` itself cannot yet emit it (no source registered today reaches that
 * branch; the lock notes it is double-gated by `APPROVALS_OPTIONAL` and unreachable in the test
 * lane). The field stays optional and forward-looking rather than invented-and-asserted: nothing
 * here claims the backend sends it, only that a caller that DOES see it must not treat it as `0`.
 */
import { apiGet } from '../utils/api'

export type PendingSourceStatus = 'ok' | 'unavailable'

export interface PendingItem {
  source: string
  id: string
  title: string
  dueAt?: string | null
  href: string
  updatedAt: string
  /** Domain-specific: true when the viewer's own action would be accepted right now. Absent for a
   *  source that has no such notion (lock §5 判据 C′). */
  actionable?: boolean
}

export interface TodoItemsResponse {
  items: PendingItem[]
  sources: Record<string, PendingSourceStatus>
}

export interface TodoCountResponse {
  count: number
  sources: Record<string, PendingSourceStatus>
  /** See file-level note: not emitted by `/api/todo/count` today, but the badge must treat it as
   *  "unavailable" rather than ignore it if it ever is. */
  degraded?: boolean
}

export async function getTodoItems(): Promise<TodoItemsResponse> {
  return apiGet('/api/todo/items')
}

export async function getTodoCount(): Promise<TodoCountResponse> {
  return apiGet('/api/todo/count')
}

/**
 * True when the response signals the caller should render a discriminable "unavailable" state
 * rather than trust the numeric count/list at face value — either the legacy `degraded` flag or
 * any registered source reporting `unavailable`. Centralized here so the badge and the center page
 * apply the identical rule (lock §3: the center must not invent a second judgment of its own, and
 * that includes not letting two call sites diverge on what "not really ok" means).
 */
export function isTodoResponseDegraded(response: { degraded?: boolean; sources: Record<string, PendingSourceStatus> }): boolean {
  if (response.degraded === true) return true
  return Object.values(response.sources).some((status) => status === 'unavailable')
}
