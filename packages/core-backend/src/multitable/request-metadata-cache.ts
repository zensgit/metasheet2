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
 *
 * WHAT THIS IS — an `AsyncLocalStorage` scope, entered explicitly by ONE caller (the stock-prep
 * apply writer, once per apply-run request = once per chunk) and exited when that call returns.
 *
 * WHAT THIS IS NOT — a process-wide cache. There is deliberately no module-level Map here:
 *   - it never outlives the async call that opened it, so it cannot be read by a later request;
 *   - it is keyed by `sheetId` (globally unique) so two sheets can never collide, and a scope is
 *     never shared between two concurrent requests — `AsyncLocalStorage` gives each its own store,
 *     which is what keeps this off the tenant-boundary surface entirely;
 *   - it holds SCHEMA metadata only (sheet row, field definitions, "this plugin owns this sheet"),
 *     never record values — values-free.
 *
 * KNOWN, ACCEPTED TRADE-OFF (rare): today each row of a chunk re-reads `meta_fields`, so a field
 * added or dropped mid-chunk is picked up by the very next row. Inside a scope, every row of that
 * one chunk instead sees the snapshot the first row read. The chunk is NOT one transaction (the
 * host wraps each `createRecord` in its own), and no lock held here spans the chunk, so the
 * interleaving is possible and is NOT prevented — it is bounded: at most one chunk's rows, and the
 * next chunk (a separate HTTP request, a separate scope) re-reads. A field DROPPED mid-chunk means
 * the remaining rows of that chunk write a key for a field id that no longer exists instead of
 * failing validation; a field ADDED mid-chunk is simply not populated, exactly as it would not be
 * without the memo. Because that is a real (if tiny) behaviour change, the whole mechanism is
 * OFF unless `MULTITABLE_ENABLE_REQUEST_METADATA_CACHE=true` — with the flag off every accessor
 * below returns `undefined`/passes through and the callers run their original statements.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MultitableField } from './field-codecs'
import type { MultitableSheetRow } from './loaders'

export type MultitableRequestMetadataCache = {
  /** `meta_sheets` rows by sheetId. */
  readonly sheets: Map<string, MultitableSheetRow>
  /** `meta_fields` rows by sheetId. */
  readonly fields: Map<string, MultitableField[]>
  /**
   * `JSON.stringify([pluginName, sheetId])` keys that ALREADY PASSED `assertSheetScope` here.
   * Only successes are recorded — a throw is never memoized, so a denial is re-derived from the
   * registry on the next call rather than cached.
   */
  readonly assertedSheetScopes: Set<string>
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
  return { sheets: new Map(), fields: new Map(), assertedSheetScopes: new Set() }
}

/**
 * Run `operation` with a fresh request-scoped metadata memo. No-op passthrough when the flag is
 * off. A NESTED call reuses the enclosing scope rather than opening a second one: an inner scope
 * could only ever be narrower, and opening one would start a divergent snapshot inside a single
 * request for no benefit.
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
 * is off).
 */
export function getMultitableRequestMetadataCache(): MultitableRequestMetadataCache | undefined {
  if (!isRequestMetadataCacheEnabled()) return undefined
  return storage.getStore()
}
