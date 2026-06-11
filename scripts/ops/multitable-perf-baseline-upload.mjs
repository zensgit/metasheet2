/**
 * Multitable D2 Perf Baseline — seed-upload helpers (S5a harness fix)
 *
 * Extracted, network-free helpers behind the §6 design-delta fix in
 * docs/development/multitable-perf-gate-d2-baseline-verdict-20260525.md:
 * all 50k/100k seed attempts died at ~307s with `TypeError: fetch failed`
 * because Node/undici's DEFAULT `headersTimeout` (300000 ms) fired while the
 * server synchronously processed the XLSX import chunk. The verdict's
 * prescribed harness-side fixes (no packages/core-backend/src/** change):
 *
 *   1. a custom undici dispatcher with headersTimeout/bodyTimeout raised for
 *      the upload (seed) calls ONLY — implemented by createUploadDispatcher();
 *   2. error logging that surfaces `err.cause` (the literal
 *      UND_ERR_HEADERS_TIMEOUT was masked because only `err.message` was
 *      printed) — implemented by formatErrorWithCause().
 *
 * Kept dependency-free so the unit test (multitable-perf-baseline-upload.test.mjs)
 * runs without network and without importing the harness (which exits on
 * missing API_BASE/AUTH_TOKEN at module load).
 */

/** Server cap XLSX_MAX_ROWS=50_000 — a chunk may never exceed it. */
export const XLSX_SERVER_MAX_ROWS = 50_000

/** Default chunk size (= server cap; one upload per 50k rows). */
export const DEFAULT_XLSX_CHUNK_SIZE = 50_000

/**
 * Default seed-upload headers/body timeout: 1800s (≥ the 1800s the operator
 * proved harmless server-side via the moot nginx bump; 6× the undici default
 * 300s wall that killed every ≥50k chunk).
 */
export const DEFAULT_SEED_UPLOAD_TIMEOUT_MS = 1_800_000

/**
 * Resolve XLSX_CHUNK_SIZE from a raw env string.
 * Clamped to [1, XLSX_SERVER_MAX_ROWS]; empty/non-numeric input falls back to
 * the default (the previous inline math propagated NaN for non-numeric input).
 */
export function resolveXlsxChunkSize(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_XLSX_CHUNK_SIZE
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_XLSX_CHUNK_SIZE
  return Math.max(1, Math.min(XLSX_SERVER_MAX_ROWS, n))
}

/**
 * Resolve the seed-upload timeout from a raw env string (SEED_UPLOAD_TIMEOUT_MS).
 * Floored at DEFAULT_SEED_UPLOAD_TIMEOUT_MS so the harness always satisfies the
 * verdict's "≥1800s for upload calls" requirement — operators may only raise it.
 */
export function resolveSeedUploadTimeoutMs(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SEED_UPLOAD_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_SEED_UPLOAD_TIMEOUT_MS
  return Math.max(DEFAULT_SEED_UPLOAD_TIMEOUT_MS, Math.round(n))
}

/**
 * Build the undici Agent options for the seed-upload dispatcher.
 * headersTimeout is THE limit that produced the 307s wall (server returns no
 * response headers until the synchronous per-row import loop finishes);
 * bodyTimeout is raised alongside as the same class of idle limit.
 */
export function buildUploadDispatcherOptions(timeoutMs) {
  const t = resolveSeedUploadTimeoutMs(timeoutMs)
  return { headersTimeout: t, bodyTimeout: t }
}

/**
 * Construct the upload-only dispatcher from an undici Agent constructor.
 * The Agent class is injected (not imported here) so unit tests can assert the
 * applied options with a fake constructor, and so the harness can lazy-import
 * undici only on the seed path (rollback phase stays dependency-light).
 */
export function createUploadDispatcher(AgentCtor, timeoutMs) {
  return new AgentCtor(buildUploadDispatcherOptions(timeoutMs))
}

const MAX_CAUSE_DEPTH = 5

/**
 * Format an error INCLUDING its `cause` chain (and `code` when present).
 * The verdict's evidence caveat: the harness printed only `err.message`
 * ("fetch failed"), masking the underlying UND_ERR_HEADERS_TIMEOUT cause.
 * Depth-capped so cyclic cause chains terminate.
 */
export function formatErrorWithCause(err) {
  const parts = []
  let current = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const code = typeof current === 'object' && current.code ? ` [code=${current.code}]` : ''
    const message =
      current instanceof Error
        ? current.message || String(current)
        : typeof current === 'object'
          ? JSON.stringify(current)
          : String(current)
    parts.push(`${message}${code}`)
    current = typeof current === 'object' ? current.cause : undefined
    if (current !== undefined && current !== null && depth === MAX_CAUSE_DEPTH) {
      parts.push('(cause chain truncated)')
    }
  }
  return parts.join(' ← caused by: ')
}
