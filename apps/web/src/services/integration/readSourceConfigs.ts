import { apiFetch } from '../../utils/api'
import type { IntegrationScope } from './workbench'

// External-API read self-service (#1709) — S3 consultant UI service layer.
//
// Scope fence: consultant/admin tier ONLY (config-time). The runtime/end-user tier never reaches
// these calls. Read-only line: operations is pinned to ['read'] at payload assembly and is not
// editable in any form. Evidence handling is values-free by construction — the probe evidence
// normalizer below copies ONLY allowlisted booleans / bounded counts / coarse enum codes /
// container {type, arrayLength}; any other field a response might carry is dropped, never rendered.

export const READ_SOURCE_MODES = ['single_record', 'list_page', 'detail_with_lines', 'resolver_lookup'] as const
export type ReadSourceMode = typeof READ_SOURCE_MODES[number]

export const READ_SOURCE_METHODS = ['GET', 'POST'] as const
export type ReadSourceMethod = typeof READ_SOURCE_METHODS[number]

export const READ_SOURCE_KEY_ENCODINGS = ['structured_json_field', 'filter_expression', 'numeric_id'] as const
export type ReadSourceKeyEncoding = typeof READ_SOURCE_KEY_ENCODINGS[number]

export const READ_SOURCE_STATUSES = ['draft', 'approved', 'retired'] as const
export type ReadSourceStatus = typeof READ_SOURCE_STATUSES[number]

export interface ReadSourceFieldMapEntry {
  source: string
  target: string
}

// The S1 config shape (server-authoritative validator: plugins read-source-config.cjs).
export interface ReadSourceConfigPayload {
  version: number
  systemId: string
  requiredKind: string
  object: string
  mode: ReadSourceMode
  readPath: string
  readMethod: ReadSourceMethod
  operations: ['read']
  keyField?: string
  keyEncoding?: ReadSourceKeyEncoding
  multiplicityRuleField?: string
  containerPaths?: string[]
  headerContainerPaths?: string[]
  lineContainerPaths?: string[]
  fieldMap?: ReadSourceFieldMapEntry[]
}

// Form draft: list fields are edited as separated text; assembly parses them.
export interface ReadSourceConfigDraft {
  version: number
  systemId: string
  requiredKind: string
  object: string
  mode: ReadSourceMode
  readPath: string
  readMethod: ReadSourceMethod
  keyField: string
  keyEncoding: '' | ReadSourceKeyEncoding
  multiplicityRuleField: string
  containerPaths: string
  headerContainerPaths: string
  lineContainerPaths: string
  fieldMap: ReadSourceFieldMapEntry[]
}

export interface ReadSourceConfigRow {
  id: string
  systemId: string
  object: string
  mode: string
  version: number
  status: ReadSourceStatus
  contentKey: string
  createdBy: string | null
  updatedAt: string | null
}

export interface ReadSourceSaveResult {
  id: string
  version: number
  status: ReadSourceStatus
  reused: boolean
  contentKey: string
}

export interface ReadSourceAuditRow {
  action: 'save_version' | 'reuse_version' | 'status_change'
  actor: string | null
  detail: Record<string, unknown>
  createdAt: string | null
}

export interface ReadSourceProbeContainerShape {
  type: 'array' | 'null' | 'object' | 'string' | 'number' | 'boolean' | 'missing' | 'other'
  arrayLength?: number | null
}

export interface ReadSourceProbeEvidence {
  ok: boolean
  object: string
  mode: string
  boundedSmoke: boolean
  containers?: Partial<Record<'primary' | 'header' | 'lines', ReadSourceProbeContainerShape>>
  containerLocated?: boolean
  boundedSmokeExecuted?: boolean
  timeoutReached?: boolean
  capReached?: boolean
  recordCount?: number
  rowCount?: number
  sampleCount?: number
  errorCode?: string
  errorType?: string
}

export interface ReadSourceFieldError {
  code: string
  field: string
  reason: string
}

// Everything lifted from a response body into error text is CLAMPED to enum-shaped patterns first —
// a value-carrying string under code/reason/field can never reach the DOM through Error.message.
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/
const ERROR_REASON_PATTERN = /^[a-z0-9_:-]{1,80}$/
const ERROR_FIELD_PATTERN = /^[A-Za-z0-9_.()-]{1,64}$/

// Coarse, values-free API error: clamped code + reason enums only — submitted values never enter error text.
export class ReadSourceApiError extends Error {
  code: string
  reason: string
  status: number
  fieldErrors: ReadSourceFieldError[]

  constructor(status: number, code: string, reason: string, fieldErrors: ReadSourceFieldError[] = []) {
    const fieldSummary = fieldErrors.length > 0
      ? `:${fieldErrors.map((entry) => ` ${entry.field}: ${entry.reason}`).join(';')}`
      : ''
    super(`读取源接口请求失败(${code}${reason ? `/${reason}` : ''})${fieldSummary}`)
    this.name = 'ReadSourceApiError'
    this.status = status
    this.code = code
    this.reason = reason
    this.fieldErrors = fieldErrors
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Save-time validator errors ride as details.errors = [{code, field, reason}]; keep only tuples where
// every part matches its enum-shaped pattern (a hostile/value-carrying part drops the whole tuple).
function clampFieldErrors(value: unknown): ReadSourceFieldError[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return []
    const { code, field, reason } = entry
    if (typeof code !== 'string' || !ERROR_CODE_PATTERN.test(code)) return []
    if (typeof field !== 'string' || !ERROR_FIELD_PATTERN.test(field)) return []
    if (typeof reason !== 'string' || !ERROR_REASON_PATTERN.test(reason)) return []
    return [{ code, field, reason }]
  })
}

async function parseReadSourceResponse<T>(response: Response): Promise<T> {
  let payload: Record<string, unknown> | null = null
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const error = isPlainObject(payload?.error) ? payload.error : {}
    const details = isPlainObject(error.details) ? error.details : {}
    const code = typeof error.code === 'string' && ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : 'READ_SOURCE_REQUEST_FAILED'
    const reason = typeof details.reason === 'string' && ERROR_REASON_PATTERN.test(details.reason)
      ? details.reason
      : ''
    throw new ReadSourceApiError(response.status, code, reason, clampFieldErrors(details.errors))
  }
  return payload?.data as T
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

// --- pure helpers (unit-testable, DOM-free) --------------------------------

export const READ_SOURCE_MODE_REQUIRED_FIELDS: Record<ReadSourceMode, string[]> = {
  single_record: ['keyField', 'containerPaths'],
  list_page: ['containerPaths'],
  detail_with_lines: ['headerContainerPaths', 'lineContainerPaths'],
  resolver_lookup: ['keyField', 'containerPaths', 'multiplicityRuleField'],
}

export function createReadSourceConfigDraft(): ReadSourceConfigDraft {
  return {
    version: 1,
    systemId: '',
    requiredKind: '',
    object: '',
    mode: 'single_record',
    readPath: '',
    readMethod: 'POST',
    keyField: '',
    keyEncoding: '',
    multiplicityRuleField: '',
    containerPaths: '',
    headerContainerPaths: '',
    lineContainerPaths: '',
    fieldMap: [],
  }
}

export function parseContainerPathList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

// Client-side mirror of the crown-jewel relative-path guard — COARSE only, the server is
// authoritative. Rejects the classes the server rejects so consultants get instant feedback.
export function isCoarseSafeRelativeReadPath(value: string): boolean {
  const raw = value.trim()
  if (!raw) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return false
  if (raw.startsWith('//')) return false
  if (raw.includes('\\')) return false
  if (raw.includes('%')) return false
  const path = raw.startsWith('/') ? raw : `/${raw}`
  if (path.split('/').some((segment) => segment === '..')) return false
  return /^\/[A-Za-z0-9\-._~/]*$/.test(path)
}

// Coarse client validation: field-name-keyed messages only (values are never echoed).
export function validateReadSourceDraft(draft: ReadSourceConfigDraft): string[] {
  const problems: string[] = []
  if (!Number.isInteger(draft.version) || draft.version < 1) problems.push('version 需为正整数')
  if (!draft.systemId.trim()) problems.push('systemId 必填(选择外部系统)')
  if (!draft.requiredKind.trim()) problems.push('requiredKind 必填')
  if (!draft.object.trim()) problems.push('object 必填')
  if (!READ_SOURCE_MODES.includes(draft.mode)) problems.push('mode 不在允许列表')
  if (!READ_SOURCE_METHODS.includes(draft.readMethod)) problems.push('readMethod 不在允许列表')
  if (!isCoarseSafeRelativeReadPath(draft.readPath)) {
    problems.push('readPath 必须是相对路径(不接受绝对 URL、%、\\、..)')
  }
  for (const field of READ_SOURCE_MODE_REQUIRED_FIELDS[draft.mode] ?? []) {
    if (field === 'keyField' && !draft.keyField.trim()) problems.push(`keyField 为 ${draft.mode} 模式必填`)
    if (field === 'multiplicityRuleField' && !draft.multiplicityRuleField.trim()) {
      problems.push(`multiplicityRuleField 为 ${draft.mode} 模式必填`)
    }
    if (field === 'containerPaths' && parseContainerPathList(draft.containerPaths).length === 0) {
      problems.push(`containerPaths 为 ${draft.mode} 模式必填`)
    }
    if (field === 'headerContainerPaths' && parseContainerPathList(draft.headerContainerPaths).length === 0) {
      problems.push(`headerContainerPaths 为 ${draft.mode} 模式必填`)
    }
    if (field === 'lineContainerPaths' && parseContainerPathList(draft.lineContainerPaths).length === 0) {
      problems.push(`lineContainerPaths 为 ${draft.mode} 模式必填`)
    }
  }
  for (const entry of draft.fieldMap) {
    const hasSource = entry.source.trim().length > 0
    const hasTarget = entry.target.trim().length > 0
    if (hasSource !== hasTarget) {
      problems.push('fieldMap 行需同时填写 source 与 target(或整行留空)')
      break
    }
  }
  return problems
}

// Assemble the exact S1 payload: operations pinned to ['read']; only mode-relevant optional
// fields ride along; empty optionals are dropped, never sent as ''.
export function buildReadSourceConfigPayload(draft: ReadSourceConfigDraft): ReadSourceConfigPayload {
  // Mirror the server's normalizeReadSourceConfig leading-slash rule so the probe route (which
  // requires a byte-normalized config) accepts the same payload the save route would normalize.
  const trimmedReadPath = draft.readPath.trim()
  const payload: ReadSourceConfigPayload = {
    version: draft.version,
    systemId: draft.systemId.trim(),
    requiredKind: draft.requiredKind.trim(),
    object: draft.object.trim(),
    mode: draft.mode,
    readPath: trimmedReadPath.startsWith('/') || trimmedReadPath === '' ? trimmedReadPath : `/${trimmedReadPath}`,
    readMethod: draft.readMethod,
    operations: ['read'],
  }
  const wantsKeyField = draft.mode === 'single_record' || draft.mode === 'resolver_lookup' || draft.mode === 'detail_with_lines'
  if (wantsKeyField && draft.keyField.trim()) payload.keyField = draft.keyField.trim()
  if (wantsKeyField && draft.keyEncoding) payload.keyEncoding = draft.keyEncoding
  if (draft.mode === 'resolver_lookup' && draft.multiplicityRuleField.trim()) {
    payload.multiplicityRuleField = draft.multiplicityRuleField.trim()
  }
  if (draft.mode === 'detail_with_lines') {
    const header = parseContainerPathList(draft.headerContainerPaths)
    const lines = parseContainerPathList(draft.lineContainerPaths)
    if (header.length > 0) payload.headerContainerPaths = header
    if (lines.length > 0) payload.lineContainerPaths = lines
  } else {
    const containers = parseContainerPathList(draft.containerPaths)
    if (containers.length > 0) payload.containerPaths = containers
  }
  const fieldMap = draft.fieldMap
    .map((entry) => ({ source: entry.source.trim(), target: entry.target.trim() }))
    .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
  if (fieldMap.length > 0) payload.fieldMap = fieldMap
  return payload
}

const EVIDENCE_CONTAINER_ALIASES = ['primary', 'header', 'lines'] as const
const EVIDENCE_SHAPE_TYPES = new Set(['array', 'null', 'object', 'string', 'number', 'boolean', 'missing', 'other'])
const EVIDENCE_BOOLEAN_KEYS = ['containerLocated', 'boundedSmokeExecuted', 'timeoutReached', 'capReached'] as const
const EVIDENCE_COUNT_KEYS = ['recordCount', 'rowCount', 'sampleCount'] as const

// Client-side mirrors of the FROZEN S2-a vocabularies — source of truth:
// plugins/plugin-integration-core/lib/read-source-probe-contract.cjs
// (READ_SOURCE_PROBE_ERROR_CODES / READ_SOURCE_PROBE_ERROR_TYPES). Anything outside these closed
// sets — even an enum-SHAPED string — is replaced by the coarse fallback, never rendered verbatim.
const READ_SOURCE_PROBE_ERROR_CODES = new Set([
  'READ_SOURCE_PROBE_CONTRACT_INVALID',
  'READ_SOURCE_PROBE_FAILED',
  'READ_SOURCE_PROBE_AUTH_FAILED',
  'READ_SOURCE_PROBE_CAP_REACHED',
  'READ_SOURCE_PROBE_CONFIG_INVALID',
  'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND',
  'READ_SOURCE_PROBE_NETWORK_FAILED',
  'READ_SOURCE_PROBE_REJECTED',
  'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED',
  'READ_SOURCE_PROBE_SHAPE_MISMATCH',
  'READ_SOURCE_PROBE_TIMEOUT',
])
const READ_SOURCE_PROBE_ERROR_TYPES = new Set([
  'Error',
  'AbortError',
  'FetchError',
  'K3WiseWebApiAdapterError',
  'ReadSourceProbeContractError',
  'ReadSourceProbeRuntimeError',
  'TimeoutError',
  'TypeError',
])

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function safeContainerShape(value: unknown): ReadSourceProbeContainerShape | null {
  if (!isPlainObject(value)) return null
  const type = typeof value.type === 'string' && EVIDENCE_SHAPE_TYPES.has(value.type)
    ? value.type as ReadSourceProbeContainerShape['type']
    : null
  if (!type) return null
  const shape: ReadSourceProbeContainerShape = { type }
  if (value.arrayLength === null) shape.arrayLength = null
  else {
    const count = safeCount(value.arrayLength)
    if (count !== null) shape.arrayLength = count
  }
  return shape
}

// THE render-side leak guard: rebuild the evidence from an explicit allowlist. Unknown fields —
// including any row values or field keys a hostile/malformed response might carry — are dropped
// before anything reaches a template.
export function normalizeReadSourceProbeEvidence(value: unknown): ReadSourceProbeEvidence | null {
  if (!isPlainObject(value)) return null
  const evidence: ReadSourceProbeEvidence = {
    ok: value.ok === true,
    object: typeof value.object === 'string' ? value.object : 'unknown',
    mode: typeof value.mode === 'string' ? value.mode : 'unknown',
    boundedSmoke: value.boundedSmoke === true,
  }
  if (isPlainObject(value.containers)) {
    const containers: ReadSourceProbeEvidence['containers'] = {}
    for (const alias of EVIDENCE_CONTAINER_ALIASES) {
      const shape = safeContainerShape(value.containers[alias])
      if (shape) containers[alias] = shape
    }
    if (Object.keys(containers).length > 0) evidence.containers = containers
  }
  for (const key of EVIDENCE_BOOLEAN_KEYS) {
    if (typeof value[key] === 'boolean') evidence[key] = value[key] as boolean
  }
  for (const key of EVIDENCE_COUNT_KEYS) {
    const count = safeCount(value[key])
    if (count !== null) evidence[key] = count
  }
  if (!evidence.ok) {
    evidence.errorCode = typeof value.errorCode === 'string' && READ_SOURCE_PROBE_ERROR_CODES.has(value.errorCode)
      ? value.errorCode
      : 'READ_SOURCE_PROBE_FAILED'
    evidence.errorType = typeof value.errorType === 'string' && READ_SOURCE_PROBE_ERROR_TYPES.has(value.errorType)
      ? value.errorType
      : 'Error'
  }
  return evidence
}

export function normalizeReadSourceConfigRow(value: unknown): ReadSourceConfigRow | null {
  if (!isPlainObject(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  const status = typeof value.status === 'string' && (READ_SOURCE_STATUSES as readonly string[]).includes(value.status)
    ? value.status as ReadSourceStatus
    : 'draft'
  return {
    id: value.id,
    systemId: typeof value.systemId === 'string' ? value.systemId : '',
    object: typeof value.object === 'string' ? value.object : '',
    mode: typeof value.mode === 'string' ? value.mode : '',
    version: safeCount(value.version) ?? 0,
    status,
    contentKey: typeof value.contentKey === 'string' ? value.contentKey : '',
    createdBy: typeof value.createdBy === 'string' ? value.createdBy : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

// --- API calls (consultant tier) --------------------------------------------

export async function listReadSourceConfigs(
  scope: IntegrationScope,
  filters: { systemId?: string; status?: string } = {},
): Promise<ReadSourceConfigRow[]> {
  const query = buildQuery({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    systemId: filters.systemId,
    status: filters.status,
  })
  const response = await apiFetch(`/api/integration/read-source-configs${query}`)
  const data = await parseReadSourceResponse<unknown[]>(response)
  return (Array.isArray(data) ? data : [])
    .map(normalizeReadSourceConfigRow)
    .filter((row): row is ReadSourceConfigRow => row !== null)
}

export async function saveReadSourceConfigVersion(
  config: ReadSourceConfigPayload,
  scope: IntegrationScope,
): Promise<ReadSourceSaveResult> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-configs${query}`, {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
  const data = await parseReadSourceResponse<Record<string, unknown>>(response)
  return {
    id: typeof data?.id === 'string' ? data.id : '',
    version: safeCount(data?.version) ?? 0,
    status: typeof data?.status === 'string' && (READ_SOURCE_STATUSES as readonly string[]).includes(data.status)
      ? data.status as ReadSourceStatus
      : 'draft',
    reused: data?.reused === true,
    contentKey: typeof data?.contentKey === 'string' ? data.contentKey : '',
  }
}

export async function approveReadSourceConfig(id: string, scope: IntegrationScope): Promise<ReadSourceConfigRow | null> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-configs/${encodeURIComponent(id)}/approve${query}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return normalizeReadSourceConfigRow(await parseReadSourceResponse<unknown>(response))
}

export async function retireReadSourceConfig(id: string, scope: IntegrationScope): Promise<ReadSourceConfigRow | null> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-configs/${encodeURIComponent(id)}/retire${query}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return normalizeReadSourceConfigRow(await parseReadSourceResponse<unknown>(response))
}

export async function listReadSourceConfigAudit(id: string, scope: IntegrationScope): Promise<ReadSourceAuditRow[]> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/read-source-configs/${encodeURIComponent(id)}/audit${query}`)
  const data = await parseReadSourceResponse<unknown[]>(response)
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    if (!isPlainObject(row)) return []
    const action = row.action === 'save_version' || row.action === 'reuse_version' || row.action === 'status_change'
      ? row.action
      : null
    if (!action) return []
    return [{
      action,
      actor: typeof row.actor === 'string' ? row.actor : null,
      detail: isPlainObject(row.detail) ? row.detail : {},
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    }]
  })
}

export async function probeReadSourceConfig(
  systemId: string,
  input: { config: ReadSourceConfigPayload; boundedSmoke: boolean; key?: string },
  scope: IntegrationScope,
): Promise<ReadSourceProbeEvidence | null> {
  const query = buildQuery({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const body: Record<string, unknown> = {
    config: input.config,
    boundedSmoke: input.boundedSmoke,
  }
  // inputs.key rides BESIDE the contract only when the config declares a keyField (the
  // runtime fail-closes both a missing required key and a key supplied to a keyless plan).
  if (input.key !== undefined && input.key.trim() !== '') {
    body.inputs = { key: input.key.trim() }
  }
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/read-source-probe${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return normalizeReadSourceProbeEvidence(await parseReadSourceResponse<unknown>(response))
}
