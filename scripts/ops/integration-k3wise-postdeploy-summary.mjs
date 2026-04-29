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

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-postdeploy-summary.mjs --input <path> [options]

Renders a compact GitHub Step Summary section body from a K3 WISE postdeploy
smoke evidence JSON file.

Options:
  --input <path>     Evidence JSON path
  --missing-ok       Render NOT RUN and exit 0 when the evidence file is missing
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

function renderMissingSummary(inputPath) {
  return [
    '- Status: **NOT RUN**',
    `- Reason: evidence file missing at \`${inputPath || 'unknown'}\``,
    '',
  ].join('\n')
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

function renderEvidenceSummary(evidence) {
  const summary = evidence && typeof evidence === 'object' ? evidence.summary || {} : {}
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : []
  const status = evidence?.ok ? 'PASS' : 'FAIL'
  const lines = [
    `- Status: **${status}**`,
    `- Base URL: \`${evidence?.baseUrl || 'unknown'}\``,
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
    console.log(renderEvidenceSummary(evidence))
    return 0
  } catch (error) {
    if (opts.missingOk && error && error.code === 'ENOENT') {
      console.log(renderMissingSummary(opts.input))
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
  parseArgs,
  renderEvidenceSummary,
  renderMissingSummary,
  summarizeCheckDetails,
  runCli,
}
