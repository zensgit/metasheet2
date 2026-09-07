// 首页目录读的节流包装 (P0-2/P0-9 补项 · U2 契约) — the fetch StockPreparationProjectBoardView.vue
// issues WHEN, AND ONLY WHEN, it is showing 今天要处理.
//
// WHAT THIS IS FOR. The home page's cards and its three-sentence banner read the U2 union (设计稿
// N1/N2: `?includePullTargets=1&includePendingCounts=1`) — the union is what adds the projects that
// exist only as self-service pull targets, and the three top-level flags are what the banner says or
// stays quiet about. That union is a full-sheet, LIMIT/OFFSET-paged scan on the server (the plugin
// module's own header states the cost and the owner's ruling on who may be charged it) and must not be
// paid on every mount/re-render of the tab that composes the home page — a tab flick or a fast
// re-render within the same operator session must not double the request. This module is that
// caller's throttle: at most one LIVE request per (tenantId, workspaceId) scope every
// `THROTTLE_WINDOW_MS`; a call inside the window reuses the in-flight or just-settled promise instead
// of issuing a second fetch.
//
// WHAT THIS IS NOT FOR — TWO CALLERS THAT MUST KEEP PAYING NOTHING.
//   * 项目备料页. The SAME component file renders the workspace, and the owner ruled that the union's
//     cost 「may not be charged to every home-page open and every board mount」 — the board runs its own
//     narrowed pull-target read and must not also run an unnarrowed one. Its directory read therefore
//     goes straight to `readStockPreparationOperatorDirectory`, un-opted-in, un-throttled, exactly as
//     it did before this pass. See that file's `loadDirectory`.
//   * The confirmation queue's OWN directory read — a different caller with a different
//     (values-free-by-default) need; routing it through this cache would be a silent behaviour change
//     nobody asked for.
//
// The throttle key is the SCOPE, not the principal, and entries outlive the components that made them
// (module-level Map). That is fine for a 5-second window on a page one person is looking at; it is not
// a session cache and must not grow into one.
import type { IntegrationScope } from '../workbench'
import {
  readStockPreparationOperatorDirectory,
  type StockPreparationOperatorDirectory,
} from './confirmationQueue'

/** 设计稿 §6.1 补项 4c: "同一 scope 5 秒内不重复发目录请求". */
const THROTTLE_WINDOW_MS = 5000

interface ThrottleEntry {
  /** `Date.now()` at the moment the live request was ISSUED — not when it settled. */
  at: number
  promise: Promise<StockPreparationOperatorDirectory>
}

const cache = new Map<string, ThrottleEntry>()

function scopeKey(scope: IntegrationScope): string {
  return `${scope.tenantId ?? ''}::${scope.workspaceId ?? ''}`
}

/**
 * 首页那一次目录读. Always opts into both U2 flags — the home page's banner and its card list need the
 * union unconditionally, so there is no partial-opt-in variant of this function. Callers that must NOT
 * pay for the union call `readStockPreparationOperatorDirectory` directly instead of reaching for a
 * flag here.
 *
 * A window is not extended by a call landing inside it: the clock is set once, at the moment the LIVE
 * request goes out, so a burst of calls inside `THROTTLE_WINDOW_MS` all resolve together and the next
 * caller after the window re-fetches — it does not need to wait out a fresh 5s from its own call.
 *
 * A FAILED read does not poison the window: the cache entry is dropped on rejection so the very next
 * caller retries immediately rather than replaying the same failure for up to 5s.
 */
export function readStockPreparationOperatorHomeDirectory(
  scope: IntegrationScope,
): Promise<StockPreparationOperatorDirectory> {
  const key = scopeKey(scope)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < THROTTLE_WINDOW_MS) return hit.promise
  const promise = readStockPreparationOperatorDirectory(scope, {
    includePullTargets: true,
    includePendingCounts: true,
  })
  cache.set(key, { at: now, promise })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

/**
 * Test seam ONLY. Clears every throttle window so specs that mount the home page's directory read
 * more than once do not silently reuse an earlier test's fetch (and, symmetrically, so a dedicated
 * throttle test starts from a clean slate). Never called from application code.
 */
export function resetStockPreparationOperatorHomeDirectoryThrottle(): void {
  cache.clear()
}
