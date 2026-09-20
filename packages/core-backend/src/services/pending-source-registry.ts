/**
 * 待办中心 v1 首切片 — `PendingSourceRegistry` (todo-center-design-lock §3/§4).
 *
 * The todo center is a pure projection: it does not own a table and does not judge visibility
 * itself. Each domain (approval today; comment / task / e-learning in later slices, per the lock's
 * §2 accession table) registers ONE source exposing its own "what is pending for this viewer" and
 * "how many" queries; the registry only aggregates.
 *
 * Fail-closed AND discriminable (lock §3 hard constraint): a source that throws must not crash the
 * whole response, must not silently read as "zero pending", and must not be reported as visible —
 * it is marked `unavailable` in the per-source status map, the other sources' results are
 * unaffected, and the caller (routes/todo.ts) always answers 200 so a genuine "zero, checked" state
 * (`ok` + 0) stays distinguishable from "could not check" (`unavailable`).
 */

import { Logger } from '../core/logger'
import { getRequestContext } from '../context/request-context'

export interface PendingItem {
  source: string
  id: string
  title: string
  dueAt?: string | null
  href: string
  updatedAt: string
  /** Domain-specific: true when the viewer's own action would be accepted right now (approval
   *  source only, for the current slice — see `approval-pending-source.ts`). Absent for a source
   *  that has no such notion. */
  actionable?: boolean
}

/** The three-input viewer contract §3.0 pins for the approval source; used as the ONE shape every
 *  registered source is handed today. A future source needing a different projection of the viewer
 *  widens this type rather than each source inventing its own — see the lock's §3 "不得自行判断可见
 *  性,也不得自己拼第二份 pending 谓词" constraint. */
export interface PendingViewer {
  actorId: string
  roles: string[]
  permissions: string[]
}

export type PendingSourceStatus = 'ok' | 'unavailable'

export interface PendingSource {
  name: string
  listPendingForUser(viewer: PendingViewer): Promise<PendingItem[]>
  /** Optional per §3: "缺省由 list 派生" — when absent, the registry counts `listPendingForUser`'s
   *  result length instead of issuing a second query. */
  countPendingForUser?(viewer: PendingViewer): Promise<number>
}

export interface PendingItemsResult {
  items: PendingItem[]
  sources: Record<string, PendingSourceStatus>
}

export interface PendingCountResult {
  count: number
  sources: Record<string, PendingSourceStatus>
}

const logger = new Logger('PendingSourceRegistry')

/** Structured, value-free failure signal for a source's fail-closed catch (acceptance finding F-2,
 *  `todo-center-real-browser-acceptance-20260920.md` §6 P2: two bare `catch` blocks below had zero
 *  logging, so a source outage was invisible to the backend). Logs the failing source's name, the
 *  request's org (tenant) when known, and the error's `message`/`code` — never the error's stack or
 *  any query result — so an outage becomes observable without widening what a degraded response can
 *  leak to the client. Purely an operational signal: the fail-closed return shape
 *  (`sources[name] = 'unavailable'`) and every existing degradation assertion are unchanged. */
function logSourceFailure(op: 'list' | 'count', sourceName: string, error: unknown): void {
  const rawCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  logger.warn(`Pending source '${sourceName}' failed to ${op} pending items; reporting unavailable`, {
    sourceId: sourceName,
    org: getRequestContext()?.tenantId,
    error: error instanceof Error ? error.message : String(error),
    code: typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined,
  })
}

export class PendingSourceRegistry {
  private readonly sources = new Map<string, PendingSource>()

  /** Idempotent by source name — re-registering (e.g. once per server instance in tests) replaces
   *  rather than duplicates. */
  register(source: PendingSource): void {
    this.sources.set(source.name, source)
  }

  /** Test-only escape hatch: a suite that wants a clean registry (e.g. to register a
   *  deliberately-throwing stub for criterion B) can reset before registering its own sources. */
  clear(): void {
    this.sources.clear()
  }

  async listPendingForUser(viewer: PendingViewer): Promise<PendingItemsResult> {
    const items: PendingItem[] = []
    const sources: Record<string, PendingSourceStatus> = {}
    for (const source of this.sources.values()) {
      try {
        const sourceItems = await source.listPendingForUser(viewer)
        items.push(...sourceItems)
        sources[source.name] = 'ok'
      } catch (error) {
        // Fail-closed: this source contributes nothing and is flagged `unavailable`, never folded
        // into "zero pending" and never allowed to 500 the aggregate response.
        logSourceFailure('list', source.name, error)
        sources[source.name] = 'unavailable'
      }
    }
    return { items, sources }
  }

  async countPendingForUser(viewer: PendingViewer): Promise<PendingCountResult> {
    let count = 0
    const sources: Record<string, PendingSourceStatus> = {}
    for (const source of this.sources.values()) {
      try {
        if (source.countPendingForUser) {
          count += await source.countPendingForUser(viewer)
        } else {
          const sourceItems = await source.listPendingForUser(viewer)
          count += sourceItems.length
        }
        sources[source.name] = 'ok'
      } catch (error) {
        logSourceFailure('count', source.name, error)
        sources[source.name] = 'unavailable'
      }
    }
    return { count, sources }
  }
}

/** Process-wide singleton — registered against in `index.ts` at server-setup time (mirrors every
 *  other route-level singleton service in this codebase) and consumed by `routes/todo.ts`. */
export const pendingSourceRegistry = new PendingSourceRegistry()
