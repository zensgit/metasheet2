import { apiFetch } from '../../utils/api'

export type IntegrationSystemStatus = 'active' | 'inactive' | 'error'
export type K3SqlServerMode = 'readonly' | 'middle-table' | 'stored-procedure'
export type IntegrationPipelineRunMode = 'manual' | 'incremental' | 'full'
export type K3WisePipelineTarget = 'material' | 'bom'
export type IntegrationPipelineRunStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type IntegrationDeadLetterStatus = 'open' | 'replayed' | 'discarded'
export type PlmReadMethod = 'api' | 'database' | 'table' | 'file' | 'manual'

export interface IntegrationApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

export interface IntegrationExternalSystem {
  id: string
  tenantId: string
  workspaceId: string | null
  projectId?: string | null
  name: string
  kind: string
  role: 'source' | 'target' | 'bidirectional'
  config: Record<string, unknown>
  capabilities: Record<string, unknown>
  status: IntegrationSystemStatus
  lastTestedAt?: string | null
  lastError?: string | null
  hasCredentials?: boolean
  credentialFingerprint?: string | null
}

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
  mode: 'incremental' | 'full' | 'manual'
  idempotencyKeyFields: string[]
  options: Record<string, unknown>
  status: 'draft' | 'active' | 'paused' | 'disabled'
  fieldMappings?: Array<Record<string, unknown>>
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationPipelineRunResult {
  id?: string
  runId?: string
  pipelineId?: string
  status?: string
  dryRun?: boolean
  metrics?: Record<string, unknown>
  [key: string]: unknown
}

export interface IntegrationPipelineRun {
  id: string
  tenantId: string
  workspaceId: string | null
  pipelineId: string
  mode: IntegrationPipelineRunMode | string
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
  retryCount: number
  status: IntegrationDeadLetterStatus | string
  lastReplayRunId?: string | null
  payloadRedacted?: boolean
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationStagingFieldDetail {
  id: string
  name: string
  type: string
  options?: string[]
}

export interface IntegrationStagingDescriptor {
  id: string
  name: string
  fields: string[]
  fieldDetails?: IntegrationStagingFieldDetail[]
}

export interface IntegrationStagingInstallResult {
  sheetIds: Record<string, string>
  warnings: string[]
}

export interface K3WiseSetupForm {
  tenantId: string
  workspaceId: string
  projectId: string
  baseId: string
  operator: string
  webApiSystemId: string
  webApiHasCredentials: boolean
  webApiName: string
  version: string
  environment: 'test' | 'uat' | 'staging' | 'production' | 'other'
  baseUrl: string
  loginPath: string
  healthPath: string
  acctId: string
  username: string
  password: string
  lcid: string
  timeoutMs: string
  autoSubmit: boolean
  autoAudit: boolean
  materialSavePath: string
  materialSubmitPath: string
  materialAuditPath: string
  bomSavePath: string
  bomSubmitPath: string
  bomAuditPath: string
  sqlEnabled: boolean
  sqlSystemId: string
  sqlHasCredentials: boolean
  sqlName: string
  sqlMode: K3SqlServerMode
  sqlServer: string
  sqlDatabase: string
  sqlUsername: string
  sqlPassword: string
  sqlAllowedTables: string
  sqlMiddleTables: string
  sqlStoredProcedures: string
  plmKind: string
  plmReadMethod: PlmReadMethod
  plmBaseUrl: string
  plmDefaultProductId: string
  plmUsername: string
  plmPassword: string
  rollbackOwner: string
  rollbackStrategy: string
  bomEnabled: boolean
  bomProductId: string
  sourceSystemId: string
  materialPipelineName: string
  materialPipelineId: string
  bomPipelineName: string
  bomPipelineId: string
  materialStagingObjectId: string
  bomStagingObjectId: string
  pipelineRunMode: IntegrationPipelineRunMode
  pipelineSampleLimit: string
  pipelineCursor: string
  allowLivePipelineRun: boolean
}

export interface K3WiseSetupPayloads {
  webApi: Record<string, unknown>
  sqlServer: Record<string, unknown> | null
}

export interface K3WisePipelinePayloads {
  material: Record<string, unknown>
  bom: Record<string, unknown>
}

export interface K3WiseStagingInstallPayload {
  tenantId: string
  workspaceId: string | null
  projectId: string
  baseId?: string
}

export interface K3WisePipelineRunPayload {
  tenantId: string
  workspaceId?: string | null
  mode: IntegrationPipelineRunMode
  cursor?: string
  sampleLimit?: number
}

export interface K3WisePipelineObservationQuery {
  tenantId: string
  workspaceId?: string | null
  pipelineId: string
  status?: string
  limit?: number
  offset?: number
}

export interface K3WiseSetupValidationIssue {
  field: keyof K3WiseSetupForm | 'form'
  message: string
}

export interface K3WisePocCommandSet {
  postdeploySmoke: string
  postdeploySummary: string
  preflight: string
  offlineMock: string
  evidence: string
}

export interface K3WiseGateJsonImportResult {
  form: K3WiseSetupForm
  warnings: string[]
}

const WEBAPI_KIND = 'erp:k3-wise-webapi'
const SQLSERVER_KIND = 'erp:k3-wise-sqlserver'
const IMPORT_SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|sessionid|session_id|cookie|accesskey|access_key|privatekey|private_key|clientsecret|client_secret)/i

function trim(value: string): string {
  return value.trim()
}

function optionalString(value: string): string | undefined {
  const normalized = trim(value)
  return normalized.length > 0 ? normalized : undefined
}

export function splitList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isPositiveIntegerText(value: string): boolean {
  const normalized = trim(value)
  if (!normalized) return false
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed > 0
}

function parseRequiredPositiveInteger(value: string, field: keyof K3WiseSetupForm): number {
  const normalized = trim(value)
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const normalized = trim(value)
  if (!normalized) return undefined
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function assertRelativePath(value: string, field: keyof K3WiseSetupForm, issues: K3WiseSetupValidationIssue[]): void {
  const normalized = trim(value)
  if (!normalized) {
    issues.push({ field, message: `${field} is required` })
    return
  }
  if (/^https?:\/\//i.test(normalized)) {
    issues.push({ field, message: `${field} must be relative to the K3 WISE base URL` })
  }
}

function validateHttpUrl(value: string, field: keyof K3WiseSetupForm, issues: K3WiseSetupValidationIssue[]): void {
  const normalized = trim(value)
  if (!normalized) {
    issues.push({ field, message: `${field} is required` })
    return
  }
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({ field, message: `${field} must use http or https` })
    }
  } catch {
    issues.push({ field, message: `${field} must be a valid URL` })
  }
}

export function createDefaultK3WiseSetupForm(): K3WiseSetupForm {
  const tenantId = typeof localStorage === 'undefined' ? '' : localStorage.getItem('tenantId') || ''
  const workspaceId = typeof localStorage === 'undefined' ? '' : localStorage.getItem('workspaceId') || ''
  return {
    tenantId,
    workspaceId,
    projectId: '',
    baseId: '',
    operator: 'integration-operator',
    webApiSystemId: '',
    webApiHasCredentials: false,
    webApiName: 'K3 WISE WebAPI',
    version: '',
    environment: 'test',
    baseUrl: '',
    loginPath: '/K3API/Login',
    healthPath: '/K3API/Health',
    acctId: '',
    username: '',
    password: '',
    lcid: '2052',
    timeoutMs: '30000',
    autoSubmit: false,
    autoAudit: false,
    materialSavePath: '/K3API/Material/Save',
    materialSubmitPath: '/K3API/Material/Submit',
    materialAuditPath: '/K3API/Material/Audit',
    bomSavePath: '/K3API/BOM/Save',
    bomSubmitPath: '/K3API/BOM/Submit',
    bomAuditPath: '/K3API/BOM/Audit',
    sqlEnabled: false,
    sqlSystemId: '',
    sqlHasCredentials: false,
    sqlName: 'K3 WISE SQL Server',
    sqlMode: 'readonly',
    sqlServer: '',
    sqlDatabase: '',
    sqlUsername: '',
    sqlPassword: '',
    sqlAllowedTables: 't_ICItem\nt_ICBOM\nt_ICBomChild',
    sqlMiddleTables: '',
    sqlStoredProcedures: '',
    plmKind: 'plm:yuantus-wrapper',
    plmReadMethod: 'api',
    plmBaseUrl: '',
    plmDefaultProductId: '',
    plmUsername: '',
    plmPassword: '',
    rollbackOwner: '',
    rollbackStrategy: 'disable-test-records',
    bomEnabled: true,
    bomProductId: '',
    sourceSystemId: '',
    materialPipelineName: 'PLM Material to K3 WISE',
    materialPipelineId: '',
    bomPipelineName: 'PLM BOM to K3 WISE',
    bomPipelineId: '',
    materialStagingObjectId: 'standard_materials',
    bomStagingObjectId: 'bom_cleanse',
    pipelineRunMode: 'manual',
    pipelineSampleLimit: '20',
    pipelineCursor: '',
    allowLivePipelineRun: false,
  }
}

export function validateK3WiseSetupForm(form: K3WiseSetupForm): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form.webApiName)) issues.push({ field: 'webApiName', message: 'WebAPI system name is required' })
  if (!trim(form.version)) issues.push({ field: 'version', message: 'K3 WISE version is required' })
  const webApiCredentialTouched = Boolean(trim(form.username) || trim(form.password) || trim(form.acctId))
  const webApiCredentialRequired = !form.webApiSystemId || !form.webApiHasCredentials || webApiCredentialTouched
  if (webApiCredentialRequired && !trim(form.acctId)) issues.push({ field: 'acctId', message: 'acctId is required' })
  if (webApiCredentialRequired && !trim(form.username)) issues.push({ field: 'username', message: 'K3 WISE username is required' })
  if (webApiCredentialRequired && !trim(form.password)) {
    issues.push({ field: 'password', message: 'K3 WISE password is required when credentials are created or replaced' })
  }
  if (!isPositiveIntegerText(form.lcid)) {
    issues.push({ field: 'lcid', message: 'lcid must be a positive integer' })
  }
  if (!isPositiveIntegerText(form.timeoutMs)) {
    issues.push({ field: 'timeoutMs', message: 'timeoutMs must be a positive integer' })
  }
  validateHttpUrl(form.baseUrl, 'baseUrl', issues)
  assertRelativePath(form.loginPath, 'loginPath', issues)
  if (trim(form.healthPath)) assertRelativePath(form.healthPath, 'healthPath', issues)
  assertRelativePath(form.materialSavePath, 'materialSavePath', issues)
  assertRelativePath(form.bomSavePath, 'bomSavePath', issues)
  if (trim(form.materialSubmitPath)) assertRelativePath(form.materialSubmitPath, 'materialSubmitPath', issues)
  if (trim(form.materialAuditPath)) assertRelativePath(form.materialAuditPath, 'materialAuditPath', issues)
  if (trim(form.bomSubmitPath)) assertRelativePath(form.bomSubmitPath, 'bomSubmitPath', issues)
  if (trim(form.bomAuditPath)) assertRelativePath(form.bomAuditPath, 'bomAuditPath', issues)
  if (form.environment === 'production' && (form.autoSubmit || form.autoAudit)) {
    issues.push({ field: 'form', message: 'Production auto-submit/audit requires a separate approval policy' })
  }
  if (form.sqlEnabled) {
    if (!trim(form.sqlName)) issues.push({ field: 'sqlName', message: 'SQL Server system name is required' })
    if (!trim(form.sqlServer)) issues.push({ field: 'sqlServer', message: 'SQL Server host is required' })
    if (!trim(form.sqlDatabase)) issues.push({ field: 'sqlDatabase', message: 'SQL Server database is required' })
    if (splitList(form.sqlAllowedTables).length === 0) {
      issues.push({ field: 'sqlAllowedTables', message: 'At least one SQL Server table must be allowed' })
    }
    const sqlCredentialTouched = Boolean(trim(form.sqlUsername) || trim(form.sqlPassword))
    if (sqlCredentialTouched && (!trim(form.sqlUsername) || !trim(form.sqlPassword))) {
      issues.push({ field: 'sqlPassword', message: 'SQL Server credentials must include both username and password' })
    }
  }
  return issues
}

function normalizeSqlObjectLeaf(value: string): string {
  const parts = value
    .trim()
    .toLowerCase()
    .split('.')
    .map((part) => part.replace(/^[\[`"']+|[\]`"']+$/g, '').trim())
    .filter(Boolean)
  return parts[parts.length - 1] || ''
}

function isK3CoreBusinessTable(value: string): boolean {
  return new Set(['t_icitem', 't_icbom', 't_icbomchild']).has(normalizeSqlObjectLeaf(value))
}

export function validateK3WiseGateDraftForm(form: K3WiseSetupForm): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form.workspaceId)) issues.push({ field: 'workspaceId', message: 'workspaceId is required for live PoC GATE' })
  if (!trim(form.operator)) issues.push({ field: 'operator', message: 'operator is required for live PoC GATE' })
  if (!trim(form.version)) issues.push({ field: 'version', message: 'K3 WISE version is required' })
  if (!trim(form.acctId)) issues.push({ field: 'acctId', message: 'acctId is required' })
  validateHttpUrl(form.baseUrl, 'baseUrl', issues)
  if (form.environment === 'production') {
    issues.push({ field: 'environment', message: 'Live PoC GATE must target a non-production K3 WISE environment' })
  }
  if (form.autoSubmit || form.autoAudit) {
    issues.push({ field: 'form', message: 'Live PoC GATE must stay Save-only: autoSubmit and autoAudit must be false' })
  }
  if (!trim(form.plmKind)) issues.push({ field: 'plmKind', message: 'PLM kind is required' })
  if (!trim(form.plmReadMethod)) issues.push({ field: 'plmReadMethod', message: 'PLM read method is required' })
  if (trim(form.plmBaseUrl)) validateHttpUrl(form.plmBaseUrl, 'plmBaseUrl', issues)
  if (!trim(form.rollbackOwner)) issues.push({ field: 'rollbackOwner', message: 'Rollback owner is required' })
  if (!trim(form.rollbackStrategy)) issues.push({ field: 'rollbackStrategy', message: 'Rollback strategy is required' })
  if (form.bomEnabled && !trim(form.bomProductId) && !trim(form.plmDefaultProductId)) {
    issues.push({ field: 'bomProductId', message: 'BOM PoC requires BOM product ID or PLM default product ID' })
  }
  if (form.sqlEnabled && form.sqlMode !== 'readonly' && splitList(form.sqlAllowedTables).some(isK3CoreBusinessTable)) {
    issues.push({ field: 'sqlAllowedTables', message: 'Live PoC may not write K3 WISE core business tables' })
  }
  return issues
}

export function validateK3WisePipelineTemplateForm(
  form: K3WiseSetupForm,
  descriptors: IntegrationStagingDescriptor[] = [],
): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form.sourceSystemId)) issues.push({ field: 'sourceSystemId', message: 'PLM source system ID is required' })
  if (!trim(form.webApiSystemId)) issues.push({ field: 'webApiSystemId', message: 'Save or select a K3 WISE WebAPI system before creating pipelines' })
  if (!trim(form.materialPipelineName)) issues.push({ field: 'materialPipelineName', message: 'Material pipeline name is required' })
  if (!trim(form.bomPipelineName)) issues.push({ field: 'bomPipelineName', message: 'BOM pipeline name is required' })
  if (!trim(form.materialStagingObjectId)) issues.push({ field: 'materialStagingObjectId', message: 'Material staging object is required' })
  if (!trim(form.bomStagingObjectId)) issues.push({ field: 'bomStagingObjectId', message: 'BOM staging object is required' })
  if (descriptors.length > 0) {
    const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id))
    if (trim(form.materialStagingObjectId) && !descriptorIds.has(trim(form.materialStagingObjectId))) {
      issues.push({ field: 'materialStagingObjectId', message: 'Material staging object must match a loaded descriptor' })
    }
    if (trim(form.bomStagingObjectId) && !descriptorIds.has(trim(form.bomStagingObjectId))) {
      issues.push({ field: 'bomStagingObjectId', message: 'BOM staging object must match a loaded descriptor' })
    }
  }
  return issues
}

export function validateK3WiseStagingInstallForm(form: K3WiseSetupForm): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form.projectId)) issues.push({ field: 'projectId', message: 'projectId is required before installing staging tables' })
  return issues
}

export function validateK3WisePipelineRunForm(
  form: K3WiseSetupForm,
  target: K3WisePipelineTarget,
): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  const pipelineField: keyof K3WiseSetupForm = target === 'material' ? 'materialPipelineId' : 'bomPipelineId'
  const pipelineId = trim(form[pipelineField])
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!pipelineId) {
    issues.push({
      field: pipelineField,
      message: `${target === 'material' ? 'Material' : 'BOM'} pipeline ID is required before dry-run or run`,
    })
  }
  if (!['manual', 'incremental', 'full'].includes(form.pipelineRunMode)) {
    issues.push({ field: 'pipelineRunMode', message: 'Pipeline run mode must be manual, incremental, or full' })
  }
  if (trim(form.pipelineSampleLimit) && parseOptionalPositiveInteger(form.pipelineSampleLimit) === undefined) {
    issues.push({ field: 'pipelineSampleLimit', message: 'Sample limit must be a positive integer' })
  }
  return issues
}

export function validateK3WisePipelineObservationForm(
  form: K3WiseSetupForm,
  target: K3WisePipelineTarget,
): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  const pipelineField: keyof K3WiseSetupForm = target === 'material' ? 'materialPipelineId' : 'bomPipelineId'
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form[pipelineField])) {
    issues.push({
      field: pipelineField,
      message: `${target === 'material' ? 'Material' : 'BOM'} pipeline ID is required before loading run history`,
    })
  }
  return issues
}

export function buildK3WiseStagingInstallPayload(form: K3WiseSetupForm): K3WiseStagingInstallPayload {
  const issues = validateK3WiseStagingInstallForm(form)
  if (issues.length > 0) {
    throw new Error(issues[0].message)
  }
  return {
    tenantId: trim(form.tenantId),
    workspaceId: optionalString(form.workspaceId) ?? null,
    projectId: trim(form.projectId),
    ...(optionalString(form.baseId) ? { baseId: trim(form.baseId) } : {}),
  }
}

export function getIntegrationStagingFieldCount(descriptor: IntegrationStagingDescriptor): number {
  return descriptor.fieldDetails?.length || descriptor.fields.length
}

export function formatIntegrationStagingDescriptorFieldSummary(descriptor: IntegrationStagingDescriptor): string {
  const details = descriptor.fieldDetails || []
  if (details.length === 0) return `${descriptor.fields.length} fields`
  const selectFields = details
    .filter((field) => field.type === 'select')
    .map((field) => {
      const optionCount = Array.isArray(field.options) ? field.options.length : 0
      return `${field.id}(${optionCount})`
    })
  const typeCounts = details.reduce<Record<string, number>>((acc, field) => {
    acc[field.type] = (acc[field.type] || 0) + 1
    return acc
  }, {})
  const typeText = Object.entries(typeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
    .join(', ')
  return selectFields.length > 0
    ? `${details.length} fields · ${typeText} · select ${selectFields.join(', ')}`
    : `${details.length} fields · ${typeText}`
}

function credentialPlaceholder(): string {
  return '<fill-outside-git>'
}

function buildMaterialGateMappings(): Array<Record<string, unknown>> {
  return [
    { sourceField: 'code', targetField: 'FNumber', transform: { type: 'upperTrim' }, validation: [{ type: 'required' }] },
    { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
    { sourceField: 'uom', targetField: 'FBaseUnitID', transform: { type: 'dictMap', dictionary: 'unit' } },
    { sourceField: 'spec', targetField: 'FModel', transform: { type: 'trim' } },
  ]
}

function buildBomGateMappings(): Array<Record<string, unknown>> {
  return [
    { sourceField: 'parentCode', targetField: 'FParentItemNumber', validation: [{ type: 'required' }] },
    { sourceField: 'childCode', targetField: 'FChildItems[].FItemNumber', validation: [{ type: 'required' }] },
    { sourceField: 'quantity', targetField: 'FChildItems[].FQty', transform: { type: 'toNumber' } },
  ]
}

export function buildK3WiseGateDraft(form: K3WiseSetupForm): Record<string, unknown> {
  const issues = validateK3WiseGateDraftForm(form)
  if (issues.length > 0) {
    throw new Error(issues[0].message)
  }

  const plmConfig: Record<string, unknown> = {}
  if (trim(form.plmDefaultProductId)) plmConfig.defaultProductId = trim(form.plmDefaultProductId)

  return {
    tenantId: trim(form.tenantId),
    workspaceId: trim(form.workspaceId),
    ...(optionalString(form.projectId) ? { projectId: trim(form.projectId) } : {}),
    operator: trim(form.operator),
    k3Wise: {
      version: trim(form.version),
      apiUrl: trim(form.baseUrl),
      acctId: trim(form.acctId),
      environment: form.environment,
      credentials: {
        username: trim(form.username) || credentialPlaceholder(),
        password: credentialPlaceholder(),
      },
      autoSubmit: false,
      autoAudit: false,
    },
    plm: {
      kind: trim(form.plmKind),
      readMethod: form.plmReadMethod,
      ...(optionalString(form.plmBaseUrl) ? { baseUrl: trim(form.plmBaseUrl) } : {}),
      ...(Object.keys(plmConfig).length > 0 ? { config: plmConfig } : {}),
      credentials: {
        username: trim(form.plmUsername) || credentialPlaceholder(),
        password: credentialPlaceholder(),
      },
    },
    sqlServer: {
      enabled: form.sqlEnabled,
      mode: form.sqlEnabled ? form.sqlMode : 'readonly',
      ...(optionalString(form.sqlServer) ? { server: trim(form.sqlServer) } : {}),
      ...(optionalString(form.sqlDatabase) ? { database: trim(form.sqlDatabase) } : {}),
      allowedTables: splitList(form.sqlAllowedTables),
      middleTables: splitList(form.sqlMiddleTables),
      storedProcedures: splitList(form.sqlStoredProcedures),
      writeCoreTables: false,
    },
    rollback: {
      owner: trim(form.rollbackOwner),
      strategy: trim(form.rollbackStrategy),
    },
    bom: {
      enabled: form.bomEnabled,
      ...(form.bomEnabled ? { productId: trim(form.bomProductId) || trim(form.plmDefaultProductId) } : {}),
    },
    fieldMappings: {
      material: buildMaterialGateMappings(),
      ...(form.bomEnabled ? { bom: buildBomGateMappings() } : {}),
    },
  }
}

export function stringifyK3WiseGateDraft(form: K3WiseSetupForm): string {
  return JSON.stringify(buildK3WiseGateDraft(form), null, 2)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  return isPlainRecord(value) ? value : null
}

function importedString(value: unknown): string {
  if (typeof value === 'string') return trim(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function firstImportedString(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    if (!hasOwn(record, key)) continue
    const value = importedString(record[key])
    if (value) return value
  }
  return ''
}

function firstImportedValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined
  for (const key of keys) {
    if (hasOwn(record, key)) return record[key]
  }
  return undefined
}

function importedListText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => importedString(item)).filter(Boolean).join('\n')
  }
  if (typeof value === 'string') {
    return splitList(value).join('\n')
  }
  return ''
}

function normalizeImportedBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
  warnings: Set<string>,
): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 0 || value === 1) return value === 1
    warnings.add(`${field} ignored because it is not a boolean-like value`)
    return fallback
  }
  if (typeof value !== 'string') {
    warnings.add(`${field} ignored because it is not a boolean-like value`)
    return fallback
  }

  const normalized = trim(value).toLowerCase()
  if (['true', '1', 'yes', 'y', 'on', '是', '启用', '开启', '开'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭', '关'].includes(normalized)) return false
  warnings.add(`${field} ignored because it is not a boolean-like value`)
  return fallback
}

function normalizeImportedEnvironment(
  value: unknown,
  fallback: K3WiseSetupForm['environment'],
  warnings: Set<string>,
): K3WiseSetupForm['environment'] {
  const normalized = importedString(value).toLowerCase()
  if (!normalized) return fallback
  if (['test', 'testing', '测试'].includes(normalized)) return 'test'
  if (['uat', '用户验收'].includes(normalized)) return 'uat'
  if (['staging', 'stage', 'pre', '预发'].includes(normalized)) return 'staging'
  if (['production', 'prod', '生产'].includes(normalized)) return 'production'
  if (normalized === 'other') return 'other'
  warnings.add(`k3Wise.environment "${importedString(value)}" mapped to other`)
  return 'other'
}

function normalizeImportedSqlMode(
  value: unknown,
  fallback: K3SqlServerMode,
  warnings: Set<string>,
): K3SqlServerMode {
  const normalized = importedString(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  if (!normalized) return fallback
  if (['readonly', 'read-only', 'ro', '只读'].includes(normalized)) return 'readonly'
  if (['middle-table', 'integration-table', 'staging-table', '中间表'].includes(normalized)) return 'middle-table'
  if (['stored-procedure', 'procedure', 'proc', 'sp', '存储过程'].includes(normalized)) return 'stored-procedure'
  warnings.add(`sqlServer.mode "${importedString(value)}" ignored; kept ${fallback}`)
  return fallback
}

function normalizeImportedPlmReadMethod(
  value: unknown,
  fallback: PlmReadMethod,
  warnings: Set<string>,
): PlmReadMethod {
  const normalized = importedString(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  if (!normalized) return fallback
  if (['api', 'rest', 'webapi', 'interface', '接口'].includes(normalized)) return 'api'
  if (['database', 'db', 'sql', '数据库'].includes(normalized)) return 'database'
  if (['table', 'data-table', '数据表', '表'].includes(normalized)) return 'table'
  if (['file', 'excel', 'csv', '文件'].includes(normalized)) return 'file'
  if (['manual', 'hand', '手工', '手动'].includes(normalized)) return 'manual'
  warnings.add(`plm.readMethod "${importedString(value)}" ignored; mapped to manual`)
  return 'manual'
}

function hasPresentSecretValue(value: unknown): boolean {
  if (typeof value === 'string') return trim(value).length > 0
  if (Array.isArray(value)) return value.length > 0
  if (isPlainRecord(value)) return Object.keys(value).length > 0
  return value !== undefined && value !== null
}

function collectIgnoredSecretWarnings(value: unknown, path: string, warnings: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIgnoredSecretWarnings(item, `${path}[${index}]`, warnings))
    return
  }
  if (!isPlainRecord(value)) return

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    if (IMPORT_SECRET_KEY_PATTERN.test(key) && hasPresentSecretValue(child)) {
      warnings.add(`${nextPath} ignored; enter it in the credential form if needed`)
      continue
    }
    collectIgnoredSecretWarnings(child, nextPath, warnings)
  }
}

function hasImportedSqlConfig(sqlServer: Record<string, unknown>): boolean {
  return ['mode', 'server', 'database', 'allowedTables', 'middleTables', 'storedProcedures'].some((key) => {
    if (!hasOwn(sqlServer, key)) return false
    const value = sqlServer[key]
    if (Array.isArray(value)) return value.length > 0
    if (isPlainRecord(value)) return Object.keys(value).length > 0
    return importedString(value).length > 0 || typeof value === 'boolean'
  })
}

export function parseK3WiseGateJsonText(jsonText: string): Record<string, unknown> {
  const normalized = trim(jsonText)
  if (!normalized) {
    throw new Error('GATE JSON is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    throw new Error('GATE JSON must be valid JSON')
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('GATE JSON must be an object')
  }
  return parsed
}

export function applyK3WiseGateJsonToForm(form: K3WiseSetupForm, jsonText: string): K3WiseGateJsonImportResult {
  const draft = parseK3WiseGateJsonText(jsonText)
  const warnings = new Set<string>()
  collectIgnoredSecretWarnings(draft, '', warnings)

  const k3Wise = recordAt(draft, 'k3Wise')
  const k3Credentials = recordAt(k3Wise || {}, 'credentials')
  const plm = recordAt(draft, 'plm')
  const plmCredentials = recordAt(plm || {}, 'credentials')
  const plmConfig = recordAt(plm || {}, 'config')
  const sqlServer = recordAt(draft, 'sqlServer')
  const sqlCredentials = recordAt(sqlServer || {}, 'credentials')
  const rollback = recordAt(draft, 'rollback')
  const bom = recordAt(draft, 'bom')

  const next: K3WiseSetupForm = {
    ...form,
    password: '',
    plmPassword: '',
    sqlPassword: '',
  }

  const tenantId = firstImportedString(draft, ['tenantId'])
  if (tenantId) next.tenantId = tenantId
  const workspaceId = firstImportedString(draft, ['workspaceId'])
  if (workspaceId) next.workspaceId = workspaceId
  const projectId = firstImportedString(draft, ['projectId'])
  if (projectId) next.projectId = projectId
  const operator = firstImportedString(draft, ['operator'])
  if (operator) next.operator = operator

  const version = firstImportedString(k3Wise, ['version'])
  if (version) next.version = version
  const baseUrl = firstImportedString(k3Wise, ['apiUrl', 'baseUrl', 'url'])
  if (baseUrl) next.baseUrl = baseUrl
  const acctId = firstImportedString(k3Wise, ['acctId', 'accountId', 'account'])
  if (acctId) next.acctId = acctId
  next.environment = normalizeImportedEnvironment(firstImportedValue(k3Wise, ['environment']), next.environment, warnings)
  const username = firstImportedString(k3Credentials, ['username', 'userName', 'user']) || firstImportedString(k3Wise, ['username', 'userName', 'user'])
  if (username) next.username = username
  next.autoSubmit = normalizeImportedBoolean(firstImportedValue(k3Wise, ['autoSubmit']), next.autoSubmit, 'k3Wise.autoSubmit', warnings)
  next.autoAudit = normalizeImportedBoolean(firstImportedValue(k3Wise, ['autoAudit']), next.autoAudit, 'k3Wise.autoAudit', warnings)

  const plmKind = firstImportedString(plm, ['kind', 'type'])
  if (plmKind) next.plmKind = plmKind
  next.plmReadMethod = normalizeImportedPlmReadMethod(firstImportedValue(plm, ['readMethod']), next.plmReadMethod, warnings)
  const plmBaseUrl = firstImportedString(plm, ['baseUrl', 'apiUrl', 'url'])
  if (plmBaseUrl) next.plmBaseUrl = plmBaseUrl
  const plmDefaultProductId =
    firstImportedString(plm, ['defaultProductId', 'productId']) ||
    firstImportedString(plmConfig, ['defaultProductId', 'productId'])
  if (plmDefaultProductId) next.plmDefaultProductId = plmDefaultProductId
  const plmUsername = firstImportedString(plmCredentials, ['username', 'userName', 'user']) || firstImportedString(plm, ['username', 'userName', 'user'])
  if (plmUsername) next.plmUsername = plmUsername

  if (sqlServer) {
    const enabledValue = firstImportedValue(sqlServer, ['enabled'])
    next.sqlEnabled = enabledValue === undefined
      ? (hasImportedSqlConfig(sqlServer) || next.sqlEnabled)
      : normalizeImportedBoolean(enabledValue, next.sqlEnabled, 'sqlServer.enabled', warnings)
    next.sqlMode = normalizeImportedSqlMode(firstImportedValue(sqlServer, ['mode']), next.sqlMode, warnings)
    const sqlHost = firstImportedString(sqlServer, ['server', 'host'])
    if (sqlHost) next.sqlServer = sqlHost
    const database = firstImportedString(sqlServer, ['database', 'dbName'])
    if (database) next.sqlDatabase = database
    const sqlUsername = firstImportedString(sqlCredentials, ['username', 'userName', 'user']) || firstImportedString(sqlServer, ['username', 'userName', 'user'])
    if (sqlUsername) next.sqlUsername = sqlUsername
    if (hasOwn(sqlServer, 'allowedTables')) next.sqlAllowedTables = importedListText(sqlServer.allowedTables)
    if (hasOwn(sqlServer, 'middleTables')) next.sqlMiddleTables = importedListText(sqlServer.middleTables)
    if (hasOwn(sqlServer, 'storedProcedures')) next.sqlStoredProcedures = importedListText(sqlServer.storedProcedures)
  }

  const rollbackOwner = firstImportedString(rollback, ['owner'])
  if (rollbackOwner) next.rollbackOwner = rollbackOwner
  const rollbackStrategy = firstImportedString(rollback, ['strategy'])
  if (rollbackStrategy) next.rollbackStrategy = rollbackStrategy

  if (bom) {
    next.bomEnabled = normalizeImportedBoolean(firstImportedValue(bom, ['enabled']), next.bomEnabled, 'bom.enabled', warnings)
    const bomProductId = firstImportedString(bom, ['productId'])
    if (bomProductId) next.bomProductId = bomProductId
  }

  return {
    form: next,
    warnings: Array.from(warnings),
  }
}

export function buildK3WisePocCommandSet(gatePath = 'artifacts/integration-live-poc/gate.json'): K3WisePocCommandSet {
  return {
    postdeploySmoke: 'node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --base-url "$METASHEET_BASE_URL" --token-file "$METASHEET_AUTH_TOKEN_FILE" --tenant-id "$METASHEET_TENANT_ID" --require-auth --out-dir artifacts/integration-live-poc/postdeploy-smoke',
    postdeploySummary: 'node scripts/ops/integration-k3wise-postdeploy-summary.mjs --input artifacts/integration-live-poc/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json --require-auth-signoff',
    preflight: `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input ${gatePath} --out-dir artifacts/integration-live-poc`,
    offlineMock: 'pnpm run verify:integration-k3wise:poc',
    evidence: 'node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet artifacts/integration-live-poc/packet.json --evidence artifacts/integration-live-poc/evidence.json --out-dir artifacts/integration-live-poc/evidence',
  }
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`
}

export function buildK3WisePocEnvironmentTemplate(form: Pick<K3WiseSetupForm, 'tenantId'>): string {
  const tenantId = trim(form.tenantId) || '<tenant-id>'
  return [
    `export METASHEET_BASE_URL=${shellDoubleQuote('https://metasheet.example.test')}`,
    `export METASHEET_AUTH_TOKEN_FILE=${shellDoubleQuote('/secure/path/metasheet-admin.jwt')}`,
    `export METASHEET_TENANT_ID=${shellDoubleQuote(tenantId)}`,
  ].join('\n')
}

export function getK3WisePipelineId(form: K3WiseSetupForm, target: K3WisePipelineTarget): string {
  return target === 'material' ? trim(form.materialPipelineId) : trim(form.bomPipelineId)
}

export function buildK3WisePipelineRunPayload(form: K3WiseSetupForm, target: K3WisePipelineTarget): K3WisePipelineRunPayload {
  const issues = validateK3WisePipelineRunForm(form, target)
  if (issues.length > 0) {
    throw new Error(issues[0].message)
  }

  const payload: K3WisePipelineRunPayload = {
    tenantId: trim(form.tenantId),
    workspaceId: optionalString(form.workspaceId) ?? null,
    mode: form.pipelineRunMode,
  }
  const sampleLimit = parseOptionalPositiveInteger(form.pipelineSampleLimit)
  if (sampleLimit !== undefined) payload.sampleLimit = sampleLimit
  const cursor = optionalString(form.pipelineCursor)
  if (cursor) payload.cursor = cursor
  return payload
}

export function buildK3WisePipelineObservationQuery(
  form: K3WiseSetupForm,
  target: K3WisePipelineTarget,
  options: { status?: string; limit?: number; offset?: number } = {},
): K3WisePipelineObservationQuery {
  const issues = validateK3WisePipelineObservationForm(form, target)
  if (issues.length > 0) {
    throw new Error(issues[0].message)
  }

  const limit = options.limit
  const offset = options.offset
  return {
    tenantId: trim(form.tenantId),
    workspaceId: optionalString(form.workspaceId) ?? null,
    pipelineId: getK3WisePipelineId(form, target),
    ...(options.status ? { status: options.status } : {}),
    ...(typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    ...(typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? { offset } : {}),
  }
}

export function buildK3WiseSetupPayloads(form: K3WiseSetupForm): K3WiseSetupPayloads {
  const workspaceId = optionalString(form.workspaceId) ?? null
  const baseSystem = {
    tenantId: trim(form.tenantId),
    workspaceId,
    status: 'active',
  }
  const webApiCredentials: Record<string, unknown> = {}
  if (trim(form.username) || trim(form.acctId) || trim(form.password)) {
    webApiCredentials.username = trim(form.username)
    webApiCredentials.acctId = trim(form.acctId)
    webApiCredentials.password = form.password
  }
  const webApi = {
    ...baseSystem,
    ...(optionalString(form.webApiSystemId) ? { id: trim(form.webApiSystemId) } : {}),
    name: trim(form.webApiName),
    kind: WEBAPI_KIND,
    role: 'target',
    config: {
      version: trim(form.version),
      environment: form.environment,
      baseUrl: trim(form.baseUrl),
      loginPath: trim(form.loginPath),
      ...(optionalString(form.healthPath) ? { healthPath: trim(form.healthPath) } : {}),
      lcid: parseRequiredPositiveInteger(form.lcid, 'lcid'),
      timeoutMs: parseRequiredPositiveInteger(form.timeoutMs, 'timeoutMs'),
      autoSubmit: form.autoSubmit,
      autoAudit: form.autoAudit,
      objects: {
        material: {
          savePath: trim(form.materialSavePath),
          ...(optionalString(form.materialSubmitPath) ? { submitPath: trim(form.materialSubmitPath) } : {}),
          ...(optionalString(form.materialAuditPath) ? { auditPath: trim(form.materialAuditPath) } : {}),
          keyField: 'FNumber',
        },
        bom: {
          savePath: trim(form.bomSavePath),
          ...(optionalString(form.bomSubmitPath) ? { submitPath: trim(form.bomSubmitPath) } : {}),
          ...(optionalString(form.bomAuditPath) ? { auditPath: trim(form.bomAuditPath) } : {}),
          keyField: 'FNumber',
        },
      },
    },
    ...(Object.keys(webApiCredentials).length > 0 ? { credentials: webApiCredentials } : {}),
    capabilities: {
      write: true,
      material: true,
      bom: true,
    },
  }

  if (!form.sqlEnabled) {
    return { webApi, sqlServer: null }
  }

  const allowedTables = splitList(form.sqlAllowedTables)
  const middleTables = splitList(form.sqlMiddleTables)
  const storedProcedures = splitList(form.sqlStoredProcedures)
  const sqlCredentials: Record<string, unknown> = {}
  if (trim(form.sqlUsername)) sqlCredentials.username = trim(form.sqlUsername)
  if (trim(form.sqlPassword)) sqlCredentials.password = form.sqlPassword
  const sqlServer = {
    ...baseSystem,
    ...(optionalString(form.sqlSystemId) ? { id: trim(form.sqlSystemId) } : {}),
    name: trim(form.sqlName),
    kind: SQLSERVER_KIND,
    role: 'bidirectional',
    config: {
      mode: form.sqlMode,
      server: trim(form.sqlServer),
      database: trim(form.sqlDatabase),
      allowedTables,
      middleTables,
      storedProcedures,
      readTables: allowedTables,
      writeTables: middleTables,
      objects: {
        material: {
          table: allowedTables[0] || 't_ICItem',
          operations: ['read'],
          columns: ['FItemID', 'FNumber', 'FName', 'FModel'],
        },
        bom: {
          table: allowedTables.find((table) => /t_ICBOM$/i.test(table)) || 't_ICBOM',
          operations: ['read'],
        },
        bom_child: {
          table: allowedTables.find((table) => /t_ICBomChild$/i.test(table)) || 't_ICBomChild',
          operations: ['read'],
        },
        ...(middleTables[0]
          ? {
              material_stage: {
                table: middleTables[0],
                operations: ['upsert'],
                writeMode: 'middle-table',
                keyField: 'FNumber',
              },
            }
          : {}),
      },
    },
    ...(Object.keys(sqlCredentials).length > 0 ? { credentials: sqlCredentials } : {}),
    capabilities: {
      read: true,
      write: middleTables.length > 0,
      sqlServer: true,
    },
  }

  return { webApi, sqlServer }
}

export function buildK3WisePipelinePayloads(form: K3WiseSetupForm): K3WisePipelinePayloads {
  const issues = validateK3WisePipelineTemplateForm(form)
  if (issues.length > 0) {
    throw new Error(issues[0].message)
  }

  const tenantId = trim(form.tenantId)
  const workspaceId = optionalString(form.workspaceId) ?? null
  const projectId = optionalString(form.projectId) ?? null
  const sourceSystemId = trim(form.sourceSystemId)
  const targetSystemId = trim(form.webApiSystemId)
  const base = {
    tenantId,
    workspaceId,
    ...(projectId ? { projectId } : {}),
    sourceSystemId,
    targetSystemId,
    status: 'draft',
  }

  return {
    material: {
      ...base,
      name: trim(form.materialPipelineName),
      description: 'Draft PLM material cleansing pipeline generated from the K3 WISE setup page.',
      sourceObject: 'materials',
      targetObject: 'material',
      mode: 'incremental',
      idempotencyKeyFields: ['sourceId', 'revision'],
      options: {
        batchSize: 100,
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
        watermark: {
          type: 'updated_at',
          field: 'updatedAt',
        },
        erpFeedback: {
          objectId: trim(form.materialStagingObjectId),
          keyField: '_integration_idempotency_key',
        },
      },
      fieldMappings: [
        {
          sourceField: 'code',
          targetField: 'FNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'name',
          targetField: 'FName',
          transform: { fn: 'trim' },
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'spec',
          targetField: 'FModel',
          transform: { fn: 'trim' },
        },
        {
          sourceField: 'uom',
          targetField: 'FBaseUnitID',
          transform: {
            fn: 'dictMap',
            map: {
              PCS: 'Pcs',
              EA: 'Pcs',
              KG: 'Kg',
            },
          },
        },
        {
          sourceField: 'sourceId',
          targetField: 'sourceId',
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'revision',
          targetField: 'revision',
          defaultValue: 'A',
        },
      ],
    },
    bom: {
      ...base,
      name: trim(form.bomPipelineName),
      description: 'Draft PLM BOM cleansing pipeline generated from the K3 WISE setup page.',
      sourceObject: 'bom',
      targetObject: 'bom',
      mode: 'manual',
      idempotencyKeyFields: ['sourceId', 'revision'],
      options: {
        batchSize: 50,
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
        erpFeedback: {
          objectId: trim(form.bomStagingObjectId),
          keyField: '_integration_idempotency_key',
        },
      },
      fieldMappings: [
        {
          sourceField: 'parentCode',
          targetField: 'FParentItemNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'childCode',
          targetField: 'FChildItemNumber',
          transform: ['trim', 'upper'],
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'quantity',
          targetField: 'FQty',
          transform: { fn: 'toNumber' },
          validation: [{ type: 'min', value: 0.000001 }],
        },
        {
          sourceField: 'uom',
          targetField: 'FUnitID',
          transform: { fn: 'trim' },
        },
        {
          sourceField: 'sequence',
          targetField: 'FEntryID',
          transform: { fn: 'toNumber' },
        },
        {
          sourceField: 'sourceId',
          targetField: 'sourceId',
          validation: [{ type: 'required' }],
        },
        {
          sourceField: 'revision',
          targetField: 'revision',
          defaultValue: 'A',
        },
      ],
    },
  }
}

export function applyExternalSystemToForm(form: K3WiseSetupForm, system: IntegrationExternalSystem): K3WiseSetupForm {
  const next = { ...form }
  if (system.kind === WEBAPI_KIND) {
    const config = system.config || {}
    const objects = (config.objects && typeof config.objects === 'object' ? config.objects : {}) as Record<string, Record<string, unknown>>
    const material = objects.material || {}
    const bom = objects.bom || {}
    next.webApiSystemId = system.id
    next.webApiHasCredentials = system.hasCredentials === true
    next.tenantId = system.tenantId || next.tenantId
    next.workspaceId = system.workspaceId || ''
    next.webApiName = system.name
    next.version = typeof config.version === 'string' ? config.version : next.version
    next.environment = typeof config.environment === 'string' ? config.environment as K3WiseSetupForm['environment'] : next.environment
    next.baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : next.baseUrl
    next.loginPath = typeof config.loginPath === 'string' ? config.loginPath : next.loginPath
    next.healthPath = typeof config.healthPath === 'string' ? config.healthPath : next.healthPath
    next.lcid = config.lcid === undefined ? next.lcid : String(config.lcid)
    next.timeoutMs = config.timeoutMs === undefined ? next.timeoutMs : String(config.timeoutMs)
    next.autoSubmit = config.autoSubmit === true
    next.autoAudit = config.autoAudit === true
    next.materialSavePath = typeof material.savePath === 'string' ? material.savePath : next.materialSavePath
    next.materialSubmitPath = typeof material.submitPath === 'string' ? material.submitPath : next.materialSubmitPath
    next.materialAuditPath = typeof material.auditPath === 'string' ? material.auditPath : next.materialAuditPath
    next.bomSavePath = typeof bom.savePath === 'string' ? bom.savePath : next.bomSavePath
    next.bomSubmitPath = typeof bom.submitPath === 'string' ? bom.submitPath : next.bomSubmitPath
    next.bomAuditPath = typeof bom.auditPath === 'string' ? bom.auditPath : next.bomAuditPath
  }
  if (system.kind === SQLSERVER_KIND) {
    const config = system.config || {}
    next.sqlEnabled = true
    next.sqlSystemId = system.id
    next.sqlHasCredentials = system.hasCredentials === true
    next.tenantId = system.tenantId || next.tenantId
    next.workspaceId = system.workspaceId || ''
    next.sqlName = system.name
    next.sqlMode = typeof config.mode === 'string' ? config.mode as K3SqlServerMode : next.sqlMode
    next.sqlServer = typeof config.server === 'string' ? config.server : next.sqlServer
    next.sqlDatabase = typeof config.database === 'string' ? config.database : next.sqlDatabase
    next.sqlAllowedTables = Array.isArray(config.allowedTables) ? config.allowedTables.join('\n') : next.sqlAllowedTables
    next.sqlMiddleTables = Array.isArray(config.middleTables) ? config.middleTables.join('\n') : next.sqlMiddleTables
    next.sqlStoredProcedures = Array.isArray(config.storedProcedures) ? config.storedProcedures.join('\n') : next.sqlStoredProcedures
  }
  return next
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

export async function listIntegrationSystems(
  kind: string,
  scope: { tenantId?: string; workspaceId?: string | null } = {},
): Promise<IntegrationExternalSystem[]> {
  const params = new URLSearchParams({ kind })
  if (scope.tenantId && scope.tenantId.trim()) params.set('tenantId', scope.tenantId.trim())
  if (scope.workspaceId && scope.workspaceId.trim()) params.set('workspaceId', scope.workspaceId.trim())
  const response = await apiFetch(`/api/integration/external-systems?${params.toString()}`)
  const data = await parseIntegrationResponse<IntegrationExternalSystem[]>(response)
  return Array.isArray(data) ? data : []
}

export async function upsertIntegrationSystem(payload: Record<string, unknown>): Promise<IntegrationExternalSystem> {
  const response = await apiFetch('/api/integration/external-systems', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationExternalSystem>(response)
}

export async function testIntegrationSystem(systemId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/test`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return parseIntegrationResponse<Record<string, unknown>>(response)
}

export async function upsertIntegrationPipeline(payload: Record<string, unknown>): Promise<IntegrationPipeline> {
  const response = await apiFetch('/api/integration/pipelines', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipeline>(response)
}

export async function runIntegrationPipeline(
  pipelineId: string,
  payload: K3WisePipelineRunPayload,
  dryRun = false,
): Promise<IntegrationPipelineRunResult> {
  const endpoint = dryRun ? 'dry-run' : 'run'
  const response = await apiFetch(`/api/integration/pipelines/${encodeURIComponent(pipelineId)}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipelineRunResult>(response)
}

function buildQueryString(input: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params.toString()
}

export async function listIntegrationPipelineRuns(query: K3WisePipelineObservationQuery): Promise<IntegrationPipelineRun[]> {
  const response = await apiFetch(`/api/integration/runs?${buildQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationPipelineRun[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listIntegrationDeadLetters(query: K3WisePipelineObservationQuery): Promise<IntegrationDeadLetter[]> {
  const response = await apiFetch(`/api/integration/dead-letters?${buildQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationDeadLetter[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listIntegrationStagingDescriptors(): Promise<IntegrationStagingDescriptor[]> {
  const response = await apiFetch('/api/integration/staging/descriptors')
  const data = await parseIntegrationResponse<IntegrationStagingDescriptor[]>(response)
  return Array.isArray(data) ? data : []
}

export async function installIntegrationStaging(payload: K3WiseStagingInstallPayload): Promise<IntegrationStagingInstallResult> {
  const response = await apiFetch('/api/integration/staging/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationStagingInstallResult>(response)
}

export const K3_WISE_WEBAPI_KIND = WEBAPI_KIND
export const K3_WISE_SQLSERVER_KIND = SQLSERVER_KIND
