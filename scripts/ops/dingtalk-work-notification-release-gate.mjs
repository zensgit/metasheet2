#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const DEFAULT_OUTPUT_DIR = 'output/dingtalk-work-notification-release-gate'
const DEFAULT_STATUS_HELPER = 'scripts/ops/dingtalk-work-notification-env-status.mjs'
const SCHEMA_VERSION = 1
const DINGTALK_ROBOT_WEBHOOK_RE = new RegExp(
  `https://${'oapi.dingtalk.com'.replaceAll('.', '\\.')}/robot/send\\?${'access' + '_token'}=[A-Za-z0-9._~-]+`,
  'gi',
)

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-work-notification-release-gate.mjs [options]

Runs a redaction-safe release gate for DingTalk work notifications. The gate is
read-only: it checks env readiness, backend health, admin auth, and the admin
workNotification runtime status API. It does not call DingTalk and does not send
messages.

Options:
  --env-file <file>              Env file for env-status helper; repeatable
  --status-helper <file>         Env-status helper, default ${DEFAULT_STATUS_HELPER}
  --api-base <url>               Backend API base, default ${DEFAULT_API_BASE}
  --auth-token <token>           Bearer token, never printed or written
  --auth-token-file <file>       File containing bearer token
  --user-id <id>                 User id for /api/admin/users/:id/dingtalk-access
  --output-json <file>           Output JSON path, default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>             Output Markdown path, default ${DEFAULT_OUTPUT_DIR}/summary.md
  --timeout-ms <ms>              HTTP timeout, default 10000
  --skip-admin-api               Only run env-status and health checks
  --allow-blocked                Exit 0 even when the gate is blocked
  --help                         Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseBoundedInteger(value, flag, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function parseArgs(argv) {
  const opts = {
    envFiles: [],
    statusHelper: path.resolve(process.cwd(), DEFAULT_STATUS_HELPER),
    apiBase: DEFAULT_API_BASE,
    authToken: '',
    authTokenFile: '',
    userId: '',
    outputJson: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.md'),
    timeoutMs: 10_000,
    skipAdminApi: false,
    allowBlocked: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--env-file':
        opts.envFiles.push(path.resolve(process.cwd(), readRequiredValue(argv, index, arg)))
        index += 1
        break
      case '--status-helper':
        opts.statusHelper = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--api-base':
        opts.apiBase = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--auth-token-file':
        opts.authTokenFile = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--user-id':
        opts.userId = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--output-json':
        opts.outputJson = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--output-md':
        opts.outputMd = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
        index += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = parseBoundedInteger(readRequiredValue(argv, index, arg), arg, 100, 120_000)
        index += 1
        break
      case '--skip-admin-api':
        opts.skipAdminApi = true
        break
      case '--allow-blocked':
        opts.allowBlocked = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (opts.authTokenFile && !opts.authToken) opts.authToken = readTokenFile(opts.authTokenFile)
  if (!opts.skipAdminApi && !opts.authToken) throw new Error('--auth-token or --auth-token-file is required unless --skip-admin-api is used')
  if (!opts.skipAdminApi && !opts.userId) throw new Error('--user-id is required unless --skip-admin-api is used')
  opts.apiBase = normalizeApiBase(opts.apiBase)

  return opts
}

function readTokenFile(file) {
  if (!existsSync(file)) throw new Error(`auth token file not found: ${file}`)
  const token = readFileSync(file, 'utf8').trim()
  if (!token) throw new Error(`auth token file is empty: ${file}`)
  return token
}

function normalizeApiBase(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(trimmed)) throw new Error('--api-base must start with http:// or https://')
  return trimmed
}

function relativePath(file) {
  if (!file) return ''
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value ?? '')
    .replace(DINGTALK_ROBOT_WEBHOOK_RE, '<dingtalk-robot-webhook-redacted>')
    .replace(new RegExp(`${'access' + '_token'}=[A-Za-z0-9._~-]{8,}`, 'gi'), 'access_token=<redacted>')
    .replace(/SEC[A-Za-z0-9+/=_-]{8,}/g, 'SEC<redacted>')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '<jwt-redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>')
}

function redactDeep(value) {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]))
  }
  return value
}

function addFailure(failures, code, message, detail = {}) {
  failures.push({ code, message, detail: redactDeep(detail) })
}

function runEnvStatus(opts) {
  const statusOutputJson = path.join(path.dirname(opts.outputJson), 'env-status.json')
  const statusOutputMd = path.join(path.dirname(opts.outputMd), 'env-status.md')
  const args = [
    opts.statusHelper,
    ...opts.envFiles.flatMap((file) => ['--env-file', file]),
    '--allow-blocked',
    '--output-json',
    statusOutputJson,
    '--output-md',
    statusOutputMd,
  ]
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' })
  let summary = null
  if (existsSync(statusOutputJson)) {
    try {
      summary = JSON.parse(readFileSync(statusOutputJson, 'utf8'))
    } catch {
      summary = null
    }
  }
  return {
    command: [
      'node',
      relativePath(opts.statusHelper),
      ...opts.envFiles.flatMap((file) => ['--env-file', relativePath(file)]),
      '--allow-blocked',
      '--output-json',
      relativePath(statusOutputJson),
      '--output-md',
      relativePath(statusOutputMd),
    ].join(' '),
    exitCode: typeof result.status === 'number' ? result.status : 1,
    stdoutLength: result.stdout?.length ?? 0,
    stderrLength: result.stderr?.length ?? 0,
    outputJson: relativePath(statusOutputJson),
    outputMd: relativePath(statusOutputMd),
    overallStatus: typeof summary?.overallStatus === 'string' ? summary.overallStatus : '',
    missingInputs: Array.isArray(summary?.missingInputs)
      ? summary.missingInputs.map((item) => ({ id: String(item?.id ?? '') })).filter((item) => item.id)
      : [],
    requirements: summary?.requirements ? redactDeep(summary.requirements) : {},
  }
}

async function fetchJson(opts, pathname, token = '') {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
  const url = `${opts.apiBase}${pathname}`
  try {
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetch(url, { headers, signal: controller.signal })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: redactString(text.slice(0, 500)) }
    }
    return {
      ok: response.ok,
      status: response.status,
      body: redactDeep(body),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: redactString(error instanceof Error ? error.message : String(error)) },
    }
  } finally {
    clearTimeout(timeout)
  }
}

function readHealthResult(result) {
  return {
    ok: result.ok && (
      result.body?.ok === true
      || result.body?.success === true
      || result.body?.status === 'ok'
    ),
    status: result.status,
    bodyStatus: result.body?.status ?? '',
    success: result.body?.success === true || result.body?.ok === true,
  }
}

function readAuthResult(result) {
  const user = result.body?.user || result.body?.data?.user || result.body?.data || {}
  return {
    ok: result.ok && (result.body?.success === true || result.body?.ok === true),
    status: result.status,
    role: user.role || result.body?.role || '',
    emailPresent: Boolean(user.email || result.body?.email),
  }
}

function readWorkNotificationResult(result) {
  const workNotification = result.body?.workNotification || result.body?.data?.workNotification || null
  return {
    ok: result.ok && Boolean(workNotification),
    status: result.status,
    available: workNotification?.available === true,
    configured: workNotification?.configured === true,
    unavailableReason: workNotification?.unavailableReason || '',
    requirements: redactDeep(workNotification?.requirements || {}),
  }
}

async function runGate(opts) {
  const failures = []
  const envStatus = runEnvStatus(opts)
  if (envStatus.exitCode !== 0) {
    addFailure(failures, 'ENV_STATUS_HELPER_FAILED', 'Env status helper failed', { exitCode: envStatus.exitCode })
  }
  if (envStatus.overallStatus !== 'ready') {
    addFailure(failures, 'ENV_STATUS_BLOCKED', 'DingTalk work-notification env status is not ready', {
      overallStatus: envStatus.overallStatus,
      missingInputs: envStatus.missingInputs.map((item) => item.id),
    })
  }

  const healthResult = readHealthResult(await fetchJson(opts, '/api/health'))
  if (!healthResult.ok) {
    addFailure(failures, 'HEALTH_CHECK_FAILED', 'Backend health check did not pass', healthResult)
  }

  let auth = { skipped: opts.skipAdminApi }
  let workNotification = { skipped: opts.skipAdminApi }
  if (!opts.skipAdminApi) {
    auth = readAuthResult(await fetchJson(opts, '/api/auth/me', opts.authToken))
    if (!auth.ok) addFailure(failures, 'AUTH_ME_FAILED', 'Admin auth probe failed', auth)

    workNotification = readWorkNotificationResult(await fetchJson(
      opts,
      `/api/admin/users/${encodeURIComponent(opts.userId)}/dingtalk-access`,
      opts.authToken,
    ))
    if (!workNotification.ok) {
      addFailure(failures, 'WORK_NOTIFICATION_STATUS_FAILED', 'Admin DingTalk workNotification status API failed', workNotification)
    } else if (!workNotification.available) {
      addFailure(failures, 'WORK_NOTIFICATION_UNAVAILABLE', 'Admin DingTalk workNotification status is unavailable', {
        unavailableReason: workNotification.unavailableReason,
      })
    }
  }

  return {
    tool: 'dingtalk-work-notification-release-gate',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: failures.length === 0 ? 'pass' : 'blocked',
    apiBase: opts.apiBase,
    envFiles: opts.envFiles.map(relativePath),
    authTokenPresent: Boolean(opts.authToken),
    authTokenFile: opts.authTokenFile ? relativePath(opts.authTokenFile) : '',
    userId: opts.userId || '',
    skipAdminApi: opts.skipAdminApi,
    envStatus,
    health: healthResult,
    auth,
    workNotification,
    failures,
    nextCommands: failures.length === 0
      ? [
          'Run a controlled DingTalk group failure and verify the rule creator receives a work notification.',
          'Run scripts/ops/dingtalk-group-failure-alert-probe.mjs with --acceptance --expect-person-status success.',
        ]
      : [
          'Resolve the listed failures, then rerun this release gate.',
          'If ENV_STATUS_BLOCKED reports agent-id-present, fill the private agent id file and run the apply helper.',
        ],
    notes: [
      'This gate is read-only and does not call DingTalk or send messages.',
      'Bearer token and credential values are never written to summaries.',
    ],
  }
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk Work Notification Release Gate',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Status: \`${summary.status}\``,
    `- API Base: \`${summary.apiBase}\``,
    `- Env Files: ${summary.envFiles.length ? summary.envFiles.map((file) => `\`${file}\``).join(', ') : '`<none>`'}`,
    `- Admin API Skipped: \`${summary.skipAdminApi}\``,
    '',
    '## Checks',
    '',
    `- Env Status: \`${summary.envStatus.overallStatus || '<unknown>'}\``,
    `- Health: \`${summary.health.ok}\` (status ${summary.health.status})`,
    `- Auth: \`${summary.auth.skipped ? 'skipped' : summary.auth.ok}\``,
    `- Work Notification Available: \`${summary.workNotification.skipped ? 'skipped' : summary.workNotification.available}\``,
    '',
  ]

  if (summary.failures.length > 0) {
    lines.push('## Failures', '')
    for (const failure of summary.failures) {
      lines.push(`- \`${failure.code}\`: ${failure.message}`)
    }
    lines.push('')
  }

  lines.push('## Evidence', '')
  lines.push(`- Env Status JSON: \`${summary.envStatus.outputJson}\``)
  lines.push(`- Env Status MD: \`${summary.envStatus.outputMd}\``)
  if (!summary.workNotification.skipped) {
    lines.push(`- Work Notification Reason: \`${summary.workNotification.unavailableReason || '<none>'}\``)
  }

  lines.push('', '## Next Commands', '')
  for (const command of summary.nextCommands) lines.push(`- ${command}`)

  lines.push('', '## Notes', '')
  for (const note of summary.notes) lines.push(`- ${note}`)

  return `${lines.join('\n')}\n`
}

function writeOutputs(opts, summary) {
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(redactDeep(summary), null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(redactDeep(summary)), 'utf8')
}

try {
  const opts = parseArgs(process.argv.slice(2))
  const summary = await runGate(opts)
  writeOutputs(opts, summary)
  console.log(`DingTalk work-notification release gate: ${summary.status}; summary=${relativePath(opts.outputMd)}`)
  if (summary.status !== 'pass' && !opts.allowBlocked) process.exitCode = 1
} catch (error) {
  console.error(redactString(error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
