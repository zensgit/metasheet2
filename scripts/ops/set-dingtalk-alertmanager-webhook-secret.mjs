#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SUPPORTED_SECRET_NAMES = [
  'ALERTMANAGER_WEBHOOK_URL',
  'ALERT_WEBHOOK_URL',
  'SLACK_WEBHOOK_URL',
  'ATTENDANCE_ALERT_SLACK_WEBHOOK_URL',
]

export function parseArgs(argv) {
  const config = {
    repo: process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2',
    name: 'ALERTMANAGER_WEBHOOK_URL',
    fromEnv: '',
    stdin: false,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') {
      config.repo = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--name') {
      config.name = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--from-env') {
      config.fromEnv = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--stdin') {
      config.stdin = true
    } else if (arg === '--dry-run') {
      config.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      config.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
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

export function validateSecretName(name) {
  if (!SUPPORTED_SECRET_NAMES.includes(name)) {
    throw new Error(`Unsupported secret name: ${name}. Supported: ${SUPPORTED_SECRET_NAMES.join(', ')}`)
  }
}

export function validateSlackWebhookUrl(value) {
  const webhookUrl = String(value || '').trim()
  if (!webhookUrl) {
    throw new Error('Webhook URL is empty')
  }

  let parsed
  try {
    parsed = new URL(webhookUrl)
  } catch {
    throw new Error('Webhook URL must be a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https')
  }
  if (parsed.hostname !== 'hooks.slack.com') {
    throw new Error('DingTalk Alertmanager stability requires a Slack webhook host: hooks.slack.com')
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('Webhook URL path is missing')
  }

  return {
    value: webhookUrl,
    host: parsed.hostname,
    pathLength: parsed.pathname.length,
  }
}

function readWebhookValue(config) {
  if (config.stdin) {
    return readFileSync(0, 'utf8')
  }
  const envName = config.fromEnv || config.name
  return process.env[envName] || ''
}

function setGitHubSecret({ repo, name, value }) {
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', repo], {
    input: `${value}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`gh secret set failed: ${result.stderr || result.stdout}`)
  }
}

function printHelp() {
  console.log(`usage: set-dingtalk-alertmanager-webhook-secret.mjs [options]

Options:
  --repo <owner/name>       GitHub repository (default: GITHUB_REPOSITORY or zensgit/metasheet2)
  --name <secret-name>      Secret name to set (default: ALERTMANAGER_WEBHOOK_URL)
  --from-env <env-name>     Read the webhook URL from an environment variable
  --stdin                   Read the webhook URL from stdin
  --dry-run                 Validate only; do not call gh secret set

Supported secret names:
  ${SUPPORTED_SECRET_NAMES.join('\n  ')}

Examples:
  printf '%s' "$ALERTMANAGER_WEBHOOK_URL" | node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs --stdin
  node scripts/ops/set-dingtalk-alertmanager-webhook-secret.mjs --from-env ALERTMANAGER_WEBHOOK_URL
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }

  validateSecretName(config.name)
  const webhook = validateSlackWebhookUrl(readWebhookValue(config))

  if (!config.dryRun) {
    setGitHubSecret({
      repo: config.repo,
      name: config.name,
      value: webhook.value,
    })
  }

  const action = config.dryRun ? 'validated' : 'configured'
  console.log(
    `[dingtalk-alertmanager-webhook-secret] ${action} ${config.name} for ${config.repo} ` +
      `(host=${webhook.host} path_length=${webhook.pathLength})`,
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
