import { apiFetch } from '../../../utils/api'
import { parseSourcePlanDraftJson, type SourcePlanReadPlan } from './sourcePlanDraft'
import { STOCK_PREPARATION_PULL_ACTION_ID } from './sourceBinding'

export const SOURCE_PLAN_VERSIONS_ROUTE = '/api/integration/stock-preparation/read-plan-configs'

export interface SourcePlanVersionConfig {
  schemaVersion: 1
  actionId: typeof STOCK_PREPARATION_PULL_ACTION_ID
  systemId: string
  readPlan: SourcePlanReadPlan
}

export interface SourcePlanVersion {
  id: string
  systemId: string
  workspaceId: null
  version: number
  contentKey: string
  status: 'draft' | 'approved' | 'retired'
  config: SourcePlanVersionConfig
  validationId: string | null
  validation: SourcePlanValidation | null
}

export interface SourcePlanValidation {
  validationId: string
  status: 'pending' | 'passed' | 'confirmed' | 'failed'
  counts: { sampleCount: number; readCount: number; objectCount: number } | null
  expiresAt: string
  confirmedAt: string | null
}

export const SOURCE_PLAN_SAMPLE_FIELDS = [
  'componentSourceId', 'parentSourceId', 'path', 'depth', 'componentCode', 'componentName',
  'material', 'sourceVersion', 'orderBomVersion', 'rawQuantity', 'totalQuantity', 'active', 'spec', 'sortLine',
] as const
export type SourcePlanSampleField = typeof SOURCE_PLAN_SAMPLE_FIELDS[number]
export type SourcePlanSampleCell = string | number | boolean | null
export type SourcePlanSampleRow = Partial<Record<SourcePlanSampleField, SourcePlanSampleCell>>
export interface SourcePlanSampleResult {
  validation: SourcePlanValidation
  sample: { rows: SourcePlanSampleRow[]; totalRows: number; displayedRows: number; truncated: boolean }
  catalog: { status: 'matched'; validation: 'physical-columns-only'; authorizesExecution: false; issues: [] }
  canApply: false
  tokenIssued: false
  authorizesExecution: false
}

export interface SourcePlanActivation {
  versionId: string
  systemId: string
  workspaceId: null
  contentKey: string
  generation: number
  status: 'active' | 'disabled'
}

export interface SourcePlanVersionList {
  versions: SourcePlanVersion[]
  activation: SourcePlanActivation | null
}

// Only these production status/code pairs can select a fixed troubleshooting message.
// Never retain server messages, details, schema values or arbitrary reason tokens.
const SOURCE_PLAN_DIAGNOSTIC_STATUSES = {
  READ_PLAN_VALIDATION_CATALOG_UNVERIFIED: 422,
  READ_PLAN_VALIDATION_INCOMPLETE: 409,
  READ_PLAN_VALIDATION_TIMEOUT: 504,
  READ_PLAN_VALIDATION_SOURCE_FAILED: 502,
  READ_PLAN_VALIDATION_EXPIRED: 409,
  READ_PLAN_VALIDATION_REQUIRED: 409,
  READ_PLAN_VALIDATION_SUPERSEDED: 409,
  READ_PLAN_VALIDATION_SOURCE_CHANGED: 409,
  READ_PLAN_VALIDATION_IN_PROGRESS: 409,
  READ_PLAN_GENERATION_CONFLICT: 409,
} as const
export type SourcePlanDiagnosticCode = keyof typeof SOURCE_PLAN_DIAGNOSTIC_STATUSES

function diagnosticCode(status: number, value: unknown): SourcePlanDiagnosticCode | undefined {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SOURCE_PLAN_DIAGNOSTIC_STATUSES, value)) return undefined
  const code = value as SourcePlanDiagnosticCode
  return SOURCE_PLAN_DIAGNOSTIC_STATUSES[code] === status ? code : undefined
}

export class SourcePlanVersionsError extends Error {
  readonly status: number
  readonly code: SourcePlanDiagnosticCode | undefined

  constructor(status: number, code?: SourcePlanDiagnosticCode) {
    super(`PLM read plan request failed (${status})`)
    this.name = 'SourcePlanVersionsError'
    this.status = status
    this.code = diagnosticCode(status, code)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(): never { throw new SourcePlanVersionsError(0) }
function handle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function generation(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 2147483647
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function count(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
}
function validationStatus(value: unknown): value is SourcePlanValidation['status'] {
  return value === 'pending' || value === 'passed' || value === 'confirmed' || value === 'failed'
}

function validationOf(value: unknown): SourcePlanValidation {
  if (!record(value) || !exact(value, ['validationId', 'status', 'counts', 'expiresAt', 'confirmedAt'])
    || !handle(value.validationId) || !validationStatus(value.status)
    || !timestamp(value.expiresAt)) invalid()
  let counts: SourcePlanValidation['counts'] = null
  if (value.status === 'passed' || value.status === 'confirmed') {
    if (!record(value.counts) || !exact(value.counts, ['sampleCount', 'readCount', 'objectCount'])
      || !count(value.counts.sampleCount, 100000) || !count(value.counts.readCount, 1000)
      || !count(value.counts.objectCount, 7)) invalid()
    counts = { sampleCount: value.counts.sampleCount, readCount: value.counts.readCount, objectCount: value.counts.objectCount }
  } else if (value.counts !== null) invalid()
  if (value.status === 'confirmed') {
    if (!timestamp(value.confirmedAt) || Date.parse(value.confirmedAt) >= Date.parse(value.expiresAt)) invalid()
  } else if (value.confirmedAt !== null) invalid()
  return { validationId: value.validationId, status: value.status as SourcePlanValidation['status'], counts,
    expiresAt: value.expiresAt, confirmedAt: value.confirmedAt as string | null }
}

function sampleRowOf(value: unknown): SourcePlanSampleRow {
  if (!record(value) || Object.keys(value).some((key) => !SOURCE_PLAN_SAMPLE_FIELDS.includes(key as SourcePlanSampleField))) invalid()
  if (typeof value.componentSourceId !== 'string' || !value.componentSourceId
    || !(value.parentSourceId === null || typeof value.parentSourceId === 'string')
    || typeof value.path !== 'string' || !value.path || !generation(value.depth) || value.depth > 20
    || typeof value.rawQuantity !== 'number' || !Number.isFinite(value.rawQuantity)
    || typeof value.totalQuantity !== 'number' || !Number.isFinite(value.totalQuantity)
    || typeof value.active !== 'boolean') invalid()
  const row: SourcePlanSampleRow = {}
  for (const key of SOURCE_PLAN_SAMPLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const cell = value[key]
    if (cell !== null && typeof cell !== 'boolean'
      && !(typeof cell === 'string' && cell.length <= 4096)
      && !(typeof cell === 'number' && Number.isFinite(cell))) invalid()
    row[key] = cell as SourcePlanSampleCell
  }
  return row
}

function versionOf(value: unknown, systemId: string): SourcePlanVersion {
  if (!record(value) || !handle(value.id) || value.systemId !== systemId || value.workspaceId !== null
    || value.actionId !== STOCK_PREPARATION_PULL_ACTION_ID || value.schemaVersion !== 1
    || !generation(value.version, 1) || !hash(value.contentKey)
    || !['draft', 'approved', 'retired'].includes(String(value.status)) || !record(value.config)) invalid()
  const config = value.config
  if (config.schemaVersion !== 1 || config.actionId !== STOCK_PREPARATION_PULL_ACTION_ID
    || config.systemId !== systemId
    || Object.keys(config).some((key) => !['schemaVersion', 'actionId', 'systemId', 'readPlan'].includes(key))) invalid()
  const parsed = parseSourcePlanDraftJson(JSON.stringify({
    schemaVersion: 1, kind: 'stock-preparation-plm-role-draft', status: 'confirm-required',
    validation: 'structure-only', readPlan: config.readPlan,
  }))
  if (!parsed.ok) invalid()
  const validation = value.validation === undefined || value.validation === null ? null : validationOf(value.validation)
  let validationId: string | null = null
  if (value.validationId !== undefined && value.validationId !== null) {
    if (!handle(value.validationId)) invalid()
    validationId = value.validationId
  }
  if (validation !== null && validation.validationId !== validationId) invalid()
  return {
    id: value.id, systemId, workspaceId: null, version: value.version, contentKey: value.contentKey,
    status: value.status as SourcePlanVersion['status'],
    validationId, validation,
    config: {
      schemaVersion: 1, actionId: STOCK_PREPARATION_PULL_ACTION_ID, systemId,
      readPlan: config.readPlan as SourcePlanReadPlan,
    },
  }
}

export async function validateSourcePlanVersionSample(systemId: string, id: string, projectNo: string): Promise<SourcePlanSampleResult> {
  if (!handle(systemId) || !handle(id) || typeof projectNo !== 'string' || !projectNo.trim()
    || projectNo.trim().length > 128 || [...projectNo].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid()
  const data = await request(`/${encodeURIComponent(id)}/validate`, { managementScope: 'tenant', systemId, projectNo: projectNo.trim() })
  if (!record(data) || !exact(data, ['validation', 'sample', 'catalog', 'canApply', 'tokenIssued', 'authorizesExecution'])
    || data.canApply !== false || data.tokenIssued !== false || data.authorizesExecution !== false) invalid()
  const validation = validationOf(data.validation)
  if (validation.status !== 'passed' || !validation.counts) invalid()
  if (!record(data.catalog) || !exact(data.catalog, ['status', 'validation', 'authorizesExecution', 'issues'])
    || data.catalog.status !== 'matched' || data.catalog.validation !== 'physical-columns-only'
    || data.catalog.authorizesExecution !== false || !Array.isArray(data.catalog.issues) || data.catalog.issues.length) invalid()
  const sample = data.sample
  if (!record(sample) || !exact(sample, ['rows', 'totalRows', 'displayedRows', 'truncated'])
    || !count(sample.totalRows, 100000) || sample.totalRows !== validation.counts.sampleCount
    || !count(sample.displayedRows, 20) || !Array.isArray(sample.rows) || sample.rows.length !== sample.displayedRows
    || sample.displayedRows !== Math.min(20, sample.totalRows) || sample.truncated !== (sample.totalRows > sample.displayedRows)) invalid()
  return {
    validation, sample: { rows: sample.rows.map(sampleRowOf), totalRows: sample.totalRows,
      displayedRows: sample.displayedRows, truncated: sample.truncated as boolean },
    catalog: { status: 'matched', validation: 'physical-columns-only', authorizesExecution: false, issues: [] },
    canApply: false, tokenIssued: false, authorizesExecution: false,
  }
}

export async function confirmSourcePlanVersionSample(systemId: string, id: string, validationId: string): Promise<SourcePlanValidation> {
  if (!handle(systemId) || !handle(id) || !handle(validationId)) invalid()
  const validation = validationOf(await request(`/${encodeURIComponent(id)}/confirm-sample`, { managementScope: 'tenant', systemId, validationId }))
  if (validation.validationId !== validationId || validation.status !== 'confirmed') invalid()
  return validation
}

function activationOf(value: unknown): SourcePlanActivation {
  if (!record(value) || !handle(value.versionId) || !handle(value.systemId) || value.workspaceId !== null
    || value.actionId !== STOCK_PREPARATION_PULL_ACTION_ID || !hash(value.contentKey)
    || !generation(value.generation, 1) || !['active', 'disabled'].includes(String(value.status))) invalid()
  return {
    versionId: value.versionId, systemId: value.systemId, workspaceId: null,
    contentKey: value.contentKey, generation: value.generation,
    status: value.status as SourcePlanActivation['status'],
  }
}

async function request(path: string, body?: Record<string, unknown>): Promise<unknown> {
  let response: Response
  let payload: unknown
  try {
    response = await apiFetch(`${SOURCE_PLAN_VERSIONS_ROUTE}${path}`, {
      // This route derives tenant/actor from the verified session, never a browser hint.
      omitHeaders: ['x-tenant-id', 'x-workspace-id'], suppressUnauthorizedRedirect: true,
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
    payload = await response.json()
  } catch { throw new SourcePlanVersionsError(0) }
  if (!response.ok || !record(payload) || payload.ok !== true || !record(payload.data)
    || Object.prototype.hasOwnProperty.call(payload, 'error')) {
    const code = !response.ok && record(payload) && payload.ok === false && record(payload.error)
      ? diagnosticCode(response.status, payload.error.code) : undefined
    throw new SourcePlanVersionsError(response.status, code)
  }
  return payload.data
}

export async function listSourcePlanVersions(systemId: string): Promise<SourcePlanVersionList> {
  if (!handle(systemId)) invalid()
  const data = await request(`?${new URLSearchParams({ managementScope: 'tenant', systemId })}`)
  if (!record(data) || !Array.isArray(data.versions) || data.versions.length > 100
    || !Object.prototype.hasOwnProperty.call(data, 'activation')) invalid()
  const versions = data.versions.map((value) => versionOf(value, systemId))
  if (new Set(versions.map((row) => row.id)).size !== versions.length) invalid()
  const activation = data.activation === null ? null : activationOf(data.activation)
  // The pointer is action-scoped: its version can belong to another owned source
  // or fall outside this page. If this page contains that exact ID, both records
  // must describe the same immutable source/content before displaying either.
  const activatedVersion = activation && versions.find((row) => row.id === activation.versionId)
  if (activation && activatedVersion && (activation.systemId !== activatedVersion.systemId
    || activation.contentKey !== activatedVersion.contentKey)) invalid()
  return { versions, activation }
}

export async function saveSourcePlanVersion(systemId: string, readPlan: SourcePlanReadPlan): Promise<SourcePlanVersion> {
  if (!handle(systemId)) invalid()
  const config: SourcePlanVersionConfig = { schemaVersion: 1, actionId: STOCK_PREPARATION_PULL_ACTION_ID, systemId, readPlan }
  return versionOf(await request('', { managementScope: 'tenant', config }), systemId)
}

export async function approveSourcePlanVersion(systemId: string, id: string): Promise<SourcePlanVersion> {
  if (!handle(systemId) || !handle(id)) invalid()
  const row = versionOf(await request(`/${encodeURIComponent(id)}/approve`, { managementScope: 'tenant', systemId }), systemId)
  if (row.id !== id || row.status !== 'approved') invalid()
  return row
}

export async function activateSourcePlanVersion(systemId: string, id: string, expectedGeneration: number): Promise<SourcePlanActivation> {
  if (!handle(systemId) || !handle(id) || !generation(expectedGeneration)) invalid()
  const activation = activationOf(await request(`/${encodeURIComponent(id)}/activate`, {
    managementScope: 'tenant', systemId, expectedGeneration,
  }))
  if (activation.versionId !== id || activation.systemId !== systemId || activation.status !== 'active'
    || activation.generation !== expectedGeneration + 1) invalid()
  return activation
}

export async function deactivateSourcePlanVersion(systemId: string, expectedGeneration: number): Promise<SourcePlanActivation> {
  if (!handle(systemId) || !generation(expectedGeneration, 1)) invalid()
  const activation = activationOf(await request('/deactivate', { managementScope: 'tenant', systemId, expectedGeneration }))
  if (activation.systemId !== systemId || activation.status !== 'disabled'
    || activation.generation !== expectedGeneration + 1) invalid()
  return activation
}
