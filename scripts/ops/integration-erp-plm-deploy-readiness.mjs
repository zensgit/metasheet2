#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  evaluatePr,
  readPrFromGh,
} from './check-pr-mainline-readiness.mjs'
import {
  evaluateStack,
} from './check-pr-stack-readiness.mjs'

const DEFAULT_MAINLINE_PRS = [
  { number: 1391, label: 'PLM disabled import route guard' },
  { number: 1390, label: 'dead-letter replay mark write guard' },
  { number: 1389, label: 'DB read where shape guard' },
  { number: 1388, label: 'external-system update default preservation' },
  { number: 1387, label: 'PLM input normalization' },
  { number: 1386, label: 'HTTP adapter relative path guard' },
  { number: 1385, label: 'HTTP adapter pagination/query guard' },
  { number: 1383, label: 'runner target write counter guard' },
  { number: 1382, label: 'K3 PoC secret text guard' },
  { number: 1381, label: 'testConnection result redaction' },
  { number: 1380, label: 'K3 SQL read/write allowlist split' },
]

const DEFAULT_UI_STACK = [
  { number: 1305, label: 'K3 WISE GATE readiness UI' },
  { number: 1364, label: 'K3 GATE middle-table validation' },
  { number: 1392, label: 'K3 SQL disabled-channel persistence' },
]

const REQUIRED_LOCAL_GATES = [
  {
    id: 'offline-poc',
    command: 'pnpm run verify:integration-k3wise:poc',
    purpose: 'Run preflight tests, evidence tests, and the mock PLM/K3 WISE PoC chain.',
  },
  {
    id: 'plugin-core',
    command: 'pnpm -F plugin-integration-core test',
    purpose: 'Verify plugin runtime, adapters, runner, dead-letter, feedback, and migration structure.',
  },
  {
    id: 'k3-setup-unit',
    command: 'pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false',
    purpose: 'Verify K3 WISE setup helper payloads and GATE form behavior.',
  },
  {
    id: 'web-build',
    command: 'pnpm --filter @metasheet/web build',
    purpose: 'Verify the K3 WISE setup UI compiles in the frontend package.',
  },
]

export function parseArgs(argv) {
  const config = {
    format: 'text',
    inputJson: null,
    output: null,
    requireApprovals: false,
    mainlineBase: 'main',
    uiRootBase: 'main',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--format') {
      config.format = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--input-json') {
      config.inputJson = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--output') {
      config.output = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--require-approvals') {
      config.requireApprovals = true
    } else if (arg === '--mainline-base') {
      config.mainlineBase = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--ui-root-base') {
      config.uiRootBase = requireValue(argv, index, arg)
      index += 1
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

function attachLabel(result, label) {
  return { ...result, label }
}

function applyInternalStagingPolicy(result, requireApprovals) {
  if (requireApprovals || result.mergeStateStatus !== 'BLOCKED') return result
  const blockedReason = 'mergeStateStatus is BLOCKED, expected CLEAN'
  if (!result.reasons.includes(blockedReason)) return result
  return {
    ...result,
    ok: result.reasons.length === 1,
    reasons: result.reasons.filter((reason) => reason !== blockedReason),
    warnings: [
      ...result.warnings,
      'mergeStateStatus is BLOCKED; allowed for internal staging when approval is not required',
    ],
  }
}

function applyApprovalPolicy(result, requireApprovals) {
  if (!requireApprovals) return result
  if (result.reviewDecision !== 'APPROVED') {
    return {
      ...result,
      ok: false,
      reasons: [
        ...result.reasons,
        `reviewDecision is ${result.reviewDecision || 'empty'}, expected APPROVED`,
      ],
    }
  }
  return result
}

export function normalizeInputPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Input JSON must be an object with mainlinePrs and uiStackPrs arrays')
  }
  return {
    mainlinePrs: Array.isArray(payload.mainlinePrs) ? payload.mainlinePrs : [],
    uiStackPrs: Array.isArray(payload.uiStackPrs) ? payload.uiStackPrs : [],
  }
}

export function evaluateDeployReadiness(payload, options = {}) {
  const requireApprovals = options.requireApprovals === true
  const mainlineBase = options.mainlineBase ?? 'main'
  const uiRootBase = options.uiRootBase ?? 'main'

  const mainlineResults = DEFAULT_MAINLINE_PRS.map((item) => {
    const pr = payload.mainlinePrs.find((candidate) => Number(candidate.number) === item.number)
    if (!pr) {
      return {
        number: item.number,
        title: '',
        url: '',
        state: '',
        baseRefName: '',
        headRefName: '',
        mergeStateStatus: '',
        reviewDecision: '',
        ok: false,
        label: item.label,
        reasons: ['PR data missing'],
        warnings: [],
        checks: [],
      }
    }
    return attachLabel(
      applyApprovalPolicy(
        applyInternalStagingPolicy(evaluatePr(pr, { expectedBase: mainlineBase }), requireApprovals),
        requireApprovals,
      ),
      item.label,
    )
  })

  const uiPrs = DEFAULT_UI_STACK.map((item) => payload.uiStackPrs.find((candidate) => Number(candidate.number) === item.number))
  const missingUi = uiPrs
    .map((pr, index) => pr ? null : DEFAULT_UI_STACK[index])
    .filter(Boolean)
  const stackSummary = missingUi.length > 0
    ? {
        ok: false,
        rootBase: uiRootBase,
        checkedAt: new Date().toISOString(),
        count: DEFAULT_UI_STACK.length,
        results: DEFAULT_UI_STACK.map((item) => ({
          number: item.number,
          title: '',
          url: '',
          state: '',
          baseRefName: '',
          headRefName: '',
          mergeStateStatus: '',
          reviewDecision: '',
          ok: false,
          label: item.label,
          expectedBase: item.number === DEFAULT_UI_STACK[0].number ? uiRootBase : 'previous stack head',
          position: DEFAULT_UI_STACK.findIndex((candidate) => candidate.number === item.number) + 1,
          reasons: missingUi.some((missing) => missing.number === item.number) ? ['PR data missing'] : [],
          warnings: [],
          checks: [],
        })),
      }
    : evaluateStack(uiPrs, { rootBase: uiRootBase })

  const uiResults = stackSummary.results.map((result) => {
    const item = DEFAULT_UI_STACK.find((candidate) => candidate.number === result.number)
    return attachLabel(
      applyApprovalPolicy(applyInternalStagingPolicy(result, requireApprovals), requireApprovals),
      item?.label ?? '',
    )
  })
  const uiOk = uiResults.every((result) => result.ok)
  const mainlineOk = mainlineResults.every((result) => result.ok)

  return {
    ok: mainlineOk && uiOk,
    checkedAt: new Date().toISOString(),
    requireApprovals,
    mainlineBase,
    uiRootBase,
    mainline: {
      ok: mainlineOk,
      required: DEFAULT_MAINLINE_PRS,
      results: mainlineResults,
    },
    uiStack: {
      ok: uiOk,
      required: DEFAULT_UI_STACK,
      results: uiResults,
    },
    localGates: REQUIRED_LOCAL_GATES,
    deployMode: {
      internalStaging: mainlineOk && uiOk ? 'candidate-ready' : 'blocked',
      customerLive: 'blocked-until-customer-gate-and-test-account',
    },
  }
}

function readPayloadFromJson(filePath) {
  return normalizeInputPayload(JSON.parse(readFileSync(filePath, 'utf8')))
}

function readPayloadFromGh() {
  return {
    mainlinePrs: DEFAULT_MAINLINE_PRS.map((item) => readPrFromGh(item.number)),
    uiStackPrs: DEFAULT_UI_STACK.map((item) => readPrFromGh(item.number)),
  }
}

export function renderText(summary) {
  const lines = [
    `ERP/PLM deploy readiness: ${summary.ok ? 'PASS' : 'FAIL'}`,
    `Internal staging: ${summary.deployMode.internalStaging}`,
    `Customer live: ${summary.deployMode.customerLive}`,
    `Require approvals: ${summary.requireApprovals ? 'yes' : 'no'}`,
    '',
    `Mainline hardening: ${summary.mainline.ok ? 'PASS' : 'FAIL'}`,
  ]

  for (const result of summary.mainline.results) {
    lines.push(`- #${result.number} ${result.ok ? 'PASS' : 'FAIL'} ${result.label}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}`)
  }

  lines.push('')
  lines.push(`K3 WISE UI stack: ${summary.uiStack.ok ? 'PASS' : 'FAIL'}`)
  for (const result of summary.uiStack.results) {
    lines.push(`- #${result.number} ${result.ok ? 'PASS' : 'FAIL'} ${result.label}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}`)
  }

  lines.push('')
  lines.push('Local gates to run on the composed staging branch:')
  for (const gate of summary.localGates) {
    lines.push(`- ${gate.command}`)
  }

  return `${lines.join('\n')}\n`
}

export function renderMarkdown(summary) {
  const lines = [
    '# ERP/PLM Deploy Readiness',
    '',
    `Overall: **${summary.ok ? 'PASS' : 'FAIL'}**`,
    '',
    `Internal staging: \`${summary.deployMode.internalStaging}\``,
    '',
    `Customer live: \`${summary.deployMode.customerLive}\``,
    '',
    `Require approvals: \`${summary.requireApprovals ? 'yes' : 'no'}\``,
    '',
    '## Mainline Hardening',
    '',
    '| PR | Label | Status | Base | Head | Reasons |',
    '| --- | --- | --- | --- | --- | --- |',
  ]

  for (const result of summary.mainline.results) {
    lines.push([
      result.url ? `[#${result.number}](${result.url})` : `#${result.number}`,
      escapePipe(result.label),
      result.ok ? 'PASS' : 'FAIL',
      `\`${result.baseRefName || 'unknown'}\``,
      `\`${result.headRefName || 'unknown'}\``,
      result.reasons.length ? result.reasons.map(escapePipe).join('<br>') : '-',
    ].join(' | '))
  }

  lines.push('')
  lines.push('## K3 WISE UI Stack')
  lines.push('')
  lines.push('| Pos | PR | Label | Status | Base | Expected Base | Head | Reasons |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const result of summary.uiStack.results) {
    lines.push([
      result.position,
      result.url ? `[#${result.number}](${result.url})` : `#${result.number}`,
      escapePipe(result.label),
      result.ok ? 'PASS' : 'FAIL',
      `\`${result.baseRefName || 'unknown'}\``,
      `\`${result.expectedBase || 'unknown'}\``,
      `\`${result.headRefName || 'unknown'}\``,
      result.reasons.length ? result.reasons.map(escapePipe).join('<br>') : '-',
    ].join(' | '))
  }

  lines.push('')
  lines.push('## Local Gates')
  lines.push('')
  for (const gate of summary.localGates) {
    lines.push(`- \`${gate.command}\` - ${gate.purpose}`)
  }
  lines.push('')

  return `${lines.join('\n')}`
}

function escapePipe(value) {
  return String(value).replaceAll('|', '\\|')
}

export function renderSummary(summary, format) {
  if (format === 'json') return `${JSON.stringify(summary, null, 2)}\n`
  if (format === 'markdown') return renderMarkdown(summary)
  return renderText(summary)
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/integration-erp-plm-deploy-readiness.mjs [options]

Options:
  --format <format>       text, markdown, or json. Default: text
  --input-json <path>     Read offline PR payload instead of calling gh
  --output <path>         Write rendered result to a file
  --require-approvals     Treat non-approved PRs as blocking
  --mainline-base <base>  Expected base for mainline hardening PRs. Default: main
  --ui-root-base <base>   Expected base for the first UI stack PR. Default: main

Input JSON shape:
  { "mainlinePrs": [<gh pr json>], "uiStackPrs": [<gh pr json>] }
`)
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv)
  if (config.help) {
    printHelp()
    return 0
  }

  const payload = config.inputJson ? readPayloadFromJson(config.inputJson) : readPayloadFromGh()
  const summary = evaluateDeployReadiness(payload, {
    requireApprovals: config.requireApprovals,
    mainlineBase: config.mainlineBase,
    uiRootBase: config.uiRootBase,
  })
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
