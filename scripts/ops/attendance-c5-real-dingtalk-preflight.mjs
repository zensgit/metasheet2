#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUTPUT_DIR = 'output/attendance-c5-real-dingtalk-preflight'
const REQUIRED_TABLES = [
  'attendance_notification_deliveries',
  'attendance_unscheduled_reminder_dispatch',
  'attendance_leave_balances',
  'attendance_group_managers',
  'directory_integrations',
  'directory_accounts',
  'directory_account_links',
]
const ENV_GROUPS = {
  appKey: ['DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID'],
  appSecret: ['DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET'],
  agentId: ['DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID'],
}

function printHelp() {
  console.log(`Usage: node scripts/ops/attendance-c5-real-dingtalk-preflight.mjs [options]

Checks whether staging is ready for the C5-5b real DingTalk work-notification
smoke. This script is read-only: it does not seed smoke rows and does not send
DingTalk messages. It also never prints secret values.

Options:
  --database-url <url>       Staging postgres URL; defaults to DATABASE_URL.
  --env-file <file>          Env file to read for DingTalk keys; repeatable.
  --mock-db-json <file>      Test hook: read DB facts from JSON instead of postgres.
  --output-json <file>       Output JSON path; default ${DEFAULT_OUTPUT_DIR}/summary.json
  --output-md <file>         Output Markdown path; default ${DEFAULT_OUTPUT_DIR}/summary.md
  --allow-blocked            Exit 0 even when prerequisites are blocked.
  --help                     Show this help.

Environment inputs:
  DINGTALK_APP_KEY / DINGTALK_CLIENT_ID
  DINGTALK_APP_SECRET / DINGTALK_CLIENT_SECRET
  DINGTALK_AGENT_ID / DINGTALK_NOTIFY_AGENT_ID
  DINGTALK_SMOKE_CONFIG_INTEGRATION_ID
  DINGTALK_SMOKE_EXTERNAL_USER_ID, or role-specific
    DINGTALK_SMOKE_SUBJECT_USER_ID / OWNER_USER_ID / SUB_OWNER_USER_ID
  SMOKE_TOKEN / TOKEN, or DEPLOY_HOST + DEPLOY_USER + DEPLOY_SSH_KEY_B64 for
    scripts/ops/resolve-attendance-smoke-token.sh
`)
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    databaseUrl: process.env.DATABASE_URL || '',
    envFiles: [],
    mockDbJson: '',
    outputJson: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.json'),
    outputMd: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, 'summary.md'),
    allowBlocked: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--database-url':
        opts.databaseUrl = readRequiredValue(argv, index, arg)
        index += 1
        break
      case '--env-file':
        opts.envFiles.push(path.resolve(process.cwd(), readRequiredValue(argv, index, arg)))
        index += 1
        break
      case '--mock-db-json':
        opts.mockDbJson = path.resolve(process.cwd(), readRequiredValue(argv, index, arg))
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
      case '--allow-blocked':
        opts.allowBlocked = true
        break
      case '--help':
        opts.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function unquoteEnvValue(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function readEnvFile(file) {
  if (!existsSync(file)) throw new Error(`env file not found: ${file}`)
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

function collectEnv(envFiles) {
  const values = new Map()
  const sources = new Map()
  for (const file of envFiles) {
    const fileValues = readEnvFile(file)
    for (const [key, value] of fileValues.entries()) {
      values.set(key, value)
      sources.set(key, file)
    }
  }
  const interestingKeys = new Set([
    ...Object.values(ENV_GROUPS).flat(),
    'DINGTALK_SMOKE_CONFIG_INTEGRATION_ID',
    'DINGTALK_SMOKE_EXTERNAL_USER_ID',
    'DINGTALK_SMOKE_SUBJECT_USER_ID',
    'DINGTALK_SMOKE_OWNER_USER_ID',
    'DINGTALK_SMOKE_SUB_OWNER_USER_ID',
    'SMOKE_TOKEN',
    'TOKEN',
    'DEPLOY_HOST',
    'DEPLOY_USER',
    'DEPLOY_SSH_KEY_B64',
    'ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES',
  ])
  for (const key of interestingKeys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) {
      values.set(key, value.trim())
      sources.set(key, '<process.env>')
    }
  }
  return { values, sources }
}

function pickEnv(values, keys) {
  for (const key of keys) {
    const value = values.get(key)
    if (typeof value === 'string' && value.trim()) return { present: true, selectedKey: key }
  }
  return { present: false, selectedKey: null }
}

function parseJsonRecord(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value
  return {}
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function storedConfigStatus(row) {
  const config = parseJsonRecord(row.config)
  return {
    integrationId: String(row.id ?? ''),
    integrationName: String(row.name ?? ''),
    status: String(row.status ?? ''),
    appKey: hasText(config.appKey),
    appSecret: hasText(config.appSecret),
    agentId: hasText(config.workNotificationAgentId) || hasText(config.agentId),
  }
}

function addCheck(checks, status, id, message, details = {}) {
  checks.push({ id, status, message, details })
}

function missingEnvConfigInputs(selected) {
  const missing = []
  if (!selected.appKey.present) missing.push('DINGTALK_APP_KEY/DINGTALK_CLIENT_ID')
  if (!selected.appSecret.present) missing.push('DINGTALK_APP_SECRET/DINGTALK_CLIENT_SECRET')
  if (!selected.agentId.present) missing.push('DINGTALK_AGENT_ID/DINGTALK_NOTIFY_AGENT_ID')
  return missing
}

function dingtalkConfigMessage({ envConfigReady, requestedIntegration, requestedIntegrationId, configuredIntegrations, missingEnvInputs }) {
  if (envConfigReady) {
    return 'DingTalk app key, app secret, and work-notification agent id are present in env/process'
  }
  if (requestedIntegration) {
    return 'requested DINGTALK_SMOKE_CONFIG_INTEGRATION_ID has complete stored work-notification config'
  }
  if (requestedIntegrationId) {
    return 'requested DINGTALK_SMOKE_CONFIG_INTEGRATION_ID is missing or incomplete'
  }
  if (configuredIntegrations.length > 0) {
    return 'stored DingTalk config exists; set DINGTALK_SMOKE_CONFIG_INTEGRATION_ID to one configured integration id'
  }
  if (missingEnvInputs.length > 0 && missingEnvInputs.length < 3) {
    return `incomplete env DingTalk work-notification config; missing ${missingEnvInputs.join(', ')}`
  }
  return 'missing DingTalk work-notification config; provide env config or DINGTALK_SMOKE_CONFIG_INTEGRATION_ID'
}

export function buildSummary({ env, dbFacts }) {
  const checks = []
  const selected = {
    appKey: pickEnv(env.values, ENV_GROUPS.appKey),
    appSecret: pickEnv(env.values, ENV_GROUPS.appSecret),
    agentId: pickEnv(env.values, ENV_GROUPS.agentId),
  }
  const envConfigReady = selected.appKey.present && selected.appSecret.present && selected.agentId.present
  const missingEnvInputs = missingEnvConfigInputs(selected)

  const tableStatuses = REQUIRED_TABLES.map(table => ({
    table,
    exists: Boolean(dbFacts.tables?.[table]),
  }))
  const missingTables = tableStatuses.filter(item => !item.exists).map(item => item.table)
  addCheck(
    checks,
    missingTables.length === 0 ? 'pass' : 'block',
    'tables',
    missingTables.length === 0
      ? 'required C5 and DingTalk directory tables are present'
      : `missing required table(s): ${missingTables.join(', ')}`,
    { tables: tableStatuses },
  )

  const storedIntegrations = (dbFacts.activeDingTalkIntegrations || []).map(storedConfigStatus)
  const configuredIntegrations = storedIntegrations.filter(item => item.appKey && item.appSecret && item.agentId)
  const requestedIntegrationId = env.values.get('DINGTALK_SMOKE_CONFIG_INTEGRATION_ID') || ''
  const requestedIntegration = requestedIntegrationId
    ? configuredIntegrations.find(item => item.integrationId === requestedIntegrationId)
    : null
  const configReady = envConfigReady || Boolean(requestedIntegration)
  addCheck(
    checks,
    configReady ? 'pass' : 'block',
    'dingtalk-config',
    dingtalkConfigMessage({
      envConfigReady,
      requestedIntegration,
      requestedIntegrationId,
      configuredIntegrations,
      missingEnvInputs,
    }),
    {
      envKeys: {
        appKey: selected.appKey.selectedKey,
        appSecret: selected.appSecret.selectedKey,
        agentId: selected.agentId.selectedKey,
      },
      missingEnvInputs,
      requestedIntegrationId: requestedIntegrationId || null,
      configuredIntegrationIds: configuredIntegrations.map(item => item.integrationId),
      activeDingTalkIntegrationCount: storedIntegrations.length,
    },
  )

  const sharedRecipient = env.values.get('DINGTALK_SMOKE_EXTERNAL_USER_ID')
  const roleRecipients = [
    env.values.get('DINGTALK_SMOKE_SUBJECT_USER_ID'),
    env.values.get('DINGTALK_SMOKE_OWNER_USER_ID'),
    env.values.get('DINGTALK_SMOKE_SUB_OWNER_USER_ID'),
  ]
  const recipientReady = hasText(sharedRecipient) || roleRecipients.every(hasText)
  addCheck(
    checks,
    recipientReady ? 'pass' : 'block',
    'recipient',
    recipientReady
      ? 'DingTalk smoke recipient is configured'
      : 'missing DINGTALK_SMOKE_EXTERNAL_USER_ID or all role-specific recipient ids',
    {
      sharedRecipient: hasText(sharedRecipient),
      roleRecipients: roleRecipients.map(hasText),
    },
  )

  const tokenReady = hasText(env.values.get('SMOKE_TOKEN')) ||
    hasText(env.values.get('TOKEN')) ||
    (hasText(env.values.get('DEPLOY_HOST')) &&
      hasText(env.values.get('DEPLOY_USER')) &&
      hasText(env.values.get('DEPLOY_SSH_KEY_B64')))
  addCheck(
    checks,
    tokenReady ? 'pass' : 'block',
    'auth-token',
    tokenReady
      ? 'SMOKE_TOKEN/TOKEN or deploy-host token fallback is available'
      : 'missing SMOKE_TOKEN/TOKEN; production staging usually needs scripts/ops/resolve-attendance-smoke-token.sh',
    {
      hasSmokeToken: hasText(env.values.get('SMOKE_TOKEN')) || hasText(env.values.get('TOKEN')),
      hasDeployHostFallback: hasText(env.values.get('DEPLOY_HOST')) &&
        hasText(env.values.get('DEPLOY_USER')) &&
        hasText(env.values.get('DEPLOY_SSH_KEY_B64')),
    },
  )

  const dueRows = Number(dbFacts.dueDeliveryRows || 0)
  const allowDue = env.values.get('ALLOW_C5_SMOKE_EXISTING_DUE_DELIVERIES') === '1'
  addCheck(
    checks,
    dueRows === 0 || allowDue ? 'pass' : 'block',
    'due-deliveries',
    dueRows === 0
      ? 'no due non-smoke delivery rows are waiting for the global worker'
      : 'due delivery rows exist; inspect before running the real smoke',
    { dueDeliveryRows: dueRows, allowOverride: allowDue },
  )

  const directoryFacts = {
    activeDingTalkIntegrationCount: storedIntegrations.length,
    configuredDingTalkIntegrationCount: configuredIntegrations.length,
    directoryAccountCount: Number(dbFacts.directoryAccountCount || 0),
    directoryLinkCount: Number(dbFacts.directoryLinkCount || 0),
  }
  addCheck(
    checks,
    'info',
    'directory-state',
    'DingTalk directory state snapshot (informational; the smoke seeds temporary links for the supplied recipient)',
    directoryFacts,
  )

  const missing = checks.filter(check => check.status === 'block')
  const overallStatus = missing.length === 0 ? 'ready' : 'blocked'
  const nextCommand = overallStatus === 'ready'
    ? 'C5_CHANNEL_MODE=dingtalk ALLOW_REAL_DINGTALK_SEND=1 DINGTALK_SMOKE_EXTERNAL_USER_ID=<recipient> EXPECTED_DEPLOY_SHA=<sha> pnpm exec tsx scripts/ops/staging-attendance-c5-delivery-smoke.ts'
    : 'Fix blocked checks above, then run the C5 real DingTalk smoke.'

  return {
    schemaVersion: 1,
    tool: 'attendance-c5-real-dingtalk-preflight',
    overallStatus,
    checks,
    missingCheckIds: missing.map(check => check.id),
    selectedConfigSource: envConfigReady
      ? 'env'
      : requestedIntegration
        ? 'DINGTALK_SMOKE_CONFIG_INTEGRATION_ID'
        : null,
    directoryFacts,
    nextCommand,
  }
}

function renderMarkdown(summary) {
  const lines = [
    '# Attendance C5 real DingTalk preflight',
    '',
    `Overall Status: \`${summary.overallStatus}\``,
    '',
    '| Check | Status | Message |',
    '|---|---|---|',
  ]
  for (const check of summary.checks) {
    lines.push(`| \`${check.id}\` | \`${check.status}\` | ${check.message.replaceAll('|', '\\|')} |`)
  }
  lines.push('', '## Next command', '', '```bash', summary.nextCommand, '```', '')
  if (summary.missingCheckIds.length > 0) {
    lines.push('## Blocked checks', '', ...summary.missingCheckIds.map(id => `- \`${id}\``), '')
  }
  lines.push('Secrets are intentionally omitted from this report.', '')
  return `${lines.join('\n')}\n`
}

async function loadDbFacts(opts) {
  if (opts.mockDbJson) {
    return JSON.parse(readFileSync(opts.mockDbJson, 'utf8'))
  }
  if (!opts.databaseUrl) {
    throw new Error('DATABASE_URL or --database-url is required unless --mock-db-json is used')
  }
  const requireFromBackend = createRequire(new URL('../../packages/core-backend/package.json', import.meta.url))
  const pg = requireFromBackend('pg')
  const pool = new pg.Pool({ connectionString: opts.databaseUrl })
  try {
    const tableRows = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    )
    const tables = Object.fromEntries(REQUIRED_TABLES.map(table => [table, false]))
    for (const row of tableRows.rows) tables[row.table_name] = true

    const integrations = tables.directory_integrations
      ? await pool.query(
        `SELECT id::text, name, status, config
           FROM directory_integrations
          WHERE provider = 'dingtalk'
            AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 20`,
      )
      : { rows: [] }

    const accountCount = tables.directory_accounts
      ? await pool.query(
        `SELECT count(*)::int AS n
           FROM directory_accounts
          WHERE provider = 'dingtalk'
            AND is_active = true`,
      )
      : { rows: [{ n: 0 }] }
    const linkCount = tables.directory_account_links
      ? await pool.query('SELECT count(*)::int AS n FROM directory_account_links')
      : { rows: [{ n: 0 }] }
    const dueRows = tables.attendance_notification_deliveries
      ? await pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_notification_deliveries
          WHERE (status IN ('pending','retrying') AND next_attempt_at <= now())
             OR (status = 'sending' AND claim_expires_at <= now())`,
      )
      : { rows: [{ n: 0 }] }

    return {
      tables,
      activeDingTalkIntegrations: integrations.rows,
      directoryAccountCount: Number(accountCount.rows[0]?.n || 0),
      directoryLinkCount: Number(linkCount.rows[0]?.n || 0),
      dueDeliveryRows: Number(dueRows.rows[0]?.n || 0),
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
}

async function main() {
  const opts = parseArgs()
  if (opts.help) {
    printHelp()
    return
  }
  const env = collectEnv(opts.envFiles)
  const dbFacts = await loadDbFacts(opts)
  const summary = buildSummary({ env, dbFacts })
  mkdirSync(path.dirname(opts.outputJson), { recursive: true })
  mkdirSync(path.dirname(opts.outputMd), { recursive: true })
  writeFileSync(opts.outputJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(opts.outputMd, renderMarkdown(summary), 'utf8')
  console.log(JSON.stringify({
    ok: summary.overallStatus === 'ready',
    overallStatus: summary.overallStatus,
    missingCheckIds: summary.missingCheckIds,
    jsonPath: path.relative(process.cwd(), opts.outputJson),
    mdPath: path.relative(process.cwd(), opts.outputMd),
  }))
  if (summary.overallStatus !== 'ready' && !opts.allowBlocked) process.exit(1)
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
