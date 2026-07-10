// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service module: UNIT CONVERSION CONFIRMATION (design §"Frontend MVP" view 4).
//
// Converts a PLM design unit into an ERP production-issue unit via a confirmed rule. If no unique
// active rule exists the line enters the exception queue (never a silent guess).
//
// INTERNAL-ONLY writes: the confirm / retire POSTs below are MULTITABLE-INTERNAL row writes against
// the frozen MVP rule table (W3b, plugin-integration-core stock-preparation-confirm-writes.cjs).
// No external ERP/K3 write. Candidates are COMPUTED server-side per read, never bulk-persisted —
// a fingerprint confirm persists the SERVER-derived 1:1 candidate (its values never cross the wire),
// and a manual rule is fully user-entered (OD3/OD4: the server never invents factors).
//
// SERVER-STAMPED confirmation: confirmedBy / confirmedAt are NEVER in any request body — the route
// derives the operator identity and the module stamps the time; a body that carries either is
// rejected as an unknown field. Every body below is built from a CLOSED key set mirroring the
// route's per-endpoint allowlist (mock-is-not-the-contract: both directions pinned in the specs).
//
// VALUES-FREE contract: counts by scope_type / rounding_rule / outcome / reason, booleans, and sha16
// handles (contextFingerprint / conversionRuleId / snapshotBatchId) only. No unit symbols-as-data
// rows, conversion factors, loss rates, or minimum quantities ever cross FROM the server;
// user-ENTERED rule values flow only upward through the closed rule allowlist.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

export type StockPreparationUnitScopeType = 'material' | 'category' | 'generic'

export type StockPreparationRoundingRule = 'none' | 'ceil' | 'floor' | 'nearest' | 'pack_size'

// Fixed FE whitelists mirroring the server's frozen vocabularies
// (stock-preparation-confirm-writes.cjs SCOPE_TYPES / ROUNDING_RULES).
export const STOCK_PREPARATION_UNIT_SCOPE_TYPES: readonly StockPreparationUnitScopeType[] = [
  'material',
  'category',
  'generic',
]

export const STOCK_PREPARATION_ROUNDING_RULES: readonly StockPreparationRoundingRule[] = [
  'none',
  'ceil',
  'floor',
  'nearest',
  'pack_size',
]

// Engine outcome / held-reason vocabularies (stock-preparation-unit-rule-match.cjs).
export type StockPreparationUnitRuleOutcome = 'reused' | 'candidate' | 'held'

export type StockPreparationUnitHeldReason =
  | 'missing_mapping'
  | 'missing_material'
  | 'missing_design_unit'
  | 'missing_issue_unit'
  | 'rule_missing'
  | 'rule_conflict'

export interface StockPreparationUnitConversionSummary {
  totalRuleCount: number
  activeRuleCount: number
  requiresConfirmationCount: number
  scopeTypeCounts: Record<StockPreparationUnitScopeType | string, number>
  roundingRuleCounts: Record<StockPreparationRoundingRule | string, number>
  pendingUnitLineCount: number
}

/**
 * Values-free summary of the unit-conversion-rule table's confirmation state.
 * GET /api/integration/stock-preparation/unit-conversions/summary
 */
export async function getStockPreparationUnitConversionSummary(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationUnitConversionSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/unit-conversions/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationUnitConversionSummary>(response)
}

// ── candidates read (W3c R9 — COMPUTED per read, never persisted) ─────────────────────────────────

/**
 * One computed unit-rule context row. The server STRIPS candidate rule values (unit symbols /
 * factor) — only `hasCandidate` crosses; a candidate row is confirmable via the fingerprint mode.
 */
export interface StockPreparationUnitConversionCandidateRow {
  /** sha16 handle for the computed unit context — the fingerprint confirm mode's identity. */
  contextFingerprint: string | null
  outcome: StockPreparationUnitRuleOutcome | string | null
  reason?: StockPreparationUnitHeldReason | string
  /** Present on `reused` rows: the sha16 handle of the active rule that already covers the context. */
  conversionRuleId?: string
  hasCandidate: boolean
}

export interface StockPreparationUnitConversionCandidateList {
  status: 'ready' | 'pending_confirmation' | 'held' | string
  snapshotBatchId: string
  rowCount: number
  byOutcome: Record<string, number>
  byReason: Record<string, number>
  rows: StockPreparationUnitConversionCandidateRow[]
}

/**
 * Values-free COMPUTED unit-rule candidate list over the latest complete snapshot batch (404 with
 * code CONFIRM_READS_BATCH_NOT_FOUND when the project has no complete batch).
 * GET /api/integration/stock-preparation/unit-conversions/candidates
 */
export async function listStockPreparationUnitConversionCandidates(
  scope: IntegrationScope & { projectId: string; snapshotBatchId?: string | null },
): Promise<StockPreparationUnitConversionCandidateList> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    snapshotBatchId: scope.snapshotBatchId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/unit-conversions/candidates${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationUnitConversionCandidateList>(response)
}

// ── human confirm writes (W3b R10-R11; multitable-internal only) ──────────────────────────────────

/** Values-free per-op evidence: subject kind + mode + target identity (objectId / key-field NAME). */
export interface StockPreparationUnitConfirmEvidence {
  subject: string
  mode: string
  target: { objectId: string; keyField: string }
  valuesFree: boolean
}

// Closed rule-mode key set — EXACT mirror of the route module's RULE_CREATE_ALLOWED_KEYS
// (stock-preparation-confirm-writes.cjs). The body's `rule` object is grounded to these keys so an
// accidental extra property (above all confirmedBy / confirmedAt) can never reach the wire.
const RULE_DRAFT_KEYS = [
  'plmUnit',
  'erpIssueUnit',
  'conversionFactor',
  'scopeType',
  'scopeKey',
  'lossRate',
  'roundingRule',
  'minimumIssueQty',
  'effectiveFrom',
  'effectiveTo',
] as const

/** Fully user-entered rule (OD3/OD4: operators enter values, the server never invents them). */
export interface StockPreparationUnitConversionRuleDraft {
  plmUnit: string
  erpIssueUnit: string
  conversionFactor: number
  scopeType: StockPreparationUnitScopeType
  /** Required for material/category scope; FORBIDDEN for generic scope (server rejects it). */
  scopeKey?: string
  lossRate?: number
  roundingRule?: StockPreparationRoundingRule
  minimumIssueQty?: number
  effectiveFrom?: string
  effectiveTo?: string
}

/**
 * Tri-XOR confirm modes (exactly one of):
 *  - conversionRuleId   — stamp an EXISTING manual-provenance rule row;
 *  - contextFingerprint — persist the SERVER-derived 1:1 candidate for a computed context
 *                         (projectId required: the server recomputes over that project's batch);
 *  - rule               — create a fully user-entered rule.
 */
export type StockPreparationUnitConversionConfirmInput =
  | { conversionRuleId: string; contextFingerprint?: undefined; rule?: undefined }
  | { contextFingerprint: string; projectId: string; snapshotBatchId?: string | null; conversionRuleId?: undefined; rule?: undefined }
  | { rule: StockPreparationUnitConversionRuleDraft; conversionRuleId?: undefined; contextFingerprint?: undefined }

export interface StockPreparationUnitConversionConfirmResult {
  persisted: boolean
  mode: 'confirmed' | 'created' | 'skipped_already_confirmed' | 'skipped_existing'
  conversionRuleId: string | null
  evidence: StockPreparationUnitConfirmEvidence
}

function unitScopeBodyFields(scope: IntegrationScope & { projectId?: string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.tenantId) out.tenantId = scope.tenantId
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  return out
}

function groundRuleDraft(draft: StockPreparationUnitConversionRuleDraft): Record<string, unknown> {
  const source = draft as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of RULE_DRAFT_KEYS) {
    const value = source[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * Human unit-rule confirm — tri-XOR body modes per the route allowlist. confirmedBy / confirmedAt
 * are server-derived and NEVER in the body (the route rejects them as unknown fields). A 409 with
 * code CONFIRM_UNIT_CANDIDATE_NOT_FOUND on the fingerprint mode means the candidate view is STALE
 * (snapshot changed / a rule landed meanwhile) — re-read before confirming.
 * POST /api/integration/stock-preparation/unit-conversions/confirm
 */
export async function confirmStockPreparationUnitConversionRule(
  input: StockPreparationUnitConversionConfirmInput,
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationUnitConversionConfirmResult> {
  const body: Record<string, unknown> = {
    ...unitScopeBodyFields(scope),
    ...(input.conversionRuleId !== undefined ? { conversionRuleId: input.conversionRuleId } : {}),
    ...(input.contextFingerprint !== undefined
      ? {
          contextFingerprint: input.contextFingerprint,
          projectId: input.projectId,
          ...(input.snapshotBatchId ? { snapshotBatchId: input.snapshotBatchId } : {}),
        }
      : {}),
    ...(input.rule !== undefined ? { rule: groundRuleDraft(input.rule) } : {}),
  }
  const response = await apiFetch('/api/integration/stock-preparation/unit-conversions/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationUnitConversionConfirmResult>(response)
}

export interface StockPreparationUnitConversionRetireResult {
  persisted: boolean
  mode: 'retired' | 'skipped_inactive'
  conversionRuleId: string
  evidence: StockPreparationUnitConfirmEvidence
}

/**
 * Retire a unit rule (server patches EXACTLY isActive:false) — required before re-creating a
 * same-scope rule with a different factor (two active same-scope rules fail closed as a conflict).
 * POST /api/integration/stock-preparation/unit-conversions/retire
 */
export async function retireStockPreparationUnitConversionRule(
  input: { conversionRuleId: string },
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationUnitConversionRetireResult> {
  const body: Record<string, unknown> = {
    ...unitScopeBodyFields(scope),
    conversionRuleId: input.conversionRuleId,
  }
  const response = await apiFetch('/api/integration/stock-preparation/unit-conversions/retire', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationUnitConversionRetireResult>(response)
}
