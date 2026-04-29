import { apiFetch } from '../../utils/api'

export type IntegrationSystemStatus = 'active' | 'inactive' | 'error'
export type K3SqlServerMode = 'readonly' | 'middle-table' | 'stored-procedure'
export type IntegrationPipelineRunMode = 'manual' | 'incremental' | 'full'
export type K3WisePipelineTarget = 'material' | 'bom'
export type IntegrationPipelineRunStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type IntegrationDeadLetterStatus = 'open' | 'replayed' | 'discarded'

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

export interface IntegrationStagingDescriptor {
  id: string
  name: string
  fields: string[]
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

const WEBAPI_KIND = 'erp:k3-wise-webapi'
const SQLSERVER_KIND = 'erp:k3-wise-sqlserver'

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

export function validateK3WisePipelineTemplateForm(form: K3WiseSetupForm): K3WiseSetupValidationIssue[] {
  const issues: K3WiseSetupValidationIssue[] = []
  if (!trim(form.tenantId)) issues.push({ field: 'tenantId', message: 'tenantId is required' })
  if (!trim(form.sourceSystemId)) issues.push({ field: 'sourceSystemId', message: 'PLM source system ID is required' })
  if (!trim(form.webApiSystemId)) issues.push({ field: 'webApiSystemId', message: 'Save or select a K3 WISE WebAPI system before creating pipelines' })
  if (!trim(form.materialPipelineName)) issues.push({ field: 'materialPipelineName', message: 'Material pipeline name is required' })
  if (!trim(form.bomPipelineName)) issues.push({ field: 'bomPipelineName', message: 'BOM pipeline name is required' })
  if (!trim(form.materialStagingObjectId)) issues.push({ field: 'materialStagingObjectId', message: 'Material staging object is required' })
  if (!trim(form.bomStagingObjectId)) issues.push({ field: 'bomStagingObjectId', message: 'BOM staging object is required' })
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
