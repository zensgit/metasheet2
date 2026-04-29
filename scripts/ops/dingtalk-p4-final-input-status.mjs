#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_ENV_FILE = 'output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env'
const DEFAULT_OUTPUT_DIR = 'output/dingtalk-p4-final-input-status'

const SECRET_KEYS = new Set([
  'DINGTALK_P4_AUTH_TOKEN',
  'DINGTALK_P4_GROUP_A_WEBHOOK',
  'DINGTALK_P4_GROUP_B_WEBHOOK',
  'DINGTALK_P4_GROUP_A_SECRET',
  'DINGTALK_P4_GROUP_B_SECRET',
])

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-final-input-status.mjs [options]

Checks the private DingTalk P4 final-input env file without calling 142 or
DingTalk. It writes redacted JSON/Markdown that tells the operator whether the
final private inputs are ready before release-readiness and real smoke.

Options:
  --env-file <file>       Env file path, default ${DEFAULT_ENV_FILE}
  --output-json <file>    Output JSON path, default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>      Output Markdown path, default ${DEFAULT_OUTPUT_DIR}/summary.md
  --allow-blocked         Exit 0 even when required final inputs are missing
  --help                  Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(argv) {
  const opts = {
    envFile: DEFAULT_ENV_FILE,
    outputJson: path.join(DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.join(DEFAULT_OUTPUT_DIR, 'summary.md'),
    allowBlocked: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--env-file':
      case '--p4-env-file':
        opts.envFile = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--output-json':
        opts.outputJson = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--output-md':
        opts.outputMd = readRequiredValue(argv, i, arg)
        i += 1
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

  opts.envFile = path.resolve(process.cwd(), opts.envFile)
  opts.outputJson = path.resolve(process.cwd(), opts.outputJson)
  opts.outputMd = path.resolve(process.cwd(), opts.outputMd)
  return opts
}

function unquoteEnvValue(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvFile(file) {
  const values = new Map()
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    values.set(trimmed.slice(0, index).trim(), unquoteEnvValue(trimmed.slice(index + 1)))
  }
  return values
}

function valueOf(values, key) {
  return String(values.get(key) ?? '').trim()
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isValidRobotWebhook(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.hostname === 'oapi.dingtalk.com'
      && parsed.pathname === '/robot/send'
      && Boolean(parsed.searchParams.get('access_token'))
  } catch {
    return false
  }
}

function robotWebhookToken(value) {
  if (!value) return ''
  try {
    return new URL(value).searchParams.get('access_token')?.trim() ?? ''
  } catch {
    return ''
  }
}

function isValidRobotSecret(value) {
  return !value || /^SEC[A-Za-z0-9+/=_-]{8,}$/.test(value)
}

function redactValue(key, value) {
  if (!value) return ''
  if (!SECRET_KEYS.has(key)) return value
  if (key.includes('WEBHOOK')) {
    try {
      const parsed = new URL(value)
      return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}?<redacted>; ${value.length} chars`
    } catch {
      return `<redacted invalid URL; ${value.length} chars>`
    }
  }
  return `<redacted; ${value.length} chars>`
}

function addCheck(summary, id, label, passed, details = {}, remediation = '') {
  summary.checks.push({
    id,
    label,
    status: passed ? 'pass' : 'fail',
    details,
    remediation,
  })
}

function buildSummary(opts, values) {
  const apiBase = valueOf(values, 'DINGTALK_P4_API_BASE')
  const webBase = valueOf(values, 'DINGTALK_P4_WEB_BASE')
  const authToken = valueOf(values, 'DINGTALK_P4_AUTH_TOKEN')
  const groupAWebhook = valueOf(values, 'DINGTALK_P4_GROUP_A_WEBHOOK')
  const groupBWebhook = valueOf(values, 'DINGTALK_P4_GROUP_B_WEBHOOK')
  const groupASecret = valueOf(values, 'DINGTALK_P4_GROUP_A_SECRET')
  const groupBSecret = valueOf(values, 'DINGTALK_P4_GROUP_B_SECRET')
  const allowedUserIds = splitList(valueOf(values, 'DINGTALK_P4_ALLOWED_USER_IDS'))
  const allowedMemberGroupIds = splitList(valueOf(values, 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS'))
  const personUserIds = splitList(valueOf(values, 'DINGTALK_P4_PERSON_USER_IDS'))
  const authorizedUserId = valueOf(values, 'DINGTALK_P4_AUTHORIZED_USER_ID') || allowedUserIds[0] || ''
  const unauthorizedUserId = valueOf(values, 'DINGTALK_P4_UNAUTHORIZED_USER_ID')
  const noEmailDingTalkExternalId = valueOf(values, 'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID')

  const summary = {
    tool: 'dingtalk-p4-final-input-status',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    envFile: opts.envFile,
    overallStatus: 'blocked',
    environment: {
      apiBase: redactValue('DINGTALK_P4_API_BASE', apiBase),
      webBase: redactValue('DINGTALK_P4_WEB_BASE', webBase),
      authTokenPresent: Boolean(authToken),
      groupAWebhook: redactValue('DINGTALK_P4_GROUP_A_WEBHOOK', groupAWebhook),
      groupBWebhook: redactValue('DINGTALK_P4_GROUP_B_WEBHOOK', groupBWebhook),
      groupASecretPresent: Boolean(groupASecret),
      groupBSecretPresent: Boolean(groupBSecret),
      allowedUserCount: allowedUserIds.length,
      allowedMemberGroupCount: allowedMemberGroupIds.length,
      personUserCount: personUserIds.length,
      manualTargets: {
        authorizedUserId,
        unauthorizedUserId,
        noEmailDingTalkExternalId,
      },
    },
    checks: [],
    missingInputs: [],
    blockedInputCount: 0,
    nextCommands: [],
  }

  addCheck(summary, 'api-base-present', 'DINGTALK_P4_API_BASE is present', Boolean(apiBase), {}, 'Set DINGTALK_P4_API_BASE to the reachable 142/staging API base.')
  addCheck(summary, 'web-base-present', 'DINGTALK_P4_WEB_BASE is present', Boolean(webBase), {}, 'Set DINGTALK_P4_WEB_BASE to the public web origin used in DingTalk links.')
  addCheck(summary, 'auth-token-present', 'DINGTALK_P4_AUTH_TOKEN is present', Boolean(authToken), {
    present: Boolean(authToken),
  }, 'Set DINGTALK_P4_AUTH_TOKEN through --set-from-env.')
  addCheck(summary, 'group-a-webhook-present', 'Group A webhook is present', Boolean(groupAWebhook), {
    value: redactValue('DINGTALK_P4_GROUP_A_WEBHOOK', groupAWebhook),
  }, 'Set DINGTALK_P4_GROUP_A_WEBHOOK to a real DingTalk robot webhook.')
  addCheck(summary, 'group-a-webhook-shape', 'Group A webhook has DingTalk robot URL shape', isValidRobotWebhook(groupAWebhook), {
    value: redactValue('DINGTALK_P4_GROUP_A_WEBHOOK', groupAWebhook),
  }, 'Use https://oapi.dingtalk.com/robot/send?access_token=...')
  addCheck(summary, 'group-b-webhook-present', 'Group B webhook is present', Boolean(groupBWebhook), {
    value: redactValue('DINGTALK_P4_GROUP_B_WEBHOOK', groupBWebhook),
  }, 'Set DINGTALK_P4_GROUP_B_WEBHOOK to a second real DingTalk robot webhook.')
  addCheck(summary, 'group-b-webhook-shape', 'Group B webhook has DingTalk robot URL shape', isValidRobotWebhook(groupBWebhook), {
    value: redactValue('DINGTALK_P4_GROUP_B_WEBHOOK', groupBWebhook),
  }, 'Use https://oapi.dingtalk.com/robot/send?access_token=...')
  const groupAToken = robotWebhookToken(groupAWebhook)
  const groupBToken = robotWebhookToken(groupBWebhook)
  addCheck(summary, 'group-webhooks-distinct', 'Group A and B robot webhooks use distinct access tokens', Boolean(groupAToken && groupBToken && groupAToken !== groupBToken), {
    groupAWebhookPresent: Boolean(groupAWebhook),
    groupBWebhookPresent: Boolean(groupBWebhook),
    sameAccessToken: Boolean(groupAToken && groupBToken && groupAToken === groupBToken),
  }, 'Use two different DingTalk group robots so multi-destination delivery is meaningful.')
  addCheck(summary, 'group-a-secret-shape', 'Group A secret is blank or SEC-shaped', isValidRobotSecret(groupASecret), {
    present: Boolean(groupASecret),
    value: redactValue('DINGTALK_P4_GROUP_A_SECRET', groupASecret),
  }, 'Unset DINGTALK_P4_GROUP_A_SECRET or set a valid SEC... signing secret.')
  addCheck(summary, 'group-b-secret-shape', 'Group B secret is blank or SEC-shaped', isValidRobotSecret(groupBSecret), {
    present: Boolean(groupBSecret),
    value: redactValue('DINGTALK_P4_GROUP_B_SECRET', groupBSecret),
  }, 'Unset DINGTALK_P4_GROUP_B_SECRET or set a valid SEC... signing secret.')
  addCheck(summary, 'allowlist-present', 'At least one local user or member group is allowlisted', allowedUserIds.length + allowedMemberGroupIds.length > 0, {
    allowedUserCount: allowedUserIds.length,
    allowedMemberGroupCount: allowedMemberGroupIds.length,
  }, 'Set DINGTALK_P4_ALLOWED_USER_IDS or DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS.')
  addCheck(summary, 'person-target-present', 'At least one person-message smoke user is present', personUserIds.length > 0, {
    personUserCount: personUserIds.length,
  }, 'Set DINGTALK_P4_PERSON_USER_IDS.')
  addCheck(summary, 'authorized-target-present', 'Authorized manual target is present', Boolean(authorizedUserId), {
    authorizedUserId,
  }, 'Set DINGTALK_P4_AUTHORIZED_USER_ID or include an allowed user.')
  addCheck(summary, 'unauthorized-target-present', 'Unauthorized manual target is present', Boolean(unauthorizedUserId), {
    unauthorizedUserId,
  }, 'Set DINGTALK_P4_UNAUTHORIZED_USER_ID to a second active DingTalk-bound local user.')
  addCheck(summary, 'unauthorized-target-distinct', 'Unauthorized target is distinct from authorized and allowed users', Boolean(unauthorizedUserId) && unauthorizedUserId !== authorizedUserId && !allowedUserIds.includes(unauthorizedUserId), {
    authorizedUserId,
    unauthorizedUserId,
    unauthorizedInAllowedUsers: allowedUserIds.includes(unauthorizedUserId),
  }, 'Use a DingTalk-bound user that is not the authorized target and not in DINGTALK_P4_ALLOWED_USER_IDS.')
  addCheck(summary, 'no-email-external-id-present', 'No-email DingTalk external id is present', Boolean(noEmailDingTalkExternalId), {
    noEmailDingTalkExternalId,
  }, 'Set DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID to an unbound no-email DingTalk identity.')

  summary.missingInputs = summary.checks
    .filter((check) => check.status === 'fail')
    .map((check) => ({
      id: check.id,
      label: check.label,
      remediation: check.remediation,
    }))
  summary.blockedInputCount = summary.missingInputs.length
  summary.overallStatus = summary.missingInputs.length === 0 ? 'ready' : 'blocked'
  summary.nextCommands = buildNextCommands(opts.envFile, summary.overallStatus)
  return summary
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function buildNextCommands(envFile, overallStatus) {
  const commands = [
    `node scripts/ops/dingtalk-p4-release-readiness.mjs --p4-env-file ${shellQuote(envFile)} --regression-profile all --regression-plan-only --output-dir output/dingtalk-p4-release-readiness/142-final-inputs --allow-failures`,
  ]
  if (overallStatus === 'ready') {
    commands.push(`node scripts/ops/dingtalk-p4-release-readiness.mjs --p4-env-file ${shellQuote(envFile)} --regression-profile all --run-smoke-session --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session --timeout-ms 120000`)
  }
  return commands
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk P4 Final Input Status',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Env File: \`${summary.envFile}\``,
    `- Overall Status: \`${summary.overallStatus}\``,
    `- Blocked Input Count: \`${summary.blockedInputCount}\``,
    '',
    '## Redacted Environment',
    '',
    `- API Base: \`${summary.environment.apiBase || '<missing>'}\``,
    `- Web Base: \`${summary.environment.webBase || '<missing>'}\``,
    `- Auth Token Present: \`${summary.environment.authTokenPresent}\``,
    `- Group A Webhook: \`${summary.environment.groupAWebhook || '<missing>'}\``,
    `- Group B Webhook: \`${summary.environment.groupBWebhook || '<missing>'}\``,
    `- Group A Secret Present: \`${summary.environment.groupASecretPresent}\``,
    `- Group B Secret Present: \`${summary.environment.groupBSecretPresent}\``,
    `- Allowed User Count: \`${summary.environment.allowedUserCount}\``,
    `- Allowed Member Group Count: \`${summary.environment.allowedMemberGroupCount}\``,
    `- Person User Count: \`${summary.environment.personUserCount}\``,
    `- Authorized Target: \`${summary.environment.manualTargets.authorizedUserId || '<missing>'}\``,
    `- Unauthorized Target: \`${summary.environment.manualTargets.unauthorizedUserId || '<missing>'}\``,
    `- No-Email External ID: \`${summary.environment.manualTargets.noEmailDingTalkExternalId || '<missing>'}\``,
    '',
    '## Checks',
    '',
    '| Check | Status | Remediation |',
    '| --- | --- | --- |',
  ]
  for (const check of summary.checks) {
    lines.push(`| \`${check.id}\` | \`${check.status}\` | ${check.status === 'pass' ? '' : check.remediation} |`)
  }
  lines.push('', '## Next Commands', '')
  for (const command of summary.nextCommands) {
    lines.push('```bash', command, '```', '')
  }
  if (summary.overallStatus !== 'ready') {
    lines.push('## Missing Inputs', '')
    for (const item of summary.missingInputs) {
      lines.push(`- \`${item.id}\`: ${item.remediation}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function writeOutputs(opts, summary) {
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(summary), 'utf8')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(opts.envFile)) {
    throw new Error(`env file not found: ${opts.envFile}`)
  }
  const values = readEnvFile(opts.envFile)
  const summary = buildSummary(opts, values)
  writeOutputs(opts, summary)
  console.log(`[dingtalk-p4-final-input-status] ${summary.overallStatus}: ${opts.outputJson}`)
  if (summary.overallStatus !== 'ready' && !opts.allowBlocked) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
