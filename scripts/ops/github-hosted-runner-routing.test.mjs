import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

function assertHostedJob(source, jobId, expectedRunner, precedingComments = []) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const starts = lines.flatMap((line, index) => line === `  ${jobId}:` ? [index] : [])
  assert.equal(starts.length, 1, `Expected exactly one job: ${jobId}`)
  const start = starts[0]
  let end = start + 1
  while (end < lines.length && !/^  \S/.test(lines[end])) end++
  const job = lines.slice(start + 1, end)
  const selectors = job.filter(line => /^    runs-on:/.test(line))
  assert.deepEqual(selectors, [`    runs-on: ${expectedRunner}`],
    `${jobId} must use a literal GitHub-hosted runner, not a self-hosted label or variable`)
  const selectorIndex = job.indexOf(selectors[0])
  assert.deepEqual(job.slice(selectorIndex - precedingComments.length, selectorIndex), precedingComments,
    `${jobId} must retain its runner exception explanation and retirement date`)
}

const pluginWorkflow = readFileSync(new URL('.github/workflows/plugin-tests.yml', root), 'utf8')
const temporaryRunnerComments = [
  '    # Temporary compatibility probe for observed UID_MAP_WRITE_DENIED on the ubuntu-24.04 image.',
  '    # This does not establish a host fix; runner-images #14254 retires ubuntu-22.04 on 2027-04-17.',
]
const otherPluginJobs = [
  'dingtalk-p4-ops-regression-gate',
  'k3wise-offline-poc',
  'after-sales-integration',
  'coverage',
]

function assertPluginWorkflowRunners(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const jobsIndex = lines.indexOf('jobs:')
  assert.notEqual(jobsIndex, -1, 'Missing jobs section')
  const jobIds = lines.slice(jobsIndex + 1).filter(line => /^  \S/.test(line) && !/^  #/.test(line))
    .map(line => {
      const header = /^  ([\w-]+):\s*(?:#.*)?$/.exec(line)
      assert.ok(header, 'plugin workflow jobs must use literal unquoted job keys')
      return header[1]
    })
  assert.deepEqual(jobIds.slice().sort(), ['test', ...otherPluginJobs].sort(),
    'plugin workflow runner allowlist must cover every job exactly once')
  assertHostedJob(source, 'test', 'ubuntu-22.04', temporaryRunnerComments)
  for (const jobId of otherPluginJobs) assertHostedJob(source, jobId, 'ubuntu-latest')
}

test('plugin jobs use GitHub-hosted Ubuntu with one temporary, dated test-job exception', () => {
  assertPluginWorkflowRunners(pluginWorkflow)
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

test('temporary runner exception cannot spread, become dynamic, duplicate or lose its retirement guard', () => {
  const pin = '    runs-on: ubuntu-22.04\n'
  const otherPin = '  coverage:\n    runs-on: ubuntu-latest\n'
  for (const mutation of [
    pluginWorkflow.replace('jobs:\n', "jobs:\n  'extra':\n    runs-on: ubuntu-22.04\n"),
    pluginWorkflow.replace('jobs:\n', 'jobs:\n  "extra":\n    runs-on: ubuntu-22.04\n'),
    pluginWorkflow.replace(pin, '    runs-on: ubuntu-latest\n'),
    pluginWorkflow.replace(pin, '    runs-on: ubuntu-24.04\n'),
    pluginWorkflow.replace(pin, '    runs-on: ${{ matrix.runner }}\n'),
    pluginWorkflow.replace(pin, pin + pin),
    pluginWorkflow.replace(pin, ''),
    pluginWorkflow.replace(otherPin, '  coverage:\n    runs-on: ubuntu-22.04\n'),
    pluginWorkflow.replace(temporaryRunnerComments[1], ''),
    pluginWorkflow.replace('2027-04-17', '2028-04-17'),
    pluginWorkflow.replace('  coverage:\n', '  test:\n'),
    pluginWorkflow + '\n  extra:\n    runs-on: ubuntu-22.04\n',
  ]) {
    assert.notEqual(mutation, pluginWorkflow, 'mutation must change the actual workflow')
    assert.throws(() => assertPluginWorkflowRunners(mutation))
  }
})
