import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  evaluateDeployReadiness,
  main,
  parseArgs,
  renderMarkdown,
} from './integration-erp-plm-deploy-readiness.mjs'

const MAINLINE_NUMBERS = [1391, 1390, 1389, 1388, 1387, 1386, 1385, 1383, 1382, 1381, 1380]
const UI_STACK = [
  { number: 1305, base: 'main', head: 'codex/erp-plm-config-workbench-20260505' },
  { number: 1364, base: 'codex/erp-plm-config-workbench-20260505', head: 'codex/k3wise-gate-middle-table-validation-20260506' },
  { number: 1392, base: 'codex/k3wise-gate-middle-table-validation-20260506', head: 'codex/k3wise-sql-disable-persist-20260507' },
]

function pr(number, baseRefName, headRefName, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: 'OPEN',
    baseRefName,
    headRefName,
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [
      { name: 'pr-validate', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    url: `https://github.com/zensgit/metasheet2/pull/${number}`,
    ...overrides,
  }
}

function cleanPayload() {
  return {
    mainlinePrs: MAINLINE_NUMBERS.map((number) => pr(number, 'main', `codex/pr-${number}`)),
    uiStackPrs: UI_STACK.map((item) => pr(item.number, item.base, item.head)),
  }
}

test('parseArgs accepts output, offline input, and approval policy', () => {
  assert.deepEqual(parseArgs([
    '--format',
    'markdown',
    '--input-json',
    'prs.json',
    '--output',
    'readiness.md',
    '--require-approvals',
    '--mainline-base',
    'release',
    '--ui-root-base',
    'staging',
  ]), {
    format: 'markdown',
    inputJson: 'prs.json',
    output: 'readiness.md',
    requireApprovals: true,
    mainlineBase: 'release',
    uiRootBase: 'staging',
  })
})

test('evaluateDeployReadiness passes clean mainline PRs and continuous UI stack', () => {
  const summary = evaluateDeployReadiness(cleanPayload())

  assert.equal(summary.ok, true)
  assert.equal(summary.deployMode.internalStaging, 'candidate-ready')
  assert.equal(summary.deployMode.customerLive, 'blocked-until-customer-gate-and-test-account')
  assert.equal(summary.mainline.results.length, MAINLINE_NUMBERS.length)
  assert.deepEqual(summary.uiStack.results.map((result) => result.expectedBase), [
    'main',
    'codex/erp-plm-config-workbench-20260505',
    'codex/k3wise-gate-middle-table-validation-20260506',
  ])
})

test('evaluateDeployReadiness fails when a required mainline PR is missing', () => {
  const payload = cleanPayload()
  payload.mainlinePrs = payload.mainlinePrs.filter((item) => item.number !== 1388)

  const summary = evaluateDeployReadiness(payload)

  assert.equal(summary.ok, false)
  assert.equal(summary.deployMode.internalStaging, 'blocked')
  const missing = summary.mainline.results.find((item) => item.number === 1388)
  assert.deepEqual(missing.reasons, ['PR data missing'])
})

test('evaluateDeployReadiness fails when the UI stack continuity breaks', () => {
  const payload = cleanPayload()
  payload.uiStackPrs[2] = pr(1392, 'main', 'codex/k3wise-sql-disable-persist-20260507')

  const summary = evaluateDeployReadiness(payload)

  assert.equal(summary.ok, false)
  const broken = summary.uiStack.results.find((item) => item.number === 1392)
  assert.deepEqual(broken.reasons, [
    'base is main, expected codex/k3wise-gate-middle-table-validation-20260506',
  ])
})

test('require approvals turns review warnings into blocking reasons', () => {
  const summary = evaluateDeployReadiness(cleanPayload(), { requireApprovals: true })

  assert.equal(summary.ok, false)
  assert.match(summary.mainline.results[0].reasons.join('\n'), /expected APPROVED/)
})

test('BLOCKED merge state is allowed for internal staging but not approval-required release', () => {
  const payload = cleanPayload()
  payload.mainlinePrs[0] = pr(1391, 'main', 'codex/pr-1391', { mergeStateStatus: 'BLOCKED' })

  const internal = evaluateDeployReadiness(payload)
  assert.equal(internal.ok, true)
  assert.equal(internal.mainline.results[0].ok, true)
  assert.match(internal.mainline.results[0].warnings.join('\n'), /allowed for internal staging/)

  const release = evaluateDeployReadiness(payload, { requireApprovals: true })
  assert.equal(release.ok, false)
  assert.match(release.mainline.results[0].reasons.join('\n'), /BLOCKED/)
})

test('renderMarkdown includes PR sections and local gates', () => {
  const markdown = renderMarkdown(evaluateDeployReadiness(cleanPayload()))

  assert.match(markdown, /## Mainline Hardening/)
  assert.match(markdown, /## K3 WISE UI Stack/)
  assert.match(markdown, /pnpm run verify:integration-k3wise:poc/)
})

test('main renders markdown from offline JSON', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'erp-plm-readiness-'))
  const input = path.join(tmpDir, 'payload.json')
  const output = path.join(tmpDir, 'readiness.md')

  try {
    writeFileSync(input, JSON.stringify(cleanPayload(), null, 2), 'utf8')

    const exitCode = main([
      '--input-json',
      input,
      '--format',
      'markdown',
      '--output',
      output,
    ])

    assert.equal(exitCode, 0)
    assert.match(readFileSync(output, 'utf8'), /Overall: \*\*PASS\*\*/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
