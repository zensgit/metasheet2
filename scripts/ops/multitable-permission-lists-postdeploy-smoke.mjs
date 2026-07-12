#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NOT_RUN = 'NOT_RUN'
const SAFE_REUSABLE_BASE_TOKENS = new Set([
  'baseline',
  'benchmark',
  'perf',
  'performance',
  'smoke',
  'staging',
  'test',
  'testing',
])

export function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '')
}

export function sanitizeErrorCode(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const normalized = value.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : 'UNSAFE_ERROR_CODE'
}

export function isSafeReusableBaseName(value) {
  if (typeof value !== 'string') return false
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return tokens.some((token) => SAFE_REUSABLE_BASE_TOKENS.has(token))
}

export function leakScan(subject, sentinels) {
  const serialized = JSON.stringify(subject)
  return sentinels.every((sentinel) => (
    typeof sentinel !== 'string'
    || sentinel.length === 0
    || !serialized.includes(sentinel)
  ))
}

export function formatSummaryBlock(summary) {
  const lines = ['MULTITABLE_PERMISSION_LISTS_POSTDEPLOY_SMOKE']
  for (const [key, value] of Object.entries(summary)) lines.push(`${key}=${value}`)
  return lines.join('\n')
}

function initialSummary() {
  return {
    pass: false,
    setupRequestsPassed: 0,
    setupRequestsExpected: 4,
    setupComplete: false,
    baseSelectionMode: 'discovered_safe_name',
    baseListHttp: NOT_RUN,
    baseCandidates: 0,
    baseSelectionAttempts: 0,
    setupFailureStep: 'none',
    setupFailureHttp: NOT_RUN,
    setupFailureCode: '',
    viewPermissionsHttp: NOT_RUN,
    viewPermissionsContract: false,
    viewPermissionsErrorCode: '',
    fieldPermissionsHttp: NOT_RUN,
    fieldPermissionsContract: false,
    fieldPermissionsErrorCode: '',
    recordPermissionsHttp: NOT_RUN,
    recordPermissionsContract: false,
    recordPermissionsErrorCode: '',
    cleanupRequired: false,
    cleanupAttempted: false,
    cleanupHttp: NOT_RUN,
    cleanupOk: true,
    selfScanClean: false,
  }
}

function requestFailure(error) {
  if (error?.name === 'AbortError') {
    return { status: 'TIMEOUT', ok: false, body: null, errorCode: 'TIMEOUT' }
  }
  return { status: 'NETWORK_ERROR', ok: false, body: null, errorCode: 'NETWORK_ERROR' }
}

async function requestJson({ baseUrl, token, timeoutMs, fetchImpl }, pathname, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    }
    const init = {
      method: options.method || 'GET',
      headers,
      signal: controller.signal,
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    const response = await fetchImpl(`${baseUrl}${pathname}`, init)
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
      errorCode: sanitizeErrorCode(body?.error?.code),
    }
  } catch (error) {
    return requestFailure(error)
  } finally {
    clearTimeout(timer)
  }
}

class SetupFailure extends Error {
  constructor(step, outcome, code = '') {
    super('postdeploy smoke setup failed')
    this.step = step
    this.status = outcome.status
    this.code = code || outcome.errorCode
  }
}

function requireCreatedId(step, outcome, value) {
  if (!outcome.ok) throw new SetupFailure(step, outcome)
  if (typeof value !== 'string' || value.length === 0) {
    throw new SetupFailure(step, outcome, 'MISSING_RESPONSE_ID')
  }
  return value
}

function safeBaseCandidates(outcome, sentinels) {
  if (!outcome.ok) throw new SetupFailure('base_list', outcome)
  const bases = outcome.body?.data?.bases
  if (!Array.isArray(bases)) {
    throw new SetupFailure('base_list', outcome, 'INVALID_BASE_LIST_CONTRACT')
  }
  const candidates = []
  for (const base of bases) {
    if (typeof base?.id === 'string' && base.id.length > 0) sentinels.push(base.id)
    if (typeof base?.name === 'string' && base.name.length > 0) sentinels.push(base.name)
    if (
      typeof base?.id === 'string'
      && base.id.length > 0
      && isSafeReusableBaseName(base?.name)
    ) {
      candidates.push(base.id)
    }
  }
  return candidates
}

function applyPermissionOutcome(summary, prefix, outcome) {
  summary[`${prefix}Http`] = outcome.status
  summary[`${prefix}ErrorCode`] = outcome.errorCode
  summary[`${prefix}Contract`] = (
    outcome.ok
    && outcome.body?.ok === true
    && Array.isArray(outcome.body?.data?.items)
  )
}

function safeProjection(summary) {
  const projected = { ...summary }
  delete projected.selfScanClean
  return { summary: projected }
}

export async function runSmoke({
  baseUrl,
  baseId,
  token,
  timeoutMs = 15000,
  fetchImpl = fetch,
  now = () => Date.now(),
  random = () => Math.random(),
}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedBaseUrl || !token) {
    throw new Error('baseUrl and token are required')
  }

  const summary = initialSummary()
  const salt = `${now().toString(36)}-${random().toString(36).slice(2, 10)}`
  const sheetName = `permission-list-smoke-${salt}`
  const requestedSheetId = `sheet_smoke_${salt.replace(/[^a-z0-9]/gi, '')}`.slice(0, 50)
  const fieldName = `smoke-field-${salt}`
  const viewName = `smoke-view-${salt}`
  const recordSentinel = `smoke-value-${salt}`
  const sentinels = [token, baseId, requestedSheetId, sheetName, fieldName, viewName, recordSentinel]
  const client = { baseUrl: normalizedBaseUrl, token, timeoutMs, fetchImpl }

  let sheetId = ''
  let fieldId = ''
  let viewId = ''
  let recordId = ''

  try {
    let candidateBaseIds
    if (baseId) {
      summary.baseSelectionMode = 'configured'
      summary.baseListHttp = 'SKIPPED'
      summary.baseCandidates = 1
      candidateBaseIds = [baseId]
    } else {
      const baseList = await requestJson(client, '/api/multitable/bases')
      summary.baseListHttp = baseList.status
      candidateBaseIds = safeBaseCandidates(baseList, sentinels)
      summary.baseCandidates = candidateBaseIds.length
      if (candidateBaseIds.length === 0) {
        throw new SetupFailure(
          'base_selection',
          { status: 'NO_SAFE_BASE', errorCode: 'NO_SAFE_BASE' },
        )
      }
    }

    let lastSheetOutcome = null
    for (const candidateBaseId of candidateBaseIds) {
      summary.baseSelectionAttempts += 1
      const sheet = await requestJson(client, '/api/multitable/sheets', {
        method: 'POST',
        body: { id: requestedSheetId, baseId: candidateBaseId, name: sheetName },
      })
      lastSheetOutcome = sheet
      if (!sheet.ok && (sheet.status === 403 || sheet.status === 404)) continue
      if (!sheet.ok) {
        if (sheet.status === 'TIMEOUT' || sheet.status === 'NETWORK_ERROR') {
          sheetId = requestedSheetId
          summary.cleanupRequired = true
        }
        throw new SetupFailure('sheet', sheet)
      }
      sheetId = requestedSheetId
      summary.cleanupRequired = true
      const returnedSheetId = requireCreatedId('sheet', sheet, sheet.body?.data?.sheet?.id)
      if (returnedSheetId !== requestedSheetId) {
        throw new SetupFailure('sheet', sheet, 'UNEXPECTED_RESPONSE_ID')
      }
      break
    }
    if (!sheetId) {
      throw new SetupFailure(
        'sheet',
        lastSheetOutcome ?? { status: 'NO_SAFE_BASE', errorCode: 'NO_SAFE_BASE' },
      )
    }
    summary.setupRequestsPassed += 1

    const field = await requestJson(client, '/api/multitable/fields', {
      method: 'POST',
      body: { sheetId, name: fieldName, type: 'string' },
    })
    fieldId = requireCreatedId('field', field, field.body?.data?.field?.id)
    sentinels.push(fieldId)
    summary.setupRequestsPassed += 1

    const view = await requestJson(client, '/api/multitable/views', {
      method: 'POST',
      body: { sheetId, name: viewName, type: 'grid' },
    })
    viewId = requireCreatedId('view', view, view.body?.data?.view?.id)
    sentinels.push(viewId)
    summary.setupRequestsPassed += 1

    const record = await requestJson(client, '/api/multitable/records', {
      method: 'POST',
      body: { sheetId, data: { [fieldId]: recordSentinel } },
    })
    recordId = requireCreatedId('record', record, record.body?.data?.record?.id)
    sentinels.push(recordId)
    summary.setupRequestsPassed += 1
    summary.setupComplete = true

    const viewPermissions = await requestJson(
      client,
      `/api/multitable/views/${encodeURIComponent(viewId)}/permissions`,
    )
    applyPermissionOutcome(summary, 'viewPermissions', viewPermissions)

    const fieldPermissions = await requestJson(
      client,
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/field-permissions`,
    )
    applyPermissionOutcome(summary, 'fieldPermissions', fieldPermissions)

    const recordPermissions = await requestJson(
      client,
      `/api/multitable/sheets/${encodeURIComponent(sheetId)}/records/${encodeURIComponent(recordId)}/permissions`,
    )
    applyPermissionOutcome(summary, 'recordPermissions', recordPermissions)
  } catch (error) {
    if (error instanceof SetupFailure) {
      summary.setupFailureStep = error.step
      summary.setupFailureHttp = error.status
      summary.setupFailureCode = sanitizeErrorCode(error.code)
    } else {
      summary.setupFailureStep = 'internal'
      summary.setupFailureHttp = 'INTERNAL_ERROR'
      summary.setupFailureCode = 'INTERNAL_SMOKE_ERROR'
    }
  } finally {
    if (sheetId) {
      summary.cleanupAttempted = true
      const cleanup = await requestJson(
        client,
        `/api/multitable/sheets/${encodeURIComponent(sheetId)}`,
        { method: 'DELETE' },
      )
      summary.cleanupHttp = cleanup.status
      summary.cleanupOk = cleanup.ok
    }
  }

  summary.selfScanClean = leakScan(safeProjection(summary), sentinels)
  summary.pass = (
    summary.setupComplete
    && summary.viewPermissionsContract
    && summary.fieldPermissionsContract
    && summary.recordPermissionsContract
    && summary.cleanupOk
    && summary.selfScanClean
  )

  const report = { summary }
  if (!leakScan(report, sentinels)) {
    summary.pass = false
    summary.selfScanClean = false
  }

  return { report, exitCode: summary.pass ? 0 : 1 }
}

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    baseId: '',
    timeoutMs: 15000,
    outDir: '',
  }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--base-url') args.baseUrl = next()
    else if (flag === '--base-id') args.baseId = next()
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next())
    else if (flag === '--out-dir') args.outDir = next()
    else throw new Error('unknown flag')
  }
  if (!args.baseUrl) throw new Error('missing required argument')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('invalid timeout')
  return args
}

async function writeReport(outDir, report) {
  if (!outDir) return
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(
    path.join(outDir, 'multitable-permission-lists-postdeploy-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(outDir, 'summary.txt'),
    `${formatSummaryBlock(report.summary)}\n`,
  )
}

async function main() {
  try {
    const args = parseArgs(process.argv)
    const token = process.env.METASHEET_AUTH_TOKEN || ''
    if (!token) throw new Error('missing token')
    const result = await runSmoke({ ...args, token })
    await writeReport(args.outDir, result.report)
    process.stdout.write(`${formatSummaryBlock(result.report.summary)}\n`)
    process.exitCode = result.exitCode
  } catch {
    process.stderr.write('[permission-list-smoke] configuration or output error\n')
    process.exitCode = 2
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : ''
if (entryUrl === import.meta.url) await main()
