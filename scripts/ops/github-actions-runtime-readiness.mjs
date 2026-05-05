#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_DINGTALK_DEPLOY_SECRETS = [
  'DEPLOY_HOST',
  'DEPLOY_USER',
  'DEPLOY_SSH_KEY_B64',
]

export const SUPPORTED_DINGTALK_WEBHOOK_SECRETS = [
  'ALERTMANAGER_WEBHOOK_URL',
  'ALERT_WEBHOOK_URL',
  'SLACK_WEBHOOK_URL',
  'ATTENDANCE_ALERT_SLACK_WEBHOOK_URL',
]

export const REQUIRED_K3_VARIABLES = [
  'METASHEET_TENANT_ID',
  'K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH',
]

export function parseArgs(argv) {
  const config = {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    format: 'text',
    output: null,
    secretsJson: null,
    variablesJson: null,
    strict: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      config.repo = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--format') {
      config.format = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output') {
      config.output = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--secrets-json') {
      config.secretsJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--variables-json') {
      config.variablesJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--strict') {
      config.strict = true
    } else if (arg === '--help' || arg === '-h') {
      config.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!['json', 'markdown', 'text'].includes(config.format)) {
    throw new Error('--format must be one of: text, markdown, json')
  }

  return config
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function runGhJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout || '[]')
}

function normalizeNamedRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => ({
      name: String(row?.name || ''),
      updatedAt: row?.updatedAt || '',
      value: row?.value,
    }))
    .filter((row) => row.name)
}

export function evaluateReadiness({ secrets, variables, repo, checkedAt = new Date().toISOString() }) {
  const secretRows = normalizeNamedRows(secrets)
  const variableRows = normalizeNamedRows(variables)
  const secretNames = new Set(secretRows.map((secret) => secret.name))
  const variableByName = new Map(variableRows.map((variable) => [variable.name, variable]))

  const missingDeploySecrets = REQUIRED_DINGTALK_DEPLOY_SECRETS.filter((name) => !secretNames.has(name))
  const presentWebhookSecrets = SUPPORTED_DINGTALK_WEBHOOK_SECRETS.filter((name) => secretNames.has(name))
  const missingK3Variables = REQUIRED_K3_VARIABLES.filter((name) => !variableByName.has(name))
  const k3HardGateValue = String(variableByName.get('K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH')?.value || '').toLowerCase()
  const k3HardGateEnabled = ['1', 'true', 'yes', 'on'].includes(k3HardGateValue)

  const checks = {
    dingtalkDeploySecrets: {
      ok: missingDeploySecrets.length === 0,
      required: REQUIRED_DINGTALK_DEPLOY_SECRETS,
      present: REQUIRED_DINGTALK_DEPLOY_SECRETS.filter((name) => secretNames.has(name)),
      missing: missingDeploySecrets,
    },
    dingtalkWebhookSelfHeal: {
      ok: presentWebhookSecrets.length > 0,
      supported: SUPPORTED_DINGTALK_WEBHOOK_SECRETS,
      present: presentWebhookSecrets,
      missing: SUPPORTED_DINGTALK_WEBHOOK_SECRETS.filter((name) => !secretNames.has(name)),
    },
    k3DeployAuthGate: {
      ok: missingK3Variables.length === 0 && k3HardGateEnabled,
      requiredVariables: REQUIRED_K3_VARIABLES,
      presentVariables: REQUIRED_K3_VARIABLES.filter((name) => variableByName.has(name)),
      missingVariables: missingK3Variables,
      requireAuthEnabled: k3HardGateEnabled,
      tenantConfigured: variableByName.has('METASHEET_TENANT_ID'),
    },
  }

  const nextActions = []
  if (!checks.dingtalkDeploySecrets.ok) {
    nextActions.push(`Configure missing DingTalk stability deploy secrets: ${missingDeploySecrets.join(', ')}.`)
  }
  if (!checks.dingtalkWebhookSelfHeal.ok) {
    nextActions.push(
      `Configure one supported webhook secret for DingTalk Alertmanager self-heal: ${SUPPORTED_DINGTALK_WEBHOOK_SECRETS.join(', ')}.`,
    )
  }
  if (missingK3Variables.includes('METASHEET_TENANT_ID')) {
    nextActions.push('Set repository variable METASHEET_TENANT_ID for K3 authenticated smoke tenant scope.')
  }
  if (missingK3Variables.includes('K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH') || !k3HardGateEnabled) {
    nextActions.push('Set repository variable K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true for automatic deploy authenticated smoke gating.')
  }
  if (nextActions.length === 0) {
    nextActions.push('GitHub Actions runtime configuration is ready for K3 deploy auth gating and DingTalk stability self-heal.')
  }

  const ok = Object.values(checks).every((check) => check.ok)
  return {
    status: ok ? 'PASS' : 'FAIL',
    ok,
    repo,
    checkedAt,
    checks,
    nextActions,
  }
}

function loadInputs(config) {
  const secrets = config.secretsJson
    ? readJsonFile(config.secretsJson)
    : runGhJson(['secret', 'list', '--repo', config.repo, '--json', 'name,updatedAt'])
  const variables = config.variablesJson
    ? readJsonFile(config.variablesJson)
    : runGhJson(['variable', 'list', '--repo', config.repo, '--json', 'name,value,updatedAt'])
  return { secrets, variables }
}

export function renderText(summary) {
  const lines = [
    `GitHub Actions runtime readiness: ${summary.status}`,
    `Repo: ${summary.repo}`,
    `Checked at: ${summary.checkedAt}`,
    '',
  ]

  for (const [name, check] of Object.entries(summary.checks)) {
    lines.push(`- ${name}: ${check.ok ? 'PASS' : 'FAIL'}`)
    if (check.missing?.length) lines.push(`  missing: ${check.missing.join(', ')}`)
    if (check.missingVariables?.length) lines.push(`  missing variables: ${check.missingVariables.join(', ')}`)
    if (name === 'dingtalkWebhookSelfHeal') {
      lines.push(`  present supported webhook secrets: ${check.present.length ? check.present.join(', ') : 'none'}`)
    }
    if (name === 'k3DeployAuthGate') {
      lines.push(`  require auth enabled: ${check.requireAuthEnabled}`)
      lines.push(`  tenant configured: ${check.tenantConfigured}`)
    }
  }

  lines.push('', 'Next actions:')
  for (const action of summary.nextActions) lines.push(`- ${action}`)
  return `${lines.join('\n')}\n`
}

export function renderMarkdown(summary) {
  const lines = [
    '# GitHub Actions Runtime Readiness',
    '',
    `- Overall: **${summary.status}**`,
    `- Repo: \`${summary.repo}\``,
    `- Checked at: \`${summary.checkedAt}\``,
    '',
    '## Checks',
    '',
  ]
  for (const [name, check] of Object.entries(summary.checks)) {
    lines.push(`- \`${name}\`: **${check.ok ? 'PASS' : 'FAIL'}**`)
    if (check.missing?.length) lines.push(`  - Missing: \`${check.missing.join('`, `')}\``)
    if (check.missingVariables?.length) lines.push(`  - Missing variables: \`${check.missingVariables.join('`, `')}\``)
    if (name === 'dingtalkWebhookSelfHeal') {
      lines.push(`  - Present supported webhook secrets: \`${check.present.length ? check.present.join('`, `') : 'none'}\``)
    }
    if (name === 'k3DeployAuthGate') {
      lines.push(`  - Require auth enabled: \`${check.requireAuthEnabled}\``)
      lines.push(`  - Tenant configured: \`${check.tenantConfigured}\``)
    }
  }
  lines.push('', '## Next Actions', '')
  for (const action of summary.nextActions) lines.push(`- ${action}`)
  return `${lines.join('\n')}\n`
}

function render(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
}

function printHelp() {
  console.log(`usage: github-actions-runtime-readiness.mjs [options]

Options:
  --repo <owner/name>          GitHub repository (default: GITHUB_REPOSITORY or zensgit/metasheet2)
  --format <text|markdown|json>
  --output <path>             Write rendered readiness output to a file
  --secrets-json <path>       Use fixture JSON instead of gh secret list
  --variables-json <path>     Use fixture JSON instead of gh variable list
  --strict                    Exit non-zero when readiness is FAIL
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }
  const { secrets, variables } = loadInputs(config)
  const summary = evaluateReadiness({ secrets, variables, repo: config.repo })
  const rendered = render(summary, config.format)
  if (config.output) {
    writeFileSync(config.output, rendered)
  } else {
    process.stdout.write(rendered)
  }
  return config.strict && !summary.ok ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
