import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  evaluatePrs,
  main,
  parseArgs,
  readPrsFromJsonFile,
  renderMarkdown,
} from './check-pr-mainline-readiness.mjs'

function openMainPr(overrides = {}) {
  return {
    number: 100,
    title: 'test: safe main PR',
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'codex/safe',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [
      { name: 'pr-validate', conclusion: 'SUCCESS', status: 'COMPLETED' },
      { name: 'optional-e2e', conclusion: 'SKIPPED', status: 'COMPLETED' },
    ],
    url: 'https://github.com/example/repo/pull/100',
    ...overrides,
  }
}

test('parseArgs accepts base, format, input, output, and PR numbers', () => {
  assert.deepEqual(parseArgs([
    '--base',
    'release',
    '--format',
    'markdown',
    '--input-json',
    'prs.json',
    '--output',
    'out.md',
    '123',
  ]), {
    expectedBase: 'release',
    format: 'markdown',
    inputJson: 'prs.json',
    output: 'out.md',
    prs: ['123'],
  })
})

test('evaluatePrs passes a clean open PR targeting main', () => {
  const summary = evaluatePrs([openMainPr()])

  assert.equal(summary.ok, true)
  assert.equal(summary.results[0].ok, true)
  assert.deepEqual(summary.results[0].reasons, [])
})

test('evaluatePrs blocks stacked PRs that do not target main', () => {
  const summary = evaluatePrs([
    openMainPr({
      number: 1063,
      baseRefName: 'codex/dingtalk-person-granted-form-guard-20260422',
      headRefName: 'codex/dingtalk-feature-plan-todo-20260422',
    }),
  ])

  assert.equal(summary.ok, false)
  assert.equal(summary.results[0].ok, false)
  assert.deepEqual(summary.results[0].reasons, [
    'base is codex/dingtalk-person-granted-form-guard-20260422, expected main',
  ])
})

test('evaluatePrs blocks dirty merge state and failed checks', () => {
  const summary = evaluatePrs([
    openMainPr({
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: [
        { name: 'unit', conclusion: 'FAILURE', status: 'COMPLETED' },
      ],
    }),
  ])

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.results[0].reasons, [
    'mergeStateStatus is DIRTY, expected CLEAN',
    'failing checks: unit',
  ])
})

test('evaluatePrs reports pending checks', () => {
  const summary = evaluatePrs([
    openMainPr({
      statusCheckRollup: [
        { name: 'unit', conclusion: '', status: 'IN_PROGRESS' },
      ],
    }),
  ])

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.results[0].reasons, [
    'pending checks: unit',
  ])
})

test('renderMarkdown summarizes failed stacked PRs', () => {
  const summary = evaluatePrs([
    openMainPr({
      number: 1063,
      baseRefName: 'codex/stack-base',
      headRefName: 'codex/stack-head',
    }),
  ])

  const markdown = renderMarkdown(summary)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /\[#1063\]\(https:\/\/github.com\/example\/repo\/pull\/100\)/)
  assert.match(markdown, /base is codex\/stack-base, expected main/)
})

test('readPrsFromJsonFile accepts a single PR object', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pr-mainline-readiness-'))
  const input = path.join(tmpDir, 'pr.json')

  try {
    writeFileSync(input, JSON.stringify(openMainPr()), 'utf8')
    assert.equal(readPrsFromJsonFile(input).length, 1)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('main can render markdown from offline JSON and returns failure for stacked PRs', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pr-mainline-readiness-'))
  const input = path.join(tmpDir, 'prs.json')
  const output = path.join(tmpDir, 'report.md')

  try {
    writeFileSync(input, JSON.stringify([
      openMainPr(),
      openMainPr({ number: 101, baseRefName: 'codex/stack-base' }),
    ]), 'utf8')

    const exitCode = main([
      '--input-json',
      input,
      '--format',
      'markdown',
      '--output',
      output,
    ])

    assert.equal(exitCode, 1)
    const report = readFileSync(output, 'utf8')
    assert.match(report, /Overall: \*\*FAIL\*\*/)
    assert.match(report, /#101/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
