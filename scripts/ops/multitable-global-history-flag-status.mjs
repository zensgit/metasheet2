#!/usr/bin/env node
/**
 * Read-only Global History staging flag status helper.
 *
 * The script intentionally prints only the flags in FLAG_KEYS. It never dumps
 * the full container environment, tokens, or connection strings.
 */

import { execFileSync } from 'node:child_process'

const FLAG_KEYS = Object.freeze([
  'MULTITABLE_ENABLE_SHEET_CONFIG_REVERT',
  'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT',
  'MULTITABLE_ENABLE_PIT_RESET',
  'MULTITABLE_ENABLE_PIT_UNDELETE',
  'MULTITABLE_META_REVISION_RETENTION_ENABLED',
])

const TRUE_VALUES = new Set(['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON'])

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function parseArgs(argv) {
  const options = {
    json: false,
    strict: false,
    help: false,
    backendContainer: process.env.METASHEET_STATUS_BACKEND_CONTAINER || 'metasheet-staging-backend',
    webContainer: process.env.METASHEET_STATUS_WEB_CONTAINER || 'metasheet-staging-web',
    sshHost: process.env.METASHEET_STATUS_SSH_HOST || '',
    healthUrl: process.env.METASHEET_STATUS_HEALTH_URL || '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--backend-container') options.backendContainer = argv[++i] || ''
    else if (arg === '--web-container') options.webContainer = argv[++i] || ''
    else if (arg === '--ssh-host') options.sshHost = argv[++i] || ''
    else if (arg === '--health-url') options.healthUrl = argv[++i] || ''
    else throw new Error(`unknown argument: ${arg}`)
  }

  return options
}

function usage() {
  return `Usage:
  node scripts/ops/multitable-global-history-flag-status.mjs [--json] [--strict]

Environment / options:
  METASHEET_STATUS_SSH_HOST       SSH target for remote docker reads, e.g. mainuser@staging-host
  METASHEET_STATUS_BACKEND_CONTAINER  backend container name (default: metasheet-staging-backend)
  METASHEET_STATUS_WEB_CONTAINER      web container name (default: metasheet-staging-web)
  METASHEET_STATUS_HEALTH_URL         optional local/tunneled health URL to fetch

Examples:
  METASHEET_STATUS_SSH_HOST=mainuser@staging-host \\
    node scripts/ops/multitable-global-history-flag-status.mjs

  METASHEET_STATUS_HEALTH_URL=http://127.0.0.1:18900/health \\
    node scripts/ops/multitable-global-history-flag-status.mjs --json
`
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function runShell(command, sshHost = '') {
  if (sshHost) {
    return runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      sshHost,
      command,
    ])
  }
  return runCommand('sh', ['-lc', command])
}

function parseContainerInspect(text) {
  const [image = '', status = ''] = String(text).trim().split('\t')
  return { image: image.trim(), status: status.trim() }
}

function imageTag(image) {
  const value = String(image || '')
  if (!value || value.includes('@sha256:')) return ''
  const slash = value.lastIndexOf('/')
  const colon = value.lastIndexOf(':')
  return colon > slash ? value.slice(colon + 1) : ''
}

function collectFlagMapFromEnvText(text) {
  const allowed = new Set(FLAG_KEYS)
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, null]))
  for (const line of String(text || '').split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!allowed.has(key)) continue
    flags[key] = line.slice(eq + 1)
  }
  return flags
}

function flagEnabled(flags, key) {
  return TRUE_VALUES.has(String(flags[key] ?? ''))
}

async function fetchHealth(healthUrl) {
  if (!healthUrl) return null
  const res = await fetch(healthUrl, { headers: { accept: 'application/json' } })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { status: res.status, ok: res.ok, body }
}

function inspectContainer(sshHost, container) {
  const command = `docker inspect ${shellQuote(container)} --format ${shellQuote('{{.Config.Image}}\t{{.State.Status}}')}`
  return parseContainerInspect(runShell(command, sshHost))
}

function readBackendFlags(sshHost, container) {
  const command = `docker exec ${shellQuote(container)} sh -lc ${shellQuote('env')}`
  return collectFlagMapFromEnvText(runShell(command, sshHost))
}

function buildAssessment(input, { strict = false } = {}) {
  const warnings = []
  const stops = []
  const backendTag = imageTag(input.backend.image)
  const webTag = imageTag(input.web.image)

  if (input.backend.status && input.backend.status !== 'running') {
    stops.push(`backend container is ${input.backend.status}`)
  }
  if (input.web.status && input.web.status !== 'running') {
    stops.push(`web container is ${input.web.status}`)
  }
  if (backendTag && webTag && backendTag !== webTag) {
    warnings.push(`backend/web image tags differ: backend=${backendTag} web=${webTag}`)
  }
  if (strict && warnings.length > 0) {
    stops.push(...warnings.map((warning) => `strict: ${warning}`))
  }
  if (input.health && !input.health.ok) {
    stops.push(`health check returned ${input.health.status}`)
  }
  if (
    flagEnabled(input.flags, 'MULTITABLE_ENABLE_PIT_RESET') &&
    flagEnabled(input.flags, 'MULTITABLE_META_REVISION_RETENTION_ENABLED')
  ) {
    stops.push('PIT_RESET is enabled while MULTITABLE_META_REVISION_RETENTION_ENABLED is true')
  }

  return {
    ok: stops.length === 0,
    warnings,
    stops,
    backendTag,
    webTag,
  }
}

function renderText(snapshot, assessment) {
  const lines = []
  lines.push('Global History staging flag status')
  lines.push('')
  lines.push(`backend: ${snapshot.backend.image || '(unknown)'} [${snapshot.backend.status || 'unknown'}]`)
  lines.push(`web:     ${snapshot.web.image || '(unknown)'} [${snapshot.web.status || 'unknown'}]`)
  if (snapshot.health) {
    const body = snapshot.health.body && typeof snapshot.health.body === 'object' ? snapshot.health.body : {}
    lines.push(`health:  ${snapshot.health.status} ${snapshot.health.ok ? 'ok' : 'not ok'}${body.commit ? ` commit=${body.commit}` : ''}${body.created ? ` created=${body.created}` : ''}`)
  }
  lines.push('')
  lines.push('flags:')
  for (const key of FLAG_KEYS) {
    lines.push(`  ${key}=${snapshot.flags[key] ?? '(absent)'}`)
  }
  lines.push('')
  lines.push('checks:')
  if (assessment.stops.length === 0) lines.push('  PASS no stop conditions detected')
  for (const stop of assessment.stops) lines.push(`  STOP ${stop}`)
  for (const warning of assessment.warnings) lines.push(`  WARN ${warning}`)
  return lines.join('\n')
}

async function collectStatus(options) {
  const backend = inspectContainer(options.sshHost, options.backendContainer)
  const web = inspectContainer(options.sshHost, options.webContainer)
  const flags = readBackendFlags(options.sshHost, options.backendContainer)
  const health = await fetchHealth(options.healthUrl)
  return { backend, web, flags, health, checkedAt: new Date().toISOString() }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    console.error(usage())
    process.exit(2)
  }
  if (options.help) {
    console.log(usage())
    return
  }

  let snapshot
  try {
    snapshot = await collectStatus(options)
  } catch (error) {
    console.error(`ERROR: failed to collect status: ${error.message}`)
    process.exit(2)
  }

  const assessment = buildAssessment(snapshot, { strict: options.strict })
  if (options.json) {
    console.log(JSON.stringify({ snapshot, assessment }, null, 2))
  } else {
    console.log(renderText(snapshot, assessment))
  }
  if (!assessment.ok) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export {
  FLAG_KEYS,
  buildAssessment,
  collectFlagMapFromEnvText,
  flagEnabled,
  imageTag,
  parseArgs,
  parseContainerInspect,
  renderText,
}
