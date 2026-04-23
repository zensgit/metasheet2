#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_ENV_FILE = path.join(homedir(), '.config', 'yuantus', 'dingtalk-p4-staging.env')
const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-env-readiness'
const DEFAULT_API_BASE = 'http://142.171.239.56:8900'
const DEFAULT_WEB_BASE = 'http://142.171.239.56:8081'

const P4_ENV_KEYS = [
  'DINGTALK_P4_API_BASE',
  'DINGTALK_P4_WEB_BASE',
  'DINGTALK_P4_AUTH_TOKEN',
  'DINGTALK_P4_GROUP_A_WEBHOOK',
  'DINGTALK_P4_GROUP_B_WEBHOOK',
  'DINGTALK_P4_GROUP_A_SECRET',
  'DINGTALK_P4_GROUP_B_SECRET',
  'DINGTALK_P4_ALLOWED_USER_IDS',
  'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS',
  'DINGTALK_P4_PERSON_USER_IDS',
  'DINGTALK_P4_AUTHORIZED_USER_ID',
  'DINGTALK_P4_UNAUTHORIZED_USER_ID',
  'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID',
]

const P4_ENV_KEY_SET = new Set(P4_ENV_KEYS)

const SECRET_KEYS = new Set([
  'DINGTALK_P4_AUTH_TOKEN',
  'DINGTALK_P4_GROUP_A_WEBHOOK',
  'DINGTALK_P4_GROUP_B_WEBHOOK',
  'DINGTALK_P4_GROUP_A_SECRET',
  'DINGTALK_P4_GROUP_B_SECRET',
])

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-env-bootstrap.mjs [options]

Creates and checks the private DingTalk P4 staging env file used by the final
remote smoke. The env file lives outside git by default and reports never write
raw bearer tokens, robot webhooks, SEC secrets, or public form tokens.

Options:
  --init                    Create a private env template
  --check                   Check env readiness and write redacted reports
  --p4-env-file <file>      Env file path, default ${DEFAULT_ENV_FILE}
  --output-dir <dir>        Report output dir, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --api-base <url>          Template API base, default ${DEFAULT_API_BASE}
  --web-base <url>          Template web base, default ${DEFAULT_WEB_BASE}
  --set <KEY=VALUE>         Safely update one known P4 env key without echoing the value
  --set-from-env <KEY>      Copy one known P4 env key from the current process environment
  --unset <KEY>             Clear one known P4 env key
  --force                   Allow --init to overwrite an existing env file
  --help                    Show this help

Typical flow:
  node scripts/ops/dingtalk-p4-env-bootstrap.mjs --init
  # Fill ${DEFAULT_ENV_FILE} outside git.
  node scripts/ops/dingtalk-p4-env-bootstrap.mjs --check
  # Or safely update fields without printing raw secret values:
  DINGTALK_P4_AUTH_TOKEN=... node scripts/ops/dingtalk-p4-env-bootstrap.mjs --set-from-env DINGTALK_P4_AUTH_TOKEN
  node scripts/ops/dingtalk-p4-smoke-session.mjs --env-file ${DEFAULT_ENV_FILE} --require-manual-targets --output-dir output/dingtalk-p4-remote-smoke-session/142-session
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    init: false,
    check: false,
    envFile: DEFAULT_ENV_FILE,
    outputDir: null,
    apiBase: DEFAULT_API_BASE,
    webBase: DEFAULT_WEB_BASE,
    force: false,
    set: [],
    setFromEnv: [],
    unset: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--init':
        opts.init = true
        break
      case '--check':
        opts.check = true
        break
      case '--p4-env-file':
      case '--env-file':
        opts.envFile = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
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
      case '--set':
        opts.set.push(parseEnvAssignment(readRequiredValue(argv, i, arg)))
        i += 1
        break
      case '--set-from-env':
        opts.setFromEnv.push(validateP4EnvKey(readRequiredValue(argv, i, arg), arg))
        i += 1
        break
      case '--unset':
        opts.unset.push(validateP4EnvKey(readRequiredValue(argv, i, arg), arg))
        i += 1
        break
      case '--force':
        opts.force = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.init && !opts.check && opts.set.length === 0 && opts.setFromEnv.length === 0 && opts.unset.length === 0) {
    throw new Error('expected --init, --check, --set, --set-from-env, or --unset')
  }

  return opts
}

function validateP4EnvKey(key, flag = '--set') {
  if (!P4_ENV_KEY_SET.has(key)) {
    throw new Error(`${flag} only supports known DingTalk P4 env keys: ${P4_ENV_KEYS.join(', ')}`)
  }
  return key
}

function parseEnvAssignment(raw) {
  const equalsIndex = raw.indexOf('=')
  if (equalsIndex <= 0) {
    throw new Error('--set expects KEY=VALUE')
  }
  const key = validateP4EnvKey(raw.slice(0, equalsIndex), '--set')
  return { key, value: raw.slice(equalsIndex + 1) }
}

function makeRunId() {
  return `dingtalk-p4-env-readiness-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function quoteEnv(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function renderTemplate(opts) {
  return `# DingTalk P4 staging smoke env
# Contains real secrets. Do not commit.
# Generated by scripts/ops/dingtalk-p4-env-bootstrap.mjs

DINGTALK_P4_API_BASE=${quoteEnv(opts.apiBase)}
DINGTALK_P4_WEB_BASE=${quoteEnv(opts.webBase)}

# Admin/table-owner bearer token for the staging backend.
DINGTALK_P4_AUTH_TOKEN=""

# Two independent DingTalk robot webhooks.
# Required URL shape: https://oapi.dingtalk.com/robot/send?access_token=...
# Keep full URLs only in this private file.
DINGTALK_P4_GROUP_A_WEBHOOK=""
DINGTALK_P4_GROUP_B_WEBHOOK=""

# Optional DingTalk SEC... signing secrets for the two robot webhooks.
DINGTALK_P4_GROUP_A_SECRET=""
DINGTALK_P4_GROUP_B_SECRET=""

# Local IDs used by dingtalk_granted form access and delivery checks.
DINGTALK_P4_ALLOWED_USER_IDS=""
DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS=""
DINGTALK_P4_PERSON_USER_IDS=""

# Manual DingTalk-client/admin target identities for final screenshots.
# If DINGTALK_P4_AUTHORIZED_USER_ID is blank, the first allowed user is used.
DINGTALK_P4_AUTHORIZED_USER_ID=""
DINGTALK_P4_UNAUTHORIZED_USER_ID=""
DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID=""
`
}

function initEnv(opts) {
  if (existsSync(opts.envFile) && !opts.force) {
    throw new Error(`env file already exists: ${opts.envFile}; pass --force to overwrite`)
  }
  mkdirSync(path.dirname(opts.envFile), { recursive: true })
  writeFileSync(opts.envFile, renderTemplate(opts), { encoding: 'utf8', mode: 0o600 })
  chmodSync(opts.envFile, 0o600)
  console.log(`[dingtalk-p4-env-bootstrap] wrote private env template: ${opts.envFile}`)
}

function collectUpdates(opts) {
  const updates = new Map()
  for (const { key, value } of opts.set) {
    updates.set(key, value)
  }
  for (const key of opts.setFromEnv) {
    if (process.env[key] === undefined) {
      throw new Error(`--set-from-env ${key} is not present in the process environment`)
    }
    updates.set(key, process.env[key] ?? '')
  }
  for (const key of opts.unset) {
    updates.set(key, '')
  }
  return updates
}

function summarizeUpdateValue(key, value) {
  if (!value) return 'blank'
  const listKeys = new Set([
    'DINGTALK_P4_ALLOWED_USER_IDS',
    'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS',
    'DINGTALK_P4_PERSON_USER_IDS',
  ])
  if (listKeys.has(key)) return `${splitList(value).length} entries`
  if (SECRET_KEYS.has(key)) return `<redacted>, ${value.length} chars`
  return `set, ${value.length} chars`
}

function renderEnvLine(key, value) {
  return `${key}=${quoteEnv(value)}`
}

function updateEnv(opts) {
  const updates = collectUpdates(opts)
  if (updates.size === 0) return
  if (!existsSync(opts.envFile)) {
    throw new Error(`env file does not exist: ${opts.envFile}; run --init first`)
  }

  const content = readFileSync(opts.envFile, 'utf8')
  const lines = content.replace(/\r?\n$/, '').split(/\r?\n/)
  const remaining = new Map(updates)
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match || !remaining.has(match[1])) return line
    const key = match[1]
    const value = remaining.get(key)
    remaining.delete(key)
    return renderEnvLine(key, value)
  })

  if (remaining.size > 0 && nextLines.some((line) => line.trim())) {
    nextLines.push('')
  }
  for (const [key, value] of remaining.entries()) {
    nextLines.push(renderEnvLine(key, value))
  }

  writeFileSync(opts.envFile, `${nextLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(opts.envFile, 0o600)

  console.log(`[dingtalk-p4-env-bootstrap] updated private env: ${opts.envFile}`)
  for (const [key, value] of updates.entries()) {
    console.log(`- ${key}: ${summarizeUpdateValue(key, value)}`)
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseEnvFile(file) {
  if (!existsSync(file)) {
    throw new Error(`env file does not exist: ${file}`)
  }

  const values = {}
  const content = readFileSync(file, 'utf8')
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

function splitList(value) {
  if (!value) return []
  return Array.from(new Set(
    String(value)
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
}

function envValue(values, key) {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : ''
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

function redactValue(key, value) {
  if (SECRET_KEYS.has(key)) {
    if (!value) return ''
    if (key.includes('WEBHOOK')) return redactString(value)
    if (key.includes('SECRET')) return 'SEC<redacted>'
    return '<redacted>'
  }
  return redactString(value)
}

function safeUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isValidRobotWebhook(value) {
  const url = safeUrl(value)
  return Boolean(
    url
      && url.protocol === 'https:'
      && url.hostname === 'oapi.dingtalk.com'
      && url.pathname === '/robot/send'
      && url.searchParams.get('access_token')?.trim(),
  )
}

function checkEnvMode(file) {
  if (process.platform === 'win32') {
    return { checked: false, mode: null, ok: true }
  }
  const mode = statSync(file).mode & 0o777
  return { checked: true, mode: mode.toString(8).padStart(3, '0'), ok: (mode & 0o077) === 0 }
}

function addCheck(summary, id, label, status, details = {}) {
  summary.checks.push({ id, label, status, details })
}

function checkRequiredValue(summary, values, key, label) {
  const value = envValue(values, key)
  addCheck(summary, key.toLowerCase(), label, value ? 'pass' : 'fail', {
    present: Boolean(value),
    value: redactValue(key, value),
  })
  return value
}

function checkReadiness(opts) {
  const values = parseEnvFile(opts.envFile)
  const outputDir = opts.outputDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
  mkdirSync(outputDir, { recursive: true })

  const summary = {
    tool: 'dingtalk-p4-env-bootstrap',
    generatedAt: new Date().toISOString(),
    envFile: opts.envFile,
    outputDir,
    overallStatus: 'fail',
    checks: [],
    environment: {},
    nextCommands: [],
  }

  const modeCheck = checkEnvMode(opts.envFile)
  addCheck(summary, 'env-file-private-mode', 'Private env file is not group/world readable', modeCheck.ok ? 'pass' : 'fail', modeCheck)

  const apiBase = checkRequiredValue(summary, values, 'DINGTALK_P4_API_BASE', 'Backend API base is set')
  addCheck(summary, 'api-base-url', 'Backend API base is a valid http(s) URL', safeUrl(apiBase) ? 'pass' : 'fail', {
    value: redactString(apiBase),
  })

  const webBase = checkRequiredValue(summary, values, 'DINGTALK_P4_WEB_BASE', 'Public web base is set')
  addCheck(summary, 'web-base-url', 'Public web base is a valid http(s) URL', safeUrl(webBase) ? 'pass' : 'fail', {
    value: redactString(webBase),
  })

  checkRequiredValue(summary, values, 'DINGTALK_P4_AUTH_TOKEN', 'Admin/table-owner bearer token is present')

  const groupAWebhook = checkRequiredValue(summary, values, 'DINGTALK_P4_GROUP_A_WEBHOOK', 'DingTalk group A robot webhook is present')
  addCheck(summary, 'group-a-webhook-shape', 'Group A webhook uses DingTalk robot URL shape', isValidRobotWebhook(groupAWebhook) ? 'pass' : 'fail', {
    value: redactValue('DINGTALK_P4_GROUP_A_WEBHOOK', groupAWebhook),
  })

  const groupBWebhook = checkRequiredValue(summary, values, 'DINGTALK_P4_GROUP_B_WEBHOOK', 'DingTalk group B robot webhook is present')
  addCheck(summary, 'group-b-webhook-shape', 'Group B webhook uses DingTalk robot URL shape', isValidRobotWebhook(groupBWebhook) ? 'pass' : 'fail', {
    value: redactValue('DINGTALK_P4_GROUP_B_WEBHOOK', groupBWebhook),
  })

  for (const key of ['DINGTALK_P4_GROUP_A_SECRET', 'DINGTALK_P4_GROUP_B_SECRET']) {
    const value = envValue(values, key)
    addCheck(summary, key.toLowerCase(), `${key} is blank or SEC-shaped`, !value || /^SEC[A-Za-z0-9+/=_-]{8,}$/.test(value) ? 'pass' : 'fail', {
      present: Boolean(value),
      value: redactValue(key, value),
    })
  }

  const allowedUserIds = splitList(envValue(values, 'DINGTALK_P4_ALLOWED_USER_IDS'))
  const allowedMemberGroupIds = splitList(envValue(values, 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS'))
  addCheck(summary, 'allowlist-present', 'At least one local user or member group is allowed', allowedUserIds.length || allowedMemberGroupIds.length ? 'pass' : 'fail', {
    allowedUserCount: allowedUserIds.length,
    allowedMemberGroupCount: allowedMemberGroupIds.length,
  })

  const personUserIds = splitList(envValue(values, 'DINGTALK_P4_PERSON_USER_IDS'))
  addCheck(summary, 'person-smoke-input', 'Person-message smoke recipient is declared for final delivery history', personUserIds.length > 0 ? 'pass' : 'fail', {
    personUserCount: personUserIds.length,
    notes: personUserIds.length > 0
      ? 'Person delivery can be bootstrapped by the final smoke session.'
      : 'Set DINGTALK_P4_PERSON_USER_IDS before final release smoke; delivery-history-group-person is a required P4 check.',
  })
  const authorizedUserId = envValue(values, 'DINGTALK_P4_AUTHORIZED_USER_ID') || allowedUserIds[0] || ''
  const unauthorizedUserId = envValue(values, 'DINGTALK_P4_UNAUTHORIZED_USER_ID')
  const noEmailDingTalkExternalId = envValue(values, 'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID')
  const missingManualTargets = []
  if (!authorizedUserId) missingManualTargets.push('authorized user')
  if (!unauthorizedUserId) missingManualTargets.push('unauthorized user')
  if (!noEmailDingTalkExternalId) missingManualTargets.push('no-email DingTalk external id')
  addCheck(summary, 'manual-targets-declared', 'Manual target identities are declared', missingManualTargets.length === 0 ? 'pass' : 'fail', {
    authorizedUserId,
    unauthorizedUserId,
    noEmailDingTalkExternalId,
    missing: missingManualTargets,
  })

  summary.environment = {
    apiBase: redactString(apiBase),
    webBase: redactString(webBase),
    authTokenPresent: Boolean(envValue(values, 'DINGTALK_P4_AUTH_TOKEN')),
    groupAWebhook: redactValue('DINGTALK_P4_GROUP_A_WEBHOOK', groupAWebhook),
    groupBWebhook: redactValue('DINGTALK_P4_GROUP_B_WEBHOOK', groupBWebhook),
    groupASecretPresent: Boolean(envValue(values, 'DINGTALK_P4_GROUP_A_SECRET')),
    groupBSecretPresent: Boolean(envValue(values, 'DINGTALK_P4_GROUP_B_SECRET')),
    allowedUserCount: allowedUserIds.length,
    allowedMemberGroupCount: allowedMemberGroupIds.length,
    personUserCount: personUserIds.length,
    manualTargets: {
      authorizedUserId,
      unauthorizedUserId,
      noEmailDingTalkExternalId,
    },
  }
  summary.nextCommands = [
    `node scripts/ops/dingtalk-p4-smoke-preflight.mjs --env-file ${shellQuote(opts.envFile)} --require-manual-targets --require-person-user --output-dir output/dingtalk-p4-remote-smoke-preflight/142-readiness`,
    `node scripts/ops/dingtalk-p4-smoke-session.mjs --env-file ${shellQuote(opts.envFile)} --require-manual-targets --output-dir output/dingtalk-p4-remote-smoke-session/142-session`,
  ]
  summary.overallStatus = summary.checks.some((check) => check.status === 'fail') ? 'fail' : 'pass'

  const jsonPath = path.join(outputDir, 'readiness-summary.json')
  const mdPath = path.join(outputDir, 'readiness-summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderMarkdown(summary), 'utf8')
  console.log(`[dingtalk-p4-env-bootstrap] readiness=${summary.overallStatus} json=${jsonPath} md=${mdPath}`)

  if (summary.overallStatus !== 'pass') {
    process.exitCode = 1
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function mdCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function renderMarkdown(summary) {
  const rows = summary.checks
    .map((check) => `| \`${mdCell(check.id)}\` | ${mdCell(check.label)} | \`${check.status}\` | ${mdCell(JSON.stringify(check.details))} |`)
    .join('\n')
  const commands = summary.nextCommands.map((command) => `- \`${command}\``).join('\n')
  return `# DingTalk P4 Env Readiness

- Generated at: \`${summary.generatedAt}\`
- Env file: \`${summary.envFile}\`
- Overall status: \`${summary.overallStatus}\`

## Checks

| Check | Label | Status | Details |
| --- | --- | --- | --- |
${rows}

## Environment Summary

\`\`\`json
${JSON.stringify(summary.environment, null, 2)}
\`\`\`

## Next Commands

${commands}

## Secret Policy

Bearer tokens, DingTalk robot access tokens, SEC secrets, JWTs, public form tokens, timestamps, and signs are redacted from this report.
`
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.init) initEnv(opts)
    updateEnv(opts)
    if (opts.check) checkReadiness(opts)
  } catch (error) {
    console.error(`[dingtalk-p4-env-bootstrap] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
    process.exit(1)
  }
}

main()
