#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 500

export const ADMIN_ENDPOINTS = Object.freeze([
  { key: 'attendance.settings', path: '/attendance/settings' },
  { key: 'attendance.ruleSets', path: '/attendance/rule-sets?pageSize=5' },
  { key: 'attendance.ruleTemplates', path: '/attendance/rule-templates' },
  { key: 'attendance.groups', path: '/attendance/groups?pageSize=5' },
  { key: 'attendance.importBatches', path: '/attendance/import/batches?pageSize=5' },
  { key: 'attendance.reportFields', path: '/attendance/report-fields' },
  { key: 'attendance.payrollTemplates', path: '/attendance/payroll-templates?pageSize=5' },
  { key: 'attendance.payrollCycles', path: '/attendance/payroll-cycles?pageSize=5' },
  { key: 'attendance.leaveTypes', path: '/attendance/leave-types?pageSize=5' },
  { key: 'attendance.overtimeRules', path: '/attendance/overtime-rules?pageSize=5' },
  { key: 'attendance.approvalFlows', path: '/attendance/approval-flows?pageSize=5' },
  { key: 'attendance.rotationRules', path: '/attendance/rotation-rules?pageSize=5' },
  { key: 'attendance.rotationAssignments', path: '/attendance/rotation-assignments?pageSize=5' },
  { key: 'attendance.shifts', path: '/attendance/shifts?pageSize=5' },
  { key: 'attendance.assignments', path: '/attendance/assignments?pageSize=5' },
  { key: 'attendanceAdmin.roleTemplates', path: '/attendance-admin/role-templates' },
  { key: 'attendanceAdmin.usersSearch', path: '/attendance-admin/users/search?q=&pageSize=5' },
  { key: 'attendanceAdmin.auditLogs', path: '/attendance-admin/audit-logs?page=1&pageSize=5' },
])

const READ_ENDPOINTS = Object.freeze([
  { key: 'attendance.rulesDefault', path: '/attendance/rules/default' },
])

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function parseBoolean(value) {
  if (value === true) return true
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y'
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  return parseBoolean(value)
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function defaultDateRange(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - 30)
  return { from: toDateOnly(from), to: toDateOnly(to) }
}

function buildDefaultOutputFile(now = new Date()) {
  return `output/attendance-admin-smoke/${timestampSlug(now)}.json`
}

export function normalizeApiBase(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const url = new URL(raw)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/api'
  } else if (!url.pathname.endsWith('/api')) {
    url.pathname = `${url.pathname}/api`
  }
  return url.toString().replace(/\/+$/, '')
}

function joinApiPath(apiBase, endpointPath) {
  const normalizedPath = String(endpointPath || '').startsWith('/')
    ? String(endpointPath)
    : `/${endpointPath}`
  return `${apiBase}${normalizedPath}`
}

export function parseConfig(env = process.env, now = new Date()) {
  const range = defaultDateRange(now)
  const from = String(env.FROM_DATE || env.FROM || range.from).trim()
  const to = String(env.TO_DATE || env.TO || range.to).trim()
  return {
    apiBase: normalizeApiBase(env.API_BASE || env.BASE_URL),
    authToken: String(env.AUTH_TOKEN || env.TOKEN || '').trim(),
    authTokenFile: String(env.AUTH_TOKEN_FILE || env.TOKEN_FILE || '').trim(),
    loginEmail: String(env.LOGIN_EMAIL || env.AUTH_EMAIL || '').trim(),
    loginPassword: String(env.LOGIN_PASSWORD || env.AUTH_PASSWORD || '').trim(),
    allowInsecureTokenFile: parseBoolean(env.ALLOW_INSECURE_TOKEN_FILE),
    expectedAdmin: parseOptionalBoolean(env.EXPECTED_ADMIN),
    requireAdmin: parseBoolean(env.REQUIRE_ADMIN),
    outputFile: String(env.OUTPUT_FILE || env.REPORT_JSON || buildDefaultOutputFile(now)).trim(),
    writeOutput: env.WRITE_OUTPUT === undefined ? true : parseBoolean(env.WRITE_OUTPUT),
    timeoutMs: parsePositiveInteger(env.TIMEOUT_MS || env.API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    retryAttempts: parsePositiveInteger(env.API_RETRY_ATTEMPTS, DEFAULT_RETRY_ATTEMPTS),
    retryDelayMs: parsePositiveInteger(env.API_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    from,
    to,
  }
}

export function validateConfig(config) {
  const errors = []
  if (!config.apiBase) errors.push('API_BASE or BASE_URL is required')
  if (!config.authToken && !config.authTokenFile && !(config.loginEmail && config.loginPassword)) {
    errors.push('AUTH_TOKEN, AUTH_TOKEN_FILE, or LOGIN_EMAIL + LOGIN_PASSWORD is required')
  }
  if (config.loginEmail && !config.loginPassword) errors.push('LOGIN_PASSWORD is required when LOGIN_EMAIL is set')
  if (config.loginPassword && !config.loginEmail) errors.push('LOGIN_EMAIL is required when LOGIN_PASSWORD is set')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.from)) errors.push('FROM_DATE must use YYYY-MM-DD')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.to)) errors.push('TO_DATE must use YYYY-MM-DD')
  if (config.from > config.to) errors.push('FROM_DATE must be on or before TO_DATE')
  return errors
}

function assertTokenFileMode(stat, displayPath, allowInsecure) {
  if (allowInsecure) return
  if ((stat.mode & 0o077) !== 0) {
    const modeText = (stat.mode & 0o777).toString(8).padStart(4, '0')
    throw new Error(`AUTH_TOKEN_FILE_INSECURE: ${displayPath}: mode ${modeText}, expected 0600 or stricter`)
  }
}

function readTokenFile(filePath, allowInsecure) {
  const displayPath = filePath
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`AUTH_TOKEN_FILE_NOT_FILE: ${displayPath}`)
  assertTokenFileMode(stat, displayPath, allowInsecure)
  const token = fs.readFileSync(filePath, 'utf8').trim()
  if (!token) throw new Error(`AUTH_TOKEN_FILE_EMPTY: ${displayPath}`)
  return token
}

function envelopeFailed(json) {
  if (!json || typeof json !== 'object') return false
  return json.ok === false || json.success === false
}

function unwrapData(json) {
  if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data')) {
    return json.data
  }
  return json
}

function safePreview(raw) {
  return String(raw || '').replace(/\s+/g, ' ').slice(0, 220)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 504)
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(config, token, endpointPath, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const method = options.method || 'GET'
  const label = options.label || `${method} ${endpointPath}`
  const url = endpointPath.startsWith('http') ? endpointPath : joinApiPath(config.apiBase, endpointPath)
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  }
  const init = {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }
  let lastError = null

  for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, init, config.timeoutMs)
      const raw = await res.text()
      let json = null
      try {
        json = raw ? JSON.parse(raw) : null
      } catch {
        json = null
      }

      if (isRetriableStatus(res.status) && attempt < config.retryAttempts) {
        await sleep(Math.min(config.retryDelayMs * attempt, 5_000))
        continue
      }

      return {
        label,
        path: endpointPath,
        status: res.status,
        ok: res.ok && !envelopeFailed(json),
        json,
        errorCode: json?.error?.code || '',
        message: json?.error?.message || json?.error || '',
        rawPreview: safePreview(raw),
      }
    } catch (error) {
      lastError = error
      if (attempt >= config.retryAttempts) break
      await sleep(Math.min(config.retryDelayMs * attempt, 5_000))
    }
  }

  return {
    label,
    path: endpointPath,
    status: 0,
    ok: false,
    json: null,
    errorCode: 'NETWORK_ERROR',
    message: lastError instanceof Error ? lastError.message : String(lastError),
    rawPreview: '',
  }
}

async function resolveToken(config, fetchImpl) {
  if (config.authToken) return { token: config.authToken, source: 'AUTH_TOKEN' }
  if (config.authTokenFile) {
    return {
      token: readTokenFile(config.authTokenFile, config.allowInsecureTokenFile),
      source: 'AUTH_TOKEN_FILE',
    }
  }

  const login = await requestJson(config, '', '/auth/login', {
    fetchImpl,
    method: 'POST',
    label: 'POST /auth/login',
    body: {
      email: config.loginEmail,
      identifier: config.loginEmail,
      password: config.loginPassword,
    },
  })
  const data = unwrapData(login.json)
  const token = String(data?.token || login.json?.token || '').trim()
  if (!login.ok || !token) {
    throw new Error(`LOGIN_FAILED: HTTP ${login.status} ${login.rawPreview || login.message}`)
  }
  return { token, source: 'LOGIN_EMAIL_PASSWORD' }
}

function collectPermissions(user, data) {
  const candidates = [
    user?.permissions,
    data?.permissions,
    user?.effectivePermissions,
    data?.effectivePermissions,
  ]
  return candidates
    .flatMap(value => Array.isArray(value) ? value : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
}

function isAttendanceAdmin({ features, permissions }) {
  return features?.attendanceAdmin === true || permissions.includes('attendance:admin')
}

function redactUser(user) {
  return {
    id: user?.id || user?.userId || user?.user_id || '',
    email: user?.email || '',
    role: user?.role || '',
  }
}

function endpointExpectation(endpoint, expectedAdmin) {
  if (endpoint.kind === 'read') return 'allow'
  return expectedAdmin ? 'allow' : 'forbid'
}

function evaluateEndpoint(endpoint, result, expectedAdmin) {
  const expectation = endpointExpectation(endpoint, expectedAdmin)
  if (expectation === 'allow') {
    const passed = result.status >= 200 && result.status < 300 && !envelopeFailed(result.json)
    return {
      ...result,
      expectation,
      passed,
      reason: passed ? 'allowed' : `expected 2xx, got ${result.status || 'network error'}`,
    }
  }

  const passed = result.status === 403
  return {
    ...result,
    expectation,
    passed,
    reason: passed ? 'forbidden as expected' : `expected 403, got ${result.status || 'network error'}`,
  }
}

function buildEndpoints(config) {
  const workbenchPath = `/attendance/advanced-scheduling/workbench?from=${encodeURIComponent(config.from)}&to=${encodeURIComponent(config.to)}`
  return [
    ...READ_ENDPOINTS.map(endpoint => ({ ...endpoint, kind: 'read' })),
    ...ADMIN_ENDPOINTS.map(endpoint => ({ ...endpoint, kind: 'admin' })),
    { key: 'attendance.advancedSchedulingWorkbench', path: workbenchPath, kind: 'admin' },
  ]
}

function summarizeEndpoint(endpoint) {
  return {
    key: endpoint.key,
    path: endpoint.path,
    status: endpoint.status,
    expectation: endpoint.expectation,
    passed: endpoint.passed,
    reason: endpoint.reason,
    errorCode: endpoint.errorCode || '',
    message: endpoint.message || '',
  }
}

function ensureOutputDir(outputFile) {
  const dir = path.dirname(outputFile)
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
}

export async function runAttendanceAdminSmoke(config, options = {}) {
  const errors = validateConfig(config)
  if (errors.length > 0) {
    throw new Error(`CONFIG_INVALID: ${errors.join('; ')}`)
  }

  const fetchImpl = options.fetchImpl || fetch
  const logger = options.logger || console
  const now = options.now || new Date()
  const auth = await resolveToken(config, fetchImpl)
  logger.log(`[attendance-admin-smoke] auth source: ${auth.source}`)

  const me = await requestJson(config, auth.token, '/auth/me', {
    fetchImpl,
    label: 'GET /auth/me',
  })
  if (!me.ok) {
    throw new Error(`AUTH_ME_FAILED: HTTP ${me.status} ${me.rawPreview || me.message}`)
  }

  const data = unwrapData(me.json)
  const user = data?.user || {}
  const features = data?.features || {}
  const permissions = collectPermissions(user, data)
  const actualAdmin = isAttendanceAdmin({ features, permissions })
  const expectedAdmin = config.expectedAdmin === null ? actualAdmin : config.expectedAdmin

  logger.log(
    `[attendance-admin-smoke] /auth/me ok: email=${user?.email || '(unknown)'} role=${user?.role || '(unknown)'} attendanceAdmin=${actualAdmin}`,
  )

  if (config.requireAdmin && !actualAdmin) {
    throw new Error('AUTH_NOT_ATTENDANCE_ADMIN: /auth/me did not expose features.attendanceAdmin=true or attendance:admin')
  }

  const endpoints = buildEndpoints(config)
  const results = []
  for (const endpoint of endpoints) {
    const result = await requestJson(config, auth.token, endpoint.path, {
      fetchImpl,
      label: `GET ${endpoint.path}`,
    })
    const evaluated = evaluateEndpoint(endpoint, result, expectedAdmin)
    results.push(evaluated)
    const marker = evaluated.passed ? 'PASS' : 'FAIL'
    logger.log(`[attendance-admin-smoke] ${marker} ${endpoint.key}: HTTP ${evaluated.status} (${evaluated.reason})`)
  }

  const failed = results.filter(result => !result.passed)
  const report = {
    generatedAt: now.toISOString(),
    apiBase: config.apiBase,
    auth: {
      tokenSource: auth.source,
      user: redactUser(user),
      features: {
        attendance: features?.attendance === true,
        attendanceAdmin: features?.attendanceAdmin === true,
        attendanceImport: features?.attendanceImport === true,
        mode: features?.mode || '',
      },
      permissionSignals: {
        attendanceAdminFeature: features?.attendanceAdmin === true,
        attendanceAdminPermission: permissions.includes('attendance:admin'),
      },
    },
    expectation: {
      expectedAdmin,
      requireAdmin: config.requireAdmin,
      from: config.from,
      to: config.to,
    },
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      adminEndpoints: results.filter(result => result.expectation === 'allow' && result.key !== 'attendance.rulesDefault').length,
      forbiddenAsExpected: results.filter(result => result.expectation === 'forbid' && result.passed).length,
    },
    endpoints: results.map(summarizeEndpoint),
  }

  if (config.writeOutput && config.outputFile) {
    ensureOutputDir(config.outputFile)
    fs.writeFileSync(config.outputFile, `${JSON.stringify(report, null, 2)}\n`)
    logger.log(`[attendance-admin-smoke] wrote ${config.outputFile}`)
  }

  if (failed.length > 0) {
    const error = new Error(`ATTENDANCE_ADMIN_SMOKE_FAILED: ${failed.length}/${results.length} endpoints failed`)
    error.report = report
    throw error
  }

  return report
}

export function renderHelp() {
  return [
    'Usage:',
    '  API_BASE=http://<host>:<port>/api AUTH_TOKEN_FILE=/secure/admin.jwt REQUIRE_ADMIN=true node scripts/verify-attendance-admin-smoke.mjs',
    '',
    'Auth inputs:',
    '  AUTH_TOKEN or AUTH_TOKEN_FILE',
    '  LOGIN_EMAIL + LOGIN_PASSWORD',
    '',
    'Expectation controls:',
    '  EXPECTED_ADMIN=true|false  Override /auth/me-derived expectation',
    '  REQUIRE_ADMIN=true         Fail immediately if token is not attendance admin',
    '',
    'Optional:',
    '  FROM_DATE=YYYY-MM-DD TO_DATE=YYYY-MM-DD OUTPUT_FILE=path WRITE_OUTPUT=0',
  ].join('\n')
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(renderHelp())
    return
  }

  let config = null
  try {
    config = parseConfig()
    await runAttendanceAdminSmoke(config)
  } catch (error) {
    console.error(`[attendance-admin-smoke] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const currentFile = pathToFileURL(fileURLToPath(import.meta.url)).href
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (currentFile === invokedFile) {
  await main()
}
