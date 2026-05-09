#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-remote-smoke-preflight'

const REQUIRED_LOCAL_FILES = [
  'docs/dingtalk-remote-smoke-checklist-20260422.md',
  'scripts/ops/dingtalk-p4-remote-smoke.mjs',
  'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs',
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-smoke-preflight.mjs [options]

Validates that the operator has enough local tooling and redacted runtime inputs
to execute the DingTalk P4 remote smoke. It does not call DingTalk robot
webhooks, does not create tables, and does not write secrets.

Options:
  --env-file <file>                Optional KEY=VALUE file to read before env/CLI
  --api-base <url>                 Backend API base, default ${DEFAULT_API_BASE}
  --web-base <url>                 Public app base used by DingTalk message links
  --auth-token <token>             Bearer token used to validate /api/auth/me
  --group-a-webhook <url>          DingTalk group A robot webhook; https://oapi.dingtalk.com/robot/send?access_token=...
  --group-b-webhook <url>          DingTalk group B robot webhook; https://oapi.dingtalk.com/robot/send?access_token=...
  --group-a-secret <secret>        Optional DingTalk group A SEC... secret
  --group-b-secret <secret>        Optional DingTalk group B SEC... secret
  --allowed-user <id>              Local user allowed to fill; repeatable
  --allowed-member-group <id>      Allowed local member group; repeatable
  --person-user <id>               Optional local user for person smoke; repeatable
  --authorized-user <id>           DingTalk-bound allowed local user for manual submit proof
  --unauthorized-user <id>         DingTalk-bound non-allowlisted local user for denial proof
  --no-email-dingtalk-external-id <id>
                                  Synced DingTalk account without local user/email for admin proof
  --require-manual-targets         Fail if the three manual target IDs above are missing
  --require-person-user            Fail if no person-message local user ID is supplied
  --output-dir <dir>               Output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --timeout-ms <ms>                API health timeout, default 10000
  --skip-api                       Skip GET /health and auth token validation
  --help                           Show this help

Environment fallbacks match dingtalk-p4-remote-smoke.mjs:
  DINGTALK_P4_API_BASE, DINGTALK_P4_WEB_BASE, DINGTALK_P4_AUTH_TOKEN,
  DINGTALK_P4_GROUP_A_WEBHOOK, DINGTALK_P4_GROUP_B_WEBHOOK,
  DINGTALK_P4_GROUP_A_SECRET, DINGTALK_P4_GROUP_B_SECRET,
  DINGTALK_P4_ALLOWED_USER_IDS, DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS,
  DINGTALK_P4_PERSON_USER_IDS, DINGTALK_P4_AUTHORIZED_USER_ID,
  DINGTALK_P4_UNAUTHORIZED_USER_ID, DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseEnvFile(file) {
  const resolved = path.resolve(process.cwd(), file)
  if (!existsSync(resolved)) {
    throw new Error(`--env-file does not exist: ${file}`)
  }

  const values = {}
  const content = readFileSync(resolved, 'utf8')
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      throw new Error(`invalid env line ${index + 1} in ${file}`)
    }
    const [, key, rawValue] = match
    values[key] = unquoteEnvValue(rawValue.trim())
  }
  return values
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function envValue(source, ...names) {
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function splitList(value) {
  if (!value) return []
  return Array.from(new Set(
    String(value)
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
}

function appendList(list, value) {
  for (const entry of splitList(value)) {
    if (!list.includes(entry)) list.push(entry)
  }
}

function parseArgs(argv) {
  let envFile = ''
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-file') {
      envFile = readRequiredValue(argv, i, '--env-file')
      break
    }
  }

  const envFileValues = envFile ? parseEnvFile(envFile) : {}
  const env = { ...envFileValues, ...process.env }
  const opts = {
    envFile,
    apiBase: envValue(env, 'DINGTALK_P4_API_BASE', 'API_BASE') || DEFAULT_API_BASE,
    webBase: envValue(env, 'DINGTALK_P4_WEB_BASE', 'WEB_BASE', 'PUBLIC_APP_URL'),
    authToken: envValue(env, 'DINGTALK_P4_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    groupAWebhook: envValue(env, 'DINGTALK_P4_GROUP_A_WEBHOOK', 'DINGTALK_GROUP_A_WEBHOOK'),
    groupBWebhook: envValue(env, 'DINGTALK_P4_GROUP_B_WEBHOOK', 'DINGTALK_GROUP_B_WEBHOOK'),
    groupASecret: envValue(env, 'DINGTALK_P4_GROUP_A_SECRET', 'DINGTALK_GROUP_A_SECRET'),
    groupBSecret: envValue(env, 'DINGTALK_P4_GROUP_B_SECRET', 'DINGTALK_GROUP_B_SECRET'),
    allowedUserIds: splitList(envValue(env, 'DINGTALK_P4_ALLOWED_USER_IDS', 'DINGTALK_P4_ALLOWED_USER_ID')),
    allowedMemberGroupIds: splitList(envValue(env, 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS', 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_ID')),
    personUserIds: splitList(envValue(env, 'DINGTALK_P4_PERSON_USER_IDS', 'DINGTALK_P4_PERSON_USER_ID')),
    authorizedUserId: envValue(env, 'DINGTALK_P4_AUTHORIZED_USER_ID'),
    unauthorizedUserId: envValue(env, 'DINGTALK_P4_UNAUTHORIZED_USER_ID'),
    noEmailDingTalkExternalId: envValue(env, 'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID'),
    requireManualTargets: false,
    requirePersonUser: false,
    outputDir: null,
    timeoutMs: 10_000,
    skipApi: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--env-file':
        i += 1
        break
      case '--api-base':
        opts.apiBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--web-base':
        opts.webBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-webhook':
        opts.groupAWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-webhook':
        opts.groupBWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-secret':
        opts.groupASecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-secret':
        opts.groupBSecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--allowed-user':
        appendList(opts.allowedUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allowed-member-group':
        appendList(opts.allowedMemberGroupIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--person-user':
        appendList(opts.personUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--authorized-user':
        opts.authorizedUserId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--unauthorized-user':
        opts.unauthorizedUserId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--no-email-dingtalk-external-id':
        opts.noEmailDingTalkExternalId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--require-manual-targets':
        opts.requireManualTargets = true
        break
      case '--require-person-user':
        opts.requirePersonUser = true
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number.parseInt(readRequiredValue(argv, i, arg), 10)
        i += 1
        break
      case '--skip-api':
        opts.skipApi = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function makeRunId() {
  return `dingtalk-p4-preflight-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function normalizeUrl(value) {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function redactString(value) {
  return String(value)
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function maskedWebhook(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    for (const key of Array.from(url.searchParams.keys())) {
      if (['access_token', 'sign', 'timestamp'].includes(key.toLowerCase())) {
        url.searchParams.set(key, '<redacted>')
      }
    }
    return redactString(url.toString())
  } catch {
    return '<invalid-url>'
  }
}

function addCheck(summary, id, label, status, details = {}) {
  summary.checks.push({
    id,
    label,
    status,
    details,
  })
}

function apiBasePath(value) {
  try {
    return new URL(value).pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function healthUrlCandidates(apiBase) {
  const routes = ['/health']
  const basePath = apiBasePath(apiBase)
  if (basePath && basePath !== '/' && basePath !== '/health') {
    routes.push(`${basePath}/health`)
  }
  return routes.map((route) => new URL(route, apiBase))
}

function authMeUrlCandidates(apiBase) {
  const routes = ['/api/auth/me']
  const basePath = apiBasePath(apiBase)
  if (basePath && basePath !== '/') {
    routes.push(`${basePath}/auth/me`)
  }
  return Array.from(new Set(routes)).map((route) => new URL(route, apiBase))
}

function checkStatus(summary, id) {
  return summary.checks.find((check) => check.id === id)?.status
}

function hasFailure(summary) {
  return summary.checks.some((check) => check.status === 'fail')
}

function validateBaseUrls(opts, summary) {
  try {
    opts.apiBase = normalizeUrl(opts.apiBase)
    addCheck(summary, 'api-base-valid', 'Backend API base URL is valid', 'pass', { apiBase: opts.apiBase })
  } catch {
    addCheck(summary, 'api-base-valid', 'Backend API base URL is valid', 'fail', { apiBase: '<invalid>' })
  }

  if (!opts.webBase) {
    addCheck(summary, 'web-base-present', 'Public web base is present for DingTalk message links', 'fail', {
      notes: 'Set DINGTALK_P4_WEB_BASE, WEB_BASE, or PUBLIC_APP_URL.',
    })
    return
  }

  try {
    opts.webBase = normalizeUrl(opts.webBase)
    addCheck(summary, 'web-base-present', 'Public web base is present for DingTalk message links', 'pass', { webBase: opts.webBase })
  } catch {
    addCheck(summary, 'web-base-present', 'Public web base is present for DingTalk message links', 'fail', { webBase: '<invalid>' })
  }
}

function validateAuth(opts, summary) {
  addCheck(summary, 'auth-token-present', 'Admin/table-owner bearer token is present', opts.authToken ? 'pass' : 'fail', {
    present: Boolean(opts.authToken),
  })
}

function validateWebhook(value, label) {
  if (!value) return `${label} is required`
  let url
  try {
    url = new URL(value)
  } catch {
    return `${label} must be a valid URL`
  }
  if (url.protocol !== 'https:') {
    return `${label} must use HTTPS`
  }
  if (url.hostname !== 'oapi.dingtalk.com' || url.pathname !== '/robot/send') {
    return `${label} must be a DingTalk robot URL from https://oapi.dingtalk.com/robot/send`
  }
  if (!url.searchParams.get('access_token')?.trim()) {
    return `${label} must include access_token`
  }
  return ''
}

function validateWebhooks(opts, summary) {
  const failures = [
    validateWebhook(opts.groupAWebhook, 'group A webhook'),
    validateWebhook(opts.groupBWebhook, 'group B webhook'),
  ].filter(Boolean)

  addCheck(summary, 'group-webhooks-valid', 'Two DingTalk group robot webhooks are present and well formed', failures.length ? 'fail' : 'pass', {
    failures,
    groupAWebhook: maskedWebhook(opts.groupAWebhook),
    groupBWebhook: maskedWebhook(opts.groupBWebhook),
  })
}

function validateSecret(value, label) {
  if (!value) return ''
  return /^SEC[A-Za-z0-9+/=_-]{8,}$/.test(value) ? '' : `${label} must look like SEC...`
}

function validateSecrets(opts, summary) {
  const failures = [
    validateSecret(opts.groupASecret, 'group A secret'),
    validateSecret(opts.groupBSecret, 'group B secret'),
  ].filter(Boolean)
  addCheck(summary, 'group-secrets-valid', 'Optional DingTalk robot secrets are valid when supplied', failures.length ? 'fail' : 'pass', {
    failures,
    groupASecretPresent: Boolean(opts.groupASecret),
    groupBSecretPresent: Boolean(opts.groupBSecret),
  })
}

function validateAllowlist(opts, summary) {
  const allowedUserCount = opts.allowedUserIds.length
  const allowedMemberGroupCount = opts.allowedMemberGroupIds.length
  addCheck(summary, 'allowlist-present', 'At least one local user or member group is allowlisted', allowedUserCount + allowedMemberGroupCount > 0 ? 'pass' : 'fail', {
    allowedUserCount,
    allowedMemberGroupCount,
  })
  addCheck(summary, 'person-smoke-input', 'DingTalk person smoke recipients are declared', opts.personUserIds.length > 0 ? 'pass' : opts.requirePersonUser ? 'fail' : 'skipped', {
    personUserCount: opts.personUserIds.length,
    notes: opts.personUserIds.length > 0
      ? 'Person delivery can be bootstrapped by the API runner.'
      : opts.requirePersonUser
        ? 'Set --person-user or DINGTALK_P4_PERSON_USER_IDS before final release smoke; delivery-history-group-person is required.'
        : 'Person delivery will remain pending until --person-user is supplied or manual evidence is filled.',
  })
}

function manualTargets(opts) {
  return {
    authorizedUserId: opts.authorizedUserId || opts.allowedUserIds[0] || '',
    unauthorizedUserId: opts.unauthorizedUserId || '',
    noEmailDingTalkExternalId: opts.noEmailDingTalkExternalId || '',
  }
}

function validateManualTargets(opts, summary) {
  const targets = manualTargets(opts)
  const missing = []
  if (!targets.authorizedUserId) missing.push('authorized user')
  if (!targets.unauthorizedUserId) missing.push('unauthorized user')
  if (!targets.noEmailDingTalkExternalId) missing.push('no-email DingTalk external id')

  addCheck(
    summary,
    'manual-targets-declared',
    'Manual DingTalk-client/admin target identities are declared',
    missing.length === 0 ? 'pass' : opts.requireManualTargets ? 'fail' : 'skipped',
    {
      ...targets,
      missing,
      notes: missing.length === 0
        ? 'Manual evidence checklist can name each operator target.'
        : 'Set manual target env values before final release smoke to avoid ambiguous screenshots.',
    },
  )
}

function validateLocalFiles(summary) {
  const missing = REQUIRED_LOCAL_FILES.filter((file) => !existsSync(path.resolve(process.cwd(), file)))
  addCheck(summary, 'local-tools-present', 'Remote-smoke docs and runner scripts are present', missing.length ? 'fail' : 'pass', {
    requiredFiles: REQUIRED_LOCAL_FILES,
    missing,
  })
}

async function validateApiHealth(opts, summary) {
  if (opts.skipApi) {
    addCheck(summary, 'api-health', 'Backend /health is reachable', 'skipped', { notes: '--skip-api was set' })
    return
  }

  if (summary.checks.some((check) => check.id === 'api-base-valid' && check.status === 'fail')) {
    addCheck(summary, 'api-health', 'Backend /health is reachable', 'skipped', { notes: 'api-base-valid failed' })
    return
  }

  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 120_000) {
    addCheck(summary, 'api-health', 'Backend /health is reachable', 'fail', { notes: '--timeout-ms must be an integer between 1000 and 120000' })
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
  const healthUrls = healthUrlCandidates(opts.apiBase)
  let lastFailure = null
  try {
    for (const url of healthUrls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        const text = await response.text()
        if (text) JSON.parse(text)
        if (response.status === 200 || response.status === 204) {
          addCheck(summary, 'api-health', 'Backend /health is reachable', 'pass', {
            statusCode: response.status,
            url: url.toString(),
          })
          return
        }
        lastFailure = { statusCode: response.status, url: url.toString() }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastFailure = {
          url: url.toString(),
          error: redactString(message),
        }
      }
    }
    addCheck(summary, 'api-health', 'Backend /health is reachable', 'fail', lastFailure ?? {
      url: healthUrls[0]?.toString() ?? '',
      error: 'health check failed',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addCheck(summary, 'api-health', 'Backend /health is reachable', 'fail', {
      url: healthUrls[0]?.toString() ?? '',
      error: redactString(message),
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function validateAuthToken(opts, summary) {
  if (opts.skipApi) {
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'skipped', { notes: '--skip-api was set' })
    return
  }

  if (checkStatus(summary, 'api-base-valid') === 'fail') {
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'skipped', { notes: 'api-base-valid failed' })
    return
  }

  if (checkStatus(summary, 'auth-token-present') !== 'pass') {
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'skipped', { notes: 'auth-token-present failed' })
    return
  }

  if (checkStatus(summary, 'api-health') !== 'pass') {
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'skipped', { notes: 'api-health did not pass' })
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
  const authUrls = authMeUrlCandidates(opts.apiBase)
  let lastFailure = null
  try {
    for (const url of authUrls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${opts.authToken}`,
          },
          signal: controller.signal,
        })
        let payload = null
        const text = await response.text()
        if (text) {
          try {
            payload = JSON.parse(text)
          } catch {
            payload = null
          }
        }

        const authenticated = response.status === 200 && payload && payload.success !== false && payload.ok !== false
        if (authenticated) {
          addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'pass', {
            statusCode: response.status,
            url: url.toString(),
            role: typeof payload.role === 'string' ? payload.role : undefined,
            plm: typeof payload.plm === 'boolean' ? payload.plm : undefined,
          })
          return
        }

        const failure = {
          statusCode: response.status,
          url: url.toString(),
          error: response.status === 401
            ? 'Invalid token'
            : response.status === 403
              ? 'Forbidden token'
              : 'auth check failed',
        }
        lastFailure = failure
        if (response.status === 401 || response.status === 403) {
          addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'fail', failure)
          return
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastFailure = {
          url: url.toString(),
          error: redactString(message),
        }
      }
    }
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'fail', lastFailure ?? {
      url: authUrls[0]?.toString() ?? '',
      error: 'auth check failed',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addCheck(summary, 'auth-token-valid', 'Admin/table-owner bearer token can authenticate', 'fail', {
      url: authUrls[0]?.toString() ?? '',
      error: redactString(message),
    })
  } finally {
    clearTimeout(timeout)
  }
}

function renderMarkdown(summary) {
  const rows = summary.checks.map((check) => {
    const notes = check.details?.notes ?? check.details?.error ?? (Array.isArray(check.details?.failures) ? check.details.failures.join('; ') : '')
    return `| \`${check.id}\` | ${check.label} | ${check.status} | ${String(notes ?? '').replaceAll('|', '\\|')} |`
  })
  const failed = summary.checks.filter((check) => check.status === 'fail')
  return `# DingTalk P4 Smoke Preflight Summary

Generated at: ${summary.generatedAt}

Overall status: **${summary.overallStatus}**

## Checks

| ID | Check | Status | Notes |
| --- | --- | --- | --- |
${rows.join('\n')}

## Next Steps

${failed.length
    ? failed.map((check) => `- Fix \`${check.id}\` before running \`dingtalk-p4-remote-smoke.mjs\`.`).join('\n')
    : '- Run `node scripts/ops/dingtalk-p4-remote-smoke.mjs --output-dir <run-dir>` with the same inputs.'}
- Complete real DingTalk-client evidence before compiling with \`--strict\`.

## Secret Handling

- This preflight does not call DingTalk webhooks.
- Bearer tokens, webhook access tokens, signatures, timestamps, SEC secrets, JWTs, public form tokens, and passwords must not be pasted into reports.
`
}

function writeOutputs(summary, outputDir) {
  mkdirSync(outputDir, { recursive: true })
  const jsonPath = path.join(outputDir, 'preflight-summary.json')
  const mdPath = path.join(outputDir, 'preflight-summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, `${renderMarkdown(summary)}\n`, 'utf8')
  return { jsonPath, mdPath }
}

async function runPreflight(opts) {
  const runId = makeRunId()
  const summary = {
    tool: 'dingtalk-p4-smoke-preflight',
    runId,
    generatedAt: new Date().toISOString(),
    environment: {
      apiBase: '',
      webBase: '',
      authTokenPresent: false,
      groupASecretPresent: false,
      groupBSecretPresent: false,
      allowedUserCount: 0,
      allowedMemberGroupCount: 0,
      personUserCount: 0,
      manualTargets: {},
    },
    checks: [],
    overallStatus: 'fail',
  }

  validateLocalFiles(summary)
  validateBaseUrls(opts, summary)
  validateAuth(opts, summary)
  validateWebhooks(opts, summary)
  validateSecrets(opts, summary)
  validateAllowlist(opts, summary)
  validateManualTargets(opts, summary)
  await validateApiHealth(opts, summary)
  await validateAuthToken(opts, summary)

  summary.environment = {
    apiBase: opts.apiBase,
    webBase: opts.webBase || '',
    authTokenPresent: Boolean(opts.authToken),
    groupAWebhook: maskedWebhook(opts.groupAWebhook),
    groupBWebhook: maskedWebhook(opts.groupBWebhook),
    groupASecretPresent: Boolean(opts.groupASecret),
    groupBSecretPresent: Boolean(opts.groupBSecret),
    allowedUserCount: opts.allowedUserIds.length,
    allowedMemberGroupCount: opts.allowedMemberGroupIds.length,
    personUserCount: opts.personUserIds.length,
    manualTargets: manualTargets(opts),
  }
  summary.overallStatus = hasFailure(summary) ? 'fail' : 'pass'

  const outputDir = opts.outputDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, runId)
  const written = writeOutputs(summary, outputDir)
  console.log(`Wrote ${path.relative(process.cwd(), written.jsonPath).replaceAll('\\', '/')}`)
  console.log(`Wrote ${path.relative(process.cwd(), written.mdPath).replaceAll('\\', '/')}`)

  return summary
}

try {
  const opts = parseArgs(process.argv.slice(2))
  const summary = await runPreflight(opts)
  if (summary.overallStatus !== 'pass') process.exit(1)
} catch (error) {
  console.error(`[dingtalk-p4-smoke-preflight] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
