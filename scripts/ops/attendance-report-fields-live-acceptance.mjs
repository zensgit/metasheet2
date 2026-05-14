#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMultitableAuthToken } from '../multitable-auth.mjs'

const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const DEFAULT_TIMEOUT_MS = 15_000
const REQUIRED_CATEGORY_IDS = ['fixed', 'basic', 'attendance', 'anomaly', 'leave', 'overtime']

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function parseBoolean(value) {
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

export function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '')
  return normalized || DEFAULT_API_BASE
}

export function normalizeHostHeader(value) {
  return String(value || '').trim()
}

function isValidHostHeader(value) {
  if (!value) return true
  return /^[A-Za-z0-9.-]+(?::\d+)?$/.test(value)
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

function buildDefaultOutputDir(now = new Date()) {
  return `output/attendance-report-fields-live-acceptance/${timestampSlug(now)}`
}

export function parseConfig(env = process.env, now = new Date()) {
  const range = defaultDateRange(now)
  const outputDir = String(env.OUTPUT_DIR || buildDefaultOutputDir(now))
  const timeoutMs = Number(env.TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  return {
    apiBase: normalizeBaseUrl(env.API_BASE || env.BASE_URL),
    hostHeader: normalizeHostHeader(env.API_HOST_HEADER || env.HOST_HEADER),
    authToken: String(env.AUTH_TOKEN || env.TOKEN || '').trim(),
    authTokenFile: String(env.AUTH_TOKEN_FILE || env.TOKEN_FILE || '').trim(),
    allowDevToken: parseBoolean(env.ALLOW_DEV_TOKEN),
    confirmSync: parseBoolean(env.CONFIRM_SYNC),
    preflightOnly: parseBoolean(env.PREFLIGHT_ONLY),
    orgId: String(env.ORG_ID || 'default').trim(),
    userId: String(env.USER_ID || '').trim(),
    from: String(env.FROM_DATE || env.FROM || range.from).trim(),
    to: String(env.TO_DATE || env.TO || range.to).trim(),
    expectVisibleCode: String(env.EXPECT_VISIBLE_CODE || 'work_date').trim(),
    expectHiddenCode: String(env.EXPECT_HIDDEN_CODE || '').trim(),
    devUserId: String(env.DEV_USER_ID || 'dev-admin').trim(),
    outputDir,
    reportPath: String(env.REPORT_JSON || path.join(outputDir, 'report.json')),
    reportMdPath: String(env.REPORT_MD || path.join(outputDir, 'report.md')),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

export function validateConfig(config) {
  const missing = []
  if (!config.preflightOnly && !config.authToken && !config.authTokenFile && !config.allowDevToken) {
    missing.push('AUTH_TOKEN/AUTH_TOKEN_FILE or ALLOW_DEV_TOKEN=1')
  }
  if (!config.preflightOnly && !config.confirmSync) missing.push('CONFIRM_SYNC=1')
  if (!config.orgId) missing.push('ORG_ID')
  if (!isValidHostHeader(config.hostHeader)) missing.push('API_HOST_HEADER host[:port]')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.from)) missing.push('FROM_DATE yyyy-mm-dd')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.to)) missing.push('TO_DATE yyyy-mm-dd')
  return missing
}

function buildQuery(config, extra = {}) {
  const query = new URLSearchParams()
  query.set('orgId', config.orgId)
  if (config.userId) query.set('userId', config.userId)
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      query.set(key, String(value))
    }
  }
  return query.toString()
}

function createReport(config) {
  return {
    ok: true,
    runMode: config.preflightOnly ? 'preflight' : 'live',
    apiBase: config.apiBase,
    hostHeader: config.hostHeader || 'default',
    orgId: config.orgId,
    userId: config.userId || 'token-user',
    from: config.from,
    to: config.to,
    expectedVisibleCode: config.expectVisibleCode || 'not-set',
    expectedHiddenCode: config.expectHiddenCode || 'not-set',
    reportPath: path.resolve(config.reportPath),
    reportMdPath: path.resolve(config.reportMdPath),
    startedAt: new Date().toISOString(),
    checks: [],
    metadata: {},
    nextActions: [],
  }
}

function createRecorder(report) {
  return (name, ok, details = {}) => {
    const check = { name, ok: Boolean(ok), details }
    report.checks.push(check)
    if (!check.ok) report.ok = false
  }
}

function redactHomePath(value) {
  const text = String(value || '')
  const homeDir = String(process.env.HOME || process.env.USERPROFILE || '').trim()
  if (!homeDir) return text
  const normalizedHome = path.resolve(homeDir)
  const normalizedText = path.resolve(text)
  if (normalizedText === normalizedHome) return '~'
  if (normalizedText.startsWith(`${normalizedHome}${path.sep}`)) {
    return `~${path.sep}${path.relative(normalizedHome, normalizedText)}`
  }
  return text
}

function redactTokenFileReason(value, tokenFile) {
  return String(value || '').split(tokenFile).join(redactHomePath(tokenFile))
}

function resolveConfiguredAuthToken(config, record) {
  if (config.authToken) {
    return { token: config.authToken, source: 'AUTH_TOKEN' }
  }

  if (!config.authTokenFile) {
    return { token: '', source: config.allowDevToken ? 'ALLOW_DEV_TOKEN' : 'none' }
  }

  const tokenFile = path.resolve(config.authTokenFile)
  const tokenFileDisplay = redactHomePath(tokenFile)
  let stat = null
  try {
    stat = fs.statSync(tokenFile)
  } catch (error) {
    const reason = redactTokenFileReason(stringifyError(error), tokenFile)
    record('config.auth-token-file', false, { tokenFile: tokenFileDisplay, reason })
    throw new Error(`AUTH_TOKEN_FILE_READ_FAILED: ${tokenFileDisplay}: ${reason}`)
  }

  if (!stat.isFile()) {
    record('config.auth-token-file', false, { tokenFile: tokenFileDisplay, status: 'not-file' })
    throw new Error(`AUTH_TOKEN_FILE_NOT_FILE: ${tokenFileDisplay}`)
  }

  const mode = stat.mode & 0o777
  const modeText = `0${mode.toString(8).padStart(3, '0')}`
  const secureMode = (mode & 0o077) === 0
  record('config.auth-token-file-permissions', secureMode, {
    tokenFile: tokenFileDisplay,
    mode: modeText,
  })
  if (!secureMode) {
    throw new Error(`AUTH_TOKEN_FILE_INSECURE: ${tokenFileDisplay}: mode ${modeText}, expected 0600 or stricter`)
  }

  let token = ''
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch (error) {
    const reason = redactTokenFileReason(stringifyError(error), tokenFile)
    record('config.auth-token-file', false, { tokenFile: tokenFileDisplay, reason })
    throw new Error(`AUTH_TOKEN_FILE_READ_FAILED: ${tokenFileDisplay}: ${reason}`)
  }

  record('config.auth-token-file', Boolean(token), {
    tokenFile: tokenFileDisplay,
    status: token ? 'loaded' : 'empty',
  })
  if (!token) {
    throw new Error(`AUTH_TOKEN_FILE_EMPTY: ${tokenFileDisplay}`)
  }
  return { token, source: 'AUTH_TOKEN_FILE' }
}

function responseHeaderAccessor(headers) {
  return {
    get(name) {
      const value = headers[String(name || '').toLowerCase()]
      if (Array.isArray(value)) return value.join(', ')
      return value || ''
    },
  }
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, hostHeader = '') {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${target.protocol}`)
  }

  const body = options.body === undefined || options.body === null
    ? null
    : typeof options.body === 'string' || Buffer.isBuffer(options.body)
      ? options.body
      : String(options.body)
  const headers = { ...(options.headers || {}) }
  if (hostHeader) headers.Host = hostHeader
  if (body !== null && !Object.keys(headers).some(key => key.toLowerCase() === 'content-length')) {
    headers['Content-Length'] = Buffer.byteLength(body)
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = []
      res.setEncoding('utf8')
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = chunks.join('')
        let json = null
        if (text) {
          try {
            json = JSON.parse(text)
          } catch {
            json = { raw: text }
          }
        }
        resolve({
          res: {
            ok: Number(res.statusCode) >= 200 && Number(res.statusCode) < 300,
            status: res.statusCode ?? 0,
            statusText: res.statusMessage || '',
            headers: responseHeaderAccessor(res.headers),
          },
          json,
          text,
        })
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

async function requestJson(config, token, route, options = {}) {
  const url = `${config.apiBase}${route}`
  return fetchJson(url, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  }, config.timeoutMs, config.hostHeader)
}

async function checkedRequest(config, token, route, checkName, label, record, options = {}) {
  try {
    const result = await requestJson(config, token, route, options)
    record(checkName, result.res.ok, { status: result.res.status })
    return ensureOk(label, result)
  } catch (error) {
    record(checkName, false, { reason: stringifyError(error) })
    throw error
  }
}

function errorMessage(result, fallback) {
  const body = result?.json
  return body?.error?.message || body?.message || body?.raw || result?.res?.statusText || fallback
}

function ensureOk(name, result) {
  if (!result?.res?.ok || result?.json?.ok === false || result?.json?.success === false) {
    const status = result?.res?.status ?? 0
    throw new Error(`${name} failed (${status}): ${errorMessage(result, 'request failed')}`)
  }
  return result.json
}

function payloadData(json) {
  return json?.data && typeof json.data === 'object' ? json.data : {}
}

function extractCategoryIds(categories) {
  return Array.isArray(categories)
    ? categories.map((category) => String(category?.id || category?.key || '')).filter(Boolean)
    : []
}

function extractFieldCodes(fields) {
  return Array.isArray(fields)
    ? fields.map((field) => String(field?.code || field?.fieldCode || '')).filter(Boolean)
    : []
}

function hasAllRequiredCategories(categories) {
  const ids = new Set(extractCategoryIds(categories))
  return REQUIRED_CATEGORY_IDS.every((id) => ids.has(id))
}

function missingRequiredCategories(categories) {
  const ids = new Set(extractCategoryIds(categories))
  return REQUIRED_CATEGORY_IDS.filter((id) => !ids.has(id))
}

function visibilityDetails(fields, config) {
  const codes = extractFieldCodes(fields)
  const visibleOk = !config.expectVisibleCode || codes.includes(config.expectVisibleCode)
  const hiddenOk = !config.expectHiddenCode || !codes.includes(config.expectHiddenCode)
  return {
    codes,
    visibleOk,
    hiddenOk,
    expectedVisibleCode: config.expectVisibleCode || 'not-set',
    expectedHiddenCode: config.expectHiddenCode || 'not-set',
  }
}

function exportedKeys(items) {
  if (!Array.isArray(items) || !items[0] || typeof items[0] !== 'object') return []
  return Object.keys(items[0])
}

function fieldNameForCode(fields, code) {
  const found = Array.isArray(fields)
    ? fields.find(field => String(field?.code || '') === code)
    : null
  return found?.name || code
}

function multitableConfig(data) {
  const value = data?.reportFieldConfig?.multitable
  return value && typeof value === 'object' ? value : null
}

function multitableConfigFingerprint(value) {
  if (!value) return 'missing'
  return [
    value.available === true ? 'available' : 'unavailable',
    value.projectId || '',
    value.objectId || '',
    value.baseId || '',
    value.sheetId || '',
    value.viewId || '',
  ].join('|')
}

function multitableBackingFingerprint(value) {
  if (!value) return 'missing'
  return [
    value.projectId || '',
    value.objectId || '',
    value.sheetId || '',
    value.viewId || '',
  ].join('|')
}

function reportFieldConfigFingerprint(data) {
  const value = data?.reportFieldConfig?.fieldsFingerprint
  return value && typeof value === 'object' && value.value
    ? String(value.value)
    : 'missing'
}

function responseHeader(result, name) {
  return result?.res?.headers?.get(name) || ''
}

function csvReportFieldFingerprint(result) {
  return responseHeader(result, 'x-attendance-report-fields-fingerprint') || 'missing'
}

function csvReportFieldFingerprintAlgorithm(result) {
  return responseHeader(result, 'x-attendance-report-fields-fingerprint-algorithm') || 'missing'
}

function csvReportFieldCount(result) {
  const parsed = Number(responseHeader(result, 'x-attendance-report-fields-count'))
  return Number.isFinite(parsed) ? parsed : null
}

function csvReportFieldCodes(result) {
  return responseHeader(result, 'x-attendance-report-fields-codes')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean)
}

function csvReportFieldBacking(result) {
  const backing = {
    projectId: responseHeader(result, 'x-attendance-report-fields-project-id'),
    objectId: responseHeader(result, 'x-attendance-report-fields-object-id'),
    sheetId: responseHeader(result, 'x-attendance-report-fields-sheet-id'),
    viewId: responseHeader(result, 'x-attendance-report-fields-view-id'),
  }
  return Object.values(backing).some(Boolean) ? backing : null
}

function classifyBlocker(error, config) {
  const message = stringifyError(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('econnrefused')
    || lower.includes('enotfound')
    || lower.includes('eai_again')
    || lower.includes('fetch failed')
    || lower.includes('socket hang up')
    || lower.includes('other side closed')
    || lower.includes('timed out')
  ) {
    return {
      code: 'BACKEND_UNREACHABLE',
      message,
      nextActions: [
        `确认 API_BASE 是否正确：${config.apiBase}`,
        config.hostHeader ? `确认 API_HOST_HEADER 是否正确：${config.hostHeader}` : '如果反代按 Host 分流，设置 API_HOST_HEADER=<host>',
        '启动后端服务：pnpm --filter @metasheet/core-backend dev',
        '如果依赖本地 Postgres/Redis，先启动 Docker daemon 后执行 pnpm docker:dev',
      ],
    }
  }
  if (lower.includes('missing required configuration')) {
    return {
      code: 'CONFIG_MISSING',
      message,
      nextActions: [
        '完整验收需要 AUTH_TOKEN=<token>、AUTH_TOKEN_FILE=<path> 或 ALLOW_DEV_TOKEN=1',
        '写入字段目录前需要显式设置 CONFIRM_SYNC=1',
        '仅检查环境可达性可设置 PREFLIGHT_ONLY=1',
      ],
    }
  }
  if (message.includes('(401)') || lower.includes('unauthorized')) {
    return {
      code: 'AUTH_UNAUTHORIZED',
      message,
      nextActions: ['刷新 AUTH_TOKEN/AUTH_TOKEN_FILE，或在本地开发环境使用 ALLOW_DEV_TOKEN=1'],
    }
  }
  if (
    message.includes('AUTH_TOKEN_FILE_READ_FAILED')
    || message.includes('AUTH_TOKEN_FILE_EMPTY')
    || message.includes('AUTH_TOKEN_FILE_INSECURE')
    || message.includes('AUTH_TOKEN_FILE_NOT_FILE')
  ) {
    return {
      code: 'AUTH_TOKEN_FILE_INVALID',
      message,
      nextActions: ['确认 AUTH_TOKEN_FILE 指向可读且非空的本地 token 文件，并执行 chmod 600 <token-file>'],
    }
  }
  if (message.includes('(403)') || lower.includes('forbidden')) {
    return {
      code: 'AUTH_FORBIDDEN',
      message,
      nextActions: ['确认 token 用户具备 attendance:admin、attendance:read 和 multitable 读写权限'],
    }
  }
  if (lower.includes('db_not_ready') || lower.includes('attendance tables missing')) {
    return {
      code: 'DB_NOT_READY',
      message,
      nextActions: ['执行后端迁移：pnpm --filter @metasheet/core-backend migrate'],
    }
  }
  if (lower.includes('multitable_unavailable') || lower.includes('provisioning_failed')) {
    return {
      code: 'MULTITABLE_UNAVAILABLE',
      message,
      nextActions: ['确认多维表插件 API 已加载，并检查 plugin_multitable_object_registry 相关迁移是否完成'],
    }
  }
  return {
    code: 'RUNNER_FAILED',
    message,
    nextActions: ['查看 report.json 中的失败 check 和后端日志，按第一个失败 API 继续定位'],
  }
}

export function renderHelp() {
  return [
    'Usage:',
    '  pnpm run verify:attendance-report-fields:live',
    '',
    'Required for live mode:',
    '  AUTH_TOKEN=<token>, AUTH_TOKEN_FILE=<path>, or ALLOW_DEV_TOKEN=1',
    '  CONFIRM_SYNC=1',
    '',
    'Common options:',
    '  API_BASE=http://127.0.0.1:8900',
    '  API_HOST_HEADER=localhost',
    '  ORG_ID=default',
    '  USER_ID=<optional-user-id>',
    '  FROM_DATE=2026-05-01',
    '  TO_DATE=2026-05-13',
    '  EXPECT_VISIBLE_CODE=work_date',
    '  EXPECT_HIDDEN_CODE=<field_code>',
    '  OUTPUT_DIR=output/attendance-report-fields-live-acceptance/<run>',
    '',
    'Preflight only:',
    '  PREFLIGHT_ONLY=1 pnpm run verify:attendance-report-fields:live',
    '',
  ].join('\n')
}

const MARKDOWN_CHECK_DETAIL_KEYS = Object.freeze([
  'status',
  'missing',
  'reason',
  'fingerprint',
  'algorithm',
  'catalog',
  'records',
  'export',
  'csv',
  'csvCode',
  'csvBacking',
  'csvCodeBacking',
  'exportBacking',
  'fieldCount',
])

function formatMarkdownInlineValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).join(',')
  return String(value)
    .replace(/`/g, "'")
    .slice(0, 240)
}

function renderMarkdownCheckDetailLines(details) {
  if (!details || typeof details !== 'object') return []
  const lines = []
  for (const key of MARKDOWN_CHECK_DETAIL_KEYS) {
    const value = details[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    lines.push(`  - ${key}: \`${formatMarkdownInlineValue(value)}\``)
  }
  return lines
}

const EVIDENCE_SUMMARY_METADATA_KEYS = Object.freeze([
  ['Catalog fingerprint', 'catalogFieldFingerprint'],
  ['Records fingerprint', 'recordsFieldFingerprint'],
  ['Export fingerprint', 'exportFieldFingerprint'],
  ['CSV fingerprint', 'csvFieldFingerprint'],
  ['CSV code fingerprint', 'csvCodeFieldFingerprint'],
  ['Catalog field count', 'catalogFieldCount'],
  ['Records field count', 'recordsFieldCount'],
  ['Export field count', 'exportFieldCount'],
  ['CSV field count', 'csvFieldCount'],
  ['CSV field codes', 'csvFieldCodes'],
  ['CSV code field codes', 'csvCodeFieldCodes'],
  ['CSV backing', 'csvBacking'],
  ['CSV code backing', 'csvCodeBacking'],
])

function hasMarkdownSummaryValue(value) {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  return String(value) !== ''
}

function renderEvidenceSummaryLines(report) {
  const metadata = report?.metadata && typeof report.metadata === 'object' && !Array.isArray(report.metadata)
    ? report.metadata
    : {}
  const lines = []
  for (const [label, key] of EVIDENCE_SUMMARY_METADATA_KEYS) {
    const value = metadata[key]
    if (!hasMarkdownSummaryValue(value)) continue
    lines.push(`- ${label}: \`${formatMarkdownInlineValue(value)}\``)
  }
  return lines.length ? ['', '## Evidence Summary', '', ...lines] : []
}

export function renderAcceptanceMarkdown(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failing = checks.filter((check) => check && check.ok === false)
  const lines = [
    '# Attendance Report Fields Live Acceptance',
    '',
    `- Overall: **${report?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- Run mode: \`${report?.runMode || 'live'}\``,
    `- API base: \`${report?.apiBase || 'missing'}\``,
    `- Host header: \`${report?.hostHeader || 'default'}\``,
    `- Org ID: \`${report?.orgId || 'missing'}\``,
    `- User scope: \`${report?.userId || 'token-user'}\``,
    `- Date range: \`${report?.from || 'missing'}..${report?.to || 'missing'}\``,
    `- Expected visible field: \`${report?.expectedVisibleCode || 'not-set'}\``,
    `- Expected hidden field: \`${report?.expectedHiddenCode || 'not-set'}\``,
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
    lines.push('', '## Error', '', `\`${report.error}\``)
  }

  if (report?.blocker) {
    lines.push('', '## Blocker', '')
    lines.push(`- Code: \`${report.blocker.code || 'UNKNOWN'}\``)
    lines.push(`- Message: \`${report.blocker.message || report.error || 'unknown'}\``)
  }

  lines.push(...renderEvidenceSummaryLines(report))

  if (report?.metadata && Object.keys(report.metadata).length > 0) {
    lines.push('', '## Metadata', '')
    for (const [key, value] of Object.entries(report.metadata)) {
      lines.push(`- ${key}: \`${String(value)}\``)
    }
  }

  lines.push('', '## Check Results', '')
  for (const check of checks) {
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
    lines.push(...renderMarkdownCheckDetailLines(check.details))
  }

  if (Array.isArray(report?.nextActions) && report.nextActions.length > 0) {
    lines.push('', '## Next Actions', '')
    for (const action of report.nextActions) {
      lines.push(`- ${action}`)
    }
  }

  lines.push(
    '',
    '## Manual Visibility Toggle',
    '',
    '- Hide a field in the multitable catalog, then rerun with `EXPECT_HIDDEN_CODE=<field_code>`.',
    '- Re-enable the same field, then rerun with `EXPECT_VISIBLE_CODE=<field_code>`.',
  )

  return `${lines.join('\n')}\n`
}

function writeArtifacts(report) {
  fs.mkdirSync(path.dirname(report.reportPath), { recursive: true })
  fs.mkdirSync(path.dirname(report.reportMdPath), { recursive: true })
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(report.reportMdPath, renderAcceptanceMarkdown(report))
}

function stringifyError(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : ''
    return cause ? `${error.message}: ${cause}` : error.message
  }
  return String(error)
}

export async function runAttendanceReportFieldsAcceptance(config) {
  const report = createReport(config)
  const record = createRecorder(report)
  const missingConfig = validateConfig(config)
  if (missingConfig.length) {
    record('config.required', false, { missing: missingConfig })
    report.error = `Missing required configuration: ${missingConfig.join(', ')}`
    report.blocker = classifyBlocker(new Error(report.error), config)
    report.nextActions = report.blocker.nextActions
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
    return report
  }

  record('config.required', true, { apiBase: config.apiBase, orgId: config.orgId })

  try {
    const healthData = await checkedRequest(config, '', '/api/health', 'api.health', 'GET /api/health', record)
    report.metadata.healthStatus = healthData?.status || healthData?.data?.status || 'ok'

    if (config.preflightOnly) {
      record('preflight.completed', true)
      record('runner.completed', true)
      return report
    }

    const configuredAuth = resolveConfiguredAuthToken(config, record)
    report.metadata.authSource = configuredAuth.source
    const token = await resolveMultitableAuthToken({
      apiBase: config.apiBase,
      envToken: configuredAuth.token,
      tokenSource: configuredAuth.source === 'AUTH_TOKEN_FILE' ? 'AUTH_TOKEN_FILE' : 'AUTH_TOKEN',
      fetchJson: (url) => fetchJson(url, {}, config.timeoutMs, config.hostHeader),
      record,
      perms: 'attendance:admin,attendance:read,multitable:read,multitable:write',
      userId: config.devUserId,
      roles: 'admin',
    })

    await checkedRequest(config, token, '/api/auth/me', 'api.auth.me', 'GET /api/auth/me', record)

    await checkedRequest(
      config,
      token,
      `/api/attendance/report-fields?${buildQuery(config)}`,
      'api.report-fields.read-before-sync',
      'GET /api/attendance/report-fields',
      record,
    )

    const syncData = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/report-fields/sync?${buildQuery(config)}`,
      'api.report-fields.sync',
      'POST /api/attendance/report-fields/sync',
      record,
      { method: 'POST' },
    ))
    record('catalog.multitable.available', syncData.multitable?.available === true, {
      projectId: syncData.multitable?.projectId || 'missing',
      sheetId: syncData.multitable?.sheetId || 'missing',
      recordCount: syncData.multitable?.recordCount ?? 0,
    })
    report.metadata.projectId = syncData.multitable?.projectId || ''
    report.metadata.sheetId = syncData.multitable?.sheetId || ''
    report.metadata.viewId = syncData.multitable?.viewId || ''

    const catalogData = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/report-fields?${buildQuery(config)}`,
      'api.report-fields.read-after-sync',
      'GET /api/attendance/report-fields after sync',
      record,
    ))
    record('catalog.required-categories', hasAllRequiredCategories(catalogData.categories), {
      categories: extractCategoryIds(catalogData.categories),
      missing: missingRequiredCategories(catalogData.categories),
    })
    const catalogVisibility = visibilityDetails(catalogData.items, config)
    record('catalog.expected-visible-field', catalogVisibility.visibleOk, {
      code: catalogVisibility.expectedVisibleCode,
      fieldCount: catalogVisibility.codes.length,
    })
    record('catalog.expected-hidden-field', catalogVisibility.hiddenOk, {
      code: catalogVisibility.expectedHiddenCode,
      skipped: !config.expectHiddenCode,
    })

    const recordsQuery = buildQuery(config, {
      from: config.from,
      to: config.to,
      pageSize: 5,
    })
    const recordsData = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/records?${recordsQuery}`,
      'api.records.read',
      'GET /api/attendance/records',
      record,
    ))
    const recordVisibility = visibilityDetails(recordsData.reportFields, config)
    record('records.report-fields.expected-visible', recordVisibility.visibleOk, {
      code: recordVisibility.expectedVisibleCode,
      fieldCount: recordVisibility.codes.length,
    })
    record('records.report-fields.expected-hidden', recordVisibility.hiddenOk, {
      code: recordVisibility.expectedHiddenCode,
      skipped: !config.expectHiddenCode,
    })

    const exportQuery = buildQuery(config, {
      from: config.from,
      to: config.to,
      limit: 5,
      format: 'json',
    })
    const exportData = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/export?${exportQuery}`,
      'api.export.json',
      'GET /api/attendance/export?format=json',
      record,
    ))
    const exportVisibility = visibilityDetails(exportData.reportFields, config)
    record('export.report-fields.expected-visible', exportVisibility.visibleOk, {
      code: exportVisibility.expectedVisibleCode,
      fieldCount: exportVisibility.codes.length,
    })
    record('export.report-fields.expected-hidden', exportVisibility.hiddenOk, {
      code: exportVisibility.expectedHiddenCode,
      skipped: !config.expectHiddenCode,
    })

    const recordCodes = extractFieldCodes(recordsData.reportFields)
    const exportCodes = extractFieldCodes(exportData.reportFields)
    record('records-export.report-field-codes-match', recordCodes.join('|') === exportCodes.join('|'), {
      records: recordCodes.join(','),
      export: exportCodes.join(','),
    })

    const recordsMultitable = multitableConfig(recordsData)
    const exportMultitable = multitableConfig(exportData)
    record('records.report-field-config.multitable-present', Boolean(recordsMultitable), {
      projectId: recordsMultitable?.projectId || 'missing',
      sheetId: recordsMultitable?.sheetId || 'missing',
    })
    record('export.report-field-config.multitable-present', Boolean(exportMultitable), {
      projectId: exportMultitable?.projectId || 'missing',
      sheetId: exportMultitable?.sheetId || 'missing',
    })
    record(
      'records-export.report-field-config-match',
      multitableConfigFingerprint(recordsMultitable) === multitableConfigFingerprint(exportMultitable),
      {
        records: multitableConfigFingerprint(recordsMultitable),
        export: multitableConfigFingerprint(exportMultitable),
      },
    )
    const catalogFieldFingerprint = reportFieldConfigFingerprint(catalogData)
    const recordsFieldFingerprint = reportFieldConfigFingerprint(recordsData)
    const exportFieldFingerprint = reportFieldConfigFingerprint(exportData)
    record('catalog.report-field-config.fingerprint-present', catalogFieldFingerprint !== 'missing', {
      fingerprint: catalogFieldFingerprint,
    })
    record('records.report-field-config.fingerprint-present', recordsFieldFingerprint !== 'missing', {
      fingerprint: recordsFieldFingerprint,
    })
    record('export.report-field-config.fingerprint-present', exportFieldFingerprint !== 'missing', {
      fingerprint: exportFieldFingerprint,
    })
    record('catalog-records.report-field-fingerprint-match', catalogFieldFingerprint === recordsFieldFingerprint, {
      catalog: catalogFieldFingerprint,
      records: recordsFieldFingerprint,
    })
    record('records-export.report-field-fingerprint-match', recordsFieldFingerprint === exportFieldFingerprint, {
      records: recordsFieldFingerprint,
      export: exportFieldFingerprint,
    })

    report.metadata.catalogFieldCount = Array.isArray(catalogData.items) ? catalogData.items.length : 0
    report.metadata.recordsFieldCount = recordCodes.length
    report.metadata.exportFieldCount = exportCodes.length
    report.metadata.recordsConfigProjectId = recordsMultitable?.projectId || ''
    report.metadata.exportConfigProjectId = exportMultitable?.projectId || ''
    report.metadata.catalogFieldFingerprint = catalogFieldFingerprint
    report.metadata.recordsFieldFingerprint = recordsFieldFingerprint
    report.metadata.exportFieldFingerprint = exportFieldFingerprint
    report.metadata.recordsTotal = recordsData.total ?? 0
    report.metadata.exportTotal = exportData.total ?? 0
    report.metadata.exportSampleKeys = exportedKeys(exportData.items).join(',')

    const csvQuery = buildQuery(config, {
      from: config.from,
      to: config.to,
      limit: 5,
      format: 'csv',
    })
    const csvExport = await requestJson(config, token, `/api/attendance/export?${csvQuery}`)
    record('api.export.csv', csvExport.res.ok, { status: csvExport.res.status })
    if (!csvExport.res.ok) ensureOk('GET /api/attendance/export?format=csv', csvExport)
    const csvHeader = String(csvExport.text || '').split(/\r?\n/)[0] || ''
    const expectedCsvLabel = fieldNameForCode(exportData.reportFields, config.expectVisibleCode)
    const csvFieldFingerprint = csvReportFieldFingerprint(csvExport)
    const csvFieldFingerprintAlgorithm = csvReportFieldFingerprintAlgorithm(csvExport)
    const csvFieldCount = csvReportFieldCount(csvExport)
    const csvFieldCodes = csvReportFieldCodes(csvExport)
    const csvBacking = csvReportFieldBacking(csvExport)
    const csvBackingFingerprint = multitableBackingFingerprint(csvBacking)
    const exportBackingFingerprint = multitableBackingFingerprint(exportMultitable)
    record('export.csv.header.expected-visible-label', csvHeader.includes(expectedCsvLabel), {
      expectedLabel: expectedCsvLabel,
      header: csvHeader,
    })
    record('export.csv.report-field-fingerprint-present', csvFieldFingerprint !== 'missing', {
      fingerprint: csvFieldFingerprint,
      algorithm: csvFieldFingerprintAlgorithm,
    })
    record('export.csv.report-field-fingerprint-match', csvFieldFingerprint === exportFieldFingerprint, {
      csv: csvFieldFingerprint,
      export: exportFieldFingerprint,
    })
    record('export.csv.report-field-count-match', csvFieldCount === exportCodes.length, {
      csv: csvFieldCount ?? 'missing',
      export: exportCodes.length,
    })
    record('export.csv.report-field-codes-present', csvFieldCodes.length > 0, {
      csv: csvFieldCodes.join(','),
      export: exportCodes.join(','),
    })
    record('export.csv.report-field-codes-match', csvFieldCodes.join('|') === exportCodes.join('|'), {
      csv: csvFieldCodes.join(','),
      export: exportCodes.join(','),
    })
    record('export.csv.report-field-backing-present', Boolean(csvBacking), {
      csvBacking: csvBackingFingerprint,
    })
    record('export.csv.report-field-backing-match', csvBackingFingerprint === exportBackingFingerprint, {
      csvBacking: csvBackingFingerprint,
      exportBacking: exportBackingFingerprint,
    })
    report.metadata.csvHeader = csvHeader
    report.metadata.csvFieldFingerprint = csvFieldFingerprint
    report.metadata.csvFieldFingerprintAlgorithm = csvFieldFingerprintAlgorithm
    report.metadata.csvFieldCount = csvFieldCount ?? ''
    report.metadata.csvFieldCodes = csvFieldCodes.join(',')
    report.metadata.csvBacking = csvBackingFingerprint

    const csvCodeQuery = buildQuery(config, {
      from: config.from,
      to: config.to,
      limit: 5,
      format: 'csv',
      header: 'code',
    })
    const csvCodeExport = await requestJson(config, token, `/api/attendance/export?${csvCodeQuery}`)
    record('api.export.csv-code-header', csvCodeExport.res.ok, { status: csvCodeExport.res.status })
    if (!csvCodeExport.res.ok) ensureOk('GET /api/attendance/export?format=csv&header=code', csvCodeExport)
    const csvCodeHeader = String(csvCodeExport.text || '').split(/\r?\n/)[0] || ''
    record('export.csv.header-code.expected-visible-code', csvCodeHeader.includes(config.expectVisibleCode), {
      expectedCode: config.expectVisibleCode,
      header: csvCodeHeader,
    })
    const csvCodeFieldFingerprint = csvReportFieldFingerprint(csvCodeExport)
    record('export.csv-code.report-field-fingerprint-match', csvCodeFieldFingerprint === exportFieldFingerprint, {
      csvCode: csvCodeFieldFingerprint,
      export: exportFieldFingerprint,
    })
    const csvCodeFieldCodes = csvReportFieldCodes(csvCodeExport)
    record('export.csv-code.report-field-codes-match', csvCodeFieldCodes.join('|') === exportCodes.join('|'), {
      csvCode: csvCodeFieldCodes.join(','),
      export: exportCodes.join(','),
    })
    const csvCodeBacking = csvReportFieldBacking(csvCodeExport)
    const csvCodeBackingFingerprint = multitableBackingFingerprint(csvCodeBacking)
    record('export.csv-code.report-field-backing-match', csvCodeBackingFingerprint === exportBackingFingerprint, {
      csvCodeBacking: csvCodeBackingFingerprint,
      exportBacking: exportBackingFingerprint,
    })
    report.metadata.csvCodeHeader = csvCodeHeader
    report.metadata.csvCodeFieldFingerprint = csvCodeFieldFingerprint
    report.metadata.csvCodeFieldCodes = csvCodeFieldCodes.join(',')
    report.metadata.csvCodeBacking = csvCodeBackingFingerprint
    record('runner.completed', true)
  } catch (error) {
    report.ok = false
    report.error = stringifyError(error)
    report.blocker = classifyBlocker(error, config)
    report.nextActions = report.blocker.nextActions
    record('runner.completed', false, { reason: report.error })
  } finally {
    report.finishedAt = new Date().toISOString()
    writeArtifacts(report)
  }

  return report
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(renderHelp())
    return
  }
  const config = parseConfig()
  const report = await runAttendanceReportFieldsAcceptance(config)
  console.log(`[attendance-report-fields-live-acceptance] ${report.ok ? 'PASS' : 'FAIL'}`)
  console.log(`[attendance-report-fields-live-acceptance] JSON: ${report.reportPath}`)
  console.log(`[attendance-report-fields-live-acceptance] MD: ${report.reportMdPath}`)
  if (report.error) {
    console.error(`[attendance-report-fields-live-acceptance] ERROR: ${report.error}`)
  }
  process.exit(report.ok ? 0 : 1)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(`[attendance-report-fields-live-acceptance] ERROR: ${error?.message || String(error)}`)
    process.exit(1)
  })
}
