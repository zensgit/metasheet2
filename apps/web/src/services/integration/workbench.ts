import { apiFetch } from '../../utils/api'

export interface IntegrationApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

export interface IntegrationScope {
  tenantId?: string
  workspaceId?: string | null
}

export interface IntegrationAdapterMetadata {
  kind: string
  label: string
  roles: Array<'source' | 'target' | 'bidirectional' | string>
  supports: string[]
  advanced: boolean
  guardrails?: {
    read?: Record<string, unknown>
    write?: Record<string, unknown>
    ui?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface WorkbenchExternalSystem {
  id: string
  tenantId: string
  workspaceId: string | null
  name: string
  kind: string
  role: 'source' | 'target' | 'bidirectional'
  status: 'active' | 'inactive' | 'error'
  config?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  hasCredentials?: boolean
  lastTestedAt?: string | null
  lastError?: string | null
}

export interface WorkbenchExternalSystemUpsertRequest extends IntegrationScope {
  id?: string
  projectId?: string | null
  name: string
  kind: string
  role: 'source' | 'target' | 'bidirectional'
  status?: 'active' | 'inactive' | 'error'
  config?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  credentials?: unknown
}

export interface WorkbenchExternalSystemDeleteResult {
  deleted: true
  system: WorkbenchExternalSystem
}

export interface IntegrationConnectionTestResult {
  ok: boolean
  status?: string | number
  code?: string
  message?: string
  authenticated?: boolean
  connected?: boolean
  system?: WorkbenchExternalSystem
}

export interface IntegrationObjectSchemaField {
  name: string
  label?: string
  type?: string
  required?: boolean
  [key: string]: unknown
}

export interface IntegrationSystemObject {
  name: string
  object?: string
  label?: string
  operations?: string[]
  source?: string
  target?: string
  schema?: IntegrationObjectSchemaField[]
  template?: Record<string, unknown>
  advanced?: boolean
}

export interface IntegrationObjectSchema {
  object: string
  fields: IntegrationObjectSchemaField[]
  template?: Record<string, unknown>
  raw?: unknown
}

export interface IntegrationFieldMapping {
  sourceField: string
  targetField: string
  transform?: unknown
  validation?: Array<Record<string, unknown>>
  defaultValue?: unknown
  sortOrder?: number
}

export type IntegrationPipelineMode = 'manual' | 'incremental' | 'full'
export type IntegrationPipelineRunStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type IntegrationDeadLetterStatus = 'open' | 'replayed' | 'discarded'

export interface IntegrationPipeline {
  id: string
  tenantId: string
  workspaceId: string | null
  projectId?: string | null
  name: string
  description?: string | null
  sourceSystemId: string
  sourceObject: string
  targetSystemId: string
  targetObject: string
  stagingSheetId?: string | null
  mode: IntegrationPipelineMode
  idempotencyKeyFields: string[]
  options: Record<string, unknown>
  status: 'draft' | 'active' | 'paused' | 'disabled'
  fieldMappings?: IntegrationFieldMapping[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationPipelineUpsertRequest extends IntegrationScope {
  id?: string
  projectId?: string | null
  name: string
  description?: string
  sourceSystemId: string
  sourceObject: string
  targetSystemId: string
  targetObject: string
  stagingSheetId?: string | null
  mode: IntegrationPipelineMode
  idempotencyKeyFields: string[]
  options: Record<string, unknown>
  status: 'draft' | 'active' | 'paused' | 'disabled'
  fieldMappings: IntegrationFieldMapping[]
}

export interface IntegrationPipelineRunPayload extends IntegrationScope {
  mode: IntegrationPipelineMode
  cursor?: string
  sampleLimit?: number
}

export interface IntegrationPipelineRunResult {
  id?: string
  runId?: string
  pipelineId?: string
  status?: string
  dryRun?: boolean
  metrics?: Record<string, unknown>
  preview?: Record<string, unknown>
  [key: string]: unknown
}

export interface IntegrationPipelineObservationQuery extends IntegrationScope {
  pipelineId: string
  status?: string
  limit?: number
  offset?: number
}

// One per-record target-write business response (sanitized + capped at 50
// server-side). This is the concrete present-day grain of #1839's RowResult.
export interface IntegrationTargetWriteSummary {
  [key: string]: unknown
}

// Forward-compatible: the runner records `targetWriteSummaries` (row-level write
// results, #1813) and `watermarkAdvanced` inside `run.details` today; unknown
// keys are preserved so new detail fields don't require a type bump.
export interface IntegrationPipelineRunDetails {
  targetWriteSummaries?: IntegrationTargetWriteSummary[]
  watermarkAdvanced?: boolean
  [key: string]: unknown
}

export interface IntegrationPipelineRun {
  id: string
  tenantId: string
  workspaceId: string | null
  pipelineId: string
  mode: IntegrationPipelineMode | string
  triggeredBy?: string | null
  status: IntegrationPipelineRunStatus | string
  rowsRead: number
  rowsCleaned: number
  rowsWritten: number
  rowsFailed: number
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  errorSummary?: string | null
  details?: IntegrationPipelineRunDetails
  createdAt?: string | null
}

export interface IntegrationDeadLetter {
  id: string
  tenantId: string
  workspaceId: string | null
  runId: string
  pipelineId: string
  idempotencyKey?: string | null
  errorCode: string
  errorMessage: string
  retryCount?: number
  status: IntegrationDeadLetterStatus | string
  lastReplayRunId?: string | null
  payloadRedacted?: boolean
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationStagingDescriptor {
  id: string
  name: string
  fields: string[]
  fieldDetails?: Array<{
    id: string
    name: string
    type: string
    options?: string[]
  }>
}

export interface IntegrationStagingOpenTarget {
  id: string
  name: string
  sheetId: string
  viewId: string
  baseId?: string | null
  openLink: string
}

export interface IntegrationStagingInstallPayload extends IntegrationScope {
  projectId?: string | null
  baseId?: string | null
}

export interface IntegrationStagingInstallResult {
  projectId?: string | null
  sheetIds: Record<string, string>
  viewIds?: Record<string, string>
  openLinks?: Record<string, string>
  targets?: IntegrationStagingOpenTarget[]
  warnings: string[]
}

export interface IntegrationTemplatePreviewRequest {
  sourceRecord: Record<string, unknown>
  fieldMappings: IntegrationFieldMapping[]
  template?: {
    id?: string
    version?: string
    documentType?: string
    bodyKey?: string
    endpointPath?: string
    schema?: IntegrationObjectSchemaField[]
  }
  // DF-T1.5 reachability wire: when payloadTemplate is a plain object the backend runs the DF-T1
  // no-write preview and returns targetPayloadPreview; omitted = legacy preview (byte-compatible).
  payloadTemplate?: Record<string, unknown>
  fieldRules?: Array<Record<string, unknown>>
}

// DF-T1.5 reachability wire: derive a minimal DF-T1 fieldRules set from the legacy preview's field
// mappings — each mapped target becomes a from_staging scalar rule (the operator-supplied
// payloadTemplate carries the rest; reference objects stay preserved by the template).
export function deriveFieldRulesFromMappings(
  fieldMappings: IntegrationFieldMapping[],
): Array<Record<string, unknown>> {
  return (Array.isArray(fieldMappings) ? fieldMappings : [])
    .filter((mapping) => typeof mapping?.targetField === 'string' && mapping.targetField.trim()
      && typeof mapping?.sourceField === 'string' && mapping.sourceField.trim())
    .map((mapping) => {
      // The DF-T1 backend transforms the staging record via fieldMappings first, so the transformed
      // record is keyed by TARGET field — from_staging reads by targetField (not the raw sourceField),
      // giving the preview the same transformed value the pipeline would Save.
      const rule: Record<string, unknown> = {
        targetField: mapping.targetField,
        sourceType: 'from_staging',
        sourceField: mapping.targetField,
        shape: 'scalar',
      }
      // Preserve required semantics from the mapping's validation.
      const validation = (mapping as { validation?: Array<{ type?: string }> }).validation
      if (Array.isArray(validation) && validation.some((entry) => entry && entry.type === 'required')) {
        rule.required = true
      }
      return rule
    })
}

export type IntegrationFieldProvenanceSource = 'staging' | 'template' | 'constant' | 'reference_table'

// DF-T1 target-payload preview evidence — present only when the request carried a payloadTemplate.
// All fields are sanitized metadata (names, counts, provenance sources); never raw payload values.
export interface IntegrationTargetPayloadPreview {
  eligibleForSaveOnly?: boolean
  unresolvedPlaceholders?: string[]
  unresolvedReferenceComponents?: Array<Record<string, unknown>>
  missingRequiredFields?: string[]
  // target field name -> provenance source ((string & {}) keeps autocomplete + tolerates new sources)
  fieldProvenance?: Record<string, IntegrationFieldProvenanceSource | (string & {})>
  compositionSource?: string
  redactionSelfCheck?: { applied?: boolean; clean?: boolean }
}

export interface IntegrationTemplatePreviewResult {
  valid: boolean
  payload: Record<string, unknown>
  targetRecord: Record<string, unknown>
  errors: Array<Record<string, unknown>>
  transformErrors: Array<Record<string, unknown>>
  validationErrors: Array<Record<string, unknown>>
  schemaErrors: Array<Record<string, unknown>>
  template?: Record<string, unknown>
  // DF-T1.5: present only in the DF-T1 payloadTemplate preview mode; the legacy preview omits it.
  targetPayloadPreview?: IntegrationTargetPayloadPreview
}

export interface IntegrationFieldProvenanceEntry {
  field: string
  source: string
}

export interface IntegrationFieldProvenanceSummary {
  entries: IntegrationFieldProvenanceEntry[]
  stats: Array<{ source: string; count: number }>
}

// Canonical source order for the DF-T1.5 provenance stats badges.
const FIELD_PROVENANCE_SOURCE_ORDER: IntegrationFieldProvenanceSource[] = ['staging', 'template', 'constant', 'reference_table']

// DF-T1.5 (read-only): derive a names-only provenance view from a DF-T1 targetPayloadPreview.
// Returns null when there is no fieldProvenance (legacy preview) so the UI renders nothing.
// NEVER reads payload values — only field names and their declared source.
export function summarizeFieldProvenance(
  preview: IntegrationTargetPayloadPreview | null | undefined,
): IntegrationFieldProvenanceSummary | null {
  const provenance = preview?.fieldProvenance
  if (!provenance || typeof provenance !== 'object') return null
  const entries: IntegrationFieldProvenanceEntry[] = Object.keys(provenance)
    .sort((a, b) => a.localeCompare(b))
    .map((field) => ({ field, source: String(provenance[field]) }))
  if (entries.length === 0) return null
  const counts = new Map<string, number>()
  for (const { source } of entries) counts.set(source, (counts.get(source) || 0) + 1)
  const stats: Array<{ source: string; count: number }> = []
  for (const source of FIELD_PROVENANCE_SOURCE_ORDER) {
    if (counts.has(source)) {
      stats.push({ source, count: counts.get(source) as number })
      counts.delete(source)
    }
  }
  for (const source of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    stats.push({ source, count: counts.get(source) as number })
  }
  return { entries, stats }
}

async function parseIntegrationResponse<T>(response: Response): Promise<T> {
  let payload: IntegrationApiEnvelope<T> | null = null
  try {
    payload = await response.json() as IntegrationApiEnvelope<T>
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`.trim()
    throw new Error(message || 'Integration API request failed')
  }
  return payload?.data as T
}

function buildQueryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params.toString()
}

function buildObservationQueryString(query: IntegrationPipelineObservationQuery): string {
  return buildQueryString({
    tenantId: query.tenantId,
    workspaceId: query.workspaceId,
    pipelineId: query.pipelineId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  })
}

function getLocalStorageValue(key: string): string {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return ''
  return localStorage.getItem(key) || ''
}

export function getDefaultIntegrationScope(): Required<IntegrationScope> {
  return {
    tenantId: getLocalStorageValue('tenantId') || 'default',
    workspaceId: getLocalStorageValue('workspaceId') || null,
  }
}

// Staging install project IDs are scoped to the integration-core plugin. The
// backend (assertProjectIdAllowedForPlugin) only inspects the final ":"-segment
// and requires it to be exactly one of these namespaces.
const INTEGRATION_PROJECT_NAMESPACES = ['integration-core', 'plugin-integration-core']

export function isIntegrationScopedProjectId(projectId: string): boolean {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : ''
  if (!trimmed) return false
  const suffix = trimmed.split(':').pop()?.trim() ?? ''
  return INTEGRATION_PROJECT_NAMESPACES.includes(suffix)
}

// Deterministic, backend-correct normalize: empty -> tenant-scoped default
// (matches the server auto-scope used when projectId is omitted); already
// scoped -> returned untouched; otherwise the user's input is preserved as a
// prefix and the required ":integration-core" suffix is appended.
export function normalizeIntegrationProjectId(projectId: string, tenantId: string): string {
  const trimmedTenant = (typeof tenantId === 'string' && tenantId.trim()) || 'default'
  const trimmed = typeof projectId === 'string' ? projectId.trim() : ''
  if (!trimmed) return `${trimmedTenant}:integration-core`
  if (isIntegrationScopedProjectId(trimmed)) return trimmed
  return `${trimmed}:integration-core`
}

export async function listIntegrationAdapters(): Promise<IntegrationAdapterMetadata[]> {
  const response = await apiFetch('/api/integration/adapters')
  const data = await parseIntegrationResponse<IntegrationAdapterMetadata[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listWorkbenchExternalSystems(scope: IntegrationScope = {}): Promise<WorkbenchExternalSystem[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<WorkbenchExternalSystem[]>(response)
  return Array.isArray(data) ? data : []
}

export async function upsertWorkbenchExternalSystem(
  payload: WorkbenchExternalSystemUpsertRequest,
): Promise<WorkbenchExternalSystem> {
  const response = await apiFetch('/api/integration/external-systems', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<WorkbenchExternalSystem>(response)
}

export async function deleteWorkbenchExternalSystem(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<WorkbenchExternalSystemDeleteResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}${query ? `?${query}` : ''}`, {
    method: 'DELETE',
  })
  return parseIntegrationResponse<WorkbenchExternalSystemDeleteResult>(response)
}

export async function listExternalSystemObjects(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<IntegrationSystemObject[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/objects${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<IntegrationSystemObject[]>(response)
  return Array.isArray(data) ? data : []
}

export async function getExternalSystemSchema(
  systemId: string,
  input: IntegrationScope & { object: string },
): Promise<IntegrationObjectSchema> {
  const query = buildQueryString({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    object: input.object,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/schema?${query}`)
  const data = await parseIntegrationResponse<IntegrationObjectSchema>(response)
  return {
    object: data?.object || input.object,
    fields: Array.isArray(data?.fields) ? data.fields : [],
    template: data?.template,
    raw: data?.raw,
  }
}

export async function testExternalSystemConnection(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<IntegrationConnectionTestResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/test${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return parseIntegrationResponse<IntegrationConnectionTestResult>(response)
}

export async function previewIntegrationTemplate(
  payload: IntegrationTemplatePreviewRequest,
): Promise<IntegrationTemplatePreviewResult> {
  const response = await apiFetch('/api/integration/templates/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationTemplatePreviewResult>(response)
}

export async function upsertIntegrationPipeline(
  payload: IntegrationPipelineUpsertRequest,
): Promise<IntegrationPipeline> {
  const response = await apiFetch('/api/integration/pipelines', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipeline>(response)
}

export async function runIntegrationPipeline(
  pipelineId: string,
  payload: IntegrationPipelineRunPayload,
  dryRun = false,
): Promise<IntegrationPipelineRunResult> {
  const endpoint = dryRun ? 'dry-run' : 'run'
  const response = await apiFetch(`/api/integration/pipelines/${encodeURIComponent(pipelineId)}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipelineRunResult>(response)
}

export async function listIntegrationPipelineRuns(
  query: IntegrationPipelineObservationQuery,
): Promise<IntegrationPipelineRun[]> {
  const response = await apiFetch(`/api/integration/runs?${buildObservationQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationPipelineRun[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listIntegrationDeadLetters(
  query: IntegrationPipelineObservationQuery,
): Promise<IntegrationDeadLetter[]> {
  const response = await apiFetch(`/api/integration/dead-letters?${buildObservationQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationDeadLetter[]>(response)
  return Array.isArray(data) ? data : []
}

// DF-N2-3 read-only: one redacted provenance event in a row's cross-run timeline.
// Mirrors the DF-N2-2c OpenAPI ProvenanceTimelineEntry (GET /api/integration/provenance).
// attrs were redacted at write (DF-N2-2b scrub gate); this read path does NOT re-redact.
export interface IntegrationProvenanceTimelineEntry {
  runId: string
  pipelineId: string
  rowId: string
  eventType: string
  at: string
  attrs: Record<string, unknown>
  eventIndex: number
  runStatus: string
  runMode: string
  runCreatedAt: string
}

export interface IntegrationProvenanceQuery extends IntegrationScope {
  rowId: string
  // pipelineId is sent to avoid cross-pipeline idempotency-key collisions merging
  // unrelated row timelines; the read route applies it as an extra view filter.
  pipelineId?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

// DF-N2-3 (read-only): a row's cross-run provenance timeline from the DF-N2-2c
// by-rowId route. rowId is the idempotency key the provenance view groups on. No
// write/replay/retry; the route is read-only and 501s on hosts without it.
export async function listIntegrationProvenanceByRow(
  query: IntegrationProvenanceQuery,
): Promise<IntegrationProvenanceTimelineEntry[]> {
  const response = await apiFetch(`/api/integration/provenance?${buildQueryString({
    tenantId: query.tenantId,
    workspaceId: query.workspaceId,
    rowId: query.rowId,
    pipelineId: query.pipelineId,
    from: query.from,
    to: query.to,
    limit: query.limit,
    offset: query.offset,
  })}`)
  const data = await parseIntegrationResponse<IntegrationProvenanceTimelineEntry[]>(response)
  return Array.isArray(data) ? data : []
}

export interface IntegrationDeadLetterReplayPayload extends IntegrationScope {
  mode?: IntegrationPipelineMode
}

// Backend returns 202 with { deadLetter, replay, warning? }. `replay` is the
// re-run result; on full success the deadLetter is marked 'replayed'.
export interface IntegrationDeadLetterReplayResult {
  deadLetter?: IntegrationDeadLetter
  replay?: IntegrationPipelineRunResult
  warning?: { code?: string; message?: string }
  [key: string]: unknown
}

// Only 'open' letters are replayable — the server enforces the same, but the UI
// must not even offer replay for replayed/discarded letters (a second live ERP
// write). Keep this in lock-step with the backend guard in pipeline-runner.cjs.
export function isDeadLetterReplayable(deadLetter: Pick<IntegrationDeadLetter, 'status'>): boolean {
  return deadLetter.status === 'open'
}

// Surfaces the existing dead-letter replay route (POST .../:id/replay). This is
// a single manual one-record re-enqueue (DF-N1) — NOT bounded retry/back-pressure
// orchestration (DF-N3). Replay re-runs the pipeline with the stored payload,
// i.e. a real target write; callers must gate it behind an explicit confirm.
export async function replayIntegrationDeadLetter(
  deadLetterId: string,
  payload: IntegrationDeadLetterReplayPayload,
): Promise<IntegrationDeadLetterReplayResult> {
  const response = await apiFetch(`/api/integration/dead-letters/${encodeURIComponent(deadLetterId)}/replay`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationDeadLetterReplayResult>(response)
}

export async function listIntegrationStagingDescriptors(): Promise<IntegrationStagingDescriptor[]> {
  const response = await apiFetch('/api/integration/staging/descriptors')
  const data = await parseIntegrationResponse<IntegrationStagingDescriptor[]>(response)
  return Array.isArray(data) ? data : []
}

export async function installIntegrationStaging(
  payload: IntegrationStagingInstallPayload,
): Promise<IntegrationStagingInstallResult> {
  const response = await apiFetch('/api/integration/staging/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationStagingInstallResult>(response)
}

export function canReadFromSystem(system: WorkbenchExternalSystem): boolean {
  return system.role === 'source' || system.role === 'bidirectional'
}

export function canWriteToSystem(system: WorkbenchExternalSystem): boolean {
  return system.role === 'target' || system.role === 'bidirectional'
}
