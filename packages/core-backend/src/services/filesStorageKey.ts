/**
 * F3 files-storage-integrity design-lock (2026-07-10), G5 + owner guard E: the controlled runtime
 * fallback that recovers a physical storage key from a `files` row's `url` when its `storage_key` column
 * is empty (an extremely old row the migration backfill did not reach, e.g. because the row's `url` did
 * not match the migration-time baseUrl prefix).
 *
 * Kept a pure, dependency-free module so the accept/reject logic — the security-load-bearing part — is
 * unit-testable with plain strings, independent of HTTP/DB plumbing (mirrors why `filesAcl.ts` is pure).
 *
 * The recovered key is ONLY ever handed to `StorageServiceImpl.downloadByKey`, which re-applies the G2
 * `resolveWithinBase` containment hard-floor — so this function is the fail-FAST first gate (return
 * `null` → the route 404s) and containment is the hard backstop. Both are fail-closed.
 */

const DEFAULT_STORAGE_BASE_URL = 'http://localhost:8900/files'

/**
 * F3 owner guard D/G (poison policy): the sentinel prefix the `add_files_storage_key` migration writes
 * into `storage_key` for a QUARANTINED row — one whose legacy `url` collided with another row's derived
 * key (same-name overwrite, F3-1) or was an unresolvable/traversal url. The full value is
 * `!f3-collision:<id>` (distinct per row → satisfies the partial UNIQUE index). The read path MUST reject
 * this BEFORE any url-fallback or provider call: a quarantined row keeps its original `url`, so letting
 * the runtime fallback re-derive a key from that url would "wash" the poison and re-expose the ambiguous
 * blob. This constant is the single source of truth for that prefix — the migration keeps a matching
 * literal (guarded by a unit test asserting the two are equal).
 */
export const FILES_POISON_KEY_PREFIX = '!f3-collision:'

/** True when a `storage_key` is a migration-written quarantine sentinel (see FILES_POISON_KEY_PREFIX). */
export function isPoisonedStorageKey(storageKey: string | null | undefined): boolean {
  return typeof storageKey === 'string' && storageKey.startsWith(FILES_POISON_KEY_PREFIX)
}

/** Same `STORAGE_BASE_URL || <default>` resolution files.ts's getStorageService uses, trailing-slash
 * trimmed — so the fallback's baseUrl and the live provider's baseUrl are the same value. */
export function getFilesStorageBaseUrl(): string {
  return (process.env.STORAGE_BASE_URL || DEFAULT_STORAGE_BASE_URL).replace(/\/+$/, '')
}

function hasTraversalSegment(value: string): boolean {
  // `..` as a whole PATH SEGMENT (split on both separators), not a substring — so a legit filename like
  // `a..b.txt` is not rejected, but `../x`, `x/..`, `x/../y`, and a bare `..` are.
  return value
    .split(/[/\\]/)
    .some((segment) => segment === '..')
}

/**
 * Owner guard E — controlled fallback. Recovers the relative physical key from `url`, or returns `null`
 * (reject → fail-closed) when the url is not safe to trust:
 *   - not same-origin (does not start with the configured `baseUrl` prefix),
 *   - empty remainder,
 *   - a `..` traversal segment in the RAW remainder,
 *   - a `..` traversal segment in the URL-DECODED remainder (guards `%2e%2e`-style encoded traversal).
 *
 * The returned key is the RAW remainder (files/multitable urls are built by raw `${baseUrl}/${key}`
 * concatenation, never percent-encoded, so the on-disk name matches the raw remainder; the decode step
 * is a rejection guard, not the key derivation). A raw name with a literal `%` that is not valid
 * percent-encoding (e.g. `50%off.pdf`) is tolerated — decode throws, we keep the raw key, and containment
 * remains the hard gate downstream.
 */
export function deriveStorageKeyFromUrl(url: string | null | undefined, baseUrl: string): string | null {
  if (!url || !baseUrl) return null
  const prefix = `${baseUrl.replace(/\/+$/, '')}/`
  if (!url.startsWith(prefix)) return null
  const raw = url.slice(prefix.length)
  if (raw.length === 0) return null
  if (hasTraversalSegment(raw)) return null
  try {
    const decoded = decodeURIComponent(raw)
    if (hasTraversalSegment(decoded)) return null
  } catch {
    // Not valid percent-encoding — a raw legacy filename containing a literal `%`. Keep the raw key;
    // resolveWithinBase (G2) is the hard containment backstop.
  }
  return raw
}
