// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: BOM SNAPSHOT BATCH & DIFF (design §"Frontend MVP" view 2).
//
// NAMING: this surface uses 快照批次 / "snapshot batch" (`snapshotBatchId`) deliberately, to avoid
// colliding with the PLM view-state "snapshot" vocabulary and the k3WiseSetup "mapping" vocabulary.
//
// READONLY-FIRST: GET-only, values-free. No overwrite of prior snapshots (design: "Keep old
// snapshots immutable"). No external write, no apply/generate — snapshot/diff read only.
//
// VALUES-FREE contract: only change COUNTS by category, status enums, booleans, and internal
// MetaSheet handles (snapshotBatchId / syncRunId / projectId). No PLM parent/child drawing numbers,
// versions, quantities, path keys, fingerprints, or raw source rows.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationSnapshotBatchStatus = 'draft' | 'active' | 'superseded' | 'rejected'

export interface StockPreparationSnapshotBatchSummary {
  snapshotBatchId: string
  snapshotVersion: number
  snapshotStatus: StockPreparationSnapshotBatchStatus | string
  syncRunId: string | null
  lineCount: number
  createdAtPresent: boolean
  /**
   * Backend completeness flag (#4002): true when the multi-step persist path (batch row → lines →
   * run row) did not finish — zero lines OR no matching run row. Values-free boolean only.
   */
  incomplete: boolean
}

export interface StockPreparationSnapshotBatchListResult {
  projectId: string
  batchCount: number
  batches: StockPreparationSnapshotBatchSummary[]
}

/** Values-free per-change-kind counts between a batch and its immutable predecessor. */
export interface StockPreparationSnapshotDiffSummary {
  snapshotBatchId: string
  baseSnapshotBatchId: string | null
  changeCounts: {
    added: number
    removed: number
    quantityChanged: number
    unitChanged: number
    versionChanged: number
    pathChanged: number
    missingChildBom: number
    fingerprintChanged: number
  }
  blockingExceptionCount: number
}

/**
 * List the immutable BOM snapshot batches for a project (newest batch does not overwrite older ones).
 * GET /api/integration/stock-preparation/snapshot-batches
 */
export async function listStockPreparationSnapshotBatches(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationSnapshotBatchListResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/snapshot-batches${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationSnapshotBatchListResult>(response)
}

/**
 * Values-free diff of a snapshot batch against its immutable predecessor batch.
 * GET /api/integration/stock-preparation/snapshot-batches/:snapshotBatchId/diff
 */
export async function getStockPreparationSnapshotDiff(
  snapshotBatchId: string,
  scope: IntegrationScope = {},
): Promise<StockPreparationSnapshotDiffSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/snapshot-batches/${encodeURIComponent(snapshotBatchId)}/diff${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationSnapshotDiffSummary>(response)
}

// ── Values-free-by-construction diff rows ────────────────────────────────────────────────────────
// The row detail is NOT values-free just because the backend projects a whitelist — the CLIENT must
// re-validate at the boundary, because open string types would let a business value planted in a
// whitelisted field (diffId, keyFingerprint, …) render straight into the DOM. So we parse from
// `unknown`, validate every field against the backend's frozen shape, and DROP any row that fails.
//
// These three vocabularies MUST equal the backend's frozen enums (stock-preparation-snapshot-diff.cjs
// DIFF_TYPES / REVIEW_STATUSES / CHANGE_TYPES) — a bomSnapshotDiff.vocab tripwire pins that so a backend
// vocab change (which would otherwise make the client silently drop every row of the new kind) fails CI.
export const STOCK_PREP_DIFF_TYPES = ['added', 'removed', 'changed', 'unchanged', 'held'] as const
export const STOCK_PREP_REVIEW_STATUSES = ['ready', 'held'] as const
export const STOCK_PREP_CHANGE_TYPES = [
  'added', 'removed', 'quantity_changed', 'unit_changed', 'version_changed', 'path_changed',
  'parent_changed', 'source_fingerprint_changed', 'invalid_qty', 'missing_child_bom',
  'duplicate_path_key', 'missing_path_key',
] as const

export type StockPreparationDiffType = (typeof STOCK_PREP_DIFF_TYPES)[number]
export type StockPreparationDiffReviewStatus = (typeof STOCK_PREP_REVIEW_STATUSES)[number]
export type StockPreparationDiffChangeType = (typeof STOCK_PREP_CHANGE_TYPES)[number]

// Only the fields the UI actually renders are carried, and every one has a TIGHT validator (enum, a
// prefixed handle, a sha16 fingerprint, or a non-negative int) — no loose pattern-matched string
// survives into the client shape. UI-unused envelope fields (reason, snapshot-line ids, path
// fingerprints, batch ids) are dropped at the boundary rather than pattern-matched, so a business value
// in one of them can never be "values-free by a regex" — it simply isn't part of the client contract.
export interface StockPreparationSnapshotDiffRow {
  diffId: string
  diffType: StockPreparationDiffType
  reviewStatus: StockPreparationDiffReviewStatus
  changeTypes: StockPreparationDiffChangeType[]
  rowCount: number
  keyFingerprint: string | null
}

export interface StockPreparationSnapshotDiffRowsResult {
  rowCount: number
  heldRowCount: number
  rows: StockPreparationSnapshotDiffRow[]
}

/** Optional filters mirroring the two server-validated enum query params. */
export interface StockPreparationSnapshotDiffRowsFilters {
  baseSnapshotBatchId?: string | null
  reviewStatus?: StockPreparationDiffReviewStatus | null
  diffType?: StockPreparationDiffType | null
}

// Exact backend shapes: diffId = `stockprep_diff_<16 hex>` (stableDiffId), fingerprint = `sha16:<16 hex>`
// (stableFingerprint). A planted business value matches neither, so it is dropped — and because every
// retained field is one of these tight shapes / an enum / a non-negative int, there is no loose pattern
// left for a value to survive under (owner: REASON_RE / HANDLE_RE removed — those fields are gone).
const DIFF_ID_RE = /^stockprep_diff_[0-9a-f]{16}$/
const FINGERPRINT_RE = /^sha16:[0-9a-f]{16}$/
const INVALID = Symbol('invalid')

/** A malformed envelope (not "zero rows") — the caller turns this into the view's unavailable state. */
export const SNAPSHOT_DIFF_ROWS_MALFORMED = 'SNAPSHOT_DIFF_ROWS_MALFORMED'

const asMatch = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null)
const asNonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
// null/undefined → null (valid absence); present-but-non-matching → INVALID (drop the row).
function asNullableMatch(v: unknown, re: RegExp): string | null | typeof INVALID {
  if (v === null || v === undefined) return null
  const s = asMatch(v, re)
  return s === null ? INVALID : s
}

function parseDiffRow(raw: unknown): StockPreparationSnapshotDiffRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const diffId = asMatch(r.diffId, DIFF_ID_RE)
  if (!diffId) return null
  if (!(STOCK_PREP_DIFF_TYPES as readonly unknown[]).includes(r.diffType)) return null
  if (!(STOCK_PREP_REVIEW_STATUSES as readonly unknown[]).includes(r.reviewStatus)) return null
  if (!Array.isArray(r.changeTypes)) return null
  for (const ct of r.changeTypes) {
    if (!(STOCK_PREP_CHANGE_TYPES as readonly unknown[]).includes(ct)) return null
  }
  const rowCount = asNonNegInt(r.rowCount)
  if (rowCount === null) return null
  const keyFp = asNullableMatch(r.keyFingerprint, FINGERPRINT_RE)
  if (keyFp === INVALID) return null

  return {
    diffId,
    diffType: r.diffType as StockPreparationDiffType,
    reviewStatus: r.reviewStatus as StockPreparationDiffReviewStatus,
    changeTypes: (r.changeTypes as StockPreparationDiffChangeType[]).slice(),
    rowCount,
    keyFingerprint: keyFp,
  }
}

/**
 * Parse the /diff/rows body from `unknown`. Fail-closed at the ENVELOPE level: a malformed envelope (not
 * an object / `rows` not an array) OR **any single invalid row** THROWS a fixed coarse token — the caller
 * surfaces the view's unavailable state. We do NOT silently drop invalid rows: dropping would turn an
 * all-invalid response into a false "no diff rows" and a mixed response into a silently-incomplete table
 * (owner). Only a genuinely valid EMPTY `rows: []` is a real no-diffs result (empty state). When every row
 * is valid, all are returned and rowCount/heldRowCount are computed from them.
 */
export function parseStockPreparationSnapshotDiffRowsResult(raw: unknown): StockPreparationSnapshotDiffRowsResult {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).rows)) {
    throw new Error(SNAPSHOT_DIFF_ROWS_MALFORMED)
  }
  const rows: StockPreparationSnapshotDiffRow[] = []
  for (const rawRow of (raw as Record<string, unknown>).rows as unknown[]) {
    const parsed = parseDiffRow(rawRow)
    if (parsed === null) throw new Error(SNAPSHOT_DIFF_ROWS_MALFORMED) // any invalid row → whole envelope unavailable
    rows.push(parsed)
  }
  return {
    rowCount: rows.length,
    heldRowCount: rows.filter((r) => r.reviewStatus === 'held').length,
    rows,
  }
}

/**
 * Values-free per-row detail for one snapshot batch's diff (view-2 drill-down under the summary).
 * GET /api/integration/stock-preparation/snapshot-batches/:snapshotBatchId/diff/rows
 * `projectId` rides the scope (required server-side); the two enum filters are optional and are
 * validated server-side against the frozen vocabularies. The response is re-validated HERE from
 * `unknown` (parseStockPreparationSnapshotDiffRowsResult) so a malformed / value-bearing row is dropped
 * at the client boundary rather than rendered.
 */
export async function listStockPreparationSnapshotDiffRows(
  snapshotBatchId: string,
  scope: IntegrationScope & { projectId?: string | null } = {},
  filters: StockPreparationSnapshotDiffRowsFilters = {},
): Promise<StockPreparationSnapshotDiffRowsResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    baseSnapshotBatchId: filters.baseSnapshotBatchId,
    reviewStatus: filters.reviewStatus,
    diffType: filters.diffType,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/snapshot-batches/${encodeURIComponent(snapshotBatchId)}/diff/rows${query ? `?${query}` : ''}`,
  )
  const raw = await parseIntegrationResponse<unknown>(response)
  return parseStockPreparationSnapshotDiffRowsResult(raw)
}
