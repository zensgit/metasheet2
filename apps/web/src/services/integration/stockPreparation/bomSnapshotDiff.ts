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
