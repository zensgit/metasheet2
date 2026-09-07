// 首页目录读的节流包装 (P0-2/P0-9 补项 · U2 契约) — the ONE fetch StockPreparationProjectBoardView.vue's
// home-page mount issues.
//
// WHAT THIS IS FOR. The home page's cards, three-sentence banner and per-row timestamps all read the
// U2 union (设计稿 N1/N2: `?includePullTargets=1&includePendingCounts=1`). That union is a full-sheet
// scan on the server (see the plugin module's own header) and must not be paid on every mount/re-render
// of the tab that composes the home page — a tab flick or a fast re-render within the same operator
// session must not double the request. This module is that ONE caller's throttle: at most one LIVE
// request per (tenantId, workspaceId) scope every `THROTTLE_WINDOW_MS`; a call inside the window reuses
// the in-flight or just-settled promise instead of issuing a second fetch.
//
// WHAT THIS IS NOT FOR. The confirmation queue's OWN directory read
// (`readStockPreparationOperatorDirectory` called directly, unwrapped, un-opted-in) is UNCHANGED — it
// is a different caller with a different (values-free-by-default) need, and routing it through this
// cache would be a silent behaviour change nobody asked for. This wrapper has exactly one caller.
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
 * 首页那一次目录读. Always opts into both U2 flags — the home page's banner and per-row timestamps
 * need the union unconditionally, so there is no partial-opt-in variant of this function.
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
