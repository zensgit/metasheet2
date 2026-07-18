// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service module: MATERIAL MAPPING CONFIRMATION (design §"Frontend MVP" view 3).
//
// Maps PLM drawing/version -> ERP material code/internal id. The MVP NEVER auto-creates ERP material
// codes and NEVER generates final lines from ambiguous candidates — unresolved rows stay pending for
// human confirmation.
//
// INTERNAL-ONLY writes: the confirm / retire / candidate-sync POSTs below are MULTITABLE-INTERNAL
// row writes against the frozen MVP mapping table (W3b, plugin-integration-core
// stock-preparation-confirm-writes.cjs). No external ERP/K3 write, no auto material create.
//
// SERVER-STAMPED confirmation: confirmedBy / confirmedAt are NEVER in any request body — the route
// derives the operator identity and the module stamps the time; a body that carries either is
// rejected as an unknown field. Every body below is built from a CLOSED key set mirroring the
// route's per-endpoint allowlist (mock-is-not-the-contract: both directions pinned in the specs).
//
// VALUES-FREE contract: counts by match_status / version_policy / match_method, booleans, confidence
// scores, and sha16 mappingId handles only. No PLM drawing numbers, versions, material names, specs,
// ERP material codes, or internal ids ever cross FROM the server; user-ENTERED values flow only
// upward through the closed create-mode allowlist.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

export type StockPreparationMatchStatus =
  | 'matched'
  | 'pending_confirm'
  | 'multi_candidate'
  | 'not_found'
  | 'version_conflict'

// OD2 round-1 hardening: `category_rule` was REMOVED from this union and the whitelist below — it
// remains a reserved enum name server-side (stock-preparation-mvp-generation.cjs VERSION_POLICIES)
// with NO implementation branch, and the server now refuses it fail-closed (422
// STOCK_PREPARATION_VERSION_POLICY_UNSUPPORTED). Legacy stored rows carrying it never auto-match
// (they degrade to the visible missing_mapping path); on the read side such a stored value can
// still cross the wire as a plain string (versionPolicyCounts keys / candidate row versionPolicy).
export type StockPreparationVersionPolicy =
  | 'drawing_and_version'
  | 'drawing_only'
  | 'manual'

// Fixed FE whitelists mirroring the server's frozen vocabularies (stock-preparation-material-match /
// -mvp-generation .cjs). The candidates read zero-fills byMatchStatus over exactly the five statuses
// (+ an optional `unknown` fold), and the sync route validates defaultVersionPolicy against exactly
// these three IMPLEMENTED policies (OD2: required per request, no server default).
export const STOCK_PREPARATION_MATCH_STATUSES: readonly StockPreparationMatchStatus[] = [
  'matched',
  'pending_confirm',
  'multi_candidate',
  'not_found',
  'version_conflict',
]

export const STOCK_PREPARATION_VERSION_POLICIES: readonly StockPreparationVersionPolicy[] = [
  'drawing_and_version',
  'drawing_only',
  'manual',
]

// Engine match methods + the confirm-writes manual marker; a junk stored value folds to `unknown`.
export type StockPreparationMatchMethod =
  | 'historical_confirmed'
  | 'exact_code_candidate'
  | 'normalized_code_candidate'
  | 'name_spec_candidate'
  | 'none'
  | 'manual_confirm'

export interface StockPreparationMaterialMappingSummary {
  totalMappingCount: number
  activeMappingCount: number
  matchStatusCounts: Record<StockPreparationMatchStatus | string, number>
  versionPolicyCounts: Record<StockPreparationVersionPolicy | string, number>
  pendingConfirmCount: number
}

/**
 * Values-free summary of the material-mapping table's confirmation state.
 * GET /api/integration/stock-preparation/material-mappings/summary
 */
export async function getStockPreparationMaterialMappingSummary(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationMaterialMappingSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/material-mappings/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationMaterialMappingSummary>(response)
}

// ── candidates read (W3c R4) ──────────────────────────────────────────────────────────────────────

/** One review-queue row: sha16 handle + enums + booleans + confidence score ONLY (values-free). */
export interface StockPreparationMaterialMappingCandidateRow {
  /** sha16 handle — the only row identity the FE ever holds; used for confirm/retire actions. */
  mappingId: string | null
  matchStatus: StockPreparationMatchStatus | 'unknown'
  /** Absent when the stored row carries no method; junk stored values fold to `unknown`. */
  matchMethod?: StockPreparationMatchMethod | 'unknown'
  versionPolicy: StockPreparationVersionPolicy | 'unknown'
  confidence: number | null
  isActive: boolean
  confirmed: boolean
  /** BOTH ERP identifiers present — the precondition for the mappingId confirm mode. */
  hasErpTarget: boolean
  plmVersionPresent: boolean
}

export interface StockPreparationMaterialMappingCandidateList {
  rowCount: number
  /** Zero-filled over the five match statuses; an extra `unknown` key appears only when junk exists. */
  byMatchStatus: Record<string, number>
  rows: StockPreparationMaterialMappingCandidateRow[]
}

/**
 * Values-free mapping review queue (active rows; optional server-side matchStatus filter).
 * GET /api/integration/stock-preparation/material-mappings/candidates
 */
export async function listStockPreparationMaterialMappingCandidates(
  scope: IntegrationScope & { projectId: string; matchStatus?: StockPreparationMatchStatus | null },
): Promise<StockPreparationMaterialMappingCandidateList> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    matchStatus: scope.matchStatus,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/material-mappings/candidates${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationMaterialMappingCandidateList>(response)
}

// ── human confirm writes (W3b R5-R7; multitable-internal only) ────────────────────────────────────

/** Values-free per-op evidence: subject kind + mode + target identity (objectId / key-field NAME). */
export interface StockPreparationConfirmEvidence {
  subject: string
  mode: string
  target: { objectId: string; keyField: string }
  valuesFree: boolean
}

// Closed create-mode key set — EXACT mirror of the route module's MAPPING_CREATE_ALLOWED_KEYS
// (stock-preparation-confirm-writes.cjs). The body's `mapping` object is grounded to these keys so
// an accidental extra property (above all confirmedBy / confirmedAt) can never reach the wire.
const MAPPING_DRAFT_KEYS = [
  'plmDrawingNo',
  'plmVersion',
  'plmMaterialName',
  'plmSpec',
  'erpMaterialCode',
  'erpMaterialInternalId',
  'erpMaterialName',
  'erpSpec',
  'versionPolicy',
  'notes',
] as const

/** Fully operator-specified confirmed mapping (create mode). User-ENTERED values only. */
export interface StockPreparationMaterialMappingDraft {
  plmDrawingNo: string
  plmVersion?: string
  plmMaterialName?: string
  plmSpec?: string
  erpMaterialCode: string
  erpMaterialInternalId: string
  erpMaterialName?: string
  erpSpec?: string
  versionPolicy: StockPreparationVersionPolicy
  notes?: string
}

/** XOR: confirm an EXISTING candidate by handle, or create a fully operator-specified mapping. */
export type StockPreparationMaterialMappingConfirmInput =
  | { mappingId: string; mapping?: undefined; notes?: string }
  | { mapping: StockPreparationMaterialMappingDraft; mappingId?: undefined; notes?: string }

export interface StockPreparationMaterialMappingConfirmResult {
  persisted: boolean
  mode: 'confirmed' | 'created' | 'skipped_already_confirmed' | 'skipped_existing'
  mappingId: string | null
  evidence: StockPreparationConfirmEvidence
}

function groundDraft(keys: readonly string[], draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = draft[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

function scopeBodyFields(scope: IntegrationScope & { projectId?: string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.tenantId) out.tenantId = scope.tenantId
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  return out
}

/**
 * Human mapping confirm — XOR body modes per the route allowlist. confirmedBy / confirmedAt are
 * server-derived and NEVER in the body (the route rejects them as unknown fields).
 * POST /api/integration/stock-preparation/material-mappings/confirm
 */
export async function confirmStockPreparationMaterialMapping(
  input: StockPreparationMaterialMappingConfirmInput,
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationMaterialMappingConfirmResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    ...(input.mappingId !== undefined ? { mappingId: input.mappingId } : {}),
    ...(input.mapping !== undefined
      ? { mapping: groundDraft(MAPPING_DRAFT_KEYS, input.mapping as unknown as Record<string, unknown>) }
      : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  }
  const response = await apiFetch('/api/integration/stock-preparation/material-mappings/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationMaterialMappingConfirmResult>(response)
}

export interface StockPreparationMaterialMappingRetireResult {
  persisted: boolean
  mode: 'retired' | 'skipped_inactive'
  mappingId: string
  evidence: StockPreparationConfirmEvidence
}

/**
 * Retire a mapping (server patches EXACTLY isActive:false) — the recovery path for a wrong confirm.
 * POST /api/integration/stock-preparation/material-mappings/retire
 */
export async function retireStockPreparationMaterialMapping(
  input: { mappingId: string },
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationMaterialMappingRetireResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    mappingId: input.mappingId,
  }
  const response = await apiFetch('/api/integration/stock-preparation/material-mappings/retire', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationMaterialMappingRetireResult>(response)
}

export interface StockPreparationMaterialMappingSyncResult {
  persisted: boolean
  mode: 'created' | 'skipped_existing'
  created: { mappings: number }
  skipped: { existing: number; matched: number }
  status: string
  snapshotBatchId: string
  evidence: Record<string, unknown>
}

/**
 * System candidate sync feeding the review queue (CREATE-ONLY for new mappingIds; a confirmed row is
 * never auto-unconfirmed). defaultVersionPolicy is REQUIRED per request — OD2: no server default,
 * and this service deliberately supplies none either.
 * POST /api/integration/stock-preparation/material-mappings/candidates/sync
 */
export async function syncStockPreparationMaterialMappingCandidates(
  input: { defaultVersionPolicy: StockPreparationVersionPolicy; snapshotBatchId?: string | null },
  scope: IntegrationScope & { projectId: string },
): Promise<StockPreparationMaterialMappingSyncResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    ...(input.snapshotBatchId ? { snapshotBatchId: input.snapshotBatchId } : {}),
    defaultVersionPolicy: input.defaultVersionPolicy,
  }
  const response = await apiFetch('/api/integration/stock-preparation/material-mappings/candidates/sync', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationMaterialMappingSyncResult>(response)
}
