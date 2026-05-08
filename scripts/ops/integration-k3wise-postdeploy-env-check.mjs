#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_OUTPUT_ROOT = 'output/integration-k3wise-postdeploy-env-check'
const DEFAULT_SMOKE_OUTPUT_ROOT = 'output/integration-k3wise-postdeploy-smoke/manual'
const TOKEN_PATTERN = /([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi
const SECRET_QUERY_KEYS = /^(access[_-]?token|api[_-]?key|auth|authorization|credential|jwt|password|secret|session[_-]?id|token)$/i

class K3WisePostdeployEnvCheckError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WisePostdeployEnvCheckError'
    this.details = details
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-postdeploy-env-check.mjs [options]

Validates local inputs before running the K3 WISE authenticated postdeploy smoke.
This does not contact the deployment host.

Options:
  --base-url <url>        MetaSheet base URL to smoke
  --auth-token <token>    Bearer token value; prefer --token-file for local use
  --token-file <path>     File containing bearer token
  --tenant-id <id>        Tenant scope for authenticated control-plane list probes
  --require-auth          Fail when no token source is supplied
  --require-tenant        Fail when tenant id is empty
  --timeout-ms <ms>       Per-request timeout for the generated smoke command
  --smoke-out-dir <dir>   Output directory for the generated smoke command
  --out-dir <dir>         Env-check report output directory
  --help                  Show this help

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

function parseBooleanValue(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  switch (String(value).trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'y':
    case 'on':
    case '是':
    case '启用':
    case '开启':
      return true
    case 'false':
    case '0':
    case 'no':
    case 'n':
    case 'off':
    case '否':
    case '禁用':
    case '关闭':
      return false
    default:
      throw new K3WisePostdeployEnvCheckError(`${name} must be a boolean`, { name, value })
  }
}

function envBoolean(defaultValue, ...names) {
  for (const name of names) {
    const value = process.env[name]
    const parsed = parseBooleanValue(value, name)
    if (parsed !== undefined) return parsed
  }
  return defaultValue
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new K3WisePostdeployEnvCheckError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: envValue('METASHEET_BASE_URL', 'PUBLIC_APP_URL'),
    authToken: envValue('K3_WISE_SMOKE_TOKEN', 'METASHEET_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    tokenFile: envValue('METASHEET_AUTH_TOKEN_FILE', 'AUTH_TOKEN_FILE'),
    tenantId: envValue('K3_WISE_SMOKE_TENANT_ID', 'METASHEET_TENANT_ID', 'TENANT_ID'),
    requireAuth: envBoolean(false, 'REQUIRE_AUTH', 'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH'),
    requireTenant: envBoolean(false, 'K3_WISE_PRE_SMOKE_REQUIRE_TENANT'),
    timeoutMs: 10_000,
    smokeOutDir: DEFAULT_SMOKE_OUTPUT_ROOT,
    outDir: '',
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
      case '--require-tenant':
        opts.requireTenant = true
        break
      case '--timeout-ms':
        opts.timeoutMs = Number(readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--smoke-out-dir':
        opts.smokeOutDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--out-dir':
        opts.outDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new K3WisePostdeployEnvCheckError(`unknown option: ${arg}`, { arg })
    }
  }

  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new K3WisePostdeployEnvCheckError('--timeout-ms must be a positive integer', { timeoutMs: opts.timeoutMs })
  }
  opts.baseUrl = opts.baseUrl.trim()
  opts.authToken = opts.authToken.trim()
  opts.tokenFile = opts.tokenFile.trim()
  opts.tenantId = opts.tenantId.trim()
  opts.smokeOutDir = opts.smokeOutDir.trim()
  return opts
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
      if (SECRET_QUERY_KEYS.test(key)) {
        url.searchParams.set(key, '<redacted>')
      }
    }
    return url.toString()
  } catch {
    return value
  }
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function makeCheck(id, status, message, details = {}) {
  return { id, status, message, ...details }
}

function normalizeBaseUrl(value) {
  if (!value) {
    throw new K3WisePostdeployEnvCheckError('base URL is required; set --base-url or METASHEET_BASE_URL', {
      field: 'baseUrl',
    })
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new K3WisePostdeployEnvCheckError('--base-url must be a valid URL', { baseUrl: value })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new K3WisePostdeployEnvCheckError('--base-url must use http or https', { baseUrl: value })
  }
  if (url.username || url.password) {
    throw new K3WisePostdeployEnvCheckError('--base-url must not contain inline credentials', { baseUrl: redactText(value) })
  }
  if (url.search || url.hash) {
    throw new K3WisePostdeployEnvCheckError('--base-url must not contain query string or hash', { baseUrl: redactText(value) })
  }
  return url.toString().replace(/\/+$/, '')
}

function getBaseUrlPathWarning(normalizedBaseUrl) {
  try {
    const url = new URL(normalizedBaseUrl)
    return url.pathname && url.pathname !== '/'
      ? `base URL includes path ${url.pathname}; smoke will append /api/... under that path`
      : ''
  } catch {
    return ''
  }
}

function looksLikeJwt(token) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
}

async function inspectToken(opts) {
  if (opts.authToken) {
    return {
      source: 'auth-token',
      present: true,
      length: opts.authToken.length,
      jwtLike: looksLikeJwt(opts.authToken),
    }
  }
  if (!opts.tokenFile) {
    return {
      source: 'none',
      present: false,
      length: 0,
      jwtLike: false,
    }
  }
  const tokenFile = path.resolve(opts.tokenFile)
  const info = await stat(tokenFile)
  if (!info.isFile()) {
    throw new K3WisePostdeployEnvCheckError('--token-file must point to a file', { tokenFile })
  }
  const raw = await readFile(tokenFile, 'utf8')
  const token = raw.trim()
  if (!token) {
    throw new K3WisePostdeployEnvCheckError('--token-file is empty', { tokenFile })
  }
  return {
    source: 'token-file',
    present: true,
    tokenFile,
    length: token.length,
    jwtLike: looksLikeJwt(token),
  }
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function buildSmokeCommand(opts, normalizedBaseUrl, tokenInfo) {
  const args = [
    'node',
    'scripts/ops/integration-k3wise-postdeploy-smoke.mjs',
    '--base-url',
    quoteShell(normalizedBaseUrl),
    '--out-dir',
    quoteShell(opts.smokeOutDir || DEFAULT_SMOKE_OUTPUT_ROOT),
    '--timeout-ms',
    quoteShell(String(opts.timeoutMs)),
  ]
  if (opts.requireAuth) args.push('--require-auth')
  if (opts.tenantId) args.push('--tenant-id', quoteShell(opts.tenantId))
  if (tokenInfo.source === 'token-file') args.push('--token-file', quoteShell(tokenInfo.tokenFile))
  if (tokenInfo.source === 'auth-token') args.push('--auth-token', '<redacted-token>')
  return args.join(' ')
}

async function runEnvCheck(opts) {
  const checks = []
  let normalizedBaseUrl = ''
  try {
    normalizedBaseUrl = normalizeBaseUrl(opts.baseUrl)
    checks.push(makeCheck('base-url', 'pass', 'base URL is valid', { baseUrl: normalizedBaseUrl }))
    const pathWarning = getBaseUrlPathWarning(normalizedBaseUrl)
    if (pathWarning) checks.push(makeCheck('base-url-path', 'warn', pathWarning, { baseUrl: normalizedBaseUrl }))
  } catch (error) {
    checks.push(makeCheck('base-url', 'fail', error.message, { details: error.details || {} }))
  }

  let tokenInfo = { source: 'none', present: false, length: 0, jwtLike: false }
  try {
    tokenInfo = await inspectToken(opts)
    if (!tokenInfo.present && opts.requireAuth) {
      checks.push(makeCheck('auth-token', 'fail', 'authenticated smoke requires --auth-token or --token-file'))
    } else if (!tokenInfo.present) {
      checks.push(makeCheck('auth-token', 'warn', 'no token supplied; authenticated checks will be skipped'))
    } else {
      checks.push(makeCheck('auth-token', tokenInfo.jwtLike ? 'pass' : 'warn', tokenInfo.jwtLike
        ? `${tokenInfo.source} is present and looks like a JWT`
        : `${tokenInfo.source} is present but does not look like a JWT; smoke will still pass it as bearer token`, {
        source: tokenInfo.source,
        tokenFile: tokenInfo.tokenFile,
        tokenLength: tokenInfo.length,
        jwtLike: tokenInfo.jwtLike,
      }))
    }
  } catch (error) {
    checks.push(makeCheck('auth-token', 'fail', error.message, { details: error.details || {} }))
  }

  if (opts.tenantId) {
    checks.push(makeCheck('tenant-id', 'pass', 'tenant id supplied', { tenantId: opts.tenantId }))
  } else if (opts.requireTenant) {
    checks.push(makeCheck('tenant-id', 'fail', 'tenant id is required; set --tenant-id or METASHEET_TENANT_ID'))
  } else {
    checks.push(makeCheck('tenant-id', 'warn', 'tenant id is empty; smoke may infer it from /api/auth/me or run unscoped list probes'))
  }

  if (opts.smokeOutDir) {
    checks.push(makeCheck('smoke-output', 'pass', 'smoke output directory is configured', {
      smokeOutDir: opts.smokeOutDir,
    }))
  } else {
    checks.push(makeCheck('smoke-output', 'warn', 'smoke output directory is empty; smoke will use its timestamped default'))
  }

  checks.push(makeCheck('timeout', 'pass', 'timeout is a positive integer', { timeoutMs: opts.timeoutMs }))

  const failCount = checks.filter((check) => check.status === 'fail').length
  const warnCount = checks.filter((check) => check.status === 'warn').length
  const evidence = {
    ok: failCount === 0,
    generatedAt: new Date().toISOString(),
    baseUrl: normalizedBaseUrl || redactText(opts.baseUrl || ''),
    requireAuth: opts.requireAuth,
    requireTenant: opts.requireTenant,
    tenantId: opts.tenantId || null,
    tokenSource: tokenInfo.source,
    smokeCommand: failCount === 0 ? buildSmokeCommand(opts, normalizedBaseUrl, tokenInfo) : '',
    checks,
    summary: {
      pass: checks.filter((check) => check.status === 'pass').length,
      warn: warnCount,
      fail: failCount,
    },
  }
  return evidence
}

function renderMarkdown(evidence) {
  const lines = [
    '# K3 WISE Postdeploy Env Check',
    '',
    `- Generated at: ${evidence.generatedAt}`,
    `- Result: ${evidence.ok ? 'PASS' : 'FAIL'}`,
    `- Base URL: ${evidence.baseUrl || 'not set'}`,
    `- Require auth: ${evidence.requireAuth ? 'yes' : 'no'}`,
    `- Tenant ID: ${evidence.tenantId || 'not set'}`,
    `- Token source: ${evidence.tokenSource}`,
    `- Summary: ${evidence.summary.pass} pass / ${evidence.summary.warn} warn / ${evidence.summary.fail} fail`,
    '',
    '## Checks',
    '',
    '| Check | Status | Message |',
    '| --- | --- | --- |',
  ]
  for (const check of evidence.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${redactText(check.message).replace(/\|/g, '\\|')} |`)
  }
  if (evidence.smokeCommand) {
    lines.push(
      '',
      '## Next Command',
      '',
      '```bash',
      redactText(evidence.smokeCommand),
      '```',
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function writeEvidence(evidence, opts) {
  const outDir = path.resolve(opts.outDir || path.join(DEFAULT_OUTPUT_ROOT, nowStamp()))
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-postdeploy-env-check.json')
  const mdPath = path.join(outDir, 'integration-k3wise-postdeploy-env-check.md')
  await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(evidence))
  return { outDir, jsonPath, mdPath }
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }
  const evidence = await runEnvCheck(opts)
  const paths = await writeEvidence(evidence, opts)
  console.log(JSON.stringify({
    ok: evidence.ok,
    baseUrl: evidence.baseUrl,
    requireAuth: evidence.requireAuth,
    tenantId: evidence.tenantId,
    tokenSource: evidence.tokenSource,
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
    const body = error instanceof K3WisePostdeployEnvCheckError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(JSON.parse(redactText(JSON.stringify(body))), null, 2))
    process.exit(1)
  })
}

export {
  K3WisePostdeployEnvCheckError,
  buildSmokeCommand,
  parseArgs,
  renderMarkdown,
  runCli,
  runEnvCheck,
}
