/**
 * REQUEST-SCOPED multitable metadata memo (design-large-bom-worker-20260906 §4.1 "L1").
 *
 * WHY THIS EXISTS — measured, not modelled (222, r14, 2026-09-06, CREATE path, 13151 rows /
 * 132 chunks, `pg_stat_user_tables` diffs):
 *   - `meta_fields`                         +26305 seq_scan  ≈ 2 per created row
 *   - `plugin_multitable_object_registry`   +26305 seq_scan  ≈ 2 per created row
 *   - `meta_sheets`                         +39455 idx_scan  ≈ 3 per created row
 * Two of those three `meta_sheets` probes, and BOTH of the `meta_fields` / registry reads, are the
 * SAME constant `sheetId` being re-read: the query segment (`query-service.ts`) and the write
 * segment (`records.ts`) each run their own `loadSheetAndFields`, and `plugin-scope.ts` asserts the
 * sheet scope once per records call. Nothing between two rows of one chunk changes what they
 * return. (The third `meta_sheets` probe is PostgreSQL's own FK check for
 * `meta_records.sheet_id REFERENCES meta_sheets(id)` — structural, not removable here.)
 * Those COUNTS are measured; the SHARE OF WALL-CLOCK they cost is NOT — `pg_stat_statements` is not
 * installed on 222 and installing it means changing PostgreSQL config — so this module removes a
 * measured number of statements, not a measured number of milliseconds.
 *
 * WHAT THIS IS — an `AsyncLocalStorage` scope, entered explicitly by ONE caller today (the
 * stock-prep apply writer, once per apply-run request = once per chunk) and exited when that call
 * returns.
 *
 * WHAT THIS IS NOT — a process-wide cache. There is deliberately no module-level Map here:
 *   - no LATER request can read it: `storage.getStore()` is `undefined` again once the call that
 *     opened the scope returns, and a request that never opened one never had a store at all.
 *     (That is NOT the same as "it never outlives that call", which would be false: a floating
 *     async continuation created INSIDE the scope — a `setTimeout`, an un-awaited promise — keeps
 *     reading this store afterwards, because that is how `AsyncLocalStorage` propagates. No
 *     consumer creates one today: `records.ts` / `query-service.ts` read the memo only on the
 *     awaited path. A background task added inside a scope later would inherit a frozen snapshot,
 *     and the age bound below is what keeps even that finite.)
 *   - two concurrent requests never share one: `AsyncLocalStorage` gives each call its own store,
 *     which is what keeps this off the tenant-boundary surface entirely. That isolation is pinned
 *     by INTERLEAVED-scope tests in `multitable-records.test.ts` and
 *     `multitable-plugin-scope.test.ts` — a module-level `let` + save/restore would pass a serial
 *     test and fail those.
 *   - it holds SCHEMA metadata only (sheet row, field definitions, "this plugin owns this sheet"),
 *     never record values — values-free.
 *   - `sheetId` is the key, and that is sufficient here NOT because the id is unguessable (it is
 *     deterministic: `stableMetaId('sheet', projectId, objectId)` in `provisioning.ts`) but because
 *     a scope never changes database: every consumer inside one scope reads through the same
 *     `poolManager.get()` pool, so one sheetId cannot mean two different rows inside one scope.
 *
 * HARD BOUND — `REQUEST_METADATA_SCOPE_MAX_AGE_MS`. The scope is opened by the CALLER, so "one
 * chunk" is the apply writer's convention, not this module's guarantee: `withMetadataCache` sits on
 * the generic plugin records API and the flag is process-wide, so any plugin could open a scope and
 * hold it open for as long as it likes. To make the window a property of the MECHANISM instead,
 * every scope carries a wall-clock deadline; past it `getMultitableRequestMetadataCache()` returns
 * `undefined` and every consumer falls back to exactly the statements it ran before this change —
 * fields re-read, sheet row re-read, sheet scope re-asserted. So the maximum age of a schema
 * snapshot, and the maximum time an ownership change can go unnoticed, are bounded by this constant
 * no matter who opened the scope or for how long. Expiry degrades; it never throws.
 *
 * KNOWN, ACCEPTED TRADE-OFFS (rare). Today each row of a chunk re-reads the metadata, so a change
 * lands on the very next row. Inside a scope, every row of that one chunk instead sees the snapshot
 * the first row read. The chunk is NOT one transaction (the host wraps each `createRecord` in its
 * own) and no lock held here spans the chunk, so the interleaving is possible and is NOT prevented.
 * It is bounded — one caller scope, and at most `REQUEST_METADATA_SCOPE_MAX_AGE_MS` — and the next
 * chunk is a separate HTTP request and a separate scope. The full list of what a scope can miss
 * mid-chunk:
 *   1. a field DROPPED — the remaining rows write a key for a field id that no longer exists into
 *      `meta_records.data` (jsonb, no FK) instead of failing validation. Neither the UI nor the
 *      export shows it, but the value is in the database.
 *   2. a field ADDED — the remaining rows still reject it, because they validate against the
 *      snapshot. Without the memo that same row would have SUCCEEDED, so this is a real behaviour
 *      change, not a no-op; `multitable-records.test.ts` asserts the rejection.
 *   3. a field RETYPED, or its `property` edited (a `singleSelect` option removed, `number` ->
 *      `string`) — the remaining rows encode and validate by the old rules.
 *   4. the SHEET soft-deleted — `loadSheetRow` filters `deleted_at IS NULL`, so what is memoized is
 *      "this sheet existed and was not soft-deleted at first read". Soft delete does not remove the
 *      row, so `meta_records.sheet_id`'s FK still resolves and the remaining rows of the chunk keep
 *      inserting into a sheet that has just been deleted, instead of failing "Sheet not found".
 *   5. the registry row's OWNER changed, or the sheet unregistered — re-derived on the next scope
 *      rather than on the next row. A REFUSAL is never memoized, so this only delays a NEW refusal.
 * Because those are real (if tiny) behaviour changes, the whole mechanism is OFF unless
 * `MULTITABLE_ENABLE_REQUEST_METADATA_CACHE=true` — with the flag off every accessor below returns
 * `undefined`/passes through and the callers run their original statements.
 *
 * DO NOT, inside a scope: run DDL (`provisioning.ensureFields` and friends) or open a host
 * transaction such as `runStockPreparationPersistUnitOfWork`. The memo is filled by
 * non-transactional reads, so a schema change made inside the scope — or a transaction whose
 * snapshot differs from the one the memo was filled from — would be shadowed by the older snapshot
 * for the rest of the scope. The one caller today does neither: `ensureFields` runs in the plan
 * phase, before apply, and `plugin-scope.ts` deliberately does NOT memoize the `ensureView`
 * assertion.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MultitableField } from './field-codecs'
import type { MultitableSheetRow } from './loaders'

/**
 * Upper bound on how long ONE scope may serve memoized metadata, enforced in
 * `getMultitableRequestMetadataCache()`.
 *
 * Sized from the measurement, not from taste: the largest legal apply chunk is
 * `LARGE_BOM_APPLY_MAX_CHUNK_SIZE = 1000` decisions (`stock-preparation-large-bom-jobs.cjs`) and
 * the measured cost is 47.07ms of server wall-clock per created row, i.e. ~47s for the worst legal
 * chunk. 120s leaves >2x of headroom over that while still turning "as long as the caller likes"
 * into a number. Past the deadline the scope silently stops serving — the caller keeps running,
 * just with the pre-change statements — so a slow chunk loses the speed-up, never correctness.
 * Deliberately NOT env-tunable: a knob for this would let an operator hand the window back to the
 * caller, which is the exact property this constant exists to remove.
 */
export const REQUEST_METADATA_SCOPE_MAX_AGE_MS = 120_000

export type MultitableRequestMetadataCache = {
  /** `meta_sheets` rows by sheetId. */
  readonly sheets: Map<string, MultitableSheetRow>
  /** `meta_fields` rows by sheetId. */
  readonly fields: Map<string, MultitableField[]>
  /**
   * `JSON.stringify([pluginName, sheetId])` keys that ALREADY PASSED `assertSheetScope` here AND
   * were reported by the host as REGISTERED. A throw is never memoized, so a denial is re-derived
   * from the registry on the next call rather than cached — and neither is the host's default
   * `observe`-mode TOLERANCE of an unregistered sheet, which returns normally after logging and
   * would otherwise look exactly like a success from here (see `plugin-scope.ts`).
   */
  readonly assertedSheetScopes: Set<string>
  /** `Date.now()` after which this scope stops serving. See `REQUEST_METADATA_SCOPE_MAX_AGE_MS`. */
  readonly expiresAt: number
}

const storage = new AsyncLocalStorage<MultitableRequestMetadataCache>()

/**
 * Read at call time (never at module load) so a test — or an operator flipping the flag between
 * deploy steps — sees the current value, mirroring `isWriterFenceEnabled` in
 * `canonical-sheet-fence.ts`.
 */
export function isRequestMetadataCacheEnabled(): boolean {
  return (
    String(process.env.MULTITABLE_ENABLE_REQUEST_METADATA_CACHE ?? '').trim().toLowerCase() ===
    'true'
  )
}

function createRequestMetadataCache(): MultitableRequestMetadataCache {
  return {
    sheets: new Map(),
    fields: new Map(),
    assertedSheetScopes: new Set(),
    expiresAt: Date.now() + REQUEST_METADATA_SCOPE_MAX_AGE_MS,
  }
}

/**
 * Run `operation` with a fresh request-scoped metadata memo. No-op passthrough when the flag is
 * off. A NESTED call reuses the enclosing scope rather than opening a second one: an inner scope
 * could only ever be narrower, and opening one would start a divergent snapshot inside a single
 * request for no benefit — and, decisively, re-entering would RESET the deadline, which would hand
 * a caller an unbounded window one nested call at a time.
 */
export async function runWithMultitableRequestMetadataCache<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (!isRequestMetadataCacheEnabled()) return operation()
  if (storage.getStore()) return operation()
  return storage.run(createRequestMetadataCache(), operation)
}

/**
 * The memo for the CURRENT async call, or `undefined` when there is none (the default everywhere:
 * every UI/REST path, every plugin path that did not opt in, and every path at all while the flag
 * is off) — and also `undefined` once the current scope is older than
 * `REQUEST_METADATA_SCOPE_MAX_AGE_MS`, which is what bounds the window for a caller that holds its
 * scope open longer than one request.
 */
export function getMultitableRequestMetadataCache(): MultitableRequestMetadataCache | undefined {
  if (!isRequestMetadataCacheEnabled()) return undefined
  const store = storage.getStore()
  if (!store) return undefined
  if (Date.now() >= store.expiresAt) return undefined
  return store
}
