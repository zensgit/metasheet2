#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'http://142.171.239.56:8081'
const DEFAULT_OUTPUT_ROOT = 'output/integration-k3wise-postdeploy-smoke'
const REQUIRED_ADAPTERS = [
  'http',
  'plm:yuantus-wrapper',
  'erp:k3-wise-webapi',
  'erp:k3-wise-sqlserver',
]
const REQUIRED_ROUTES = [
  ['GET', '/api/integration/status'],
  ['GET', '/api/integration/external-systems'],
  ['POST', '/api/integration/external-systems'],
  ['POST', '/api/integration/external-systems/:id/test'],
  ['GET', '/api/integration/pipelines'],
  ['POST', '/api/integration/pipelines'],
  ['POST', '/api/integration/pipelines/:id/dry-run'],
  ['POST', '/api/integration/pipelines/:id/run'],
  ['GET', '/api/integration/runs'],
  ['GET', '/api/integration/dead-letters'],
  ['GET', '/api/integration/staging/descriptors'],
  ['POST', '/api/integration/staging/install'],
]
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
const TOKEN_PATTERN = /([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g

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
  --require-auth         Fail when no token is supplied or auth checks are skipped
  --out-dir <dir>        Output directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --timeout-ms <ms>      Per-request timeout, default 10000
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
    requireAuth: false,
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
      case '--require-auth':
        opts.requireAuth = true
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
  return url.toString().replace(/\/+$/, '')
}

function redactText(value) {
  return String(value).replace(TOKEN_PATTERN, '<redacted-token>')
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
  return result(id, 'fail', {
    error: error && error.message ? redactText(error.message) : redactText(String(error)),
  })
}

async function readToken(opts) {
  if (opts.authToken) return opts.authToken.trim()
  if (!opts.tokenFile) return ''
  const raw = await readFile(opts.tokenFile, 'utf8')
  return raw.trim()
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

async function requestJson(baseUrl, pathname, { token = '', timeoutMs = 10_000, acceptStatuses = [200] } = {}) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchWithTimeout(`${baseUrl}${pathname}`, { headers }, timeoutMs)
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

function assertStagingDescriptors(body) {
  const data = body && body.data ? body.data : body
  if (!Array.isArray(data)) {
    throw new K3WisePostdeploySmokeError('staging descriptors response must be an array')
  }
  const ids = data.map((descriptor) => descriptor && descriptor.id).filter(Boolean)
  for (const id of REQUIRED_STAGING_DESCRIPTORS) {
    if (!ids.includes(id)) {
      throw new K3WisePostdeploySmokeError(`missing staging descriptor ${id}`, { ids })
    }
  }
  return { descriptors: ids, descriptorsChecked: REQUIRED_STAGING_DESCRIPTORS.length }
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
  const token = await readToken(opts)
  const checks = []

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
    if (!/id=["']app["']/.test(page.text) && !/K3 WISE|MetaSheet|metasheet/i.test(page.text)) {
      throw new K3WisePostdeploySmokeError('K3 WISE frontend route did not look like the app shell')
    }
    checks.push(result('k3-wise-frontend-route', 'pass', {
      httpStatus: page.status,
      bytes: page.text.length,
    }))
  } catch (error) {
    checks.push(failResult('k3-wise-frontend-route', error))
  }

  if (!token) {
    const skipped = result('authenticated-integration-contract', opts.requireAuth ? 'fail' : 'skipped', {
      reason: 'no bearer token supplied',
    })
    checks.push(skipped)
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
  }

  const failed = checks.filter((check) => check.status === 'fail')
  const evidence = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    authenticated: Boolean(token),
    requireAuth: opts.requireAuth,
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
    `- Generated at: ${evidence.generatedAt}`,
    `- Base URL: ${evidence.baseUrl}`,
    `- Authenticated checks: ${evidence.authenticated ? 'yes' : 'no'}`,
    `- Result: ${evidence.ok ? 'PASS' : 'FAIL'}`,
    `- Summary: ${evidence.summary.pass} pass / ${evidence.summary.skipped} skipped / ${evidence.summary.fail} fail`,
    '',
    '## Checks',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
  ]
  for (const check of evidence.checks) {
    const detail = check.error || check.reason || JSON.stringify({ ...check, id: undefined, status: undefined })
    lines.push(`| ${check.id} | ${check.status} | ${String(detail).replace(/\|/g, '\\|')} |`)
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
  assertStagingDescriptors,
  assertStatusRoutes,
  parseArgs,
  renderMarkdown,
  runCli,
  runSmoke,
}
