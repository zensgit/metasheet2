#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'http://142.171.239.56:8081'
const DEFAULT_OUTPUT_ROOT = 'output/integration-k3wise-postdeploy-smoke'
const ISSUE1542_SMOKE_PIPELINE_ID = 'issue1542_postdeploy_staging_material_smoke'
const REQUIRED_ADAPTERS = [
  'http',
  'plm:yuantus-wrapper',
  'erp:k3-wise-webapi',
  'erp:k3-wise-sqlserver',
  'metasheet:staging',
  'metasheet:multitable',
]
const REQUIRED_ROUTES = [
  ['GET', '/api/integration/status'],
  ['GET', '/api/integration/adapters'],
  ['GET', '/api/integration/external-systems'],
  ['POST', '/api/integration/external-systems'],
  ['GET', '/api/integration/external-systems/:id'],
  ['POST', '/api/integration/external-systems/:id/test'],
  ['GET', '/api/integration/pipelines'],
  ['POST', '/api/integration/pipelines'],
  ['GET', '/api/integration/pipelines/:id'],
  ['POST', '/api/integration/pipelines/:id/dry-run'],
  ['POST', '/api/integration/pipelines/:id/run'],
  ['GET', '/api/integration/runs'],
  ['GET', '/api/integration/dead-letters'],
  ['POST', '/api/integration/dead-letters/:id/replay'],
  ['GET', '/api/integration/staging/descriptors'],
  ['POST', '/api/integration/staging/install'],
]
const REQUIRED_DATA_FACTORY_ADAPTER_METADATA = {
  'metasheet:staging': {
    roles: ['source'],
    advanced: false,
    guardrails: {
      read: {
        hostOwned: true,
        dryRunFriendly: true,
        noExternalNetwork: true,
      },
      write: {
        supported: false,
      },
    },
  },
  'metasheet:multitable': {
    roles: ['target'],
    supports: ['testConnection', 'listObjects', 'getSchema', 'upsert'],
    advanced: false,
    guardrails: {
      read: {
        supported: false,
      },
      write: {
        hostOwned: true,
        pluginScopedSheetsOnly: true,
        supportsAppend: true,
        supportsUpsertByKey: true,
      },
    },
  },
}
const CONTROL_PLANE_LIST_PROBES = [
  ['integration-list-external-systems', '/api/integration/external-systems'],
  ['integration-list-pipelines', '/api/integration/pipelines'],
  ['integration-list-runs', '/api/integration/runs'],
  ['integration-list-dead-letters', '/api/integration/dead-letters'],
]
const REQUIRED_STAGING_DESCRIPTORS = [
  'plm_raw_items',
  'standard_materials',
  'bom_cleanse',
  'integration_exceptions',
  'integration_run_log',
]
const REQUIRED_STAGING_FIELD_DETAILS = {
  plm_raw_items: {
    sourceSystemId: { type: 'string' },
    objectType: { type: 'string' },
    sourceId: { type: 'string' },
    revision: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    rawPayload: { type: 'string' },
    fetchedAt: { type: 'date' },
    pipelineRunId: { type: 'string' },
  },
  standard_materials: {
    code: { type: 'string' },
    name: { type: 'string' },
    uom: { type: 'string' },
    category: { type: 'string' },
    status: { type: 'select', options: ['draft', 'active', 'obsolete'] },
    erpSyncStatus: { type: 'select', options: ['pending', 'synced', 'failed'] },
    erpExternalId: { type: 'string' },
    erpBillNo: { type: 'string' },
    erpResponseCode: { type: 'string' },
    erpResponseMessage: { type: 'string' },
    lastSyncedAt: { type: 'date' },
  },
  bom_cleanse: {
    parentCode: { type: 'string' },
    childCode: { type: 'string' },
    quantity: { type: 'number' },
    uom: { type: 'string' },
    sequence: { type: 'number' },
    revision: { type: 'string' },
    validFrom: { type: 'date' },
    validTo: { type: 'date' },
    status: { type: 'select', options: ['draft', 'active', 'obsolete'] },
  },
  integration_exceptions: {
    pipelineId: { type: 'string' },
    runId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    errorCode: { type: 'string' },
    errorMessage: { type: 'string' },
    sourcePayload: { type: 'string' },
    transformedPayload: { type: 'string' },
    status: { type: 'select', options: ['open', 'in_review', 'replayed', 'discarded'] },
    assignee: { type: 'string' },
    note: { type: 'string' },
  },
  integration_run_log: {
    pipelineId: { type: 'string' },
    runId: { type: 'string' },
    mode: { type: 'select', options: ['incremental', 'full', 'manual', 'replay'] },
    triggeredBy: { type: 'string' },
    status: { type: 'select', options: ['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] },
    rowsRead: { type: 'number' },
    rowsCleaned: { type: 'number' },
    rowsWritten: { type: 'number' },
    rowsFailed: { type: 'number' },
    durationMs: { type: 'number' },
    startedAt: { type: 'date' },
    finishedAt: { type: 'date' },
    errorSummary: { type: 'string' },
  },
}
const TOKEN_PATTERN = /([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi

class K3WisePostdeploySmokeError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WisePostdeploySmokeError'
    this.details = details
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-postdeploy-smoke.mjs [options]

Runs a post-deploy smoke against the deployed MetaSheet K3 WISE integration
surface. Public checks always run; authenticated integration-route checks run
when a bearer token is supplied.

Options:
  --base-url <url>       MetaSheet base URL, default ${DEFAULT_BASE_URL}
  --auth-token <token>   Optional bearer token for authenticated checks
  --token-file <path>    Optional file containing bearer token
  --tenant-id <id>       Optional tenant scope for authenticated list probes
  --workspace-id <id>    Optional workspace scope for authenticated probes
  --require-auth         Fail when no token is supplied or auth checks are skipped
  --out-dir <dir>        Output directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --timeout-ms <ms>      Per-request timeout, default 10000
  --issue1542-workbench-smoke
                          Opt-in Data Factory #1542 smoke: verify staging schema
                          discovery and draft pipeline save. Writes metadata only;
                          never runs dry-run or Save-only.
  --help                 Show this help

Environment fallbacks:
  METASHEET_BASE_URL, PUBLIC_APP_URL
  METASHEET_AUTH_TOKEN, ADMIN_TOKEN, AUTH_TOKEN
  METASHEET_AUTH_TOKEN_FILE, AUTH_TOKEN_FILE
  METASHEET_TENANT_ID, TENANT_ID
`)
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new K3WisePostdeploySmokeError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: envValue('METASHEET_BASE_URL', 'PUBLIC_APP_URL') || DEFAULT_BASE_URL,
    authToken: envValue('METASHEET_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    tokenFile: envValue('METASHEET_AUTH_TOKEN_FILE', 'AUTH_TOKEN_FILE'),
    tenantId: envValue('METASHEET_TENANT_ID', 'TENANT_ID'),
    workspaceId: envValue('METASHEET_WORKSPACE_ID', 'WORKSPACE_ID'),
    requireAuth: false,
    issue1542WorkbenchSmoke: false,
    outDir: '',
    timeoutMs: 10_000,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--base-url':
        opts.baseUrl = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--token-file':
        opts.tokenFile = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--tenant-id':
        opts.tenantId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--workspace-id':
        opts.workspaceId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--require-auth':
        opts.requireAuth = true
        break
      case '--issue1542-workbench-smoke':
        opts.issue1542WorkbenchSmoke = true
        break
      case '--out-dir':
        opts.outDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number(readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new K3WisePostdeploySmokeError(`unknown option: ${arg}`, { arg })
    }
  }

  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new K3WisePostdeploySmokeError('--timeout-ms must be a positive integer', { timeoutMs: opts.timeoutMs })
  }
  opts.baseUrl = normalizeBaseUrl(opts.baseUrl)
  return opts
}

function normalizeBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new K3WisePostdeploySmokeError('--base-url must be a valid URL', { baseUrl: value })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new K3WisePostdeploySmokeError('--base-url must use http or https', { baseUrl: value })
  }
  if (url.username || url.password) {
    throw new K3WisePostdeploySmokeError('--base-url must not contain inline credentials', { baseUrl: redactText(value) })
  }
  if (url.search || url.hash) {
    throw new K3WisePostdeploySmokeError('--base-url must not contain query string or hash', { baseUrl: redactText(value) })
  }
  return url.toString().replace(/\/+$/, '')
}

function redactText(value) {
  return String(value)
    .replace(TOKEN_PATTERN, '<redacted-token>')
    .replace(URL_PATTERN, redactUrl)
}

function redactUrl(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = '<redacted-credentials>'
      url.password = ''
    }
    for (const key of Array.from(url.searchParams.keys())) {
      url.searchParams.set(key, '<redacted>')
    }
    if (url.hash) {
      url.hash = '#<redacted>'
    }
    return url.toString()
  } catch {
    return value
  }
}

function markdownText(value) {
  return String(value ?? '').replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim()
}

function markdownInlineCode(value) {
  const text = markdownText(value)
  const runs = text.match(/`+/g) || ['']
  const fenceLength = Math.max(1, ...runs.map((run) => run.length + 1))
  const fence = '`'.repeat(fenceLength)
  const content = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text
  return `${fence}${content}${fence}`
}

function markdownTableCodeCell(value) {
  return markdownInlineCode(value).replace(/\|/g, '\\|')
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function result(id, status, details = {}) {
  return {
    id,
    ...details,
    status,
  }
}

function failResult(id, error) {
  const details = error && error.details && typeof error.details === 'object'
    ? { details: sanitizeBody(error.details) }
    : {}
  return result(id, 'fail', {
    error: error && error.message ? redactText(error.message) : redactText(String(error)),
    ...details,
  })
}

async function readToken(opts) {
  if (opts.authToken) return opts.authToken.trim()
  if (!opts.tokenFile) return ''
  const raw = await readFile(opts.tokenFile, 'utf8')
  return raw.trim()
}

async function resolveToken(opts) {
  try {
    return {
      token: await readToken(opts),
      check: null,
    }
  } catch (error) {
    return {
      token: '',
      check: failResult('auth-token', error),
    }
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function requestJson(baseUrl, pathname, {
  token = '',
  timeoutMs = 10_000,
  acceptStatuses = [200],
  method = 'GET',
  requestBody,
} = {}) {
  const headers = { Accept: 'application/json' }
  const request = { headers, method }
  if (requestBody !== undefined) {
    headers['Content-Type'] = 'application/json'
    request.body = JSON.stringify(requestBody)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchWithTimeout(`${baseUrl}${pathname}`, request, timeoutMs)
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 500) }
    }
  }
  if (!acceptStatuses.includes(response.status)) {
    throw new K3WisePostdeploySmokeError(`${pathname} returned HTTP ${response.status}`, {
      status: response.status,
      body: sanitizeBody(body),
    })
  }
  return { status: response.status, body: sanitizeBody(body) }
}

function withQuery(pathname, query = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${pathname}?${search}` : pathname
}

async function requestText(baseUrl, pathname, { timeoutMs = 10_000 } = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${pathname}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  }, timeoutMs)
  const text = await response.text()
  if (response.status !== 200) {
    throw new K3WisePostdeploySmokeError(`${pathname} returned HTTP ${response.status}`, { status: response.status })
  }
  return { status: response.status, text }
}

function sanitizeBody(value) {
  if (Array.isArray(value)) return value.map(sanitizeBody)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactText(value) : value
  const next = {}
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|authorization|credential/i.test(key)) {
      next[key] = '<redacted>'
    } else {
      next[key] = sanitizeBody(child)
    }
  }
  return next
}

function normalizeRoute(route) {
  return `${String(route.method || '').toUpperCase()} ${String(route.path || '')}`
}

function assertStatusRoutes(statusBody) {
  const data = statusBody && statusBody.data ? statusBody.data : statusBody
  const adapters = Array.isArray(data?.adapters) ? data.adapters : []
  const routes = Array.isArray(data?.routes) ? data.routes.map(normalizeRoute) : []

  const missingAdapters = REQUIRED_ADAPTERS.filter((adapter) => !adapters.includes(adapter))
  const missingRoutes = REQUIRED_ROUTES
    .map(([method, routePath]) => `${method} ${routePath}`)
    .filter((route) => !routes.includes(route))

  if (missingAdapters.length > 0 || missingRoutes.length > 0) {
    throw new K3WisePostdeploySmokeError('integration status is missing required adapters or routes', {
      missingAdapters,
      missingRoutes,
    })
  }

  return { adapters, adaptersChecked: REQUIRED_ADAPTERS.length, routesChecked: REQUIRED_ROUTES.length }
}

function valueAtPath(value, path) {
  return path.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return current[segment]
  }, value)
}

function addInvalidAdapterField(invalidAdapters, kind, path, message) {
  if (!invalidAdapters[kind]) invalidAdapters[kind] = {}
  invalidAdapters[kind][path] = message
}

function assertArrayIncludes(actual, expected, invalidAdapters, kind, path) {
  if (!Array.isArray(actual)) {
    addInvalidAdapterField(invalidAdapters, kind, path, 'expected array')
    return
  }
  const missing = expected.filter((item) => !actual.includes(item))
  if (missing.length > 0) {
    addInvalidAdapterField(invalidAdapters, kind, path, `missing ${missing.join(', ')}`)
  }
}

function assertBooleanFields(adapter, expectedFields, invalidAdapters, kind, prefix) {
  for (const [field, expected] of Object.entries(expectedFields || {})) {
    const path = prefix ? `${prefix}.${field}` : field
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      assertBooleanFields(adapter, expected, invalidAdapters, kind, path)
      continue
    }
    const actual = valueAtPath(adapter, path)
    if (actual !== expected) {
      addInvalidAdapterField(invalidAdapters, kind, path, `expected ${String(expected)} but got ${String(actual)}`)
    }
  }
}

function assertDataFactoryAdapterDiscovery(body) {
  const data = body && body.data !== undefined ? body.data : body
  if (!Array.isArray(data)) {
    throw new K3WisePostdeploySmokeError('adapter discovery response data must be an array', {
      received: Array.isArray(data) ? 'array' : typeof data,
    })
  }
  const adaptersByKind = new Map()
  for (const adapter of data) {
    if (adapter && typeof adapter.kind === 'string') adaptersByKind.set(adapter.kind, adapter)
  }
  const missingAdapters = []
  const invalidAdapters = {}
  for (const [kind, expected] of Object.entries(REQUIRED_DATA_FACTORY_ADAPTER_METADATA)) {
    const adapter = adaptersByKind.get(kind)
    if (!adapter) {
      missingAdapters.push(kind)
      continue
    }
    assertArrayIncludes(adapter.roles, expected.roles || [], invalidAdapters, kind, 'roles')
    if (expected.supports) assertArrayIncludes(adapter.supports, expected.supports, invalidAdapters, kind, 'supports')
    if (Object.prototype.hasOwnProperty.call(expected, 'advanced') && adapter.advanced !== expected.advanced) {
      addInvalidAdapterField(invalidAdapters, kind, 'advanced', `expected ${String(expected.advanced)} but got ${String(adapter.advanced)}`)
    }
    assertBooleanFields(adapter, expected.guardrails || {}, invalidAdapters, kind, 'guardrails')
  }
  if (missingAdapters.length > 0 || Object.keys(invalidAdapters).length > 0) {
    throw new K3WisePostdeploySmokeError('adapter discovery is missing required Data Factory multitable metadata', {
      missingAdapters,
      invalidAdapters,
    })
  }
  return {
    adapters: Array.from(adaptersByKind.keys()),
    adaptersChecked: Object.keys(REQUIRED_DATA_FACTORY_ADAPTER_METADATA).length,
  }
}

function collectDescriptorFields(descriptor) {
  const fieldIds = new Set()
  const fieldDetailsById = new Map()

  const collect = (field, detailSource) => {
    if (typeof field === 'string') {
      fieldIds.add(field)
      return
    }
    if (!field || typeof field !== 'object' || typeof field.id !== 'string' || !field.id) return
    fieldIds.add(field.id)
    if (detailSource) fieldDetailsById.set(field.id, field)
  }

  if (Array.isArray(descriptor.fields)) {
    for (const field of descriptor.fields) collect(field, typeof field === 'object')
  }
  if (Array.isArray(descriptor.fieldDetails)) {
    for (const field of descriptor.fieldDetails) collect(field, true)
  }
  return { fieldIds, fieldDetailsById }
}

function addInvalidField(invalidFields, descriptorId, fieldId, message) {
  if (!invalidFields[descriptorId]) invalidFields[descriptorId] = {}
  if (!invalidFields[descriptorId][fieldId]) invalidFields[descriptorId][fieldId] = []
  invalidFields[descriptorId][fieldId].push(message)
}

function assertStagingDescriptors(body) {
  const data = body && body.data ? body.data : body
  if (!Array.isArray(data)) {
    throw new K3WisePostdeploySmokeError('staging descriptors response must be an array')
  }
  const descriptorsById = new Map()
  for (const descriptor of data) {
    if (descriptor && typeof descriptor.id === 'string') descriptorsById.set(descriptor.id, descriptor)
  }
  const ids = Array.from(descriptorsById.keys())
  for (const id of REQUIRED_STAGING_DESCRIPTORS) {
    if (!descriptorsById.has(id)) {
      throw new K3WisePostdeploySmokeError(`missing staging descriptor ${id}`, { ids })
    }
  }
  const missingFields = {}
  const invalidFields = {}
  let fieldsChecked = 0
  let fieldDetailsChecked = 0
  for (const id of REQUIRED_STAGING_DESCRIPTORS) {
    const descriptor = descriptorsById.get(id)
    const { fieldIds, fieldDetailsById } = collectDescriptorFields(descriptor)
    const requiredFieldDetails = REQUIRED_STAGING_FIELD_DETAILS[id] || {}
    const requiredFields = Object.keys(requiredFieldDetails)
    fieldsChecked += requiredFields.length
    const missing = requiredFields.filter((fieldId) => !fieldIds.has(fieldId))
    if (missing.length > 0) missingFields[id] = missing

    for (const [fieldId, expected] of Object.entries(requiredFieldDetails)) {
      const detail = fieldDetailsById.get(fieldId)
      if (!detail) {
        addInvalidField(invalidFields, id, fieldId, 'missing field detail')
        continue
      }
      fieldDetailsChecked += 1
      if (detail.type !== expected.type) {
        addInvalidField(invalidFields, id, fieldId, `expected type ${expected.type} but got ${detail.type || 'missing'}`)
      }
      if (Array.isArray(expected.options)) {
        const actualOptions = Array.isArray(detail.options) ? new Set(detail.options.map(String)) : new Set()
        const missingOptions = expected.options.filter((option) => !actualOptions.has(option))
        if (missingOptions.length > 0) {
          addInvalidField(invalidFields, id, fieldId, `missing options: ${missingOptions.join(', ')}`)
        }
      }
    }
  }
  if (Object.keys(missingFields).length > 0 || Object.keys(invalidFields).length > 0) {
    throw new K3WisePostdeploySmokeError('staging descriptors do not match required field contract', {
      missingFields,
      invalidFields,
    })
  }
  return {
    descriptors: ids,
    descriptorsChecked: REQUIRED_STAGING_DESCRIPTORS.length,
    fieldsChecked,
    fieldDetailsChecked,
  }
}

function assertListResponse(body, probeId) {
  const data = body && body.data !== undefined ? body.data : body
  if (!Array.isArray(data)) {
    throw new K3WisePostdeploySmokeError(`${probeId} response data must be an array`, {
      received: Array.isArray(data) ? 'array' : typeof data,
    })
  }
  return { rows: data.length }
}

function responseData(body) {
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}

function requireSystem(systems, { kind, role, label }) {
  const system = systems.find((candidate) => {
    if (!candidate || candidate.kind !== kind) return false
    return !role || candidate.role === role || candidate.role === 'bidirectional'
  })
  if (!system) {
    throw new K3WisePostdeploySmokeError(`${label || kind} system is not configured`, {
      kind,
      role: role || null,
      configuredKinds: systems
        .filter((candidate) => candidate && typeof candidate.kind === 'string')
        .map((candidate) => `${candidate.kind}:${candidate.role || 'unknown'}`),
    })
  }
  return system
}

function assertObjectListed(body, objectName, label) {
  const data = responseData(body)
  if (!Array.isArray(data)) {
    throw new K3WisePostdeploySmokeError(`${label} object list response data must be an array`, {
      received: Array.isArray(data) ? 'array' : typeof data,
    })
  }
  const object = data.find((item) => item && (item.name === objectName || item.object === objectName))
  if (!object) {
    throw new K3WisePostdeploySmokeError(`${label} does not list required object ${objectName}`, {
      objectName,
      listedObjects: data
        .filter((item) => item && (typeof item.name === 'string' || typeof item.object === 'string'))
        .map((item) => item.name || item.object),
    })
  }
  return object
}

function assertSchemaFields(body, objectName, requiredFields, label) {
  const data = responseData(body)
  const fields = Array.isArray(data?.fields) ? data.fields : []
  const fieldNames = fields
    .map((field) => (field && typeof field === 'object' ? field.name || field.id : field))
    .filter((field) => typeof field === 'string' && field)
  const missingFields = requiredFields.filter((field) => !fieldNames.includes(field))
  if (fields.length === 0 || missingFields.length > 0) {
    throw new K3WisePostdeploySmokeError(`${label} schema is missing required fields`, {
      objectName,
      fieldCount: fields.length,
      requiredFields,
      missingFields,
      fieldNames,
    })
  }
  return {
    object: data?.object || objectName,
    fieldCount: fields.length,
    requiredFields,
  }
}

function issue1542PipelinePayload({ tenantId, workspaceId, sourceSystemId, targetSystemId }) {
  return {
    id: ISSUE1542_SMOKE_PIPELINE_ID,
    tenantId,
    workspaceId: workspaceId || null,
    name: 'Issue 1542 postdeploy smoke: staging material to K3',
    description: 'Draft metadata-only smoke. Verifies Data Factory pipeline save without running dry-run or Save-only.',
    sourceSystemId,
    sourceObject: 'standard_materials',
    targetSystemId,
    targetObject: 'material',
    mode: 'manual',
    status: 'draft',
    idempotencyKeyFields: ['code'],
    options: {
      target: {
        autoSubmit: false,
        autoAudit: false,
      },
      workbench: {
        source: 'integration-k3wise-postdeploy-smoke',
        issue: '#1542',
      },
      k3Template: {
        id: 'material',
        version: '1',
        documentType: 'material',
        bodyKey: 'Data',
      },
    },
    fieldMappings: [
      {
        sourceField: 'code',
        targetField: 'FNumber',
        validation: [{ type: 'required' }],
        sortOrder: 0,
      },
      {
        sourceField: 'name',
        targetField: 'FName',
        validation: [{ type: 'required' }],
        sortOrder: 1,
      },
      {
        sourceField: 'uom',
        targetField: 'FBaseUnitID',
        defaultValue: 'PCS',
        sortOrder: 2,
      },
    ],
  }
}

function assertPipelineSaveResponse(body) {
  const data = responseData(body)
  if (!data || typeof data !== 'object' || !data.id) {
    throw new K3WisePostdeploySmokeError('pipeline save did not return a pipeline id', {
      body: sanitizeBody(body),
    })
  }
  if (data.id !== ISSUE1542_SMOKE_PIPELINE_ID) {
    throw new K3WisePostdeploySmokeError('pipeline save returned an unexpected id', {
      expected: ISSUE1542_SMOKE_PIPELINE_ID,
      actual: data.id,
    })
  }
  if (!Array.isArray(data.idempotencyKeyFields) || !data.idempotencyKeyFields.includes('code')) {
    throw new K3WisePostdeploySmokeError('pipeline save did not hydrate idempotencyKeyFields as an array', {
      idempotencyKeyFields: data.idempotencyKeyFields,
    })
  }
  if (!data.options || typeof data.options !== 'object' || data.options?.k3Template?.id !== 'material') {
    throw new K3WisePostdeploySmokeError('pipeline save did not hydrate options.k3Template', {
      options: sanitizeBody(data.options),
    })
  }
  if (!Array.isArray(data.fieldMappings) || data.fieldMappings.length < 3) {
    throw new K3WisePostdeploySmokeError('pipeline save did not return field mappings', {
      fieldMappingsLength: Array.isArray(data.fieldMappings) ? data.fieldMappings.length : null,
    })
  }
  return {
    pipelineId: data.id,
    status: data.status || null,
    fieldMappings: data.fieldMappings.length,
  }
}

async function runIssue1542WorkbenchSmoke({ baseUrl, token, tenantId, workspaceId, timeoutMs }) {
  const checks = []
  let systems = []
  let stagingSystem = null
  let k3TargetSystem = null

  try {
    const systemsResponse = await requestJson(baseUrl, withQuery('/api/integration/external-systems', {
      tenantId,
      workspaceId,
      limit: 100,
    }), { token, timeoutMs })
    const data = responseData(systemsResponse.body)
    if (!Array.isArray(data)) {
      throw new K3WisePostdeploySmokeError('external systems response data must be an array', {
        received: Array.isArray(data) ? 'array' : typeof data,
      })
    }
    systems = data
    stagingSystem = requireSystem(systems, {
      kind: 'metasheet:staging',
      role: 'source',
      label: 'MetaSheet staging source',
    })
    k3TargetSystem = requireSystem(systems, {
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      label: 'K3 WISE WebAPI target',
    })
    checks.push(result('issue1542-system-readiness', 'pass', {
      stagingSourceId: stagingSystem.id,
      targetSystemId: k3TargetSystem.id,
      systemsChecked: systems.length,
    }))
  } catch (error) {
    return [failResult('issue1542-system-readiness', error)]
  }

  try {
    const objects = await requestJson(baseUrl, withQuery(`/api/integration/external-systems/${encodeURIComponent(stagingSystem.id)}/objects`, {
      tenantId,
      workspaceId,
    }), { token, timeoutMs })
    assertObjectListed(objects.body, 'standard_materials', 'MetaSheet staging source')

    const schema = await requestJson(baseUrl, withQuery(`/api/integration/external-systems/${encodeURIComponent(stagingSystem.id)}/schema`, {
      tenantId,
      workspaceId,
      object: 'standard_materials',
    }), { token, timeoutMs })
    checks.push(result('issue1542-staging-source-schema', 'pass', {
      systemId: stagingSystem.id,
      ...assertSchemaFields(schema.body, 'standard_materials', ['code', 'name', 'uom'], 'MetaSheet staging source'),
    }))
  } catch (error) {
    checks.push(failResult('issue1542-staging-source-schema', error))
  }

  try {
    const objects = await requestJson(baseUrl, withQuery(`/api/integration/external-systems/${encodeURIComponent(k3TargetSystem.id)}/objects`, {
      tenantId,
      workspaceId,
    }), { token, timeoutMs })
    assertObjectListed(objects.body, 'material', 'K3 WISE target')

    const schema = await requestJson(baseUrl, withQuery(`/api/integration/external-systems/${encodeURIComponent(k3TargetSystem.id)}/schema`, {
      tenantId,
      workspaceId,
      object: 'material',
    }), { token, timeoutMs })
    checks.push(result('issue1542-k3-material-schema', 'pass', {
      systemId: k3TargetSystem.id,
      ...assertSchemaFields(schema.body, 'material', ['FNumber', 'FName', 'FBaseUnitID'], 'K3 WISE target'),
    }))
  } catch (error) {
    checks.push(failResult('issue1542-k3-material-schema', error))
  }

  try {
    const payload = issue1542PipelinePayload({
      tenantId,
      workspaceId,
      sourceSystemId: stagingSystem.id,
      targetSystemId: k3TargetSystem.id,
    })
    const saved = await requestJson(baseUrl, '/api/integration/pipelines', {
      token,
      timeoutMs,
      method: 'POST',
      requestBody: payload,
      acceptStatuses: [200, 201],
    })
    checks.push(result('issue1542-pipeline-save', 'pass', assertPipelineSaveResponse(saved.body)))
  } catch (error) {
    checks.push(failResult('issue1542-pipeline-save', error))
  }

  return checks
}

function assertFrontendAppShell(page, label) {
  if (!/id=["']app["']/.test(page.text) && !/MetaSheet|metasheet/i.test(page.text)) {
    throw new K3WisePostdeploySmokeError(`${label} frontend route did not look like the app shell`)
  }
  return {
    httpStatus: page.status,
    bytes: page.text.length,
  }
}

function extractTenantId(authBody) {
  const candidates = [
    authBody?.tenantId,
    authBody?.user?.tenantId,
    authBody?.data?.tenantId,
    authBody?.data?.user?.tenantId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

async function runSmoke(opts) {
  const checks = []
  const resolvedToken = await resolveToken(opts)
  const token = resolvedToken.token
  if (resolvedToken.check) checks.push(resolvedToken.check)

  try {
    const health = await requestJson(opts.baseUrl, '/api/health', { timeoutMs: opts.timeoutMs })
    const summary = health.body?.pluginsSummary || {}
    if (health.body?.ok !== true && health.body?.success !== true && health.body?.status !== 'ok') {
      throw new K3WisePostdeploySmokeError('/api/health did not report ok', { body: health.body })
    }
    if (summary.failed !== undefined && Number(summary.failed) !== 0) {
      throw new K3WisePostdeploySmokeError('/api/health reports failed plugins', { pluginsSummary: summary })
    }
    checks.push(result('api-health', 'pass', {
      plugins: health.body?.plugins ?? null,
      pluginsSummary: summary,
    }))
  } catch (error) {
    checks.push(failResult('api-health', error))
  }

  try {
    const pluginHealth = await requestJson(opts.baseUrl, '/api/integration/health', { token, timeoutMs: opts.timeoutMs })
    if (pluginHealth.body?.ok !== true || pluginHealth.body?.plugin !== 'plugin-integration-core') {
      throw new K3WisePostdeploySmokeError('/api/integration/health did not report integration-core ok', {
        body: pluginHealth.body,
      })
    }
    checks.push(result('integration-plugin-health', 'pass', {
      plugin: pluginHealth.body.plugin,
      milestone: pluginHealth.body.milestone,
    }))
  } catch (error) {
    if (!token && error?.details && (error.details.status === 401 || error.details.status === 403)) {
      checks.push(result('integration-plugin-health', 'skipped', {
        reason: '/api/integration/health requires an auth token on this deployment',
      }))
    } else {
      checks.push(failResult('integration-plugin-health', error))
    }
  }

  try {
    const page = await requestText(opts.baseUrl, '/integrations/k3-wise', { timeoutMs: opts.timeoutMs })
    checks.push(result('k3-wise-frontend-route', 'pass', assertFrontendAppShell(page, 'K3 WISE')))
  } catch (error) {
    checks.push(failResult('k3-wise-frontend-route', error))
  }

  try {
    const page = await requestText(opts.baseUrl, '/integrations/workbench', { timeoutMs: opts.timeoutMs })
    checks.push(result('data-factory-frontend-route', 'pass', assertFrontendAppShell(page, 'Data Factory')))
  } catch (error) {
    checks.push(failResult('data-factory-frontend-route', error))
  }

  if (!token) {
    const skipped = result('authenticated-integration-contract', opts.requireAuth ? 'fail' : 'skipped', {
      reason: 'no bearer token supplied',
    })
    checks.push(skipped)
    if (opts.issue1542WorkbenchSmoke) {
      checks.push(result('issue1542-workbench-smoke', 'fail', {
        reason: '--issue1542-workbench-smoke requires an auth token because it probes configured systems and saves draft pipeline metadata',
      }))
    }
  } else {
    let tenantId = opts.tenantId
    try {
      const me = await requestJson(opts.baseUrl, '/api/auth/me', { token, timeoutMs: opts.timeoutMs })
      const user = me.body?.user || me.body?.data?.user || me.body?.data || {}
      tenantId = tenantId || extractTenantId(me.body)
      checks.push(result('auth-me', 'pass', {
        userId: user.id || user.userId || null,
        role: user.role || null,
        tenantId: tenantId || null,
      }))
    } catch (error) {
      checks.push(failResult('auth-me', error))
    }

    try {
      const status = await requestJson(opts.baseUrl, '/api/integration/status', { token, timeoutMs: opts.timeoutMs })
      checks.push(result('integration-route-contract', 'pass', assertStatusRoutes(status.body)))
    } catch (error) {
      checks.push(failResult('integration-route-contract', error))
    }

    try {
      const adapterDiscovery = await requestJson(opts.baseUrl, '/api/integration/adapters', { token, timeoutMs: opts.timeoutMs })
      checks.push(result('data-factory-adapter-discovery', 'pass', assertDataFactoryAdapterDiscovery(adapterDiscovery.body)))
    } catch (error) {
      checks.push(failResult('data-factory-adapter-discovery', error))
    }

    for (const [id, pathname] of CONTROL_PLANE_LIST_PROBES) {
      try {
        const response = await requestJson(opts.baseUrl, withQuery(pathname, {
          tenantId,
          limit: 1,
        }), { token, timeoutMs: opts.timeoutMs })
        checks.push(result(id, 'pass', {
          path: pathname,
          tenantId: tenantId || null,
          ...assertListResponse(response.body, id),
        }))
      } catch (error) {
        checks.push(failResult(id, error))
      }
    }

    try {
      const descriptors = await requestJson(opts.baseUrl, '/api/integration/staging/descriptors', { token, timeoutMs: opts.timeoutMs })
      checks.push(result('staging-descriptor-contract', 'pass', assertStagingDescriptors(descriptors.body)))
    } catch (error) {
      checks.push(failResult('staging-descriptor-contract', error))
    }

    if (opts.issue1542WorkbenchSmoke) {
      if (!tenantId) {
        checks.push(result('issue1542-workbench-smoke', 'fail', {
          reason: 'tenantId could not be resolved from --tenant-id, environment, or /api/auth/me',
        }))
      } else {
        checks.push(...await runIssue1542WorkbenchSmoke({
          baseUrl: opts.baseUrl,
          token,
          tenantId,
          workspaceId: opts.workspaceId || '',
          timeoutMs: opts.timeoutMs,
        }))
      }
    }
  }

  const failed = checks.filter((check) => check.status === 'fail')
  const internalTrialSignoff = failed.length === 0 && Boolean(token)
  const internalTrialSignoffReason = internalTrialSignoff
    ? 'authenticated smoke passed'
    : failed.length > 0
      ? 'one or more smoke checks failed'
      : 'authenticated checks did not run'
  const evidence = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    authenticated: Boolean(token),
    requireAuth: opts.requireAuth,
    signoff: {
      internalTrial: internalTrialSignoff ? 'pass' : 'blocked',
      reason: internalTrialSignoffReason,
    },
    checks,
    summary: {
      pass: checks.filter((check) => check.status === 'pass').length,
      skipped: checks.filter((check) => check.status === 'skipped').length,
      fail: failed.length,
    },
  }
  return evidence
}

async function writeEvidence(evidence, opts) {
  const outDir = path.resolve(opts.outDir || path.join(DEFAULT_OUTPUT_ROOT, nowStamp()))
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-postdeploy-smoke.json')
  const mdPath = path.join(outDir, 'integration-k3wise-postdeploy-smoke.md')
  await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(evidence))
  return { outDir, jsonPath, mdPath }
}

function renderMarkdown(evidence) {
  const lines = [
    '# Integration K3 WISE Postdeploy Smoke',
    '',
    `- Generated at: ${markdownInlineCode(evidence.generatedAt)}`,
    `- Base URL: ${markdownInlineCode(evidence.baseUrl)}`,
    `- Authenticated checks: ${evidence.authenticated ? 'yes' : 'no'}`,
    `- Internal trial signoff: ${evidence.signoff?.internalTrial === 'pass' ? 'PASS' : 'BLOCKED'} (${markdownText(evidence.signoff?.reason || 'unknown')})`,
    `- Diagnostic result: ${evidence.ok ? 'PASS' : 'FAIL'}`,
    `- Summary: ${evidence.summary.pass} pass / ${evidence.summary.skipped} skipped / ${evidence.summary.fail} fail`,
    '',
    '## Checks',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
  ]
  for (const check of evidence.checks) {
    const detail = check.error || check.reason || JSON.stringify({ ...check, id: undefined, status: undefined })
    lines.push(`| ${markdownTableCodeCell(check.id)} | ${markdownTableCodeCell(check.status)} | ${markdownTableCodeCell(detail)} |`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }
  const evidence = await runSmoke(opts)
  const paths = await writeEvidence(evidence, opts)
  console.log(JSON.stringify({
    ok: evidence.ok,
    baseUrl: evidence.baseUrl,
    authenticated: evidence.authenticated,
    signoff: evidence.signoff,
    summary: evidence.summary,
    jsonPath: paths.jsonPath,
    mdPath: paths.mdPath,
  }, null, 2))
  return evidence.ok ? 0 : 1
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().then((code) => {
    process.exit(code)
  }).catch((error) => {
    const body = error instanceof K3WisePostdeploySmokeError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(sanitizeBody(body), null, 2))
    process.exit(1)
  })
}

export {
  K3WisePostdeploySmokeError,
  assertDataFactoryAdapterDiscovery,
  assertStagingDescriptors,
  assertStatusRoutes,
  markdownInlineCode,
  markdownText,
  parseArgs,
  renderMarkdown,
  runCli,
  runSmoke,
}
