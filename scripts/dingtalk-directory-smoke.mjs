#!/usr/bin/env node

const args = process.argv.slice(2)

function readFlag(name) {
  const index = args.findIndex((arg) => arg === name)
  if (index < 0) return null
  const next = args[index + 1]
  if (!next || next.startsWith('--')) return null
  return next
}

function hasFlag(name) {
  return args.includes(name)
}

function printHelp() {
  console.log(`Usage:
  node scripts/dingtalk-directory-smoke.mjs --base-url http://127.0.0.1:8081 --token <bearer> [--integration-id dir-1] [--page-size 20] [--export-limit 100]

Environment fallback:
  METASHEET_BASE_URL / BASE_URL
  METASHEET_ADMIN_TOKEN / ADMIN_TOKEN / TOKEN
  DIRECTORY_INTEGRATION_ID

Behavior:
  1. GET /api/admin/directory/integrations
  2. Resolve integrationId from --integration-id or the first integration
  3. GET /runs, /departments, /accounts?page=1&pageSize=N
  4. GET /accounts/export.csv?limit=N
  5. Validate pagination, summary fields, CSV headers, and export response headers
`)
}

if (hasFlag('--help')) {
  printHelp()
  process.exit(0)
}

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function ensureTrailingSlashRemoved(value) {
  return value.replace(/\/$/, '')
}

function toRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function readNumber(record, key) {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null
}

function readBoolean(record, key) {
  return typeof record[key] === 'boolean' ? record[key] : null
}

async function requestJson(baseUrl, token, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
  const payload = await response.json().catch(() => ({}))
  return {
    ok: response.ok,
    status: response.status,
    payload: toRecord(payload),
  }
}

async function requestText(baseUrl, token, path, accept = 'text/plain') {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
    },
  })
  const body = await response.text().catch(() => '')
  return {
    ok: response.ok,
    status: response.status,
    body,
    headers: response.headers,
  }
}

function unwrapItems(payload) {
  const data = toRecord(payload.data)
  const items = Array.isArray(data.items) ? data.items : Array.isArray(payload.items) ? payload.items : []
  return items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
}

function unwrapData(payload) {
  return toRecord(payload.data)
}

function summarizeFailure(label, result) {
  const error = toRecord(result.payload.error)
  const message = typeof error.message === 'string' && error.message ? error.message : JSON.stringify(result.payload)
  return `${label} failed with HTTP ${result.status}: ${message}`
}

function summarizeTextFailure(label, result) {
  return `${label} failed with HTTP ${result.status}: ${result.body || '<empty body>'}`
}

function readHeaderNumber(headers, key) {
  const raw = headers.get(key)
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function readHeaderBoolean(headers, key) {
  const raw = headers.get(key)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '')
}

const baseUrl = ensureTrailingSlashRemoved(
  readFlag('--base-url')
  || readEnv('METASHEET_BASE_URL', 'BASE_URL', 'PUBLIC_APP_URL'),
)
const token = readFlag('--token') || readEnv('METASHEET_ADMIN_TOKEN', 'ADMIN_TOKEN', 'TOKEN')
const requestedIntegrationId = readFlag('--integration-id') || readEnv('DIRECTORY_INTEGRATION_ID')
const pageSizeRaw = Number(readFlag('--page-size') || '20')
const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.trunc(pageSizeRaw), 100) : 20
const exportLimitRaw = Number(readFlag('--export-limit') || String(pageSize))
const exportLimit = Number.isFinite(exportLimitRaw) && exportLimitRaw > 0 ? Math.min(Math.trunc(exportLimitRaw), 10000) : pageSize

if (!baseUrl || !token) {
  printHelp()
  console.error('\nMissing required base URL or admin token.')
  process.exit(1)
}

const integrationsResult = await requestJson(baseUrl, token, '/api/admin/directory/integrations')
if (!integrationsResult.ok) {
  console.error(summarizeFailure('Directory integrations request', integrationsResult))
  process.exit(1)
}

const integrations = unwrapItems(integrationsResult.payload)
const selectedIntegration = requestedIntegrationId
  ? integrations.find((item) => item.id === requestedIntegrationId)
  : integrations[0]

if (!selectedIntegration) {
  console.error(`No directory integration found${requestedIntegrationId ? ` for id ${requestedIntegrationId}` : ''}.`)
  process.exit(1)
}

const integrationId = String(selectedIntegration.id)

const [runsResult, departmentsResult, accountsResult, exportResult] = await Promise.all([
  requestJson(baseUrl, token, `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/runs`),
  requestJson(baseUrl, token, `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/departments`),
  requestJson(baseUrl, token, `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts?page=1&pageSize=${pageSize}`),
  requestText(
    baseUrl,
    token,
    `/api/admin/directory/integrations/${encodeURIComponent(integrationId)}/accounts/export.csv?limit=${exportLimit}`,
    'text/csv',
  ),
])

for (const [label, result] of [
  ['Directory runs request', runsResult],
  ['Directory departments request', departmentsResult],
  ['Directory accounts request', accountsResult],
]) {
  if (!result.ok) {
    console.error(summarizeFailure(label, result))
    process.exit(1)
  }
}

if (!exportResult.ok) {
  console.error(summarizeTextFailure('Directory accounts export request', exportResult))
  process.exit(1)
}

const accountsData = unwrapData(accountsResult.payload)
const summary = toRecord(accountsData.summary)
const requiredSummaryKeys = [
  'linked',
  'pending',
  'conflict',
  'ignored',
  'active',
  'inactive',
  'dingtalkAuthEnabled',
  'dingtalkAuthDisabled',
  'bound',
  'unbound',
]
const missingSummaryKeys = requiredSummaryKeys.filter((key) => readNumber(summary, key) === null)
if (missingSummaryKeys.length > 0) {
  console.error(`Directory accounts summary is missing keys: ${missingSummaryKeys.join(', ')}`)
  process.exit(1)
}

const total = readNumber(accountsData, 'total')
const page = readNumber(accountsData, 'page')
const responsePageSize = readNumber(accountsData, 'pageSize')
const pageCount = readNumber(accountsData, 'pageCount')
const hasNextPage = readBoolean(accountsData, 'hasNextPage')
const hasPreviousPage = readBoolean(accountsData, 'hasPreviousPage')

if ([total, page, responsePageSize, pageCount].some((value) => value === null) || hasNextPage === null || hasPreviousPage === null) {
  console.error('Directory accounts response is missing pagination fields.')
  process.exit(1)
}

const exportContentType = exportResult.headers.get('content-type') || ''
if (!exportContentType.toLowerCase().includes('text/csv')) {
  console.error(`Directory accounts export content-type must include text/csv, received: ${exportContentType || '<missing>'}`)
  process.exit(1)
}

const exportFilename = exportResult.headers.get('content-disposition') || ''
if (!/filename=/i.test(exportFilename)) {
  console.error('Directory accounts export is missing content-disposition filename header.')
  process.exit(1)
}

const exportTotal = readHeaderNumber(exportResult.headers, 'x-export-total')
const exportReturned = readHeaderNumber(exportResult.headers, 'x-export-returned')
const exportTruncated = readHeaderBoolean(exportResult.headers, 'x-export-truncated')
if ([exportTotal, exportReturned].some((value) => value === null) || exportTruncated === null) {
  console.error('Directory accounts export is missing X-Export-* headers.')
  process.exit(1)
}

if (exportReturned > exportTotal) {
  console.error(`Directory accounts export returned count ${exportReturned} cannot exceed total ${exportTotal}.`)
  process.exit(1)
}

const csvBody = stripBom(exportResult.body)
if (!csvBody.startsWith('external_user_id,name,nick,email,')) {
  console.error('Directory accounts export CSV is missing the expected header row.')
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  integration: {
    id: integrationId,
    name: selectedIntegration.name || '',
    corpId: selectedIntegration.corpId || selectedIntegration.corp_id || '',
  },
  counts: {
    integrations: integrations.length,
    runs: unwrapItems(runsResult.payload).length,
    departments: unwrapItems(departmentsResult.payload).length,
    accountsOnPage: unwrapItems(accountsResult.payload).length,
    totalAccounts: total,
  },
  pagination: {
    page,
    pageSize: responsePageSize,
    pageCount,
    hasNextPage,
    hasPreviousPage,
  },
  export: {
    limit: exportLimit,
    total: exportTotal,
    returned: exportReturned,
    truncated: exportTruncated,
    contentType: exportContentType,
    contentDisposition: exportFilename,
  },
  summary,
}, null, 2))
