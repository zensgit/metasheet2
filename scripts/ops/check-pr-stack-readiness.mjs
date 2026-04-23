#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  evaluatePr,
  normalizePrList,
} from './check-pr-mainline-readiness.mjs'

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
    rootBase: 'main',
    format: 'text',
    inputJson: null,
    output: null,
    prs: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root-base') {
      config.rootBase = requireValue(argv, index, arg)
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

export function evaluateStack(prs, options = {}) {
  const rootBase = options.rootBase ?? 'main'
  const results = []

  for (const [index, pr] of prs.entries()) {
    const expectedBase = index === 0
      ? rootBase
      : prs[index - 1]?.headRefName
    const result = evaluatePr(pr, { expectedBase })

    if (!expectedBase) {
      result.ok = false
      result.reasons.push('expected base could not be resolved from previous PR head')
    }

    if (index > 0 && pr.headRefName === prs[index - 1]?.headRefName) {
      result.ok = false
      result.reasons.push(`head duplicates previous PR head ${pr.headRefName}`)
    }

    results.push({
      ...result,
      expectedBase,
      position: index + 1,
    })
  }

  return {
    ok: results.every((result) => result.ok),
    rootBase,
    checkedAt: new Date().toISOString(),
    count: results.length,
    results,
  }
}

export function renderText(summary) {
  const lines = [
    `PR stack readiness: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `Root base: ${summary.rootBase}`,
    `PR count: ${summary.count}`,
  ]

  for (const result of summary.results) {
    lines.push('')
    lines.push(`${result.position}. #${result.number ?? '?'} ${result.title ?? ''}`.trim())
    lines.push(`status: ${result.ok ? 'PASS' : 'FAIL'}`)
    lines.push(`base: ${result.baseRefName ?? 'unknown'} -> expected ${result.expectedBase ?? 'unknown'}`)
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
    '# PR Stack Readiness',
    '',
    `Overall: **${summary.ok ? 'PASS' : 'FAIL'}**`,
    '',
    `Root base: \`${summary.rootBase}\``,
    '',
    '| Pos | PR | Status | Base | Expected Base | Head | Merge State | Reasons |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const result of summary.results) {
    const pr = result.url
      ? `[#${result.number}](${result.url})`
      : `#${result.number ?? '?'}`
    const reasons = result.reasons.length > 0
      ? result.reasons.map((reason) => escapePipe(reason)).join('<br>')
      : '-'
    lines.push([
      result.position,
      pr,
      result.ok ? 'PASS' : 'FAIL',
      `\`${result.baseRefName ?? 'unknown'}\``,
      `\`${result.expectedBase ?? 'unknown'}\``,
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

export function renderSummary(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
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

function printHelp() {
  console.log(`Usage:
  node scripts/ops/check-pr-stack-readiness.mjs [options] <pr...>
  node scripts/ops/check-pr-stack-readiness.mjs --input-json prs.json

Options:
  --root-base <branch>  Expected base branch for the first PR. Default: main
  --format <format>    text, markdown, or json. Default: text
  --input-json <path>  Read PR object array from JSON instead of calling gh
  --output <path>      Write rendered result to a file

PRs must be passed from bottom to top of the stack.
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

  const summary = evaluateStack(prs, { rootBase: config.rootBase })
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
