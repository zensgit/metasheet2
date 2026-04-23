#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const GH_PR_FIELDS = [
  'number',
  'title',
  'state',
  'baseRefName',
  'headRefName',
  'mergeStateStatus',
  'reviewDecision',
  'statusCheckRollup',
  'url',
].join(',')

export function parseArgs(argv) {
  const config = {
    expectedBase: 'main',
    format: 'text',
    inputJson: null,
    output: null,
    prs: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base') {
      config.expectedBase = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--format') {
      config.format = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--input-json') {
      config.inputJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output') {
      config.output = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      config.help = true
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    } else {
      config.prs.push(arg)
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

export function normalizePrList(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.prs)) return value.prs
  if (value && Array.isArray(value.pullRequests)) return value.pullRequests
  if (value && typeof value === 'object') return [value]
  throw new Error('Input JSON must be a PR object or an array of PR objects')
}

export function evaluatePr(pr, options = {}) {
  const expectedBase = options.expectedBase ?? 'main'
  const reasons = []
  const warnings = []
  const checks = normalizeChecks(pr.statusCheckRollup)
  const pendingChecks = checks.filter(isPendingCheck)
  const failedChecks = checks.filter((check) => !isPendingCheck(check) && !isSuccessfulCheck(check))

  if (pr.state !== 'OPEN') {
    reasons.push(`state is ${pr.state ?? 'unknown'}, expected OPEN`)
  }

  if (pr.baseRefName !== expectedBase) {
    reasons.push(`base is ${pr.baseRefName ?? 'unknown'}, expected ${expectedBase}`)
  }

  if (pr.mergeStateStatus && pr.mergeStateStatus !== 'CLEAN') {
    reasons.push(`mergeStateStatus is ${pr.mergeStateStatus}, expected CLEAN`)
  }

  if (failedChecks.length > 0) {
    reasons.push(`failing checks: ${failedChecks.map((check) => check.name).join(', ')}`)
  }

  if (pendingChecks.length > 0) {
    reasons.push(`pending checks: ${pendingChecks.map((check) => check.name).join(', ')}`)
  }

  if (pr.reviewDecision && pr.reviewDecision !== 'APPROVED') {
    warnings.push(`reviewDecision is ${pr.reviewDecision}`)
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision || '',
    ok: reasons.length === 0,
    reasons,
    warnings,
    checks,
  }
}

function normalizeChecks(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return []
  return statusCheckRollup.map((check) => ({
    name: check.name ?? check.context ?? 'unknown-check',
    conclusion: check.conclusion ?? check.state ?? '',
    status: check.status ?? (check.conclusion || check.state ? 'COMPLETED' : ''),
  }))
}

function isSuccessfulCheck(check) {
  return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(check.conclusion).toUpperCase())
}

function isPendingCheck(check) {
  return Boolean(check.status && check.status !== 'COMPLETED')
}

export function evaluatePrs(prs, options = {}) {
  const results = prs.map((pr) => evaluatePr(pr, options))
  return {
    ok: results.every((result) => result.ok),
    expectedBase: options.expectedBase ?? 'main',
    checkedAt: new Date().toISOString(),
    results,
  }
}

export function renderText(summary) {
  const lines = [
    `PR mainline readiness: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `Expected base: ${summary.expectedBase}`,
  ]

  for (const result of summary.results) {
    lines.push('')
    lines.push(`#${result.number ?? '?'} ${result.title ?? ''}`.trim())
    lines.push(`status: ${result.ok ? 'PASS' : 'FAIL'}`)
    lines.push(`base: ${result.baseRefName ?? 'unknown'} -> expected ${summary.expectedBase}`)
    lines.push(`head: ${result.headRefName ?? 'unknown'}`)
    lines.push(`mergeStateStatus: ${result.mergeStateStatus ?? 'unknown'}`)
    if (result.reasons.length > 0) {
      lines.push(`reasons: ${result.reasons.join('; ')}`)
    }
    if (result.warnings.length > 0) {
      lines.push(`warnings: ${result.warnings.join('; ')}`)
    }
  }

  return `${lines.join('\n')}\n`
}

export function renderMarkdown(summary) {
  const lines = [
    '# PR Mainline Readiness',
    '',
    `Overall: **${summary.ok ? 'PASS' : 'FAIL'}**`,
    '',
    `Expected base: \`${summary.expectedBase}\``,
    '',
    '| PR | Status | Base | Head | Merge State | Reasons |',
    '| --- | --- | --- | --- | --- | --- |',
  ]

  for (const result of summary.results) {
    const pr = result.url
      ? `[#${result.number}](${result.url})`
      : `#${result.number ?? '?'}`
    const reasons = result.reasons.length > 0
      ? result.reasons.map((reason) => escapePipe(reason)).join('<br>')
      : '-'
    lines.push([
      pr,
      result.ok ? 'PASS' : 'FAIL',
      `\`${result.baseRefName ?? 'unknown'}\``,
      `\`${result.headRefName ?? 'unknown'}\``,
      `\`${result.mergeStateStatus ?? 'unknown'}\``,
      reasons,
    ].join(' | '))
  }

  return `${lines.join('\n')}\n`
}

function escapePipe(value) {
  return String(value).replaceAll('|', '\\|')
}

export function readPrsFromJsonFile(filePath) {
  return normalizePrList(JSON.parse(readFileSync(filePath, 'utf8')))
}

export function readPrFromGh(prNumber) {
  const result = spawnSync('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    GH_PR_FIELDS,
  ], {
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh pr view failed for ${prNumber}`)
  }

  return JSON.parse(result.stdout)
}

export function renderSummary(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/check-pr-mainline-readiness.mjs [options] <pr...>
  node scripts/ops/check-pr-mainline-readiness.mjs --input-json pr.json

Options:
  --base <branch>       Expected base branch. Default: main
  --format <format>     text, markdown, or json. Default: text
  --input-json <path>   Read PR object or array from JSON instead of calling gh
  --output <path>       Write rendered result to a file
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }

  const prs = config.inputJson
    ? readPrsFromJsonFile(config.inputJson)
    : config.prs.map((prNumber) => readPrFromGh(prNumber))

  if (prs.length === 0) {
    throw new Error('At least one PR number or --input-json is required')
  }

  const summary = evaluatePrs(prs, { expectedBase: config.expectedBase })
  const rendered = renderSummary(summary, config.format)

  if (config.output) {
    mkdirSync(path.dirname(config.output), { recursive: true })
    writeFileSync(config.output, rendered, 'utf8')
  } else {
    process.stdout.write(rendered)
  }

  return summary.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
