// Read-source resolver composition — client service layer + vocabulary mirror (C-R4-2 / C-R4-3a, #1709).
//
// C-R4-3a adds the runtime-tier service calls (list approved compositions + run an approved chain) and a
// VALUES-FREE client normalizer for the run response. The server already returns values-free chain
// evidence + a last-hop-only data payload; this normalizer is defense-in-depth — it copies ONLY the
// allowlisted shape (ok / failedStep / a bounded per-step vector of {step, ok, rule?, errorCode?} /
// coarse errorCode via the mirror / values-free planErrors triples) and drops anything else a response
// might carry. It never fabricates or widens the data plane.
//
// The composition chain-evidence coarse codes are the SERVER's closed vocabulary
// (plugins/plugin-integration-core/lib/read-source-composition-planner.cjs
// READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES). They surface in the run route's values-free chain evidence
// (evidence.errorCode + per-step steps[].errorCode) that the C-R4-3 composition UI renders. This module
// mirrors them client-side so the UI can label/branch on a known enum instead of a raw string.
//
// Source of truth = the server. If the server ever extends the vocabulary and this mirror is not synced,
// the client silently drops the new value. The parity tripwire
// (apps/web/tests/composition-vocab-mirror.spec.ts) fails RED the moment the two diverge — sync this
// module (and any C-R4-3 UI/tests) whenever it does. Same discipline as the resolver mirror in
// readSourceConfigs.ts + multitable-resolver-vocab-mirror.spec.ts.

import { apiFetch } from '../../utils/api'
import type { IntegrationScope } from './workbench'

export const COMPOSITION_PLAN_ERROR_CODES = [
  'READ_SOURCE_COMPOSITION_PLAN_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING',
  'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH',
  'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID',
  'READ_SOURCE_COMPOSITION_STEP_FAILED',
  'READ_SOURCE_COMPOSITION_STEP_NOT_RUN',
  'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR',
] as const

export type CompositionPlanErrorCode = typeof COMPOSITION_PLAN_ERROR_CODES[number]

const COMPOSITION_PLAN_ERROR_CODE_SET: ReadonlySet<string> = new Set(COMPOSITION_PLAN_ERROR_CODES)

// Narrow a raw evidence errorCode string to the mirrored closed vocabulary; null for an unknown code so a
// caller (the C-R4-3 UI) shows the raw code verbatim rather than mislabeling it as a known one.
export function asCompositionPlanErrorCode(value: unknown): CompositionPlanErrorCode | null {
  return typeof value === 'string' && COMPOSITION_PLAN_ERROR_CODE_SET.has(value)
    ? (value as CompositionPlanErrorCode)
    : null
}

// --- runtime-tier service layer (C-R4-3a) -----------------------------------

const COMPOSITION_STATUSES = ['draft', 'approved', 'retired'] as const
export type CompositionStatus = typeof COMPOSITION_STATUSES[number]

export interface ReadSourceCompositionRow {
  id: string
  name: string
  version: number
  status: CompositionStatus
  contentKey: string
  updatedAt: string | null
}

// A values-free per-step outcome from the stitched chain evidence.
export interface CompositionRunStep {
  step: number
  ok: boolean
  rule?: string
  errorCode?: string
}

export interface CompositionRunEvidence {
  ok: boolean
  failedStep: number | null
  steps: CompositionRunStep[]
  errorCode?: CompositionPlanErrorCode
  planErrors?: Array<{ code: string, field: string, reason: string }>
}

// The chain data is ONLY the last hop's single resolver output (target + scalar value), or null.
export interface CompositionRunData {
  resolver: { target: string, value: string | number }
}

export interface CompositionRunResult {
  evidence: CompositionRunEvidence
  data: CompositionRunData | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

async function parseCompositionResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : {}
    const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`
    const message = typeof error.message === 'string' ? error.message : `request failed (${response.status})`
    throw new Error(`${code}: ${message}`)
  }
  return (isPlainObject(payload) && 'data' in payload ? payload.data : payload) as T
}

function normalizeCompositionRow(value: unknown): ReadSourceCompositionRow | null {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id) return null
  const status = typeof value.status === 'string' && (COMPOSITION_STATUSES as readonly string[]).includes(value.status)
    ? (value.status as CompositionStatus)
    : 'draft'
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    version: typeof value.version === 'number' && Number.isFinite(value.version) ? value.version : 0,
    status,
    contentKey: typeof value.contentKey === 'string' ? value.contentKey : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

function normalizeRunStep(value: unknown): CompositionRunStep | null {
  if (!isPlainObject(value) || typeof value.step !== 'number' || !Number.isInteger(value.step)) return null
  const step: CompositionRunStep = { step: value.step, ok: value.ok === true }
  // rule is a closed resolver vocabulary; only surface a recognized value.
  if (value.rule === 'exactly_one' || value.rule === 'first_when_sorted' || value.rule === 'field_equals') {
    step.rule = value.rule
  }
  // errorCode may be a composition coarse code (mirror) OR a per-hop probe/resolver code; surface a
  // string verbatim (all server codes are values-free), preferring the mirror-narrowed form when it matches.
  if (typeof value.errorCode === 'string' && value.errorCode) {
    step.errorCode = asCompositionPlanErrorCode(value.errorCode) ?? value.errorCode
  }
  return step
}

// Values-free allowlist of the run response. Copies ONLY the known shape; a resolved data value is
// accepted only when it is a finite number or a non-blank string (the last hop's single scalar output).
export function normalizeCompositionRunResult(value: unknown): CompositionRunResult {
  const rawEvidence = isPlainObject(value) ? value.evidence : null
  const evidence: CompositionRunEvidence = {
    ok: isPlainObject(rawEvidence) && rawEvidence.ok === true,
    failedStep: isPlainObject(rawEvidence) && typeof rawEvidence.failedStep === 'number' && Number.isInteger(rawEvidence.failedStep)
      ? rawEvidence.failedStep
      : null,
    steps: isPlainObject(rawEvidence) && Array.isArray(rawEvidence.steps)
      ? rawEvidence.steps.map(normalizeRunStep).filter((s): s is CompositionRunStep => s !== null)
      : [],
  }
  if (isPlainObject(rawEvidence) && !evidence.ok) {
    const coarse = asCompositionPlanErrorCode(rawEvidence.errorCode)
    if (coarse) evidence.errorCode = coarse
    if (Array.isArray(rawEvidence.planErrors)) {
      const triples = rawEvidence.planErrors
        .filter(isPlainObject)
        .filter((e) => typeof e.code === 'string' && typeof e.field === 'string' && typeof e.reason === 'string')
        .map((e) => ({ code: e.code as string, field: e.field as string, reason: e.reason as string }))
      if (triples.length > 0) evidence.planErrors = triples
    }
  }

  let data: CompositionRunData | null = null
  const rawData = isPlainObject(value) ? value.data : null
  if (evidence.ok && isPlainObject(rawData) && isPlainObject(rawData.resolver)) {
    const { target, value: resolved } = rawData.resolver as Record<string, unknown>
    const scalar = (typeof resolved === 'number' && Number.isFinite(resolved))
      || (typeof resolved === 'string' && resolved.trim().length > 0)
    if (typeof target === 'string' && target && scalar) {
      data = { resolver: { target, value: resolved as string | number } }
    }
  }
  return { evidence, data }
}

// List compositions (read-tier). Pass status:'approved' for the runnable set the operator picks from.
export async function listReadSourceCompositions(
  scope: IntegrationScope,
  filters: { status?: CompositionStatus } = {},
): Promise<ReadSourceCompositionRow[]> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, status: filters.status })
  const response = await apiFetch(`/api/integration/read-source-compositions${query}`)
  const data = await parseCompositionResponse<unknown[]>(response)
  return (Array.isArray(data) ? data : [])
    .map(normalizeCompositionRow)
    .filter((row): row is ReadSourceCompositionRow => row !== null)
}

// Run an APPROVED composition with ONLY the first business key (the strict { inputs: { key } } contract).
// Never sends a config/plan/target/per-hop key. Returns the values-free { evidence, data }.
export async function runReadSourceComposition(
  id: string,
  key: string,
  scope: IntegrationScope,
): Promise<CompositionRunResult> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-compositions/${encodeURIComponent(id)}/run${query}`, {
    method: 'POST',
    body: JSON.stringify({ inputs: { key } }),
  })
  return normalizeCompositionRunResult(await parseCompositionResponse<unknown>(response))
}
