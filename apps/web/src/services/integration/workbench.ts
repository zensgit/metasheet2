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
  details?: Record<string, unknown>
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
