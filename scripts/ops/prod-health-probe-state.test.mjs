import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  evaluateProdHealthProbeState,
  normalizeProdHealthRunHistory,
} from './prod-health-probe-state.mjs'

const modulePath = fileURLToPath(
  new URL('./prod-health-probe-state.mjs', import.meta.url),
)
const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/prod-health-probe-monitor.yml', import.meta.url),
)
const runbookPath = fileURLToPath(
  new URL(
    '../../docs/development/prod-health-probe-monitor-runbook-20260714.md',
    import.meta.url,
  ),
)

function completedRun(conclusion, overrides = {}) {
  return {
    event: 'schedule',
    head_branch: 'main',
    display_title: 'Prod Health Probe Monitor',
    conclusion,
    ...overrides,
  }
}

test('normalizes only relevant completed runs and preserves silence as a barrier', () => {
  const history = normalizeProdHealthRunHistory({
    workflow_runs: [
      completedRun('failure'),
      completedRun('success', {
        display_title: 'Prod Health Probe Monitor [SILENCED]',
      }),
      completedRun('failure'),
      completedRun('cancelled'),
      completedRun('failure', { event: 'push' }),
      completedRun('failure', { head_branch: 'feature' }),
    ],
  })

  assert.deepEqual(history, ['failure', 'silenced', 'failure'])
})

test('fails closed when the Actions history payload is malformed', () => {
  assert.throws(
    () => normalizeProdHealthRunHistory({}),
    /must include workflow_runs/,
  )
})

test('crosses after three real consecutive failures and heartbeats at twelve', () => {
  assert.deepEqual(
    evaluateProdHealthProbeState({
      probeResult: 'fail',
      history: ['failure', 'failure', 'success'],
    }),
    {
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      crossing: true,
      heartbeat: false,
      ensureOpen: true,
      shouldClose: false,
    },
  )

  const heartbeat = evaluateProdHealthProbeState({
    probeResult: 'fail',
    history: Array.from({ length: 11 }, () => 'failure'),
  })
  assert.equal(heartbeat.consecutiveFailures, 12)
  assert.equal(heartbeat.heartbeat, true)
  assert.equal(heartbeat.ensureOpen, true)
})

test('silenced runs reset both streaks without counting as a recovery', () => {
  const firstPass = evaluateProdHealthProbeState({
    probeResult: 'pass',
    history: ['silenced', 'failure', 'failure'],
  })
  assert.equal(firstPass.consecutiveSuccesses, 1)
  assert.equal(firstPass.shouldClose, false)

  const firstFailure = evaluateProdHealthProbeState({
    probeResult: 'fail',
    history: ['silenced', 'failure', 'failure'],
  })
  assert.equal(firstFailure.consecutiveFailures, 1)
  assert.equal(firstFailure.ensureOpen, false)
})

test('requires two real successful probes to close an alert', () => {
  const recovery = evaluateProdHealthProbeState({
    probeResult: 'pass',
    history: ['success', 'failure', 'failure', 'failure'],
  })
  assert.equal(recovery.consecutiveSuccesses, 2)
  assert.equal(recovery.shouldClose, true)
})

test('CLI emits GitHub output fields from the same state implementation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'prod-health-state-'))
  const historyFile = path.join(directory, 'history.json')
  writeFileSync(
    historyFile,
    JSON.stringify({
      workflow_runs: [completedRun('failure'), completedRun('failure')],
    }),
  )

  try {
    const result = spawnSync(
      process.execPath,
      [
        modulePath,
        '--history-file',
        historyFile,
        '--probe-result',
        'fail',
        '--fail-threshold',
        '3',
        '--recovery-threshold',
        '2',
        '--heartbeat-every',
        '12',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^consecutive_failures=3$/m)
    assert.match(result.stdout, /^crossing=true$/m)
    assert.match(result.stdout, /^ensure_open=true$/m)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow treats only HTTP 200 as healthy and calls the tested state helper', () => {
  const workflow = readFileSync(workflowPath, 'utf8')

  assert.match(workflow, /elif \[\[ "\$code" == "200" \]\]; then/)
  assert.match(
    workflow,
    /else\s+echo "\[probe\] attempt=\$attempt http=\$code \(non-200 -> fail\)"\s+result="fail"/s,
  )
  assert.doesNotMatch(workflow, /pass-with-note/)
  assert.match(workflow, /node scripts\/ops\/prod-health-probe-state\.mjs/)
  assert.match(workflow, /--history-file "\$history_file"/)
})

test('runbook does not describe redirects or client errors as healthy', () => {
  const runbook = readFileSync(runbookPath, 'utf8')
  assert.match(runbook, /any HTTP status other than 200 \(including 3xx\/4xx\/5xx\) \| fail/)
  assert.doesNotMatch(runbook, /pass-with-note/)
})
