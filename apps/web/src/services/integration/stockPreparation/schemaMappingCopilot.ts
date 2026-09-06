// 列映射副驾 (schema-mapping copilot) — FRONTEND SERVICE.
//
// THE ONE THING TO REMEMBER: the AI PROPOSES, a human CONFIRMS, and the CONFIRMED PRESET is the
// authoritative artifact. `proposeSchemaMapping` returns SUGGESTIONS ONLY (never a preset);
// `confirmSchemaMapping` is the only call that yields a preset, and only from what the human confirmed.
//
// FAIL-OPEN mirror of the backend: a propose response with `aiAvailable: false` is NOT an error — the
// AI enhancement is simply absent and the panel falls back to the deterministic hints for manual
// mapping. Only a transport / envelope failure throws.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const SCHEMA_MAPPING_COPILOT_PROPOSE_ROUTE = '/api/integration/stock-preparation/schema-mapping-copilot/propose'
export const SCHEMA_MAPPING_COPILOT_CONFIRM_ROUTE = '/api/integration/stock-preparation/schema-mapping-copilot/confirm'

// ---------------------------------------------------------------------------
// Request shapes — the discovered schema signals a human would stare at.
// ---------------------------------------------------------------------------

export interface SchemaMappingColumnInput {
  id: string
  name: string
  /** Optional values-free sample shape; raw samples are scrubbed server-side. */
  sampleShape?: { nonNullRatio?: number; distinctRatio?: number; numericRatio?: number; maxLength?: number }
}

export interface SchemaMappingDictionaryRow {
  columnName: string
  label: string
  type?: string
  enabled?: boolean
}

export interface SchemaMappingSignalsInput {
  tableNames: string[]
  columns: SchemaMappingColumnInput[]
  dictionaryRows: SchemaMappingDictionaryRow[]
}

// ---------------------------------------------------------------------------
// Response shapes.
// ---------------------------------------------------------------------------

export interface SchemaMappingDeterministicHint {
  family: string | null
  dictLabel: string | null
  labelHint: string | null
  isGenericSlot: boolean
}

/** One per-column proposal — the AI half is clearly separable from the deterministic half. */
export interface SchemaMappingProposal {
  id: string
  column: string | null
  aiMeaning: string | null
  aiSemantic: string | null
  aiReasoning: string | null
  aiConfidence: 'low' | 'medium' | 'high' | null
  deterministic: SchemaMappingDeterministicHint
  groundedByDiscovery: boolean
  agreesWithDiscovery: boolean | null
}

export interface SchemaMappingProvenance {
  aiGenerated?: boolean
  advisory?: boolean
  providerTier?: string
  provider?: string
  model?: string
}

export interface SchemaMappingCitation {
  id: string
  label?: string
  referenced: boolean
}

/** A base semanticExpectation from the detected vendor family — a valid, complete confirm seed. */
export interface SchemaMappingBaseExpectation {
  semantic: string
  locus: 'dictionary-assigned-column' | 'native-column'
  columnFamily?: string
  dictionary?: string
  dictionaryTypeHint?: 'numeric' | 'list' | 'text'
  labelHint?: 'quantity' | 'unit' | 'material-code'
  role?: string
  roleColumn?: string
  note?: string
}

export interface SchemaMappingProposalResult {
  aiAvailable: boolean
  reason: string | null
  message: string | null
  manualFallback: boolean
  familyDetection: { presetId: string | null; reason: string }
  presetId: string | null
  baseSemanticExpectations: SchemaMappingBaseExpectation[]
  proposals: SchemaMappingProposal[]
  aiSuggestionText?: string
  aiParseError?: boolean
  citations: SchemaMappingCitation[]
  provenance: SchemaMappingProvenance | null
  scrubbedCount: number
  /** STRUCTURAL: a proposal NEVER carries an authoritative preset — the AI output is not applied. */
  authoritativePreset: null
}

/** The provenance a human sets on each confirmed semantic. */
export type SchemaMappingSemanticSource = 'ai-suggested' | 'human-set'

export interface SchemaMappingConfirmedSemantic {
  semantic: string
  locus: 'dictionary-assigned-column' | 'native-column'
  columnFamily?: string
  dictionary?: string
  dictionaryTypeHint?: 'numeric' | 'list' | 'text'
  labelHint?: 'quantity' | 'unit' | 'material-code'
  role?: string
  roleColumn?: string
  note?: string
  source: SchemaMappingSemanticSource
}

export interface SchemaMappingConfirmResult {
  preset: Record<string, unknown>
  provenance: {
    confirmedBy: string
    confirmedAt: string
    fields: Array<{ semantic: string; source: SchemaMappingSemanticSource }>
    aiSuggested: number
    humanSet: number
  }
  aiFieldCount: number
  humanFieldCount: number
}

// ---------------------------------------------------------------------------
// Transport.
// ---------------------------------------------------------------------------

class SchemaMappingCopilotRequestError extends Error {
  code: string
  status: number
  field?: string
  constructor(message: string, code: string, status: number, field?: string) {
    super(message)
    this.name = 'SchemaMappingCopilotRequestError'
    this.code = code
    this.status = status
    if (field) this.field = field
  }
}

export { SchemaMappingCopilotRequestError }

async function postEnvelope<T>(route: string, scope: IntegrationScope, body: Record<string, unknown>): Promise<T> {
  const suffix = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const url = suffix ? `${route}?${suffix}` : route
  const response = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let payload: IntegrationApiEnvelope<T> | undefined
  try {
    payload = (await response.json()) as IntegrationApiEnvelope<T>
  } catch {
    throw new SchemaMappingCopilotRequestError('COPILOT_RESPONSE_NOT_JSON', 'COPILOT_RESPONSE_NOT_JSON', response.status)
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const code = (payload && payload.error && payload.error.code) || 'COPILOT_REQUEST_FAILED'
    // Values-free: we surface the clamped code + field NAME, never the raw error message.
    const field = payload && payload.error && payload.error.details && typeof payload.error.details.field === 'string'
      ? (payload.error.details.field as string)
      : undefined
    throw new SchemaMappingCopilotRequestError(code, code, response.status, field)
  }
  return (payload.data ?? {}) as T
}

/**
 * Ask the copilot to PROPOSE per-column meanings. The result is advisory — `aiAvailable: false` means
 * the boundary was off/absent and the caller falls back to the deterministic hints (manual mapping).
 */
export async function proposeSchemaMapping(
  scope: IntegrationScope,
  signals: SchemaMappingSignalsInput,
): Promise<SchemaMappingProposalResult> {
  return postEnvelope<SchemaMappingProposalResult>(SCHEMA_MAPPING_COPILOT_PROPOSE_ROUTE, scope, { signals })
}

/**
 * Write the human-confirmed semantics into a DETERMINISTIC vendor preset (the authoritative artifact).
 * `confirmedBy` is SERVER-STAMPED — never sent from here. A confirmation that fails deterministic
 * validation throws with the coded reason (the panel surfaces it; nothing is applied).
 */
export async function confirmSchemaMapping(
  scope: IntegrationScope,
  input: { presetId: string; confirmedSemantics: SchemaMappingConfirmedSemantic[] },
): Promise<SchemaMappingConfirmResult> {
  return postEnvelope<SchemaMappingConfirmResult>(SCHEMA_MAPPING_COPILOT_CONFIRM_ROUTE, scope, {
    presetId: input.presetId,
    confirmedSemantics: input.confirmedSemantics,
  })
}
