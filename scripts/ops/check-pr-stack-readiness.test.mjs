import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  evaluateStack,
  main,
  parseArgs,
  renderMarkdown,
} from './check-pr-stack-readiness.mjs'

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
    url: `https://github.com/example/repo/pull/${number}`,
    ...overrides,
  }
}

test('parseArgs accepts root base, format, input, output, and PR numbers', () => {
  assert.deepEqual(parseArgs([
    '--root-base',
    'release',
    '--format',
    'json',
    '--input-json',
    'stack.json',
    '--output',
    'out.json',
    '1',
    '2',
  ]), {
    rootBase: 'release',
    format: 'json',
    inputJson: 'stack.json',
    output: 'out.json',
    prs: ['1', '2'],
  })
})
test('evaluateStack passes a continuous clean stack', () => {
  const summary = evaluateStack([
    pr(1, 'main', 'feature-a'),
    pr(2, 'feature-a', 'feature-b'),
    pr(3, 'feature-b', 'feature-c'),
  ])

  assert.equal(summary.ok, true)
  assert.deepEqual(summary.results.map((result) => result.expectedBase), [
    'main',
    'feature-a',
    'feature-b',
  ])
})

test('evaluateStack fails when first PR does not target root base', () => {
  const summary = evaluateStack([
    pr(1, 'feature-parent', 'feature-a'),
  ])

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.results[0].reasons, [
    'base is feature-parent, expected main',
  ])
})

test('evaluateStack fails when stack continuity is broken', () => {
  const summary = evaluateStack([
    pr(1, 'main', 'feature-a'),
    pr(2, 'other-base', 'feature-b'),
  ])

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.results[1].reasons, [
    'base is other-base, expected feature-a',
  ])
})

test('evaluateStack fails dirty PRs and keeps later continuity checks', () => {
  const summary = evaluateStack([
    pr(1, 'main', 'feature-a', { mergeStateStatus: 'DIRTY' }),
    pr(2, 'feature-a', 'feature-b'),
  ])

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.results[0].reasons, [
    'mergeStateStatus is DIRTY, expected CLEAN',
  ])
  assert.equal(summary.results[1].ok, true)
})

test('renderMarkdown includes expected base and reasons', () => {
  const summary = evaluateStack([
    pr(1, 'main', 'feature-a'),
    pr(2, 'wrong', 'feature-b'),
  ])

  const markdown = renderMarkdown(summary)
  assert.match(markdown, /Overall: \*\*FAIL\*\*/)
  assert.match(markdown, /Expected Base/)
  assert.match(markdown, /base is wrong, expected feature-a/)
})

test('main can render markdown from offline JSON and return failure', () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pr-stack-readiness-'))
  const input = path.join(tmpDir, 'stack.json')
  const output = path.join(tmpDir, 'report.md')

  try {
    writeFileSync(input, JSON.stringify([
      pr(1, 'main', 'feature-a'),
      pr(2, 'wrong', 'feature-b'),
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
    assert.match(readFileSync(output, 'utf8'), /Overall: \*\*FAIL\*\*/)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
