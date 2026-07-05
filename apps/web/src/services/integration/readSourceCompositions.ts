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
import { READ_SOURCE_PROBE_ERROR_CODES } from './readSourceConfigs'
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

// Exact registered union for a stitched-vector per-step errorCode: the composition coarse codes (this
// mirror) PLUS the per-hop probe/resolver codes (READ_SOURCE_PROBE_ERROR_CODES already includes the
// resolver codes). Anything outside this union is dropped by normalizeRunStep.
const STEP_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>([
  ...COMPOSITION_PLAN_ERROR_CODES,
  ...READ_SOURCE_PROBE_ERROR_CODES,
])

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

// Coarse-code / reason clamps (mirror readSourceConfigs.ts ReadSourceApiError). The raw server
// error.message is NEVER surfaced — only a clamped code + optional clamped reason — so the error path is
// values-free BY CONSTRUCTION, not by trusting the server to keep messages coarse (a future server bug
// echoing a business value into message can never reach the client render).
const COMPOSITION_ERROR_REASON_PATTERN = /^[a-z0-9_:-]{1,80}$/
// planErrors[].field is a structural path the C-R1 validator emits (e.g. `steps.1.readSourceConfigId`,
// `(root)`, `steps.0.(unexpected)`). Bound it to that shape so a business value can never ride in.
const COMPOSITION_ERROR_FIELD_PATTERN = /^[A-Za-z0-9_.()]{1,60}$/
// planErrors[].code is a composition validator code (READ_SOURCE_COMPOSITION_*). Requiring the prefix is
// stricter than a bare uppercase regex — a code-shaped business value (e.g. MAT_001_SECRET) is rejected.
const COMPOSITION_VALIDATOR_CODE_PATTERN = /^READ_SOURCE_COMPOSITION_[A-Z_]{1,60}$/

// The EXACT registered set of HTTP error.code values the composition run/list routes emit (the composition
// config errors + the read-source-config errors re-surfaced during per-step loading + the auth codes).
// error.code is clamped against this set — NOT a bare regex — so a code-SHAPED business value (uppercase +
// underscore, e.g. MAT_001_SECRET, which would pass a regex) coarsens to the fixed fallback instead of
// rendering. An unregistered-but-legit future server code also coarsens (safe degradation, never a leak).
const COMPOSITION_REQUEST_ERROR_CODES: ReadonlySet<string> = new Set([
  'READ_SOURCE_COMPOSITION_CONFIG_INVALID',
  'READ_SOURCE_COMPOSITION_CONFIG_NOT_FOUND',
  'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED',
  'READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT',
  'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID',
  'READ_SOURCE_CONFIG_INVALID',
  'READ_SOURCE_CONFIG_NOT_FOUND',
  'READ_SOURCE_CONFIG_NOT_APPROVED',
  'READ_SOURCE_CONFIG_STATUS_CONFLICT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
])

// Authoring-tier (save/approve/retire/audit) validation-error surface: the C-R1 validator's
// details.errors triples (save-time CONFIG_INVALID). Clamped with the SAME three patterns as the
// run-route planErrors triples above — a triple failing ANY clamp is dropped whole (fail-closed),
// mirroring #3588's planErrors clamp discipline.
export interface ReadSourceCompositionFieldError {
  code: string
  field: string
  reason: string
}

function clampCompositionFieldErrors(value: unknown): ReadSourceCompositionFieldError[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return []
    const { code, field, reason } = entry
    if (typeof code !== 'string' || !COMPOSITION_VALIDATOR_CODE_PATTERN.test(code)) return []
    if (typeof field !== 'string' || !COMPOSITION_ERROR_FIELD_PATTERN.test(field)) return []
    if (typeof reason !== 'string' || !COMPOSITION_ERROR_REASON_PATTERN.test(reason)) return []
    return [{ code, field, reason }]
  })
}

export class ReadSourceCompositionApiError extends Error {
  status: number
  code: string
  reason: string
  fieldErrors: ReadSourceCompositionFieldError[]
  constructor(status: number, code: string, reason: string, fieldErrors: ReadSourceCompositionFieldError[] = []) {
    // .message is built from the clamped code (+reason) only — the panel renders error.message, so this
    // is the values-free string it shows.
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'ReadSourceCompositionApiError'
    this.status = status
    this.code = code
    this.reason = reason
    this.fieldErrors = fieldErrors
  }
}

async function parseCompositionResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok || (isPlainObject(payload) && payload.ok === false)) {
    const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : {}
    const details = isPlainObject(error.details) ? error.details : {}
    const code = typeof error.code === 'string' && COMPOSITION_REQUEST_ERROR_CODES.has(error.code)
      ? error.code
      : 'READ_SOURCE_COMPOSITION_REQUEST_FAILED'
    const reason = typeof details.reason === 'string' && COMPOSITION_ERROR_REASON_PATTERN.test(details.reason)
      ? details.reason
      : ''
    throw new ReadSourceCompositionApiError(response.status, code, reason, clampCompositionFieldErrors(details.errors))
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
  // errorCode may be a composition coarse code (the mirror) OR a per-hop probe/resolver code — surface it
  // ONLY when it is in the EXACT registered union (never a verbatim fallthrough): an unknown string (e.g.
  // a future server bug leaking a business identifier that looks like A_CODE) is DROPPED, not rendered.
  if (typeof value.errorCode === 'string' && STEP_ERROR_CODE_SET.has(value.errorCode)) {
    step.errorCode = value.errorCode
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
      // Bounded-clamp EACH triple field (code / field / reason) — not just typeof string — so the triple
      // is values-free by construction: a future server bug echoing a business value into any of the
      // three cannot ride in. An entry failing any clamp is dropped whole (fail-closed).
      const triples = rawEvidence.planErrors
        .filter(isPlainObject)
        .filter((e) =>
          typeof e.code === 'string' && COMPOSITION_VALIDATOR_CODE_PATTERN.test(e.code)
          && typeof e.field === 'string' && COMPOSITION_ERROR_FIELD_PATTERN.test(e.field)
          && typeof e.reason === 'string' && COMPOSITION_ERROR_REASON_PATTERN.test(e.reason))
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

// --- authoring-tier service layer (consultant/admin, config-time) ----------
//
// Config-time mirrors of the readSourceConfigs.ts save/approve/retire/audit calls — for a future
// authoring panel over the C-R4-1 composition routes. Read-only line honored: operations is pinned
// to ['read'] and is never caller-suppliable; step ids / toInput / fromStep are likewise pinned by
// buildReadSourceCompositionPayload, not by the draft. Values-free line honored: the audit
// normalizer keeps ONLY the coarse {from,to} status pair from `detail` (never a version number or
// any other field a response might carry), and the API error surface adds clamped fieldErrors on
// top of the existing clamped code+reason (never the raw server message).

// Coarse client-side mirrors of the server's isBoundedIdentifier / isBoundedConfigId
// (read-source-composition-config.cjs). Client hint only — the server re-validates authoritatively.
const COMPOSITION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const COMPOSITION_CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const COMPOSITION_SOURCE_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/

// Authoring draft: the v1 two-hop shape reduced to what a form actually edits. Everything else
// (version, operations, step ids, fromStep, toInput) is fixed by the builder below — never editable.
export interface ReadSourceCompositionDraft {
  name: string
  step1ConfigId: string
  step2ConfigId: string
  sourceTarget: string
}

export interface ReadSourceCompositionStepInput {
  fromStep: 'step-1'
  sourceTarget: string
  toInput: 'key'
}

export interface ReadSourceCompositionPayload {
  version: 1
  name: string
  operations: ['read']
  steps: [
    { id: 'step-1', readSourceConfigId: string },
    { id: 'step-2', readSourceConfigId: string, input: ReadSourceCompositionStepInput },
  ]
}

export function createReadSourceCompositionDraft(): ReadSourceCompositionDraft {
  return { name: '', step1ConfigId: '', step2ConfigId: '', sourceTarget: '' }
}

// Pure builder: assembles the EXACT server config shape (read-source-composition-config.cjs v1).
// version/operations/step ids/toInput/fromStep are pinned constants — a draft can never smuggle an
// extra field into the payload, since only the four named draft properties are ever read here.
export function buildReadSourceCompositionPayload(draft: ReadSourceCompositionDraft): ReadSourceCompositionPayload {
  return {
    version: 1,
    name: draft.name.trim(),
    operations: ['read'],
    steps: [
      { id: 'step-1', readSourceConfigId: draft.step1ConfigId.trim() },
      {
        id: 'step-2',
        readSourceConfigId: draft.step2ConfigId.trim(),
        input: { fromStep: 'step-1', sourceTarget: draft.sourceTarget.trim(), toInput: 'key' },
      },
    ],
  }
}

// Coarse client-side pre-checks (field-name-keyed messages only; values are never echoed — mirrors
// validateReadSourceDraft in readSourceConfigs.ts). The server (read-source-composition-config.cjs)
// stays authoritative; this only gives a future authoring panel instant, values-free feedback.
export function validateReadSourceCompositionDraft(draft: ReadSourceCompositionDraft): string[] {
  const problems: string[] = []
  if (!COMPOSITION_NAME_PATTERN.test(draft.name.trim())) {
    problems.push('name 必须是合法标识符(字母/数字开头,长度不超过 64)')
  }
  const step1Valid = COMPOSITION_CONFIG_ID_PATTERN.test(draft.step1ConfigId.trim())
  if (!step1Valid) problems.push('step1ConfigId 必须是合法引用标识符(长度不超过 128)')
  const step2Valid = COMPOSITION_CONFIG_ID_PATTERN.test(draft.step2ConfigId.trim())
  if (!step2Valid) problems.push('step2ConfigId 必须是合法引用标识符(长度不超过 128)')
  if (step1Valid && step2Valid && draft.step1ConfigId.trim() === draft.step2ConfigId.trim()) {
    problems.push('step1ConfigId 与 step2ConfigId 不能相同')
  }
  if (!COMPOSITION_SOURCE_TARGET_PATTERN.test(draft.sourceTarget.trim())) {
    problems.push('sourceTarget 必须是合法标识符(字母/数字开头,长度不超过 64)')
  }
  return problems
}

export interface ReadSourceCompositionSaveResult extends ReadSourceCompositionRow {
  reused: boolean
}

export async function saveReadSourceCompositionVersion(
  draft: ReadSourceCompositionDraft,
  scope: IntegrationScope,
): Promise<ReadSourceCompositionSaveResult> {
  const config = buildReadSourceCompositionPayload(draft)
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-compositions${query}`, {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
  const data = await parseCompositionResponse<unknown>(response)
  const row = normalizeCompositionRow(data)
  return {
    id: row?.id ?? '',
    name: row?.name ?? '',
    version: row?.version ?? 0,
    status: row?.status ?? 'draft',
    contentKey: row?.contentKey ?? '',
    updatedAt: row?.updatedAt ?? null,
    reused: isPlainObject(data) && data.reused === true,
  }
}

export async function approveReadSourceComposition(id: string, scope: IntegrationScope): Promise<ReadSourceCompositionRow | null> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-compositions/${encodeURIComponent(id)}/approve${query}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return normalizeCompositionRow(await parseCompositionResponse<unknown>(response))
}

export async function retireReadSourceComposition(id: string, scope: IntegrationScope): Promise<ReadSourceCompositionRow | null> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-compositions/${encodeURIComponent(id)}/retire${query}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return normalizeCompositionRow(await parseCompositionResponse<unknown>(response))
}

// Values-free audit row: action/actor/createdAt are coarse by construction (closed enum / plain
// string / ISO string); `detail` is clamped to ONLY the {from,to} status-transition pair — a
// `version` number (present on save_version/reuse_version rows) or any other field the row might
// carry is dropped, never surfaced.
export interface ReadSourceCompositionAuditRow {
  action: 'save_version' | 'reuse_version' | 'status_change'
  actor: string | null
  detail: { from?: CompositionStatus; to?: CompositionStatus }
  createdAt: string | null
}

const COMPOSITION_STATUS_SET: ReadonlySet<string> = new Set(COMPOSITION_STATUSES)

function clampCompositionAuditDetail(value: unknown): { from?: CompositionStatus; to?: CompositionStatus } {
  const detail: { from?: CompositionStatus; to?: CompositionStatus } = {}
  if (!isPlainObject(value)) return detail
  if (typeof value.from === 'string' && COMPOSITION_STATUS_SET.has(value.from)) {
    detail.from = value.from as CompositionStatus
  }
  if (typeof value.to === 'string' && COMPOSITION_STATUS_SET.has(value.to)) {
    detail.to = value.to as CompositionStatus
  }
  return detail
}

export async function listReadSourceCompositionAudit(id: string, scope: IntegrationScope): Promise<ReadSourceCompositionAuditRow[]> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-compositions/${encodeURIComponent(id)}/audit${query}`)
  const data = await parseCompositionResponse<unknown[]>(response)
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    if (!isPlainObject(row)) return []
    const action = row.action === 'save_version' || row.action === 'reuse_version' || row.action === 'status_change'
      ? row.action
      : null
    if (!action) return []
    return [{
      action,
      actor: typeof row.actor === 'string' ? row.actor : null,
      detail: clampCompositionAuditDetail(row.detail),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    }]
  })
}
