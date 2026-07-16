import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const PROD_HEALTH_SILENCE_MARKER = '[SILENCED]'

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return parsed
}

export function normalizeProdHealthRunHistory(payload, options = {}) {
  const maxRuns = positiveInteger(options.maxRuns ?? 96, 'maxRuns')
  if (!Array.isArray(payload?.workflow_runs)) {
    throw new TypeError('Actions response must include workflow_runs')
  }
  const runs = payload.workflow_runs
  const history = []

  for (const run of runs) {
    if (
      !run ||
      (run.event !== 'schedule' && run.event !== 'workflow_dispatch') ||
      run.head_branch !== 'main'
    ) {
      continue
    }

    const displayTitle = String(run.display_title || '')
    if (displayTitle.includes(PROD_HEALTH_SILENCE_MARKER)) {
      history.push('silenced')
    } else if (run.conclusion === 'success' || run.conclusion === 'failure') {
      history.push(run.conclusion)
    } else {
      continue
    }

    if (history.length >= maxRuns) break
  }

  return history
}

export function evaluateProdHealthProbeState(input) {
  const probeResult = input?.probeResult
  if (probeResult !== 'pass' && probeResult !== 'fail') {
    throw new TypeError('probeResult must be pass or fail')
  }

  const history = Array.isArray(input?.history) ? input.history : []
  const failThreshold = positiveInteger(input?.failThreshold ?? 3, 'failThreshold')
  const recoveryThreshold = positiveInteger(
    input?.recoveryThreshold ?? 2,
    'recoveryThreshold',
  )
  const heartbeatEvery = positiveInteger(input?.heartbeatEvery ?? 12, 'heartbeatEvery')

  let previousFailures = 0
  let previousSuccesses = 0
  for (const conclusion of history) {
    if (conclusion === 'silenced') break
    if (conclusion === 'failure' && previousSuccesses === 0) {
      previousFailures += 1
    } else if (conclusion === 'success' && previousFailures === 0) {
      previousSuccesses += 1
    } else {
      break
    }
  }

  let consecutiveFailures = 0
  let consecutiveSuccesses = 0
  let crossing = false
  let heartbeat = false
  let ensureOpen = false
  let shouldClose = false

  if (probeResult === 'fail') {
    consecutiveFailures = previousFailures + 1
    ensureOpen = consecutiveFailures >= failThreshold
    crossing = consecutiveFailures === failThreshold
    heartbeat =
      consecutiveFailures > failThreshold &&
      consecutiveFailures % heartbeatEvery === 0
  } else {
    consecutiveSuccesses = previousSuccesses + 1
    shouldClose = consecutiveSuccesses >= recoveryThreshold
  }

  return {
    consecutiveFailures,
    consecutiveSuccesses,
    crossing,
    heartbeat,
    ensureOpen,
    shouldClose,
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${key}`)
    }
    options[key.slice(2)] = value
    index += 1
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options['history-file']) throw new Error('--history-file is required')

  const payload = JSON.parse(await readFile(options['history-file'], 'utf8'))
  const history = normalizeProdHealthRunHistory(payload, {
    maxRuns: options['max-runs'] ?? 96,
  })
  const state = evaluateProdHealthProbeState({
    probeResult: options['probe-result'],
    history,
    failThreshold: options['fail-threshold'] ?? 3,
    recoveryThreshold: options['recovery-threshold'] ?? 2,
    heartbeatEvery: options['heartbeat-every'] ?? 12,
  })

  console.error(
    `[prod-health-probe-state] recent history: ${history.join(' ') || '<none>'}`,
  )
  console.log(`consecutive_failures=${state.consecutiveFailures}`)
  console.log(`consecutive_successes=${state.consecutiveSuccesses}`)
  console.log(`crossing=${state.crossing}`)
  console.log(`heartbeat=${state.heartbeat}`)
  console.log(`ensure_open=${state.ensureOpen}`)
  console.log(`should_close=${state.shouldClose}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[prod-health-probe-state] ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
