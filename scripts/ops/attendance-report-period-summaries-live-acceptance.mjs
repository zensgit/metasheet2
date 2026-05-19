#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveMultitableAuthToken } from '../multitable-auth.mjs'

const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 5
const EXPECTED_OBJECT_ID = 'attendance_report_period_summaries'
const AUTH_SOURCE_CHOICES = Object.freeze(['AUTH_TOKEN', 'AUTH_TOKEN_FILE', 'ALLOW_DEV_TOKEN'])

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function parseBoolean(value) {
  return value === true || value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
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

function normalizeAuthSource(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_')
  if (!normalized) return ''
  if (normalized === 'TOKEN') return 'AUTH_TOKEN'
  if (normalized === 'TOKEN_FILE') return 'AUTH_TOKEN_FILE'
  if (normalized === 'DEV_TOKEN') return 'ALLOW_DEV_TOKEN'
  return normalized
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
  return `output/attendance-report-period-summaries-live-acceptance/${timestampSlug(now)}`
}

export function parseConfig(env = process.env, now = new Date()) {
  const range = defaultDateRange(now)
  const outputDir = String(env.OUTPUT_DIR || buildDefaultOutputDir(now))
  return {
    apiBase: normalizeBaseUrl(env.API_BASE || env.BASE_URL),
    hostHeader: normalizeHostHeader(env.API_HOST_HEADER || env.HOST_HEADER),
    authSource: normalizeAuthSource(env.AUTH_SOURCE || env.TOKEN_SOURCE),
    authToken: String(env.AUTH_TOKEN || env.TOKEN || '').trim(),
    authTokenFile: String(env.AUTH_TOKEN_FILE || env.TOKEN_FILE || '').trim(),
    allowDevToken: parseBoolean(env.ALLOW_DEV_TOKEN),
    confirmSync: parseBoolean(env.CONFIRM_SYNC),
    preflightOnly: parseBoolean(env.PREFLIGHT_ONLY),
    orgId: String(env.ORG_ID || 'default').trim(),
    userId: String(env.USER_ID || '').trim(),
    userIds: splitCsv(env.USER_IDS),
    allUsers: parseBoolean(env.ALL_USERS),
    from: String(env.FROM_DATE || env.FROM || range.from).trim(),
    to: String(env.TO_DATE || env.TO || range.to).trim(),
    cycleId: String(env.CYCLE_ID || '').trim(),
    page: parsePositiveInteger(env.PAGE, DEFAULT_PAGE),
    pageSize: parsePositiveInteger(env.PAGE_SIZE, DEFAULT_PAGE_SIZE),
    jobMode: parseBoolean(env.JOB_MODE),
    jobMaxPages: parsePositiveInteger(env.JOB_MAX_PAGES || env.MAX_JOB_PAGES, 10),
    expectObjectId: String(env.EXPECT_OBJECT_ID || EXPECTED_OBJECT_ID).trim(),
    expectFieldFingerprint: String(env.EXPECT_FIELD_FINGERPRINT || '').trim(),
    expectUsersScanned: env.EXPECT_USERS_SCANNED === undefined ? null : Number(env.EXPECT_USERS_SCANNED),
    expectCreatedOrPatched: parseBoolean(env.EXPECT_CREATED_OR_PATCHED),
    devUserId: String(env.DEV_USER_ID || 'dev-admin').trim(),
    outputDir,
    reportPath: String(env.REPORT_JSON || path.join(outputDir, 'report.json')),
    reportMdPath: String(env.REPORT_MD || path.join(outputDir, 'report.md')),
    timeoutMs: parsePositiveInteger(env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  }
}

function hasUserSelection(config) {
  return Boolean(config.userId || config.userIds.length > 0 || config.allUsers)
}

export function validateConfig(config) {
  const missing = []
  if (config.authSource && !AUTH_SOURCE_CHOICES.includes(config.authSource)) {
    missing.push('AUTH_SOURCE one of AUTH_TOKEN, AUTH_TOKEN_FILE, ALLOW_DEV_TOKEN')
  }
  if (!config.preflightOnly && !config.authToken && !config.authTokenFile && !config.allowDevToken) {
    missing.push('AUTH_TOKEN/AUTH_TOKEN_FILE or ALLOW_DEV_TOKEN=1')
  }
  if (!config.preflightOnly && config.authSource === 'AUTH_TOKEN' && !config.authToken) {
    missing.push('AUTH_SOURCE=AUTH_TOKEN requires AUTH_TOKEN/TOKEN')
  }
  if (!config.preflightOnly && config.authSource === 'AUTH_TOKEN_FILE' && !config.authTokenFile) {
    missing.push('AUTH_SOURCE=AUTH_TOKEN_FILE requires AUTH_TOKEN_FILE/TOKEN_FILE')
  }
  if (!config.preflightOnly && config.authSource === 'ALLOW_DEV_TOKEN' && !config.allowDevToken) {
    missing.push('AUTH_SOURCE=ALLOW_DEV_TOKEN requires ALLOW_DEV_TOKEN=1')
  }
  if (!config.preflightOnly && !config.confirmSync) missing.push('CONFIRM_SYNC=1')
  if (!config.orgId) missing.push('ORG_ID')
  if (!isValidHostHeader(config.hostHeader)) missing.push('API_HOST_HEADER host[:port]')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.from)) missing.push('FROM_DATE yyyy-mm-dd')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.to)) missing.push('TO_DATE yyyy-mm-dd')
  if (!config.preflightOnly && !hasUserSelection(config)) missing.push('USER_ID/USER_IDS or ALL_USERS=1')
  if (config.allUsers && (config.userId || config.userIds.length > 0)) {
    missing.push('Use either ALL_USERS=1 or USER_ID/USER_IDS, not both')
  }
  if (config.expectUsersScanned !== null && (!Number.isFinite(config.expectUsersScanned) || config.expectUsersScanned < 0)) {
    missing.push('EXPECT_USERS_SCANNED non-negative number')
  }
  return missing
}

function buildQuery(config) {
  const query = new URLSearchParams()
  query.set('orgId', config.orgId)
  return query.toString()
}

function buildDateRangeBody(config) {
  return {
    from: config.from,
    to: config.to,
    ...buildUserSelectionBody(config),
  }
}

function buildCycleBody(config) {
  return {
    cycleId: config.cycleId,
    ...buildUserSelectionBody(config),
  }
}

function buildUserSelectionBody(config) {
  if (config.allUsers) return { allUsers: true, page: config.page, pageSize: config.pageSize }
  if (config.userIds.length > 0) return { userIds: config.userIds }
  return { userId: config.userId }
}

function createReport(config) {
  return {
    ok: true,
    runMode: config.preflightOnly ? 'preflight' : 'live',
    apiBase: config.apiBase,
    hostHeader: config.hostHeader || 'default',
    orgId: config.orgId,
    userSelection: config.allUsers ? 'allUsers' : config.userIds.length > 0 ? 'userIds' : 'userId',
    userId: config.userId || '',
    userIds: config.userIds,
    allUsers: config.allUsers,
    from: config.from,
    to: config.to,
    cycleId: config.cycleId || '',
    page: config.page,
    pageSize: config.pageSize,
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

function configuredAuthSources(config) {
  return [
    config.authToken ? 'AUTH_TOKEN' : '',
    config.authTokenFile ? 'AUTH_TOKEN_FILE' : '',
    config.allowDevToken ? 'ALLOW_DEV_TOKEN' : '',
  ].filter(Boolean)
}

function recordConfiguredAuthSource(record, selected, presentSources, requested = '') {
  const ignored = presentSources.filter(source => source !== selected)
  const details = {
    selected,
    present: presentSources.join(',') || 'none',
    ignored: ignored.join(',') || 'none',
  }
  if (requested) details.requested = requested
  record('config.auth-source', true, details)
}

function resolveConfiguredAuthToken(config, record) {
  const presentSources = configuredAuthSources(config)
  const selectedSource = config.authSource || (
    config.authToken
      ? 'AUTH_TOKEN'
      : config.authTokenFile
        ? 'AUTH_TOKEN_FILE'
        : config.allowDevToken
          ? 'ALLOW_DEV_TOKEN'
          : 'none'
  )

  if (selectedSource === 'AUTH_TOKEN') {
    recordConfiguredAuthSource(record, 'AUTH_TOKEN', presentSources, config.authSource)
    return { token: config.authToken, source: 'AUTH_TOKEN' }
  }

  if (selectedSource === 'ALLOW_DEV_TOKEN' || selectedSource === 'none') {
    recordConfiguredAuthSource(record, selectedSource, presentSources, config.authSource)
    return { token: '', source: selectedSource }
  }

  recordConfiguredAuthSource(record, 'AUTH_TOKEN_FILE', presentSources, config.authSource)
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

  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  record('config.auth-token-file', Boolean(token), {
    tokenFile: tokenFileDisplay,
    status: token ? 'loaded' : 'empty',
  })
  if (!token) throw new Error(`AUTH_TOKEN_FILE_EMPTY: ${tokenFileDisplay}`)
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
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  return fetchJson(`${config.apiBase}${route}`, {
    ...options,
    body,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  }, config.timeoutMs, config.hostHeader)
}

async function checkedRequest(config, token, route, checkName, record, options = {}) {
  try {
    const result = await requestJson(config, token, route, options)
    record(checkName, result.res.ok, { status: result.res.status })
    return ensureOk(checkName, result)
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

function syncRoute(config) {
  return `/api/attendance/report-period-summaries/sync?${buildQuery(config)}`
}

function isExpectedObject(data, config) {
  return data?.multitable?.objectId === config.expectObjectId
}

function hasFingerprint(data) {
  return Boolean(data?.fieldFingerprint)
}

function isCleanSyncResult(data) {
  return Number(data?.failed ?? 0) === 0 && Number(data?.duplicateRowKeys ?? 0) === 0
}

function rerunSkipped(data) {
  return Number(data?.skipped ?? 0) >= 1 || Number(data?.usersScanned ?? 0) === 0
}

function createdOrPatched(data) {
  return Number(data?.created ?? 0) + Number(data?.patched ?? 0) > 0
}

function isTerminalJobStatus(status) {
  return ['completed', 'canceled', 'failed'].includes(String(status || '').trim())
}

function jobTotalsPresent(job) {
  const totals = job?.totals && typeof job.totals === 'object' ? job.totals : null
  return Boolean(totals && Number.isFinite(Number(totals.usersScanned)) && Number.isFinite(Number(totals.synced)))
}

function reportSyncJobUserSelection(config) {
  if (config.allUsers) return { allUsers: true }
  if (config.userIds.length > 0) return { userIds: config.userIds }
  return { userId: config.userId }
}

function reportSyncJobBody(config, periodSource) {
  return {
    kind: 'period_summaries',
    mode: 'manual_step',
    pageSize: config.pageSize,
    periodSource,
    userSelection: reportSyncJobUserSelection(config),
  }
}

async function runReportSyncJobAcceptance(config, token, label, body, record) {
  const created = payloadData(await checkedRequest(
    config,
    token,
    `/api/attendance/report-sync-jobs?${buildQuery(config)}`,
    `api.${label}.job.create`,
    record,
    { method: 'POST', body },
  ))
  const jobId = String(created?.id || '')
  record(`${label}.job.created`, Boolean(jobId), {
    jobId: jobId || 'missing',
    kind: created?.kind || 'missing',
    status: created?.status || 'missing',
  })

  let job = created
  let pageCount = 0
  const pageStatuses = []
  while (jobId && !isTerminalJobStatus(job?.status) && pageCount < config.jobMaxPages) {
    pageCount += 1
    const pageData = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/report-sync-jobs/${encodeURIComponent(jobId)}/run-next-page?${buildQuery(config)}`,
      `api.${label}.job.run-page`,
      record,
      { method: 'POST' },
    ))
    job = pageData.job || job
    pageStatuses.push(job?.status || 'missing')
  }

  record(`${label}.job.completed`, job?.status === 'completed', {
    jobId: jobId || 'missing',
    status: job?.status || 'missing',
    pages: pageCount,
  })
  record(`${label}.job.pages-within-limit`, pageCount > 0 && pageCount <= config.jobMaxPages, {
    pages: pageCount,
    maxPages: config.jobMaxPages,
    statuses: pageStatuses.join(','),
  })
  record(`${label}.job.totals-present`, jobTotalsPresent(job), {
    usersScanned: job?.totals?.usersScanned ?? 'missing',
    synced: job?.totals?.synced ?? 'missing',
    failed: job?.totals?.failed ?? 'missing',
  })

  if (jobId && job?.status === 'completed') {
    const rerun = await requestJson(
      config,
      token,
      `/api/attendance/report-sync-jobs/${encodeURIComponent(jobId)}/run-next-page?${buildQuery(config)}`,
      { method: 'POST' },
    )
    const errorCode = rerun?.json?.error?.code || ''
    record(`${label}.job.terminal-rerun-rejected`, rerun.res.status === 409 && errorCode === 'JOB_TERMINAL', {
      status: rerun.res.status,
      code: errorCode || 'missing',
    })
    const replacement = payloadData(await checkedRequest(
      config,
      token,
      `/api/attendance/report-sync-jobs?${buildQuery(config)}`,
      `api.${label}.job.create-after-terminal`,
      record,
      { method: 'POST', body },
    ))
    const replacementJobId = String(replacement?.id || '')
    record(`${label}.job.new-job-created`, Boolean(replacementJobId && replacementJobId !== jobId), {
      jobId: replacementJobId || 'missing',
      previousJobId: jobId,
      status: replacement?.status || 'missing',
    })
    if (replacementJobId) {
      const canceled = payloadData(await checkedRequest(
        config,
        token,
        `/api/attendance/report-sync-jobs/${encodeURIComponent(replacementJobId)}/cancel?${buildQuery(config)}`,
        `api.${label}.job.cancel-new-job`,
        record,
        { method: 'POST' },
      ))
      record(`${label}.job.new-job-canceled`, canceled?.status === 'canceled', {
        jobId: replacementJobId,
        status: canceled?.status || 'missing',
      })
    }
  } else {
    record(`${label}.job.terminal-rerun-rejected`, false, {
      reason: 'job did not reach completed status',
      status: job?.status || 'missing',
    })
  }

  return { jobId, job, pageCount }
}

function usersScannedMatches(data, config) {
  if (config.expectUsersScanned === null) return true
  return Number(data?.usersScanned ?? data?.synced ?? 0) === config.expectUsersScanned
}

function recordSyncChecks(record, name, data, config) {
  record(`${name}.ok`, true, {
    synced: data.synced ?? 0,
    created: data.created ?? 0,
    patched: data.patched ?? 0,
    skipped: data.skipped ?? 0,
    failed: data.failed ?? 0,
  })
  record(`${name}.multitable-object`, isExpectedObject(data, config), {
    objectId: data?.multitable?.objectId || 'missing',
  })
  record(`${name}.fingerprint`, hasFingerprint(data), {
    fingerprint: data?.fieldFingerprint || 'missing',
  })
  record(`${name}.clean`, isCleanSyncResult(data), {
    failed: data?.failed ?? 0,
    duplicateRowKeys: data?.duplicateRowKeys ?? 0,
  })
  record(`${name}.users-scanned`, usersScannedMatches(data, config), {
    usersScanned: data?.usersScanned ?? data?.synced ?? 0,
    expected: config.expectUsersScanned ?? 'not-set',
  })
  if (config.expectFieldFingerprint) {
    record(`${name}.expected-fingerprint`, data?.fieldFingerprint === config.expectFieldFingerprint, {
      fingerprint: data?.fieldFingerprint || 'missing',
      expected: config.expectFieldFingerprint,
    })
  }
  if (config.expectCreatedOrPatched) {
    record(`${name}.created-or-patched`, createdOrPatched(data), {
      created: data?.created ?? 0,
      patched: data?.patched ?? 0,
    })
  }
}

async function syncPeriodTwice(config, token, label, body, record) {
  const first = payloadData(await checkedRequest(config, token, syncRoute(config), `api.${label}.sync-first`, record, {
    method: 'POST',
    body,
  }))
  recordSyncChecks(record, `${label}.first`, first, config)

  const second = payloadData(await checkedRequest(config, token, syncRoute(config), `api.${label}.sync-rerun`, record, {
    method: 'POST',
    body,
  }))
  recordSyncChecks(record, `${label}.rerun`, second, config)
  record(`${label}.rerun-skipped`, rerunSkipped(second), {
    skipped: second.skipped ?? 0,
    usersScanned: second.usersScanned ?? 'n/a',
  })

  return { first, second }
}

function classifyBlocker(error, config) {
  const message = stringifyError(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('econnrefused')
    || lower.includes('enotfound')
    || lower.includes('eai_again')
    || lower.includes('socket hang up')
    || lower.includes('timed out')
  ) {
    return {
      code: 'BACKEND_UNREACHABLE',
      message,
      nextActions: [`确认 API_BASE 是否正确：${config.apiBase}`, '确认 staging tunnel 或后端服务处于可访问状态'],
    }
  }
  if (lower.includes('missing required configuration')) {
    return {
      code: 'CONFIG_MISSING',
      message,
      nextActions: ['设置 AUTH_TOKEN_FILE=<path>、CONFIRM_SYNC=1、USER_ID/USER_IDS 或 ALL_USERS=1'],
    }
  }
  if (message.includes('(401)') || lower.includes('unauthorized')) {
    return { code: 'AUTH_UNAUTHORIZED', message, nextActions: ['刷新 AUTH_TOKEN_FILE 后重跑'] }
  }
  if (message.includes('(403)') || lower.includes('forbidden')) {
    return { code: 'AUTH_FORBIDDEN', message, nextActions: ['确认 token 用户具备 attendance:admin 与 multitable 写权限'] }
  }
  if (message.includes('AUTH_TOKEN_FILE_')) {
    return { code: 'AUTH_TOKEN_FILE_INVALID', message, nextActions: ['确认 token 文件存在、非空且 chmod 600'] }
  }
  return { code: 'RUNNER_FAILED', message, nextActions: ['查看 report.json 的第一个失败 check 和后端日志'] }
}

export function renderHelp() {
  return [
    'Usage:',
    '  pnpm run verify:attendance-report-period-summaries:live',
    '',
    'Required for live mode:',
    '  AUTH_TOKEN=<token>, AUTH_TOKEN_FILE=<path>, or ALLOW_DEV_TOKEN=1',
    '  CONFIRM_SYNC=1',
    '  USER_ID=<id>, USER_IDS=<id,id>, or ALL_USERS=1',
    '',
    'Common options:',
    '  API_BASE=http://127.0.0.1:8900',
    '  API_HOST_HEADER=localhost',
    '  ORG_ID=default',
    '  FROM_DATE=2026-05-01',
    '  TO_DATE=2026-05-13',
    '  CYCLE_ID=<optional-payroll-cycle-id>',
    '  PAGE=1',
    '  PAGE_SIZE=5',
    '  JOB_MODE=1',
    '  JOB_MAX_PAGES=10',
    '  EXPECT_USERS_SCANNED=1',
    '  EXPECT_CREATED_OR_PATCHED=1',
    '  AUTH_SOURCE=AUTH_TOKEN|AUTH_TOKEN_FILE|ALLOW_DEV_TOKEN',
    '  OUTPUT_DIR=output/attendance-report-period-summaries-live-acceptance/<run>',
    '',
    'Preflight only:',
    '  PREFLIGHT_ONLY=1 pnpm run verify:attendance-report-period-summaries:live',
    '',
  ].join('\n')
}

const MARKDOWN_CHECK_DETAIL_KEYS = Object.freeze([
  'status',
  'reason',
  'missing',
  'selected',
  'present',
  'ignored',
  'requested',
  'mode',
  'tokenFile',
  'synced',
  'created',
  'patched',
  'skipped',
  'failed',
  'duplicateRowKeys',
  'usersScanned',
  'jobId',
  'kind',
  'pages',
  'maxPages',
  'statuses',
  'synced',
  'expected',
  'objectId',
  'fingerprint',
])

function formatMarkdownInlineValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).join(',')
  return String(value).replace(/`/g, "'").slice(0, 240)
}

function renderMarkdownCheckDetailLines(details) {
  if (!details || typeof details !== 'object') return []
  const lines = []
  for (const key of MARKDOWN_CHECK_DETAIL_KEYS) {
    const value = details[key]
    if (value === undefined || value === null || value === '') continue
    lines.push(`  - ${key}: \`${formatMarkdownInlineValue(value)}\``)
  }
  return lines
}

export function renderAcceptanceMarkdown(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failing = checks.filter(check => check && check.ok === false)
  const lines = [
    '# Attendance Report Period Summaries Live Acceptance',
    '',
    `- Overall: **${report?.ok === false ? 'FAIL' : 'PASS'}**`,
    `- Run mode: \`${report?.runMode || 'live'}\``,
    `- API base: \`${report?.apiBase || 'missing'}\``,
    `- Host header: \`${report?.hostHeader || 'default'}\``,
    `- Org ID: \`${report?.orgId || 'missing'}\``,
    `- User selection: \`${report?.userSelection || 'missing'}\``,
    `- Date range: \`${report?.from || 'missing'}..${report?.to || 'missing'}\``,
    `- Cycle ID: \`${report?.cycleId || 'not-set'}\``,
    `- Started at: \`${report?.startedAt || 'missing'}\``,
    `- Finished at: \`${report?.finishedAt || 'missing'}\``,
    `- JSON report: \`${report?.reportPath || 'missing'}\``,
    `- Markdown report: \`${report?.reportMdPath || 'missing'}\``,
    '',
    '## Checks',
    '',
    `- Total checks: \`${checks.length}\``,
    failing.length
      ? `- Failing checks: ${failing.map(check => `\`${check.name}\``).join(', ')}`
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
  if (report?.metadata && Object.keys(report.metadata).length > 0) {
    lines.push('', '## Metadata', '')
    for (const [key, value] of Object.entries(report.metadata)) {
      lines.push(`- ${key}: \`${formatMarkdownInlineValue(value)}\``)
    }
  }
  lines.push('', '## Check Results', '')
  for (const check of checks) {
    lines.push(`- \`${check.name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
    lines.push(...renderMarkdownCheckDetailLines(check.details))
  }
  if (Array.isArray(report?.nextActions) && report.nextActions.length > 0) {
    lines.push('', '## Next Actions', '')
    for (const action of report.nextActions) lines.push(`- ${action}`)
  }
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

export async function runAttendanceReportPeriodSummariesAcceptance(config) {
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
    let configuredAuth = { token: '', source: 'preflight' }
    if (!config.preflightOnly) {
      configuredAuth = resolveConfiguredAuthToken(config, record)
      report.metadata.authSource = configuredAuth.source
    }

    const healthData = await checkedRequest(config, '', '/api/health', 'api.health', record)
    report.metadata.healthStatus = healthData?.status || healthData?.data?.status || 'ok'

    if (config.preflightOnly) {
      record('preflight.completed', true)
      record('runner.completed', true)
      report.finishedAt = new Date().toISOString()
      writeArtifacts(report)
      return report
    }

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

    await checkedRequest(config, token, '/api/auth/me', 'api.auth.me', record)

    const dateRange = await syncPeriodTwice(config, token, 'date-range', buildDateRangeBody(config), record)
    report.metadata.dateRangeFieldFingerprint = dateRange.second.fieldFingerprint || dateRange.first.fieldFingerprint || ''
    report.metadata.dateRangeObjectId = dateRange.second.multitable?.objectId || dateRange.first.multitable?.objectId || ''
    report.metadata.dateRangeSheetId = dateRange.second.multitable?.sheetId || dateRange.first.multitable?.sheetId || ''
    report.metadata.dateRangeViewId = dateRange.second.multitable?.viewId || dateRange.first.multitable?.viewId || ''

    if (config.jobMode) {
      const dateRangeJob = await runReportSyncJobAcceptance(
        config,
        token,
        'date-range',
        reportSyncJobBody(config, { from: config.from, to: config.to }),
        record,
      )
      report.metadata.dateRangeJobId = dateRangeJob.jobId
      report.metadata.dateRangeJobStatus = dateRangeJob.job?.status || ''
      report.metadata.dateRangeJobPages = dateRangeJob.pageCount
    } else {
      record('date-range.job.skipped', true, { reason: 'JOB_MODE not set' })
    }

    if (config.cycleId) {
      const cycle = await syncPeriodTwice(config, token, 'payroll-cycle', buildCycleBody(config), record)
      report.metadata.cycleFieldFingerprint = cycle.second.fieldFingerprint || cycle.first.fieldFingerprint || ''
      report.metadata.cycleId = config.cycleId
      if (config.jobMode) {
        const cycleJob = await runReportSyncJobAcceptance(
          config,
          token,
          'payroll-cycle',
          reportSyncJobBody(config, { cycleId: config.cycleId }),
          record,
        )
        report.metadata.cycleJobId = cycleJob.jobId
        report.metadata.cycleJobStatus = cycleJob.job?.status || ''
        report.metadata.cycleJobPages = cycleJob.pageCount
      } else {
        record('payroll-cycle.job.skipped', true, { reason: 'JOB_MODE not set' })
      }
    } else {
      record('payroll-cycle.skipped', true, { reason: 'CYCLE_ID not set' })
      record('payroll-cycle.job.skipped', true, { reason: 'CYCLE_ID not set' })
    }

    record('runner.completed', report.ok)
  } catch (error) {
    report.error = stringifyError(error)
    report.blocker = classifyBlocker(error, config)
    report.nextActions = report.blocker.nextActions
    report.ok = false
  }

  report.finishedAt = new Date().toISOString()
  writeArtifacts(report)
  return report
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(renderHelp())
    return
  }

  const config = parseConfig()
  const report = await runAttendanceReportPeriodSummariesAcceptance(config)
  console.log(`[attendance-report-period-summaries-live-acceptance] ${report.ok ? 'PASS' : 'FAIL'}`)
  console.log(`[attendance-report-period-summaries-live-acceptance] JSON: ${report.reportPath}`)
  console.log(`[attendance-report-period-summaries-live-acceptance] MD: ${report.reportMdPath}`)
  if (!report.ok) {
    console.error(`[attendance-report-period-summaries-live-acceptance] ERROR: ${report.error || 'unknown error'}`)
    process.exitCode = 1
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[attendance-report-period-summaries-live-acceptance] ERROR: ${error?.message || String(error)}`)
    process.exitCode = 1
  })
}
