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

export interface StockPreparationSnapshotDiffRow {
  diffId: string
  diffType: StockPreparationDiffType
  reviewStatus: StockPreparationDiffReviewStatus
  changeTypes: StockPreparationDiffChangeType[]
  reason: string | null
  rowCount: number
  previousSnapshotLineId: string | null
  currentSnapshotLineId: string | null
  keyFingerprint: string | null
  previousPathKeyFingerprint: string | null
  currentPathKeyFingerprint: string | null
}

export interface StockPreparationSnapshotDiffRowsResult {
  snapshotBatchId: string
  baseSnapshotBatchId: string | null
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

// Exact backend handle/fingerprint shapes (stock-preparation-snapshot-diff.cjs / -expansion-snapshot-mapper.cjs):
// diffId = `stockprep_diff_<16 hex>`, snapshot-line id = `stockprep_snapshot_line_<16 hex>`,
// fingerprint = `sha16:<16 hex>`. A planted business value (drawing no / material code / name / qty)
// matches none of these, so it is dropped — this is what makes the client values-free by construction.
const DIFF_ID_RE = /^stockprep_diff_[0-9a-f]{16}$/
const SNAPSHOT_LINE_ID_RE = /^stockprep_snapshot_line_[0-9a-f]{16}$/
const FINGERPRINT_RE = /^sha16:[0-9a-f]{16}$/
const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/ // coarse snake_case code (backend builds it, e.g. matched_path_changed)
const HANDLE_RE = /^[A-Za-z0-9_:.-]{1,128}$/ // conservative bound for the result-level batch handles
const INVALID = Symbol('invalid')

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

  const reason = asNullableMatch(r.reason, REASON_RE)
  if (reason === INVALID) return null
  const prevLine = asNullableMatch(r.previousSnapshotLineId, SNAPSHOT_LINE_ID_RE)
  if (prevLine === INVALID) return null
  const currLine = asNullableMatch(r.currentSnapshotLineId, SNAPSHOT_LINE_ID_RE)
  if (currLine === INVALID) return null
  const keyFp = asNullableMatch(r.keyFingerprint, FINGERPRINT_RE)
  if (keyFp === INVALID) return null
  const prevFp = asNullableMatch(r.previousPathKeyFingerprint, FINGERPRINT_RE)
  if (prevFp === INVALID) return null
  const currFp = asNullableMatch(r.currentPathKeyFingerprint, FINGERPRINT_RE)
  if (currFp === INVALID) return null

  return {
    diffId,
    diffType: r.diffType as StockPreparationDiffType,
    reviewStatus: r.reviewStatus as StockPreparationDiffReviewStatus,
    changeTypes: (r.changeTypes as StockPreparationDiffChangeType[]).slice(),
    reason,
    rowCount,
    previousSnapshotLineId: prevLine,
    currentSnapshotLineId: currLine,
    keyFingerprint: keyFp,
    previousPathKeyFingerprint: prevFp,
    currentPathKeyFingerprint: currFp,
  }
}

/** Parse the /diff/rows body from `unknown`, dropping any row that fails validation. */
export function parseStockPreparationSnapshotDiffRowsResult(raw: unknown): StockPreparationSnapshotDiffRowsResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawRows = Array.isArray(r.rows) ? r.rows : []
  const rows = rawRows.map(parseDiffRow).filter((x): x is StockPreparationSnapshotDiffRow => x !== null)
  const baseId = asNullableMatch(r.baseSnapshotBatchId, HANDLE_RE)
  return {
    snapshotBatchId: asMatch(r.snapshotBatchId, HANDLE_RE) ?? '',
    baseSnapshotBatchId: baseId === INVALID ? null : baseId,
    rowCount: asNonNegInt(r.rowCount) ?? rows.length,
    heldRowCount: asNonNegInt(r.heldRowCount) ?? 0,
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
