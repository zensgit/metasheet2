#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_TOP_LEVEL = ['tenantId', 'workspaceId', 'k3Wise', 'plm', 'rollback']
const SECRET_KEY_PATTERN = /password|secret|token|session|credential|api[-_]?key|authorization/i
const NON_PRODUCTION_ENVS = new Set(['test', 'testing', 'uat', 'sandbox', 'staging', 'dev', 'development'])
const K3_CORE_TABLES = new Set(['t_icitem', 't_icbom', 't_icbomchild'])
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])
const SQL_MODE_ALIASES = new Map([
  ['read only', 'readonly'],
  ['read-only', 'readonly'],
  ['read_only', 'readonly'],
  ['middle table', 'middle-table'],
  ['middle_table', 'middle-table'],
  ['stored procedure', 'stored-procedure'],
  ['stored_procedure', 'stored-procedure'],
])
const SQL_MODES = new Set(['readonly', 'middle-table', 'stored-procedure'])
const MATERIAL_REQUIRED_TARGET_FIELDS = [
  { label: 'K3 material code', targets: ['FNumber'] },
  { label: 'K3 material name', targets: ['FName'] },
]
const BOM_REQUIRED_TARGET_FIELDS = [
  { label: 'K3 BOM parent material', targets: ['FParentItemNumber'] },
  { label: 'K3 BOM child material', targets: ['FChildItems[].FItemNumber', 'FChildItemNumber', 'FItemNumber'] },
  { label: 'K3 BOM child quantity', targets: ['FChildItems[].FQty', 'FQty'] },
]

class LivePocPreflightError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'LivePocPreflightError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LivePocPreflightError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function optionalObject(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new LivePocPreflightError(`${field} must be an object`, { field })
  }
  return value
}

function optionalArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new LivePocPreflightError(`${field} must be an array`, { field })
  }
  return value
}

function normalizeSafeBoolean(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LivePocPreflightError(`${field} must be a finite boolean, 0/1, or boolean-like string`, { field })
    }
    if (value === 1) return true
    if (value === 0) return false
    throw new LivePocPreflightError(`${field} must be 0 or 1 when given as a number`, { field, received: value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return false
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new LivePocPreflightError(`${field} must be a boolean, 0/1, or boolean-like string`, { field })
}

function normalizeSqlMode(value, sqlEnabled) {
  const fallback = sqlEnabled ? 'readonly' : 'disabled'
  const text = optionalString(value)
  if (!text) return fallback
  const key = text.toLowerCase().replace(/\s+/g, ' ')
  const normalized = SQL_MODE_ALIASES.get(key) || key
  if (normalized === 'disabled' && !sqlEnabled) return normalized
  if (normalized === 'disabled' && sqlEnabled) {
    throw new LivePocPreflightError(
      'sqlServer.mode=disabled requires sqlServer.enabled=false; set enabled=false or choose readonly, middle-table, or stored-procedure',
      {
        field: 'sqlServer.mode',
        mode: text,
        sqlServerEnabled: true,
        acceptedModes: ['readonly', 'middle-table', 'stored-procedure'],
      },
    )
  }
  if (!SQL_MODES.has(normalized)) {
    throw new LivePocPreflightError('sqlServer.mode must be readonly, middle-table, or stored-procedure', {
      field: 'sqlServer.mode',
      mode: text,
    })
  }
  return normalized
}

function normalizeSqlIdentifierPart(part) {
  return part
    .trim()
    .replace(/^[\[`"']+|[\]`"']+$/g, '')
    .trim()
}

function normalizeSqlObjectName(value) {
  const parts = String(value)
    .trim()
    .toLowerCase()
    .split('.')
    .map(normalizeSqlIdentifierPart)
    .filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function assertK3AuthContract(k3Wise) {
  const credentials = optionalObject(k3Wise.credentials, 'k3Wise.credentials')
  const hasSessionId = Boolean(optionalString(credentials.sessionId))
  const hasUsernamePassword = Boolean(
    (optionalString(credentials.username) || optionalString(credentials.userName)) &&
    optionalString(credentials.password)
  )
  if (!hasSessionId && !hasUsernamePassword) {
    throw new LivePocPreflightError('K3 WISE credentials require credentials.sessionId or credentials.username/password', {
      field: 'k3Wise.credentials',
      accepted: ['sessionId', 'username+password'],
    })
  }
}

function normalizeTargetPath(value) {
  return String(value)
    .trim()
    .replace(/\[\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function collectTargetFields(mappings, field) {
  return mappings.map((mapping, index) => {
    if (!isPlainObject(mapping)) {
      throw new LivePocPreflightError(`${field}[${index}] must be an object`, {
        field,
        index,
      })
    }
    return requiredString(mapping.targetField, `${field}[${index}].targetField`)
  })
}

function assertRequiredTargetFields(mappings, requirements, field) {
  const targetFields = collectTargetFields(mappings, field)
  const normalizedTargets = new Set(targetFields.map(normalizeTargetPath))
  for (const requirement of requirements) {
    const acceptedTargets = requirement.targets.map(normalizeTargetPath)
    if (!acceptedTargets.some((target) => normalizedTargets.has(target))) {
      throw new LivePocPreflightError(`${field} must map ${requirement.label}`, {
        field,
        requiredTargetFields: requirement.targets,
        targetFields,
      })
    }
  }
}

function validateUrl(value, field) {
  const text = requiredString(value, field)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new LivePocPreflightError(`${field} must be a valid URL`, { field })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LivePocPreflightError(`${field} must use http or https`, { field })
  }
  return parsed.toString()
}

function assertNoSecretStrings(value, secrets, location = 'root') {
  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (secret && value.includes(secret)) {
        throw new LivePocPreflightError(`generated packet leaks secret at ${location}`, { location })
      }
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretStrings(item, secrets, `${location}[${index}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertNoSecretStrings(child, secrets, `${location}.${key}`)
    }
  }
}

function collectSecretValues(value, acc = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecretValues(item, acc))
    return acc
  }
  if (!isPlainObject(value)) return acc
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.length >= 4) {
      acc.push(child)
      continue
    }
    collectSecretValues(child, acc)
  }
  return acc
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? '<redacted>' : redact(child)
  }
  return result
}

function normalizeGate(input) {
  if (!isPlainObject(input)) {
    throw new LivePocPreflightError('gate input must be a JSON object')
  }
  for (const field of REQUIRED_TOP_LEVEL) {
    if (input[field] === undefined || input[field] === null) {
      throw new LivePocPreflightError(`${field} is required`, { field })
    }
  }

  const tenantId = requiredString(input.tenantId, 'tenantId')
  const workspaceId = requiredString(input.workspaceId, 'workspaceId')
  const projectId = optionalString(input.projectId)
  const operator = optionalString(input.operator) || 'integration-operator'
  const k3Wise = optionalObject(input.k3Wise, 'k3Wise')
  const plm = optionalObject(input.plm, 'plm')
  const sqlServer = optionalObject(input.sqlServer, 'sqlServer')
  const rollback = optionalObject(input.rollback, 'rollback')
  const fieldMappings = optionalObject(input.fieldMappings, 'fieldMappings')
  const bom = optionalObject(input.bom, 'bom')

  const environment = requiredString(k3Wise.environment, 'k3Wise.environment').toLowerCase()
  if (!NON_PRODUCTION_ENVS.has(environment)) {
    throw new LivePocPreflightError('K3 WISE live PoC must target a non-production test environment', {
      field: 'k3Wise.environment',
      environment,
    })
  }

  const autoSubmit = normalizeSafeBoolean(k3Wise.autoSubmit, 'k3Wise.autoSubmit')
  const autoAudit = normalizeSafeBoolean(k3Wise.autoAudit, 'k3Wise.autoAudit')
  if (autoSubmit || autoAudit) {
    throw new LivePocPreflightError('M2 live PoC packet is Save-only: autoSubmit and autoAudit must be false', {
      field: 'k3Wise.autoSubmit/autoAudit',
    })
  }

  const sqlEnabled = normalizeSafeBoolean(sqlServer.enabled, 'sqlServer.enabled')
  const sqlWriteCoreFlag = normalizeSafeBoolean(sqlServer.writeCoreTables, 'sqlServer.writeCoreTables')
  const sqlMode = normalizeSqlMode(sqlServer.mode, sqlEnabled)
  const allowedTables = optionalArray(sqlServer.allowedTables, 'sqlServer.allowedTables').map((table) => String(table))
  const writesCoreTable = allowedTables.some((table) => K3_CORE_TABLES.has(normalizeSqlObjectName(table)))
  if (sqlEnabled && sqlMode !== 'readonly' && (sqlWriteCoreFlag || writesCoreTable)) {
    throw new LivePocPreflightError('SQL Server channel may not write K3 core business tables in live PoC', {
      field: 'sqlServer.allowedTables',
      allowedTables,
    })
  }

  const bomEnabled = normalizeSafeBoolean(bom.enabled, 'bom.enabled')
  const bomProductId = optionalString(bom.productId) || optionalString(plm.defaultProductId) || optionalString(plm.config && plm.config.defaultProductId)
  if (bomEnabled && !bomProductId) {
    throw new LivePocPreflightError('BOM PoC requires bom.productId or plm.defaultProductId', {
      field: 'bom.productId',
    })
  }

  const materialMappings = optionalArray(fieldMappings.material, 'fieldMappings.material')
  if (materialMappings.length === 0) {
    throw new LivePocPreflightError('fieldMappings.material must contain at least one mapping', {
      field: 'fieldMappings.material',
    })
  }
  assertRequiredTargetFields(materialMappings, MATERIAL_REQUIRED_TARGET_FIELDS, 'fieldMappings.material')
  if (bomEnabled) {
    const bomMappings = optionalArray(fieldMappings.bom, 'fieldMappings.bom')
    if (bomMappings.length === 0) {
      throw new LivePocPreflightError('fieldMappings.bom must contain at least one mapping when BOM PoC is enabled', {
        field: 'fieldMappings.bom',
      })
    }
    assertRequiredTargetFields(bomMappings, BOM_REQUIRED_TARGET_FIELDS, 'fieldMappings.bom')
  }

  requiredString(k3Wise.version, 'k3Wise.version')
  validateUrl(k3Wise.apiUrl || k3Wise.baseUrl, 'k3Wise.apiUrl')
  requiredString(k3Wise.acctId, 'k3Wise.acctId')
  assertK3AuthContract(k3Wise)
  requiredString(plm.readMethod, 'plm.readMethod')
  requiredString(rollback.owner, 'rollback.owner')
  requiredString(rollback.strategy, 'rollback.strategy')

  return {
    tenantId,
    workspaceId,
    projectId,
    operator,
    k3Wise: {
      ...k3Wise,
      environment,
      autoSubmit: false,
      autoAudit: false,
    },
    plm,
    sqlServer: {
      ...sqlServer,
      enabled: sqlEnabled,
      writeCoreTables: sqlWriteCoreFlag,
      mode: sqlMode,
    },
    rollback,
    fieldMappings,
    bom: {
      ...bom,
      enabled: bomEnabled,
      productId: bomProductId,
    },
    sqlEnabled,
    sqlMode,
  }
}

function credentialPlaceholder(source) {
  const credentials = optionalObject(source.credentials, 'credentials')
  const keys = Object.keys(credentials).filter((key) => credentials[key] !== undefined && credentials[key] !== null)
  return {
    requiredCredentialKeys: keys.sort(),
    credentials: Object.fromEntries(keys.sort().map((key) => [key, '<set-at-runtime>'])),
  }
}

function normalizeMaterialMapping(mapping, index) {
  if (!isPlainObject(mapping)) {
    throw new LivePocPreflightError(`fieldMappings.material[${index}] must be an object`, {
      field: 'fieldMappings.material',
      index,
    })
  }
  return {
    sourceField: requiredString(mapping.sourceField, `fieldMappings.material[${index}].sourceField`),
    targetField: requiredString(mapping.targetField, `fieldMappings.material[${index}].targetField`),
    transform: mapping.transform === undefined ? null : redact(mapping.transform),
    validation: mapping.validation === undefined ? null : redact(mapping.validation),
    defaultValue: mapping.defaultValue === undefined ? null : mapping.defaultValue,
    sortOrder: Number.isInteger(mapping.sortOrder) ? mapping.sortOrder : index,
  }
}

function buildExternalSystems(gate) {
  const plmConfig = {
    baseUrl: optionalString(gate.plm.baseUrl) || undefined,
    readMethod: gate.plm.readMethod,
    pageSize: gate.plm.pageSize || 50,
    defaultProductId: gate.bom.productId || undefined,
    ...(isPlainObject(gate.plm.config) ? redact(gate.plm.config) : {}),
  }
  if (gate.bom.productId) plmConfig.defaultProductId = gate.bom.productId

  const plmCredentials = credentialPlaceholder(gate.plm)
  const k3Credentials = credentialPlaceholder({
    credentials: {
      ...(isPlainObject(gate.k3Wise.credentials) ? gate.k3Wise.credentials : {}),
      acctId: gate.k3Wise.acctId,
    },
  })

  const systems = [
    {
      name: 'live-poc-plm-source',
      tenantId: gate.tenantId,
      workspaceId: gate.workspaceId,
      projectId: gate.projectId,
      kind: gate.plm.kind || 'plm:yuantus-wrapper',
      role: 'source',
      status: 'active',
      config: plmConfig,
      capabilities: { objects: ['materials', 'bom'], write: false },
      ...plmCredentials,
    },
    {
      name: 'live-poc-k3-wise-target',
      tenantId: gate.tenantId,
      workspaceId: gate.workspaceId,
      projectId: gate.projectId,
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      config: {
        baseUrl: validateUrl(gate.k3Wise.apiUrl || gate.k3Wise.baseUrl, 'k3Wise.apiUrl'),
        loginPath: gate.k3Wise.loginPath || '/K3API/Login',
        healthPath: gate.k3Wise.healthPath || undefined,
        autoSubmit: false,
        autoAudit: false,
        timeoutMs: Number.isInteger(gate.k3Wise.timeoutMs) ? gate.k3Wise.timeoutMs : 30000,
        objects: redact(gate.k3Wise.objects || {}),
      },
      capabilities: { objects: ['material', 'bom'], write: true, lifecycleAutomation: false },
      ...k3Credentials,
    },
  ]

  if (gate.sqlEnabled) {
    systems.push({
      name: 'live-poc-k3-wise-sql-channel',
      tenantId: gate.tenantId,
      workspaceId: gate.workspaceId,
      projectId: gate.projectId,
      kind: 'erp:k3-wise-sqlserver',
      role: 'source',
      status: 'active',
      config: {
        mode: gate.sqlMode,
        server: optionalString(gate.sqlServer.server) || '<provided-by-customer>',
        database: optionalString(gate.sqlServer.database) || '<provided-by-customer>',
        allowedTables: optionalArray(gate.sqlServer.allowedTables, 'sqlServer.allowedTables'),
        middleTables: optionalArray(gate.sqlServer.middleTables, 'sqlServer.middleTables'),
        storedProcedures: optionalArray(gate.sqlServer.storedProcedures, 'sqlServer.storedProcedures'),
      },
      capabilities: {
        readOnly: gate.sqlMode === 'readonly',
        middleTableOnly: gate.sqlMode === 'middle-table',
      },
      ...credentialPlaceholder(gate.sqlServer),
    })
  }

  return systems
}

function buildPipelines(gate, externalSystems) {
  const plm = externalSystems.find((system) => system.name === 'live-poc-plm-source')
  const k3 = externalSystems.find((system) => system.name === 'live-poc-k3-wise-target')
  const materialMappings = gate.fieldMappings.material.map(normalizeMaterialMapping)

  const pipelines = [
    {
      name: 'live-poc-plm-material-to-k3-wise-save-only',
      tenantId: gate.tenantId,
      workspaceId: gate.workspaceId,
      projectId: gate.projectId,
      description: 'M2 live PoC material Save-only pipeline generated from GATE answers.',
      sourceSystemName: plm.name,
      targetSystemName: k3.name,
      sourceObject: 'materials',
      targetObject: 'material',
      mode: 'manual',
      status: 'draft',
      idempotencyKeyFields: ['sourceSystemId', 'objectType', 'sourceId', 'revision'],
      options: {
        writeMode: 'saveOnly',
        sampleLimit: gate.k3Wise.sampleLimit || 3,
        advanceWatermarkOnPartialFailure: false,
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
      },
      fieldMappings: materialMappings,
    },
  ]

  if (gate.bom.enabled === true) {
    pipelines.push({
      name: 'live-poc-plm-bom-to-k3-wise-save-only',
      tenantId: gate.tenantId,
      workspaceId: gate.workspaceId,
      projectId: gate.projectId,
      description: 'M2 live PoC simple BOM Save-only pipeline generated from GATE answers.',
      sourceSystemName: plm.name,
      targetSystemName: k3.name,
      sourceObject: 'bom',
      targetObject: 'bom',
      mode: 'manual',
      status: 'draft',
      idempotencyKeyFields: ['sourceSystemId', 'objectType', 'sourceId', 'revision'],
      options: {
        writeMode: 'saveOnly',
        sampleLimit: 1,
        advanceWatermarkOnPartialFailure: false,
        source: {
          filters: {
            productId: gate.bom.productId,
          },
        },
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
      },
      fieldMappings: optionalArray(gate.fieldMappings.bom, 'fieldMappings.bom').map((mapping, index) => ({
        ...normalizeMaterialMapping(mapping, index),
      })),
    })
  }

  return pipelines
}

function buildChecklist(gate) {
  const base = [
    { id: 'GATE-01', status: 'ready', check: 'Customer GATE answers archived and secrets stored outside Git.' },
    { id: 'CONN-01', status: 'todo', check: 'Create PLM external system, then run testConnection.' },
    { id: 'CONN-02', status: 'todo', check: 'Create K3 WISE test-account external system, then run testConnection.' },
    { id: 'DRY-01', status: 'todo', check: 'Create material pipeline and run dry-run for 1-3 rows.' },
    { id: 'SAVE-01', status: 'todo', check: 'Run material Save-only with autoSubmit=false and autoAudit=false.' },
    { id: 'FAIL-01', status: 'todo', check: 'Verify one controlled failure enters dead letter and can replay after correction.' },
    { id: 'ROLLBACK-01', status: 'todo', check: `Execute rollback SOP owner=${gate.rollback.owner}, strategy=${gate.rollback.strategy}.` },
  ]
  if (gate.bom.enabled === true) {
    base.splice(5, 0, {
      id: 'BOM-01',
      status: 'todo',
      check: 'Run simple BOM PoC using config.defaultProductId or direct filters.productId only.',
    })
  }
  return base
}

function buildPacket(input, { generatedAt = new Date().toISOString() } = {}) {
  const gate = normalizeGate(input)
  const secrets = collectSecretValues(input)
  const externalSystems = buildExternalSystems(gate)
  const pipelines = buildPipelines(gate, externalSystems)
  const packet = {
    schemaVersion: 1,
    generatedAt,
    tenantId: gate.tenantId,
    workspaceId: gate.workspaceId,
    projectId: gate.projectId,
    operator: gate.operator,
    status: 'preflight-ready',
    safety: {
      environment: gate.k3Wise.environment,
      saveOnly: true,
      autoSubmit: false,
      autoAudit: false,
      sqlServerMode: gate.sqlMode,
      productionWriteBlocked: true,
    },
    gateSummary: {
      k3Wise: {
        version: gate.k3Wise.version,
        apiUrl: validateUrl(gate.k3Wise.apiUrl || gate.k3Wise.baseUrl, 'k3Wise.apiUrl'),
        acctId: gate.k3Wise.acctId,
        environment: gate.k3Wise.environment,
      },
      plm: {
        kind: gate.plm.kind || 'plm:yuantus-wrapper',
        readMethod: gate.plm.readMethod,
        baseUrl: optionalString(gate.plm.baseUrl) || null,
      },
      rollback: redact(gate.rollback),
    },
    externalSystems,
    pipelines,
    checklist: buildChecklist(gate),
    notes: [
      'This packet is safe to commit only after confirming no customer secrets are present.',
      'Use the credentials placeholders when creating external systems; do not paste secrets into MD evidence.',
      'BOM product scope is carried by PLM config.defaultProductId or direct adapter filters.productId.',
      'Do not use pipeline.options.source.productId.',
    ],
  }

  assertNoSecretStrings(packet, secrets)
  return packet
}

function renderMarkdown(packet) {
  const lines = [
    `# K3 WISE Live PoC Packet - ${packet.generatedAt.slice(0, 10)}`,
    '',
    '## Summary',
    '',
    `- Status: ${packet.status}`,
    `- Tenant: ${packet.tenantId}`,
    `- Workspace: ${packet.workspaceId}`,
    `- K3 environment: ${packet.safety.environment}`,
    `- Save-only: ${packet.safety.saveOnly}`,
    `- Auto Submit: ${packet.safety.autoSubmit}`,
    `- Auto Audit: ${packet.safety.autoAudit}`,
    `- SQL Server mode: ${packet.safety.sqlServerMode}`,
    '',
    '## External Systems',
    '',
    '| Name | Kind | Role | Status | Credential keys |',
    '|---|---|---|---|---|',
    ...packet.externalSystems.map((system) => `| ${system.name} | ${system.kind} | ${system.role} | ${system.status} | ${(system.requiredCredentialKeys || []).join(', ') || 'none'} |`),
    '',
    '## Pipelines',
    '',
    '| Name | Source object | Target object | Mode | Status |',
    '|---|---|---|---|---|',
    ...packet.pipelines.map((pipeline) => `| ${pipeline.name} | ${pipeline.sourceObject} | ${pipeline.targetObject} | ${pipeline.mode} | ${pipeline.status} |`),
    '',
    '## Checklist',
    '',
    '| ID | Status | Check |',
    '|---|---|---|',
    ...packet.checklist.map((item) => `| ${item.id} | ${item.status} | ${item.check} |`),
    '',
    '## Safety Notes',
    '',
    ...packet.notes.map((note) => `- ${note}`),
    '',
  ]
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  const args = { outDir: 'artifacts/integration-live-poc', printSample: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') {
      args.input = argv[++i]
    } else if (arg === '--out-dir') {
      args.outDir = argv[++i]
    } else if (arg === '--print-sample') {
      args.printSample = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new LivePocPreflightError(`unknown argument: ${arg}`)
    }
  }
  return args
}

function sampleGate() {
  return {
    tenantId: 'tenant-test',
    workspaceId: 'workspace-test',
    operator: 'integration-admin',
    k3Wise: {
      version: 'K3 WISE 15.x test',
      apiUrl: 'https://k3.example.test/K3API/',
      acctId: 'AIS_TEST',
      environment: 'test',
      credentials: {
        username: 'k3-test-user',
        password: '<fill-outside-git>',
      },
      autoSubmit: false,
      autoAudit: false,
    },
    plm: {
      kind: 'plm:yuantus-wrapper',
      readMethod: 'api',
      baseUrl: 'https://plm.example.test/',
      defaultProductId: 'PRODUCT-TEST-001',
      credentials: {
        username: 'plm-test-user',
        password: '<fill-outside-git>',
      },
    },
    sqlServer: {
      enabled: true,
      mode: 'readonly',
      server: '10.0.0.10',
      database: 'AIS_TEST',
      allowedTables: ['t_ICItem', 't_MeasureUnit'],
    },
    rollback: {
      owner: 'customer-k3-admin',
      strategy: 'disable-test-records',
    },
    bom: {
      enabled: true,
    },
    fieldMappings: {
      material: [
        { sourceField: 'code', targetField: 'FNumber', transform: { type: 'upperTrim' }, validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
        { sourceField: 'uom', targetField: 'FBaseUnitID', transform: { type: 'dictMap', dictionary: 'unit' } },
      ],
      bom: [
        { sourceField: 'parentCode', targetField: 'FParentItemNumber', validation: [{ type: 'required' }] },
        { sourceField: 'childCode', targetField: 'FChildItems[].FItemNumber', validation: [{ type: 'required' }] },
        { sourceField: 'quantity', targetField: 'FChildItems[].FQty', transform: { type: 'toNumber' } },
      ],
    },
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input gate.json --out-dir artifacts/integration-live-poc')
    console.log('       node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample')
    return 0
  }
  if (args.printSample) {
    console.log(JSON.stringify(sampleGate(), null, 2))
    return 0
  }
  if (!args.input) {
    throw new LivePocPreflightError('--input is required')
  }

  const raw = await readFile(args.input, 'utf8')
  const gate = JSON.parse(raw)
  const packet = buildPacket(gate)
  const outDir = path.resolve(args.outDir)
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-live-poc-packet.json')
  const mdPath = path.join(outDir, 'integration-k3wise-live-poc-packet.md')
  await writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(packet))
  console.log(JSON.stringify({
    ok: true,
    jsonPath,
    mdPath,
    status: packet.status,
    externalSystems: packet.externalSystems.length,
    pipelines: packet.pipelines.length,
  }, null, 2))
  return 0
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().catch((error) => {
    const body = error instanceof LivePocPreflightError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(body, null, 2))
    process.exitCode = 1
  })
}

export {
  LivePocPreflightError,
  buildPacket,
  collectSecretValues,
  normalizeGate,
  redact,
  renderMarkdown,
  runCli,
  sampleGate,
}
