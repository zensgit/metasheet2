import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

function assertHostedJob(source, jobId, expectedRunner) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const start = lines.indexOf(`  ${jobId}:`)
  assert.notEqual(start, -1, `Missing job: ${jobId}`)
  let end = start + 1
  while (end < lines.length && !/^  [\w-]+:\s*(?:#.*)?$/.test(lines[end])) end++
  const selectors = lines.slice(start + 1, end).filter(line => /^    runs-on:/.test(line))
  assert.deepEqual(selectors, [`    runs-on: ${expectedRunner}`],
    `${jobId} must use a literal GitHub-hosted runner, not a self-hosted label or variable`)
}

test('required Linux integration job uses GitHub-hosted Ubuntu', () => {
  const workflow = readFileSync(new URL('.github/workflows/plugin-tests.yml', root), 'utf8')
  assertHostedJob(workflow, 'test', 'ubuntu-latest')
})

test('PowerShell 5.1 acceptance uses GitHub-hosted Windows', () => {
  const workflow = readFileSync(new URL('.github/workflows/stock-prep-powershell51.yml', root), 'utf8')
  assertHostedJob(workflow, 'stock-prep-powershell51', 'windows-latest')
})

test('routing contract rejects retired labels, expressions, missing and multiline selectors', () => {
  const rejected = [
    '    runs-on: ms2-wsl',
    '    runs-on: [self-hosted, Linux, X64]',
    '    runs-on: [self-hosted, Windows, X64, ms2-win]',
    "    runs-on: ${{ vars.MS2_PLUGIN_RUNNER || 'ubuntu-latest' }}",
    '    runs-on:\n      - self-hosted\n      - Linux',
    '',
  ]
  for (const selector of rejected) {
    assert.throws(() => assertHostedJob(`jobs:\n  test:\n${selector}\n    steps: []\n`, 'test', 'ubuntu-latest'))
  }
  assert.throws(() => assertHostedJob('jobs:\n  unrelated:\n    runs-on: ubuntu-latest\n', 'test', 'ubuntu-latest'))
})
