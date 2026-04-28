import { apiFetch } from '../../utils/api'

export type IntegrationSystemStatus = 'active' | 'inactive' | 'error'
export type K3SqlServerMode = 'readonly' | 'middle-table' | 'stored-procedure'

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

export interface K3WiseSetupForm {
  tenantId: string
  workspaceId: string
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
}

export interface K3WiseSetupPayloads {
  webApi: Record<string, unknown>
  sqlServer: Record<string, unknown> | null
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

function parsePositiveInteger(value: string, fallback: number): number {
  const normalized = trim(value)
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
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
      lcid: parsePositiveInteger(form.lcid, 2052),
      timeoutMs: parsePositiveInteger(form.timeoutMs, 30000),
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

export const K3_WISE_WEBAPI_KIND = WEBAPI_KIND
export const K3_WISE_SQLSERVER_KIND = SQLSERVER_KIND
