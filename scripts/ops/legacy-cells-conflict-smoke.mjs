#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 15_000

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function resolveApiBase(value) {
  const normalized = normalizeBaseUrl(value)
  if (!normalized) return ''
  try {
    const url = new URL(normalized)
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/api'
      return normalizeBaseUrl(url.toString())
    }
    if (url.pathname.endsWith('/api')) return normalized
    return normalized
  } catch {
    return normalized.endsWith('/api') ? normalized : `${normalized}/api`
  }
}

export function cellEndpoint(apiBase, spreadsheetId, sheetId) {
  return `${resolveApiBase(apiBase)}/spreadsheets/${encodeURIComponent(spreadsheetId)}/sheets/${encodeURIComponent(sheetId)}/cells`
}

export function parseEnvFile(content) {
  const result = {}
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [rawKey, ...rest] = trimmed.split('=')
    const key = rawKey.trim()
    let value = rest.join('=').trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) result[key] = value
  }
  return result
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--env-file') {
      args.envFile = argv[i + 1] || ''
      i += 1
      continue
    }
    if (arg === '--json') {
      args.json = true
      continue
    }
  }
  return args
}

export function parseConfig(env = process.env, args = parseArgs()) {
  let fileEnv = {}
  if (args.envFile) {
    fileEnv = parseEnvFile(fs.readFileSync(args.envFile, 'utf8'))
  }
  const merged = { ...fileEnv, ...env }
  const apiBase = resolveApiBase(merged.API_BASE || merged.BASE_URL || merged.STAGING_BASE_URL)
  const outputDir = String(
    merged.OUTPUT_DIR ||
      `output/legacy-cells-conflict-smoke/${new Date().toISOString().replace(/[:.]/g, '-')}`,
  )

  return {
    apiBase,
    token: String(merged.AUTH_TOKEN || merged.TOKEN || '').trim(),
    loginIdentifier: String(
      merged.LOGIN_EMAIL ||
        merged.LOGIN_USERNAME ||
        merged.USERNAME ||
        merged.YUANTUS_BOOTSTRAP_ADMIN_USERNAME ||
        '',
    ).trim(),
    loginPassword: String(
      merged.LOGIN_PASSWORD ||
        merged.PASSWORD ||
        merged.YUANTUS_BOOTSTRAP_ADMIN_PASSWORD ||
        '',
    ),
    tenantId: String(merged.TENANT_ID || merged.YUANTUS_BOOTSTRAP_TENANT_ID || '').trim(),
    allowDevToken: isTruthy(merged.ALLOW_DEV_TOKEN),
    confirmWrite: isTruthy(merged.CONFIRM_WRITE),
    cleanup: !isFalsy(merged.CLEANUP),
    timeoutMs: positiveNumber(merged.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    outputDir,
    reportPath: String(merged.REPORT_JSON || path.join(outputDir, 'report.json')),
    reportMdPath: String(merged.REPORT_MD || path.join(outputDir, 'report.md')),
    spreadsheetName: String(
      merged.SPREADSHEET_NAME || `legacy-cell-conflict-smoke-${new Date().toISOString()}`,
    ),
    args,
  }
}

export function validateConfig(config) {
  const missing = []
  if (!config.apiBase) missing.push('API_BASE or BASE_URL')
  if (!config.confirmWrite) missing.push('CONFIRM_WRITE=1')
  if (!config.token && !(config.loginIdentifier && config.loginPassword) && !config.allowDevToken) {
    missing.push('AUTH_TOKEN/TOKEN or LOGIN_EMAIL/USERNAME + LOGIN_PASSWORD/PASSWORD or ALLOW_DEV_TOKEN=1')
  }
  return missing
}

export function renderLegacyCellsConflictSmokeMarkdown(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failing = checks.filter((check) => check && check.ok === false)
  const lines = [
    '# Legacy Cells Conflict Smoke',
    '',
    `- Overall: **${report?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- API base: \`${report?.apiBase || 'missing'}\``,
    `- Spreadsheet ID: \`${report?.spreadsheetId || 'missing'}\``,
    `- Sheet ID: \`${report?.sheetId || 'missing'}\``,
    `- Auth source: \`${report?.authSource || 'unknown'}\``,
    `- Cleanup attempted: \`${report?.cleanupAttempted ? 'true' : 'false'}\``,
    `- Cleanup ok: \`${report?.cleanupOk ? 'true' : 'false'}\``,
    `- Started at: \`${report?.startedAt || 'missing'}\``,
    `- Finished at: \`${report?.finishedAt || 'missing'}\``,
    `- JSON report: \`${report?.reportPath || 'missing'}\``,
    `- Markdown report: \`${report?.reportMdPath || 'missing'}\``,
    '',
    '## Checks',
    '',
    `- Total checks: \`${checks.length}\``,
    failing.length
      ? `- Failing checks: ${failing.map((check) => `\`${check.name}\``).join(', ')}`
      : '- Failing checks: none',
  ]

  if (report?.error) {
    lines.push(`- Error: \`${report.error}\``)
  }

  lines.push('', '## Check Results', '')
  for (const check of checks) {
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
  }

  if (report?.conflict) {
    lines.push('', '## Conflict Payload', '', '```json')
    lines.push(JSON.stringify(report.conflict, null, 2))
    lines.push('```')
  }

  if (report?.finalCell) {
    lines.push('', '## Final Cell', '', '```json')
    lines.push(JSON.stringify(report.finalCell, null, 2))
    lines.push('```')
  }

  return `${lines.join('\n')}\n`
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function isFalsy(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase())
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function authHeaders(token, config, extra = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(config.tenantId ? { 'x-tenant-id': config.tenantId } : {}),
    ...extra,
  }
}

async function fetchJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = { raw: text }
      }
    }
    return { res, json }
  } finally {
    clearTimeout(timer)
  }
}

function extractToken(payload) {
  const value = payload?.data?.token ?? payload?.token ?? ''
  return typeof value === 'string' ? value.trim() : ''
}

async function validateToken(config, token) {
  if (!token) return false
  const result = await fetchJson(`${config.apiBase}/auth/me`, {
    headers: authHeaders(token, config),
  }, config.timeoutMs)
  return result.res.ok && result.json?.ok !== false && result.json?.success !== false
}

async function login(config) {
  const payload = {
    identifier: config.loginIdentifier,
    email: config.loginIdentifier,
    password: config.loginPassword,
    ...(config.tenantId ? { tenantId: config.tenantId } : {}),
  }
  const result = await fetchJson(`${config.apiBase}/auth/login`, {
    method: 'POST',
    headers: authHeaders('', config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, config.timeoutMs)
  const token = extractToken(result.json)
  if (!result.res.ok || !token) {
    throw new Error(`Login failed with HTTP ${result.res.status}`)
  }
  return token
}

async function devToken(config) {
  const params = new URLSearchParams({
    userId: 'legacy-cells-smoke-admin',
    roles: 'admin',
    perms: '*:*',
  })
  if (config.tenantId) params.set('tenantId', config.tenantId)
  const result = await fetchJson(`${config.apiBase}/auth/dev-token?${params}`, {
    headers: authHeaders('', config),
  }, config.timeoutMs)
  const token = extractToken(result.json)
  if (!result.res.ok || !token) {
    throw new Error(`Dev token failed with HTTP ${result.res.status}`)
  }
  return token
}

async function resolveToken(config, record) {
  if (config.token) {
    const ok = await validateToken(config, config.token)
    record('auth.token', ok)
    if (ok) return { token: config.token, source: 'token' }
  }

  if (config.loginIdentifier && config.loginPassword) {
    try {
      const token = await login(config)
      const ok = await validateToken(config, token)
      record('auth.login', ok)
      if (ok) return { token, source: 'login' }
    } catch (error) {
      record('auth.login', false, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (config.allowDevToken) {
    const token = await devToken(config)
    const ok = await validateToken(config, token)
    record('auth.dev-token', ok)
    if (ok) return { token, source: 'dev-token' }
  }

  throw new Error('Unable to resolve a usable auth token')
}

async function createSpreadsheet(config, token) {
  const result = await fetchJson(`${config.apiBase}/spreadsheets`, {
    method: 'POST',
    headers: authHeaders(token, config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: config.spreadsheetName,
      initial_sheets: [{ name: 'ConflictSmoke' }],
    }),
  }, config.timeoutMs)
  if (!result.res.ok || result.json?.ok !== true) {
    throw new Error(`Create spreadsheet failed with HTTP ${result.res.status}`)
  }
  const spreadsheetId = result.json?.data?.spreadsheet?.id
  const sheetId = result.json?.data?.sheets?.[0]?.id
  if (!spreadsheetId || !sheetId) {
    throw new Error('Create spreadsheet response missing spreadsheet/sheet id')
  }
  return { spreadsheetId, sheetId, payload: result.json }
}

async function putCell(config, token, spreadsheetId, sheetId, cell) {
  return fetchJson(cellEndpoint(config.apiBase, spreadsheetId, sheetId), {
    method: 'PUT',
    headers: authHeaders(token, config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ cells: [cell] }),
  }, config.timeoutMs)
}

async function getCells(config, token, spreadsheetId, sheetId) {
  const result = await fetchJson(cellEndpoint(config.apiBase, spreadsheetId, sheetId), {
    headers: authHeaders(token, config),
  }, config.timeoutMs)
  if (!result.res.ok || result.json?.ok !== true) {
    throw new Error(`Get cells failed with HTTP ${result.res.status}`)
  }
  return result.json?.data?.cells || []
}

async function deleteSpreadsheet(config, token, spreadsheetId) {
  return fetchJson(`${config.apiBase}/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
    method: 'DELETE',
    headers: authHeaders(token, config),
  }, config.timeoutMs)
}

function firstUpdatedCell(result) {
  return result.json?.data?.cells?.[0] || null
}

function cellPlainValue(cell) {
  const raw = cell?.value
  if (raw && typeof raw === 'object' && 'value' in raw) return raw.value
  return raw
}

function writeArtifacts(report) {
  fs.mkdirSync(path.dirname(report.reportPath), { recursive: true })
  fs.mkdirSync(path.dirname(report.reportMdPath), { recursive: true })
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(report.reportMdPath, renderLegacyCellsConflictSmokeMarkdown(report))
}

export async function runLegacyCellsConflictSmoke(config = parseConfig()) {
  const startedAt = new Date().toISOString()
  const checks = []
  const record = (name, ok, details = {}) => {
    checks.push({ name, ok: Boolean(ok), ...details })
    return Boolean(ok)
  }
  const report = {
    ok: false,
    apiBase: config.apiBase,
    authSource: 'unknown',
    cleanupAttempted: false,
    cleanupOk: false,
    startedAt,
    finishedAt: '',
    reportPath: config.reportPath,
    reportMdPath: config.reportMdPath,
    checks,
  }

  try {
    const missing = validateConfig(config)
    record('config.valid', missing.length === 0, { missing })
    if (missing.length > 0) {
      throw new Error(`Missing required config: ${missing.join(', ')}`)
    }

    const auth = await resolveToken(config, record)
    report.authSource = auth.source

    const created = await createSpreadsheet(config, auth.token)
    report.spreadsheetId = created.spreadsheetId
    report.sheetId = created.sheetId
    record('spreadsheet.create', true)

    const seed = await putCell(config, auth.token, created.spreadsheetId, created.sheetId, {
      row: 0,
      col: 0,
      value: 'seed',
    })
    const seedCell = firstUpdatedCell(seed)
    const seedVersion = seedCell?.version
    record('cell.seed', seed.res.ok && seed.json?.ok === true && typeof seedVersion === 'number', {
      status: seed.res.status,
      version: seedVersion,
    })
    if (typeof seedVersion !== 'number') throw new Error('Seed cell response missing numeric version')

    const beforeA = (await getCells(config, auth.token, created.spreadsheetId, created.sheetId))[0]
    const beforeB = (await getCells(config, auth.token, created.spreadsheetId, created.sheetId))[0]
    record('cell.session-a-read', beforeA?.version === seedVersion)
    record('cell.session-b-read', beforeB?.version === seedVersion)

    const updateA = await putCell(config, auth.token, created.spreadsheetId, created.sheetId, {
      row: 0,
      col: 0,
      value: 'session-a',
      expectedVersion: seedVersion,
    })
    const updateACell = firstUpdatedCell(updateA)
    const updateAVersion = updateACell?.version
    record('cell.session-a-update', updateA.res.ok && updateA.json?.ok === true && typeof updateAVersion === 'number', {
      status: updateA.res.status,
      version: updateAVersion,
    })
    if (typeof updateAVersion !== 'number') throw new Error('Session A update response missing numeric version')

    const updateB = await putCell(config, auth.token, created.spreadsheetId, created.sheetId, {
      row: 0,
      col: 0,
      value: 'session-b',
      expectedVersion: seedVersion,
    })
    const conflict = updateB.json?.error || null
    report.conflict = conflict
    record('cell.session-b-conflict', updateB.res.status === 409 && conflict?.code === 'VERSION_CONFLICT', {
      status: updateB.res.status,
      serverVersion: conflict?.serverVersion,
      expectedVersion: conflict?.expectedVersion,
    })
    record('cell.conflict-version-payload', conflict?.serverVersion === updateAVersion && conflict?.expectedVersion === seedVersion)

    const finalCells = await getCells(config, auth.token, created.spreadsheetId, created.sheetId)
    const finalCell = finalCells.find((cell) => cell.row_index === 0 && cell.column_index === 0) || null
    report.finalCell = finalCell
    record('cell.final-value-preserved', cellPlainValue(finalCell) === 'session-a')
    record('cell.final-version-current', finalCell?.version === updateAVersion)

    if (config.cleanup && report.spreadsheetId) {
      report.cleanupAttempted = true
      const cleanup = await deleteSpreadsheet(config, auth.token, report.spreadsheetId)
      report.cleanupOk = cleanup.res.ok && cleanup.json?.ok === true
      record('spreadsheet.cleanup', report.cleanupOk, { status: cleanup.res.status })
    }

    report.ok = checks.every((check) => check.ok)
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.ok = false
  } finally {
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
  }

  return report
}

async function main() {
  const config = parseConfig(process.env, parseArgs())
  const report = await runLegacyCellsConflictSmoke(config)
  if (config.args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`[legacy-cells-conflict-smoke] ${report.ok ? 'PASS' : 'FAIL'}`)
    console.log(`[legacy-cells-conflict-smoke] api_base=${report.apiBase}`)
    console.log(`[legacy-cells-conflict-smoke] auth_source=${report.authSource}`)
    console.log(`[legacy-cells-conflict-smoke] report=${report.reportMdPath}`)
  }
  process.exit(report.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
