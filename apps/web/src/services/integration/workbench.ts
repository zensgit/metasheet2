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

export interface PlmIntegrationCapabilityFeature {
  supported: boolean
  api_version?: string | null
  entitled?: boolean
  cache_scope?: Record<string, unknown>
  scenarios?: string[]
  actions?: string[]
  action_status?: string | null
  [key: string]: unknown
}

export interface PlmIntegrationCapabilitiesManifest {
  schema_version: string
  provider: string
  advisory: boolean
  features: Record<string, PlmIntegrationCapabilityFeature>
}

export type PlmIntegrationCapabilitiesResult =
  | {
    data_source_id: string
    available: true
    manifest: PlmIntegrationCapabilitiesManifest
  }
  | {
    data_source_id: string
    available: false
    reason?: string
  }

// PLM-COLLAB P3-C: the governed READ-ONLY BOM multi-table review context (provider's P3-A
// surface, relayed by the metasheet2 backend behind the advisory capability gate).
export interface PlmBomMultitableLine {
  bom_line_id: string
  part_id: string
  item_number: string | null
  name: string | null
  state: string | null
  generation: number | null
  quantity: number | null
  uom: string | null
  find_num: string | null
  refdes: string | null
  level: number
  path: string[]
  path_labels: string[]
  source_version: number | null
  source_updated_at: string | null
  sync_status: string
}

export interface PlmBomMultitablePart {
  part_id: string
  item_number: string | null
  name: string | null
  state: string | null
  generation: number | null
}

export interface PlmBomMultitableContext {
  part: PlmBomMultitablePart
  lines: PlmBomMultitableLine[]
  source_version: number | null
  source_updated_at: string | null
  sync_status: string
  template_key: string
}

export type PlmBomMultitableResult =
  | {
    data_source_id: string
    available: true
    entitled: boolean
    context: PlmBomMultitableContext | null
  }
  | {
    data_source_id: string
    available: false
    reason?: string
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

// DF-T3b-2b UI-wire: binds a from_reference_table domain to the staging system/object that holds its
// mapping sheet. The preview route (DF-T3b-2b) live-bulk-reads each via the staging source-adapter.
export interface IntegrationReferenceMappingSource {
  domain: string
  systemId: string
  object: string
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
  // DF-T3b-2b UI-wire: when present, the preview route live-bulk-reads each domain's mapping sheet so
  // from_reference_table resolves per-material. Omitted = no live resolution (byte-compatible).
  referenceMappingSources?: IntegrationReferenceMappingSource[]
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

// DF-T2b: a typed DF-T1 field rule (produced by the DF-T2a derive helper, edited by the
// authoring UI). Vocabulary mirrors http-routes.cjs DF_T1_* (route-local on the backend).
export interface IntegrationFieldRule {
  targetField: string
  sourceType: 'from_staging' | 'from_constant' | 'preserve_template' | 'from_reference_table'
  sourceField?: string
  value?: unknown
  shape: 'scalar' | 'object-passthrough' | 'by-fnumber' | 'by-fid'
  completeness?: 'none' | 'require-fnumber-fname' | 'require-fid-fname'
  required?: boolean
  // DF-T3b-2d: the reference-mapping domain a from_reference_table rule resolves against.
  domain?: string
}

// DF-T3b-2d: the reference-mapping domains an operator may bind a from_reference_table field to.
// Mirrors the backend built-in templates (K3_REFERENCE_MAPPING_TEMPLATES, #2043). The backend
// validates the domain (unknown → 400), so a stale list here is a non-correctness gap, not a bug.
export const DF_T3_REFERENCE_DOMAINS = [
  'unit', 'unit-group', 'account', 'warehouse', 'manager', 'category',
  'use-state', 'track', 'planning-strategy', 'order-strategy', 'inspection-level', 'inspection-mode',
] as const

export interface IntegrationFieldRuleEditability {
  editable: boolean
  locked: boolean
  reason: 'gated' | 'reference' | null
  isReference: boolean
}

// Whether a field's mode may be edited, and how. The durable REFERENCE identity is the SHAPE
// (object-passthrough / by-* — set by DF-T2a for object values), NOT the sourceType: a *scalar* may
// legitimately be `from_staging` (replace) OR `preserve_template` (preserve). DF-T3b-2d: a reference is
// now **reference-editable** — it may flip between preserve_template and from_reference_table(+domain),
// but is STILL never downgradable to a scalar replace (the v1 no-downgrade rule holds; from_reference_table
// keeps a full reference object, resolved per-material). Gated fields are locked outright and win over
// reference-editability (the gated check is first — e.g. FBaseUnitID stays closed even though it's a reference).
export function fieldRuleEditability(
  rule: Pick<IntegrationFieldRule, 'targetField' | 'shape'>,
  gatedFields: string[] = [],
): IntegrationFieldRuleEditability {
  if (gatedFields.includes(rule.targetField)) {
    return { editable: false, locked: true, reason: 'gated', isReference: false }
  }
  if (rule.shape !== 'scalar') {
    return { editable: true, locked: false, reason: 'reference', isReference: true }
  }
  return { editable: true, locked: false, reason: null, isReference: false }
}

// Pure SCALAR mode setters — called only on an editable scalar field. Shape stays 'scalar'; only the
// replace/preserve mode flips. These never run on a reference/gated field (the UI routes those elsewhere).
export function setFieldRuleReplace(rule: IntegrationFieldRule, sourceField: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'from_staging', shape: 'scalar', sourceField }
  delete next.completeness
  delete next.domain
  return next
}

export function setFieldRulePreserve(rule: IntegrationFieldRule): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'preserve_template', shape: 'scalar' }
  delete next.sourceField
  delete next.domain
  return next
}

// DF-T3b-2d: pure REFERENCE mode setters — keep the reference SHAPE (object-passthrough / by-*) and
// completeness; flip only between preserve_template and from_reference_table (+domain). NEVER scalar.
// `setFieldRuleFromReferenceTable(rule, '')` yields the half-state (from_reference_table, no domain) —
// safe: the backend resolver fail-closes a domain-less rule (no index → unresolved), never silently picks.
export function setFieldRuleFromReferenceTable(rule: IntegrationFieldRule, domain: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'from_reference_table' }
  if (domain) next.domain = domain
  else delete next.domain
  return next
}

export function setFieldRuleReferencePreserve(rule: IntegrationFieldRule): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'preserve_template' }
  delete next.domain
  delete next.sourceField
  return next
}

// DF-T3b dual-binding picker: set the sourceCode COLUMN (rule.sourceField) the resolver reads for a
// from_reference_table reference — the SECOND binding (the sheet binding is referenceMappingSources).
// The preview path reads getPath(sourceRecord, rule.sourceField) (http-routes.cjs), so without this the
// resolver would default to the targetField column and read the wrong value. Empty → drop sourceField.
export function setFieldRuleReferenceSourceField(rule: IntegrationFieldRule, sourceField: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule }
  if (sourceField) next.sourceField = sourceField
  else delete next.sourceField
  return next
}

export type IntegrationFieldProvenanceSource = 'staging' | 'template' | 'constant' | 'reference_table'

// DF-T1 target-payload preview evidence — present only when the request carried a payloadTemplate.
// All fields are sanitized metadata (names, counts, provenance sources); never raw payload values.
export interface IntegrationTargetPayloadPreview {
  eligibleForSaveOnly?: boolean
  unresolvedPlaceholders?: string[]
  unresolvedReferenceComponents?: Array<Record<string, unknown>>
  missingRequiredFields?: string[]
  // target field name -> provenance source (string keeps this additive for backend-introduced sources).
  fieldProvenance?: Record<string, IntegrationFieldProvenanceSource | string>
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

function isPlmCapabilitiesManifest(value: unknown): value is PlmIntegrationCapabilitiesManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.schema_version === 'string'
    && record.schema_version.length > 0
    && record.provider === 'yuantus-plm'
    && record.advisory === true
    && Boolean(record.features && typeof record.features === 'object' && !Array.isArray(record.features))
  )
}

function normalizePlmCapabilitiesResult(
  dataSourceId: string,
  value: unknown,
): PlmIntegrationCapabilitiesResult {
  if (!value || typeof value !== 'object') {
    return { data_source_id: dataSourceId, available: false, reason: 'unavailable' }
  }
  const record = value as Record<string, unknown>
  const resultDataSourceId = typeof record.data_source_id === 'string' && record.data_source_id.trim()
    ? record.data_source_id.trim()
    : dataSourceId
  if (record.available === true && isPlmCapabilitiesManifest(record.manifest)) {
    return {
      data_source_id: resultDataSourceId,
      available: true,
      manifest: record.manifest,
    }
  }
  return {
    data_source_id: resultDataSourceId,
    available: false,
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unavailable',
  }
}

// P3-C: a DEDICATED normalizer for the BOM multi-table relay (its own shape, not the
// capability manifest). Validates only the envelope + that `context`, when present, is a
// part+lines object; the rows are passed through (forward-compatible with provider additions).
function isPlmBomMultitableContext(value: unknown): value is PlmBomMultitableContext {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Boolean(record.part && typeof record.part === 'object' && !Array.isArray(record.part))
    && Array.isArray(record.lines)
  )
}

function normalizePlmBomMultitableResult(
  dataSourceId: string,
  value: unknown,
): PlmBomMultitableResult {
  if (!value || typeof value !== 'object') {
    return { data_source_id: dataSourceId, available: false, reason: 'unavailable' }
  }
  const record = value as Record<string, unknown>
  const resolvedId = typeof record.data_source_id === 'string' && record.data_source_id.trim()
    ? record.data_source_id.trim()
    : dataSourceId
  if (record.available !== true) {
    return {
      data_source_id: resolvedId,
      available: false,
      reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unavailable',
    }
  }
  const entitled = record.entitled === true
  const context = entitled && isPlmBomMultitableContext(record.context) ? record.context : null
  return { data_source_id: resolvedId, available: true, entitled, context }
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

export async function getPlmDataSourceCapabilities(dataSourceId: string): Promise<PlmIntegrationCapabilitiesResult> {
  const normalizedId = dataSourceId.trim()
  if (!normalizedId) {
    return { data_source_id: '', available: false, reason: 'unavailable' }
  }
  const response = await apiFetch(`/api/plm-workbench/data-sources/${encodeURIComponent(normalizedId)}/capabilities`)
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    return { data_source_id: normalizedId, available: false, reason: 'unavailable' }
  }
  return normalizePlmCapabilitiesResult(normalizedId, payload)
}

// P3-C: the backend relay (/api/plm-workbench/.../bom-multitable/.../context) returns a BARE
// object (NOT the {ok,data} integration envelope), so read response.json() directly + a
// dedicated normalizer -- do NOT route this through parseIntegrationResponse. The relay has
// already done the advisory gate (unsupported -> available:false; unentitled -> available:true
// + entitled:false + context:null without querying the resource).
export async function getPlmBomMultitableContext(
  dataSourceId: string,
  partId: string,
): Promise<PlmBomMultitableResult> {
  const dsId = dataSourceId.trim()
  const pid = partId.trim()
  if (!dsId || !pid) {
    return { data_source_id: dsId, available: false, reason: 'unavailable' }
  }
  const response = await apiFetch(
    `/api/plm-workbench/data-sources/${encodeURIComponent(dsId)}/bom-multitable/${encodeURIComponent(pid)}/context`,
  )
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    return { data_source_id: dsId, available: false, reason: 'unavailable' }
  }
  return normalizePlmBomMultitableResult(dsId, payload)
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

// DF-T2c: a values-free entry in the derive evidence summary (field names + shape presence only).
export interface IntegrationTemplateEvidenceField {
  field: string
  sourceType: string
  shape: string
  completeness?: string
  isReference: boolean
  hasValue: boolean
}

// DF-T2c: the draft returned by the read-only derive route. Deliberately carries NO raw
// payloadTemplate (the operator-local customer values stay off the wire) — only the rules, the
// gated field names, and a values-free evidence summary.
export interface IntegrationTemplateDraft {
  fieldRules: IntegrationFieldRule[]
  gatedFields: string[]
  evidence?: {
    fields: IntegrationTemplateEvidenceField[]
    gatedFields: string[]
  }
}

// DF-T2c: derive a draft { payloadTemplate, fieldRules, gatedFields } from a RAW operator-local
// payloadTemplate via the read-only derive route (which runs the DF-T2a helper server-side — no
// duplication, no write; fails closed on redaction markers / secrets / outer {Data:…} envelopes).
export async function deriveIntegrationTemplate(
  payloadTemplate: Record<string, unknown>,
): Promise<IntegrationTemplateDraft> {
  const response = await apiFetch('/api/integration/templates/derive', {
    method: 'POST',
    body: JSON.stringify({ payloadTemplate }),
  })
  return parseIntegrationResponse<IntegrationTemplateDraft>(response)
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

export interface IntegrationTableActionParameter {
  id: string
  label?: string
  type?: string
  required?: boolean
  trim?: boolean
  binding?: Record<string, unknown>
}

export interface IntegrationTableActionMetadata {
  actionId: string
  kind: string
  label: string
  configured: boolean
  parameters: IntegrationTableActionParameter[]
  permissions?: {
    dryRun?: string
    apply?: string
  }
  evidence?: Record<string, unknown>
}

export interface IntegrationTableActionDryRunResult {
  action?: IntegrationTableActionMetadata
  status: string
  dryRunToken?: string | null
  revision?: string
  canApply?: boolean
  counts?: Record<string, number>
  evidence?: Record<string, unknown>
}

export interface IntegrationTableActionApplyResult {
  action?: IntegrationTableActionMetadata
  status: string
  permission?: string
  dryRunRevision?: string
  apply?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export interface IntegrationTableActionRequestPayload {
  parameters: Record<string, unknown>
  confirm?: {
    dryRunToken?: string
    acceptManualConfirmHold?: boolean
  }
}

export interface IntegrationStockPreparationOptionSyncPayload extends IntegrationScope {
  projectId?: string | null
  optionSets?: Record<string, unknown>
  optionSources?: Record<string, unknown>
  configInfo?: Record<string, unknown>
}

export interface IntegrationStockPreparationOptionSyncResult {
  ok?: boolean
  target?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export async function listIntegrationTableActions(scope: IntegrationScope = {}): Promise<IntegrationTableActionMetadata[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<IntegrationTableActionMetadata[]>(response)
  return Array.isArray(data) ? data : []
}

export async function dryRunIntegrationTableAction(
  actionId: string,
  payload: IntegrationScope & Pick<IntegrationTableActionRequestPayload, 'parameters'>,
): Promise<IntegrationTableActionDryRunResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/dry-run${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({
      parameters: payload.parameters,
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionDryRunResult>(response)
}

export async function applyIntegrationTableAction(
  actionId: string,
  payload: IntegrationScope & IntegrationTableActionRequestPayload,
): Promise<IntegrationTableActionApplyResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/apply${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({
      parameters: payload.parameters,
      confirm: payload.confirm,
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionApplyResult>(response)
}

export async function syncIntegrationStockPreparationOptions(
  payload: IntegrationStockPreparationOptionSyncPayload,
): Promise<IntegrationStockPreparationOptionSyncResult> {
  const response = await apiFetch('/api/integration/stock-preparation/options/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationStockPreparationOptionSyncResult>(response)
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
