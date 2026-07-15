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

/**
 * One values-free diff ROW (the per-row drill-down under the summary). The backend projects a FROZEN
 * whitelist (stock-preparation-snapshot-reads.cjs `DIFF_ROW_KEYS`): opaque MetaSheet handles
 * (diffId / snapshot-line ids), enum vocabularies (diffType / reviewStatus / changeTypes), a coarse
 * `reason` code, a `rowCount`, and SHA-16 FINGERPRINTS. The fingerprints are one-way hashes of the
 * key / path-key — NOT the raw path keys, drawing numbers, quantities, or units — so they stay within
 * the values-free contract (opaque handles), unlike the raw values that never cross this boundary.
 */
export type StockPreparationDiffReviewStatus = 'pending' | 'held' | 'accepted' | string
export type StockPreparationDiffType = 'added' | 'removed' | 'changed' | string

export interface StockPreparationSnapshotDiffRow {
  diffId: string
  diffType: StockPreparationDiffType
  reviewStatus: StockPreparationDiffReviewStatus
  changeTypes: string[]
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

/**
 * Values-free per-row detail for one snapshot batch's diff (view-2 drill-down under the summary).
 * GET /api/integration/stock-preparation/snapshot-batches/:snapshotBatchId/diff/rows
 * `projectId` rides the scope (required server-side); the two enum filters are optional and are
 * validated server-side against the frozen vocabularies (a bad value → values-free 400 with the field
 * name only), so the client passes them straight through.
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
  return parseIntegrationResponse<StockPreparationSnapshotDiffRowsResult>(response)
}
