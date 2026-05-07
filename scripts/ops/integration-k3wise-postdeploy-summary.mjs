#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

class K3WisePostdeploySummaryError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WisePostdeploySummaryError'
    this.details = details
  }
}

const TOKEN_PATTERN = /([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/g

function redactText(value) {
  return String(value).replace(TOKEN_PATTERN, '<redacted-token>')
}

function redactBaseUrlForDisplay(value) {
  const text = String(value || '').trim()
  if (!text) return 'unknown'
  try {
    const parsed = new URL(text)
    let display = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
    if (parsed.search) display += '?<redacted-query>'
    if (parsed.hash) display += '#<redacted-fragment>'
    return redactText(display)
  } catch {
    return redactText(text)
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-postdeploy-summary.mjs --input <path> [options]

Renders a compact GitHub Step Summary section body from a K3 WISE postdeploy
smoke evidence JSON file.

Options:
  --input <path>     Evidence JSON path
  --missing-ok       Render NOT RUN and exit 0 when the evidence file is missing
  --require-auth-signoff
                      Render internal-trial signoff as blocked unless the smoke
                      evidence contains an authenticated PASS
  --help             Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new K3WisePostdeploySummaryError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    input: '',
    missingOk: false,
    requireAuthSignoff: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--input':
        opts.input = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--missing-ok':
        opts.missingOk = true
        break
      case '--require-auth-signoff':
        opts.requireAuthSignoff = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new K3WisePostdeploySummaryError(`unknown option: ${arg}`, { arg })
    }
  }

  if (!opts.help && !opts.input) {
    throw new K3WisePostdeploySummaryError('--input is required')
  }

  return opts
}

function renderMissingSummary(inputPath, { requireAuthSignoff = false } = {}) {
  const lines = []
  if (requireAuthSignoff) {
    lines.push('- Internal trial signoff: **BLOCKED**')
    lines.push('- Signoff reason: evidence file missing; authenticated smoke did not run')
  }
  lines.push(
    '- Status: **NOT RUN**',
    `- Reason: evidence file missing at \`${inputPath || 'unknown'}\``,
    '',
  )
  return lines.join('\n')
}

function inferInternalTrialSignoff(evidence) {
  if (evidence?.signoff?.internalTrial === 'pass') {
    return { status: 'PASS', reason: evidence.signoff.reason || 'authenticated smoke passed' }
  }
  if (evidence?.signoff?.internalTrial === 'blocked') {
    return { status: 'BLOCKED', reason: evidence.signoff.reason || 'authenticated smoke did not pass' }
  }
  if (evidence?.ok && evidence?.authenticated) {
    return { status: 'PASS', reason: 'authenticated smoke passed' }
  }
  if (!evidence?.authenticated) {
    return { status: 'BLOCKED', reason: 'authenticated checks did not run' }
  }
  return { status: 'BLOCKED', reason: 'one or more smoke checks failed' }
}

function renderSignoffLines(evidence, { requireAuthSignoff = false } = {}) {
  if (!requireAuthSignoff) return []
  const signoff = inferInternalTrialSignoff(evidence)
  return [
    `- Internal trial signoff: **${signoff.status}**`,
    `- Signoff reason: ${signoff.reason}`,
  ]
}

function formatDetailValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return '`none`'
    return value.map((item) => `\`${String(item)}\``).join(', ')
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => Array.isArray(child) ? child.length > 0 : child !== undefined && child !== null)
      .map(([key, child]) => `${key}: ${formatDetailValue(child)}`)
    return entries.length > 0 ? entries.join('; ') : '`none`'
  }
  return `\`${String(value)}\``
}

function summarizeCheckDetails(check) {
  const details = check && check.details && typeof check.details === 'object' ? check.details : {}
  const lines = []
  for (const key of ['missingAdapters', 'missingRoutes', 'missingFields', 'invalidFields']) {
    const value = details[key]
    const hasValue = Array.isArray(value)
      ? value.length > 0
      : value && typeof value === 'object'
        ? Object.keys(value).length > 0
        : value !== undefined && value !== null && value !== ''
    if (hasValue) lines.push(`    - ${key}: ${formatDetailValue(value)}`)
  }
  return lines
}

function renderEvidenceSummary(evidence, options = {}) {
  const summary = evidence && typeof evidence === 'object' ? evidence.summary || {} : {}
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : []
  const status = evidence?.ok ? 'PASS' : 'FAIL'
  const lines = [
    ...renderSignoffLines(evidence, options),
    `- Status: **${status}**`,
    `- Base URL: \`${redactBaseUrlForDisplay(evidence?.baseUrl)}\``,
    `- Authenticated checks: \`${evidence?.authenticated ? 'yes' : 'no'}\``,
    `- Summary: \`${Number(summary.pass || 0)} pass / ${Number(summary.skipped || 0)} skipped / ${Number(summary.fail || 0)} fail\``,
    '- Checks:',
  ]
  for (const check of checks) {
    lines.push(`  - \`${check?.id || 'unknown'}\`: \`${check?.status || 'unknown'}\``)
    if (check?.status === 'fail') {
      lines.push(...summarizeCheckDetails(check))
    }
  }
  if (checks.length === 0) {
    lines.push('  - `none`: `missing`')
  }
  lines.push('')
  return lines.join('\n')
}

async function readEvidence(inputPath) {
  const raw = await readFile(inputPath, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new K3WisePostdeploySummaryError(`invalid evidence JSON: ${inputPath}`, {
      cause: error && error.message ? error.message : String(error),
    })
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }

  const inputPath = path.resolve(opts.input)
  try {
    const evidence = await readEvidence(inputPath)
    console.log(renderEvidenceSummary(evidence, { requireAuthSignoff: opts.requireAuthSignoff }))
    return 0
  } catch (error) {
    if (opts.missingOk && error && error.code === 'ENOENT') {
      console.log(renderMissingSummary(opts.input, { requireAuthSignoff: opts.requireAuthSignoff }))
      return 0
    }
    throw error
  }
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().then((code) => {
    process.exit(code)
  }).catch((error) => {
    const body = error instanceof K3WisePostdeploySummaryError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(body, null, 2))
    process.exit(1)
  })
}

export {
  K3WisePostdeploySummaryError,
  formatDetailValue,
  inferInternalTrialSignoff,
  parseArgs,
  redactBaseUrlForDisplay,
  renderEvidenceSummary,
  renderMissingSummary,
  renderSignoffLines,
  summarizeCheckDetails,
  runCli,
}
